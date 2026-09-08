import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, mkdir, open as openFile, realpath, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type {
  LocalProviderAdapter,
  LocalRuntimeCapabilities,
  LocalRuntimePromptInput,
  LocalRuntimeProviderEvent,
  LocalRuntimeSessionHandle,
  LocalRuntimeSessionInput,
} from "@cohub/protocol";
import { resolveWorkspacePath, workspaceFenceRoot } from "./workspace-path.js";

const PROVIDER = "pi" as const;
const ADAPTER_VERSION = "@earendil-works/pi-coding-agent@0.81.1";
const MAX_PENDING_EVENTS = 2048;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
// Keep raw values well below the runtime's event limit. JSON escaping can
// expand control-heavy text substantially, and the normalized envelope adds
// routing metadata around every provider payload.
const MAX_DELTA_BYTES = 512 * 1024;
const MAX_TOOL_VALUE_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const CANCEL_TIMEOUT_MS = 5_000;
const MAX_NATIVE_ID_LENGTH = 255;
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const PATH_KEYS = ["path", "file_path", "directory", "root"] as const;
const MAX_PROVIDER_EVENT_ID_LENGTH = 255;
type PiAccessMode = "read_only" | "full_access";

function cancellationTimeout(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : CANCEL_TIMEOUT_MS;
}

type Json = Record<string, unknown>;

const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

const textValue = (value: unknown, limit = MAX_TEXT_BYTES): string => {
  if (typeof value !== "string") return "";
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  return Buffer.from(value, "utf8").subarray(0, limit).toString("utf8").replace(/[\uFFFD]$/, "");
};

function boundedJson(value: unknown, limit = MAX_TOOL_VALUE_BYTES): unknown {
  if (typeof value === "string") return textValue(value, limit);
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized, "utf8") > limit) return { truncated: true };
    return value;
  } catch {
    return { unavailable: true };
  }
}

function boundedRecord(value: unknown, limit = MAX_TOOL_VALUE_BYTES): Json {
  const bounded = boundedJson(record(value), limit);
  return bounded && typeof bounded === "object" && !Array.isArray(bounded)
    ? bounded as Json
    : { value: bounded };
}

function splitUtf8(value: string, maxBytes = MAX_DELTA_BYTES): string[] {
  if (!value) return [];
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return [value];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < encoded.byteLength) {
    let end = Math.min(offset + maxBytes, encoded.byteLength);
    if (end < encoded.byteLength) {
      while (end > offset && ((encoded[end] ?? 0) & 0xc0) === 0x80) end -= 1;
      if (end === offset) {
        end = Math.min(offset + maxBytes, encoded.byteLength);
        while (end < encoded.byteLength && ((encoded[end] ?? 0) & 0xc0) === 0x80) end += 1;
      }
    }
    chunks.push(encoded.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return chunks;
}

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const boundedLabel = (value: unknown, fallback: string): string =>
  textValue(stringValue(value) ?? fallback, 4 * 1024);

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/**
 * Resolve the existing prefix of a path so symlinked workspace children cannot
 * escape the provider's cwd. The nearest-parent fallback also covers a new
 * file whose final component does not exist yet.
 */
async function canonicalPathForFence(candidate: string): Promise<string> {
  let probe = candidate;
  while (true) {
    try {
      const resolvedProbe = await realpath(probe);
      const suffix = relative(probe, candidate);
      return suffix ? resolve(resolvedProbe, suffix) : resolvedProbe;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return resolve(candidate);
      probe = parent;
    }
  }
}

/**
 * A workspace fence must have an existing directory root. Falling back to a
 * missing path's nearest existing parent would silently widen the fence.
 */
async function canonicalWorkspaceRoot(root: string): Promise<string> {
  let details: Awaited<ReturnType<typeof stat>>;
  try {
    details = await stat(root);
  } catch {
    throw new Error("Pi provider workspace root is unavailable");
  }
  if (!details.isDirectory()) throw new Error("Pi provider workspace root must be a directory");
  try {
    return await realpath(root);
  } catch {
    throw new Error("Pi provider workspace root is unavailable");
  }
}

async function assertWorkspacePath(raw: unknown, cwd: string, workspaceRoot = cwd): Promise<void> {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) {
    throw new Error("Tool path is invalid");
  }
  let candidate: string;
  try {
    candidate = resolveWorkspacePath(raw, cwd, workspaceRoot);
  } catch {
    throw new Error("Tool path is invalid");
  }
  const root = await canonicalWorkspaceRoot(workspaceFenceRoot(cwd, workspaceRoot));
  const canonical = await canonicalPathForFence(candidate);
  if (!isWithin(root, canonical)) throw new Error("Tool path is outside the authorized workspace");
}

function isVirtualWorkspacePath(raw: string): boolean {
  const normalized = raw.trim().replace(/\\/g, "/");
  return normalized === "/workspace"
    || normalized.startsWith("/workspace/")
    || normalized === "@/workspace"
    || normalized.startsWith("@/workspace/")
    || /^file:\/\/\/workspace(?:\/|$)/i.test(normalized);
}

/**
 * Pi's built-in tools resolve absolute paths directly on the host. Convert
 * accepted `/workspace` aliases to a cwd-relative path before execution so
 * the native tool sees the same physical file that the policy fence checked.
 * Relative paths keep their original spelling (and therefore do not expose
 * the host's physical replica path in tool result messages).
 */
function mapVirtualToolPaths(input: Json, cwd: string, workspaceRoot: string): void {
  for (const key of PATH_KEYS) {
    const raw = input[key];
    if (typeof raw !== "string" || !isVirtualWorkspacePath(raw)) continue;
    const physical = resolveWorkspacePath(raw, cwd, workspaceRoot);
    const relativePath = relative(cwd, physical);
    input[key] = relativePath || ".";
  }
}

function jsonText(value: unknown): string {
  if (typeof value === "string") return textValue(value, MAX_TOOL_VALUE_BYTES);
  try {
    return textValue(JSON.stringify(value) ?? "", MAX_TOOL_VALUE_BYTES);
  } catch {
    return "";
  }
}

/**
 * Pi reuses an assistant response id for every streaming chunk.  Event ids
 * therefore need a content revision as well as the native response id before
 * they can be used as durable ledger keys.
 */
function valueFingerprint(value: unknown): string {
  let serialized = "";
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    serialized = String(value);
  }
  return createHash("sha256").update(serialized, "utf8").digest("hex").slice(0, 16);
}

function providerEventId(...parts: Array<string | number | undefined | null>): string | undefined {
  const raw = parts
    .filter((part): part is string | number => part !== undefined && part !== null && String(part).length > 0)
    .map(String)
    .join(":");
  if (!raw) return undefined;
  if (raw.length <= MAX_PROVIDER_EVENT_ID_LENGTH
    && Buffer.byteLength(raw, "utf8") <= MAX_PROVIDER_EVENT_ID_LENGTH
    && !hasControlCharacters(raw)) return raw;
  const digest = createHash("sha256").update(raw, "utf8").digest("hex");
  const readable = stripControlCharacters(raw);
  const prefixBytes = Math.max(0, MAX_PROVIDER_EVENT_ID_LENGTH - digest.length - 1);
  const prefix = Buffer.from(readable, "utf8").subarray(0, prefixBytes).toString("utf8").replace(/[\uFFFD]$/u, "");
  return `${prefix}:${digest}`;
}

function appendBoundedText(current: string, addition: string, limit: number): string {
  const remaining = limit - Buffer.byteLength(current, "utf8");
  return remaining > 0 ? current + textValue(addition, remaining) : current;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function stripControlCharacters(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) continue;
    result += value[index];
  }
  return result;
}

function boundedNativeId(value: unknown, fallback = randomUUID()): string {
  const normalized = stringValue(value);
  if (!normalized) return fallback;
  return providerEventId(normalized) ?? fallback;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return textValue(value, MAX_TOOL_VALUE_BYTES);
  const raw = record(value);
  if (typeof raw.output === "string") return textValue(raw.output, MAX_TOOL_VALUE_BYTES);
  if (typeof raw.content === "string") return textValue(raw.content, MAX_TOOL_VALUE_BYTES);
  if (Array.isArray(raw.content)) {
    return textValue(raw.content.map((item) => {
      const block = record(item);
      return block.type === "text" ? String(block.text ?? "") : "";
    }).join(""), MAX_TOOL_VALUE_BYTES);
  }
  return jsonText(value);
}

function usage(value: unknown): Json | null {
  const raw = record(value);
  const number = (candidate: unknown): number | undefined =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined;
  const input = number(raw.input) ?? number(raw.input_tokens);
  const output = number(raw.output) ?? number(raw.output_tokens);
  const cacheRead = number(raw.cacheRead) ?? number(raw.cache_read_input_tokens);
  const cacheWrite = number(raw.cacheWrite) ?? number(raw.cache_write_input_tokens);
  const total = number(raw.totalTokens) ?? number(raw.total_tokens);
  const reasoning = number(raw.reasoning);
  if ([input, output, cacheRead, cacheWrite, total, reasoning].every((entry) => entry === undefined)) return null;
  const values = [input, output, cacheRead, cacheWrite].filter((entry): entry is number => entry !== undefined);
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(total === undefined ? (values.length ? { totalTokens: values.reduce((sum, item) => sum + item, 0) } : {}) : { totalTokens: total }),
    ...(raw.cost && typeof raw.cost === "object" ? { cost: boundedJson(raw.cost) } : {}),
  };
}

function imageData(data: string, mimeType: string): ImageContent {
  const normalized = data.replace(/\s/g, "");
  if (!normalized) throw new Error("Pi image content is empty");
  if (!mimeType.trim()) throw new Error("Pi image content is missing a MIME type");
  if (!mimeType.trim().toLowerCase().startsWith("image/")) throw new Error("Pi image content MIME type must be an image");
  const maxEncodedLength = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
  if (normalized.length > maxEncodedLength || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error("Pi image content is not valid base64");
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.byteLength > MAX_IMAGE_BYTES) throw new Error("Pi image content exceeds the size limit");
  // Node's base64 decoder accepts non-zero trailing bits (for example `AB==`).
  // Round-trip the bytes so malformed encodings cannot be forwarded to a
  // provider with a different interpretation.
  const canonical = decoded.toString("base64");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  if (canonical !== padded) throw new Error("Pi image content is not valid base64");
  return { type: "image", data: normalized, mimeType };
}

function imageValue(value: unknown): ImageContent {
  if (typeof value === "string") {
    const dataUrl = /^data:([^;,]+);base64,(.*)$/is.exec(value.trim());
    return dataUrl ? imageData(dataUrl[2] ?? "", dataUrl[1] ?? "") : imageData(value, "image/png");
  }
  const raw = record(value);
  if (raw.type === "url") throw new Error("Pi local provider does not accept URL image content");
  const mimeType = typeof raw.mimeType === "string" ? raw.mimeType : raw.media_type;
  if ((raw.type === "base64" || raw.type === "image") && typeof raw.data === "string" && typeof mimeType === "string") {
    return imageData(raw.data, mimeType);
  }
  throw new Error("Pi image content must be base64 data with a MIME type");
}

function contentParts(input: LocalRuntimePromptInput): { text: string; images: ImageContent[] } {
  if (typeof input.text !== "string") throw new Error("Pi prompt text must be a string");
  if (input.content !== undefined && !Array.isArray(input.content)) {
    throw new Error("Pi prompt content must be an array");
  }
  if (input.options !== undefined && record(input.options) !== input.options) {
    throw new Error("Pi prompt options must be an object");
  }
  const options = record(input.options);
  const blocks = input.content ?? [];
  const textBlocks: string[] = [];
  const images: ImageContent[] = [];
  for (const [index, value] of blocks.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Pi prompt content block ${index} is malformed`);
    }
    const block = value as Record<string, unknown>;
    switch (block.type) {
      case "text":
        if (typeof block.text !== "string") throw new Error(`Pi prompt text block ${index} is malformed`);
        textBlocks.push(textValue(block.text));
        break;
      case "image": {
        const source = record(block.source);
        if (source.type === "url") throw new Error("Pi local provider does not accept URL image content");
        if (source.type !== "base64" || typeof source.data !== "string" || typeof source.media_type !== "string") {
          throw new Error(`Pi prompt image block ${index} is malformed`);
        }
        images.push(imageData(source.data, source.media_type));
        break;
      }
      case "shell_command": {
        if (typeof block.rawText !== "string" || typeof block.command !== "string") {
          throw new Error(`Pi prompt shell command block ${index} is malformed`);
        }
        textBlocks.push(textValue(block.rawText || block.command, 4 * 1024 * 1024));
        break;
      }
      case "system_note":
        if (typeof block.text !== "string") throw new Error(`Pi prompt system note block ${index} is malformed`);
        textBlocks.push(textValue(block.text, 4 * 1024 * 1024));
        break;
      default:
        throw new Error(`Pi prompt content block type is unsupported: ${String(block.type || "unknown")}`);
    }
  }
  const contentText = textBlocks.join("\n\n");
  const directText = input.text;
  // The protocol may carry both a rendered text field and structured blocks.
  // Keep both unless the rendered field is exactly the same projection; a
  // truthy-only fallback silently drops shell/system notes in that case.
  const text = directText && contentText && directText !== contentText
    ? `${directText}\n\n${contentText}`
    : directText || contentText;
  const topLevelImages = (input as LocalRuntimePromptInput & { images?: unknown[] }).images;
  const optionImages = options.images;
  if (topLevelImages !== undefined && !Array.isArray(topLevelImages)) {
    throw new Error("Pi prompt images must be an array");
  }
  if (optionImages !== undefined && !Array.isArray(optionImages)) {
    throw new Error("Pi prompt options.images must be an array");
  }
  const extraImages = topLevelImages ?? optionImages ?? [];
  for (const value of extraImages) images.push(imageValue(value));
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) throw new Error("Pi prompt exceeds the text size limit");
  return { text, images };
}

function finalAssistantText(message: unknown): string {
  const content = record(message).content;
  if (typeof content === "string") return textValue(content, MAX_TEXT_BYTES);
  if (!Array.isArray(content)) return "";
  return textValue(content.map((value) => {
    const block = record(value);
    return block.type === "text" ? String(block.text ?? "") : "";
  }).join(""), MAX_TEXT_BYTES);
}

function responseId(message: unknown): string | undefined {
  const value = stringValue(record(message).responseId);
  return value ? boundedNativeId(value) : undefined;
}

function event(
  context: TurnContext,
  kind: LocalRuntimeProviderEvent["kind"],
  payload: Json,
  providerEventIdValue?: string,
): LocalRuntimeProviderEvent {
  const id = providerEventId(providerEventIdValue);
  return {
    kind,
    ...(id ? { providerEventId: id } : {}),
    payload: {
      nativeTurnId: context.turnId,
      nativeSessionId: context.sessionId,
      ...payload,
    },
  };
}

export type PiToolAuthorizationInput = {
  toolId: string;
  toolName: string;
  input: Json;
  cwd: string;
  accessMode: "read_only" | "full_access";
};

export type PiSessionManagerFactory = {
  list: (cwd: string, sessionDir?: string) => Promise<ReadonlyArray<{ id: string; path: string; cwd?: string }>>;
  open: (path: string, sessionDir?: string, cwdOverride?: string) => SessionManager;
  create: (cwd: string, sessionDir?: string, options?: { id?: string }) => SessionManager;
  fork?: (sourcePath: string, cwd: string, sessionDir?: string, options?: { id?: string }) => SessionManager;
};

export type PiProviderOptions = {
  sessionId?: string | null;
  cwd?: string;
  /** Physical replica root corresponding to the wire-level `/workspace`. */
  workspaceRoot?: string;
  /** Signal inherited from the runtime host; applies to every turn. */
  signal?: AbortSignal;
  sessionDir?: string;
  agentDir?: string;
  model?: string | null;
  modelObject?: Model<Api>;
  modelRuntime?: ModelRuntime;
  /** Native retries are disabled by default; the wire protocol cannot retract partial retry output. */
  autoRetry?: boolean;
  /** Optional settings manager, primarily for embedders and tests. */
  settingsManager?: SettingsManager;
  /** Bound the wait for a native abort/dispose operation to settle. */
  cancelTimeoutMs?: number;
  accessMode?: "read_only" | "full_access";
  tools?: string[];
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  operation?: LocalRuntimeSessionInput["operation"];
  createAgentSession?: (options: CreateAgentSessionOptions) => Promise<{ session: AgentSession }>;
  sessionManager?: SessionManager;
  sessionManagerFactory?: PiSessionManagerFactory;
  authorizeTool?: (input: PiToolAuthorizationInput, signal?: AbortSignal) => boolean | Promise<boolean>;
  workspaceGuard?: (input: PiToolAuthorizationInput, signal?: AbortSignal) => boolean | Promise<boolean>;
};

const sessionManagers: PiSessionManagerFactory = {
  list: (cwd, sessionDir) => SessionManager.list(cwd, sessionDir),
  open: (path, sessionDir, cwdOverride) => SessionManager.open(path, sessionDir, cwdOverride),
  create: (cwd, sessionDir, options) => SessionManager.create(cwd, sessionDir, options),
  fork: (sourcePath, cwd, sessionDir, options) => SessionManager.forkFrom(sourcePath, cwd, sessionDir, options),
};

type TurnState = {
  turnId: string;
  controller: AbortController;
  queue: LocalRuntimeProviderEvent[];
  waiters: Array<{ resolve: (result: IteratorResult<LocalRuntimeProviderEvent>) => void; reject: (error: Error) => void }>;
  finished: boolean;
  iteratorClosed: boolean;
  terminalEmitted: boolean;
  cancelTimedOut: boolean;
  failure?: Error;
  unsubscribe?: () => void;
  cancelPromise?: Promise<void>;
  donePromise: Promise<void>;
  resolveDone: () => void;
};

type TurnContext = {
  state: TurnState;
  turnId: string;
  sessionId: string;
  assistantMessagesBefore: Set<unknown>;
  messageCountBefore: number;
  assistantMessage?: unknown;
  finalText: string;
  usage: Json | null;
  usageFingerprint?: string;
  /**
   * Fingerprinted streaming events let a replay of the same native event use
   * the same id, while the revision fallback keeps malformed SDK events
   * without a partial snapshot distinct.
   */
  streamEventIds: Map<string, string>;
  streamRevisions: Map<string, number>;
  streamedTextEventIds: Set<string>;
  anonymousToolOccurrences: Array<{
    base: string;
    id: string;
    name: string;
    started: boolean;
    completed: boolean;
    lastSeen: number;
  }>;
  anonymousToolCounters: Map<string, number>;
  anonymousToolClock: number;
  nativeToolOccurrences: Array<{
    nativeId: string;
    id: string;
    name: string;
    argsFingerprint?: string;
    started: boolean;
    completed: boolean;
    lastSeen: number;
  }>;
  nativeToolCounters: Map<string, number>;
  settled: boolean;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
};

type ToolLifecycle = "started" | "updated" | "completed";

/**
 * Pi normally supplies a toolCallId, but malformed extensions and a few old
 * versions did not. Keep those calls addressable without using a random id;
 * repeated identical calls still receive distinct occurrence ordinals.
 */
function toolIdentity(
  context: TurnContext,
  rawId: unknown,
  rawName: unknown,
  args: unknown,
  lifecycle: ToolLifecycle,
): string {
  const nativeId = stringValue(rawId);
  if (nativeId) {
    const boundedId = boundedNativeId(nativeId);
    const name = boundedLabel(rawName, "tool");
    const argsFingerprint = args === undefined ? undefined : valueFingerprint(args);
    let occurrence = context.nativeToolOccurrences
      .filter((candidate) => candidate.nativeId === boundedId && !candidate.completed)
      .sort((left, right) => right.lastSeen - left.lastSeen)[0];

    // A repeated start with the same arguments is a transport replay. A
    // changed argument set indicates a malformed SDK reusing the id for a
    // second call, even when the first call is still active.
    if (lifecycle === "started" && occurrence && occurrence.started
      && occurrence.argsFingerprint !== argsFingerprint) {
      occurrence = undefined;
    }
    if (!occurrence && lifecycle !== "started") {
      occurrence = context.nativeToolOccurrences
        .filter((candidate) => candidate.nativeId === boundedId)
        .sort((left, right) => right.lastSeen - left.lastSeen)[0];
    }
    if (!occurrence) {
      const ordinal = (context.nativeToolCounters.get(boundedId) ?? 0) + 1;
      context.nativeToolCounters.set(boundedId, ordinal);
      occurrence = {
        nativeId: boundedId,
        id: ordinal === 1
          ? boundedId
          : providerEventId(context.turnId, "tool", boundedId, "occurrence", ordinal) as string,
        name,
        ...(argsFingerprint ? { argsFingerprint } : {}),
        started: false,
        completed: false,
        lastSeen: 0,
      };
      context.nativeToolOccurrences.push(occurrence);
    }
    occurrence.lastSeen = ++context.anonymousToolClock;
    if (argsFingerprint && !occurrence.argsFingerprint) occurrence.argsFingerprint = argsFingerprint;
    if (lifecycle === "started") occurrence.started = true;
    if (lifecycle === "completed") occurrence.completed = true;
    return occurrence.id;
  }
  const name = boundedLabel(rawName, "tool");
  const hasArgs = args !== undefined;
  const base = `${name}:${hasArgs ? valueFingerprint(args) : ""}`;
  let occurrence = hasArgs
    ? context.anonymousToolOccurrences
      .filter((candidate) => candidate.base === base && !candidate.completed && (lifecycle !== "started" || !candidate.started))
      .sort((left, right) => right.lastSeen - left.lastSeen)[0]
    : context.anonymousToolOccurrences
      .filter((candidate) => candidate.name === name && !candidate.completed)
      .sort((left, right) => right.lastSeen - left.lastSeen)[0];
  // A completion/update may arrive without arguments. If no active call is
  // available, preserve a prior occurrence with the same name as a late
  // event rather than inventing a random id.
  occurrence ??= !hasArgs
    ? context.anonymousToolOccurrences
      .filter((candidate) => candidate.name === name)
      .sort((left, right) => right.lastSeen - left.lastSeen)[0]
    : undefined;
  if (!occurrence) {
    const ordinal = (context.anonymousToolCounters.get(base) ?? 0) + 1;
    context.anonymousToolCounters.set(base, ordinal);
    occurrence = {
      base,
      id: providerEventId(context.turnId, "tool", "anonymous", valueFingerprint(base), ordinal) as string,
      name,
      started: false,
      completed: false,
      lastSeen: 0,
    };
    context.anonymousToolOccurrences.push(occurrence);
  }
  occurrence.lastSeen = ++context.anonymousToolClock;
  if (lifecycle === "started") occurrence.started = true;
  if (lifecycle === "completed") occurrence.completed = true;
  return occurrence.id;
}

/** Build replay-safe ids for tool lifecycle frames, including reused native ids. */
function toolLifecycleEventId(
  context: TurnContext,
  lifecycle: ToolLifecycle,
  toolId: string,
  value: unknown,
): string {
  const base = `tool:${lifecycle}:${toolId}`;
  const fingerprint = valueFingerprint(value);
  const key = `${base}:${fingerprint}`;
  const existing = context.streamEventIds.get(key);
  if (existing) return existing;
  const revision = (context.streamRevisions.get(base) ?? 0) + 1;
  context.streamRevisions.set(base, revision);
  const id = providerEventId(context.turnId, "tool", toolId, lifecycle, revision, fingerprint) as string;
  context.streamEventIds.set(key, id);
  return id;
}

function turnState(turnId: string): TurnState {
  let resolveDone!: () => void;
  const donePromise = new Promise<void>((resolve) => { resolveDone = resolve; });
  return {
    turnId,
    controller: new AbortController(),
    queue: [],
    waiters: [],
    finished: false,
    iteratorClosed: false,
    terminalEmitted: false,
    cancelTimedOut: false,
    donePromise,
    resolveDone,
  };
}

function streamingEventId(
  context: TurnContext,
  kind: "text" | "thinking",
  nativeId: string | undefined,
  index: number,
  update: Json,
  message: unknown,
): string {
  const key = `${kind}:${nativeId ?? context.turnId}:${index}`;
  // The SDK documents `partial` as the cumulative assistant message. It is
  // stable across transport retries and changes for each real content update.
  const partial = update.partial ?? message;
  const hasPartial = partial !== undefined && partial !== null;
  const fingerprint = valueFingerprint({
    type: update.type,
    contentIndex: index,
    delta: typeof update.delta === "string" ? update.delta : undefined,
    ...(hasPartial ? { partial } : {}),
  });
  if (hasPartial) {
    const fingerprintKey = `${key}:${fingerprint}`;
    const existing = context.streamEventIds.get(fingerprintKey);
    if (existing) return existing;
    const id = providerEventId(nativeId || context.turnId, kind, index, fingerprint) as string;
    context.streamEventIds.set(fingerprintKey, id);
    return id;
  }
  const revision = (context.streamRevisions.get(key) ?? 0) + 1;
  context.streamRevisions.set(key, revision);
  return providerEventId(nativeId || context.turnId, kind, index, revision, fingerprint) as string;
}

function failedEvent(sessionId: string, message: string, code: string): AsyncIterable<LocalRuntimeProviderEvent> {
  const turnId = randomUUID();
  const value: LocalRuntimeProviderEvent = {
    kind: "turn.failed",
    providerEventId: `${turnId}:failed`,
    payload: {
      nativeTurnId: turnId,
      nativeSessionId: sessionId,
      status: "turn_failed",
      message: textValue(message, MAX_TOOL_VALUE_BYTES),
      code,
      ...(code === "aborted" || code === "cancelled" ? { aborted: true } : {}),
    },
  };
  return {
    [Symbol.asyncIterator]: () => {
      let emitted = false;
      return {
        next: async () => {
          if (emitted) return { done: true, value: undefined };
          emitted = true;
          return { done: false, value };
        },
        return: async () => ({ done: true, value: undefined }),
      };
    },
  };
}

function errorValue(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" && value.trim() ? value : fallback);
}

function abortedError(reason: unknown): Error {
  const error = errorValue(reason, "Pi turn aborted");
  error.name = "AbortError";
  return error;
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortedError(signal.reason));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      rejectPromise(abortedError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // Resolve/reject handlers consume the source promise directly. Avoid an
    // ignored `.finally()` chain, whose rejected result would become an
    // unhandled rejection when the authorization hook fails.
    void promise.then(
      (value) => { cleanup(); resolvePromise(value); },
      (error) => { cleanup(); rejectPromise(error); },
    );
  });
}

/** Keep native abort from pinning the runtime when a provider never settles. */
function raceTimeout<T>(promise: Promise<T>, timeoutMs = CANCEL_TIMEOUT_MS): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => settle(() => rejectPromise(new Error("Pi provider cancellation timed out"))), timeoutMs);
    timer.unref?.();
    void promise.then(
      (value) => settle(() => resolvePromise(value)),
      (error) => settle(() => rejectPromise(error)),
    );
  });
}

export class PiProviderSession implements LocalRuntimeSessionHandle {
  private readonly cwd: string;
  private readonly workspaceRoot: string;
  private readonly defaultSignal?: AbortSignal;
  private readonly modelRuntime?: ModelRuntime;
  private readonly cancelTimeoutMs: number;
  private readonly authorizeTool?: PiProviderOptions["authorizeTool"];
  private readonly workspaceGuard?: PiProviderOptions["workspaceGuard"];
  private readonly previousBeforeToolCall?: AgentSession["agent"]["beforeToolCall"];
  private readonly previousActiveToolNames?: string[];
  private readonly configuredToolNames: string[];
  private readonly fullAccessToolNames: string[];
  /** The host-authorized ceiling; a turn may downgrade but never exceed it. */
  private readonly accessModeCeiling: PiAccessMode;
  private accessMode: "read_only" | "full_access";
  private active?: { state: TurnState; context: TurnContext };
  private closed = false;
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(private readonly native: AgentSession, options: PiProviderOptions = {}) {
    const rawSessionId = native.sessionId as unknown;
    const nativeSessionId = stringValue(rawSessionId);
    if (!nativeSessionId) {
      throw new Error("Pi provider returned an invalid native session id");
    }
    if (nativeSessionId.length > MAX_NATIVE_ID_LENGTH || Buffer.byteLength(nativeSessionId, "utf8") > MAX_NATIVE_ID_LENGTH) {
      throw new Error("Pi provider returned an oversized native session id");
    }
    if (nativeSessionId !== rawSessionId || hasControlCharacters(nativeSessionId)) {
      throw new Error("Pi provider returned an invalid native session id");
    }
    const configuredCwd = options.cwd ?? native.sessionManager.getCwd();
    if (typeof configuredCwd !== "string" || !configuredCwd.trim() || !isAbsolute(configuredCwd.trim())) {
      throw new Error("Pi provider cwd must be an absolute path");
    }
    this.cwd = resolve(configuredCwd.trim());
    const configuredWorkspaceRoot = options.workspaceRoot ?? this.cwd;
    if (typeof configuredWorkspaceRoot !== "string"
      || !configuredWorkspaceRoot.trim()
      || !isAbsolute(configuredWorkspaceRoot.trim())) {
      throw new Error("workspaceRoot must be an absolute path");
    }
    this.workspaceRoot = resolve(configuredWorkspaceRoot.trim());
    this.defaultSignal = options.signal;
    this.modelRuntime = options.modelRuntime;
    this.cancelTimeoutMs = cancellationTimeout(options.cancelTimeoutMs);
    this.accessModeCeiling = options.accessMode === "full_access" ? "full_access" : "read_only";
    this.accessMode = options.accessMode === "full_access" ? "full_access" : "read_only";
    this.authorizeTool = options.authorizeTool;
    this.workspaceGuard = options.workspaceGuard;
    this.previousBeforeToolCall = native.agent.beforeToolCall;
    const nativeToolNames = typeof native.getActiveToolNames === "function" ? native.getActiveToolNames() : undefined;
    const registeredToolNames = typeof native.getAllTools === "function"
      ? native.getAllTools().map((tool) => tool.name).filter((name): name is string => typeof name === "string" && name.trim().length > 0)
      : undefined;
    this.previousActiveToolNames = nativeToolNames?.slice();
    const explicitToolNames = options.tools?.slice();
    const defaultToolNames = nativeToolNames?.slice() ?? registeredToolNames?.slice() ?? [];
    this.fullAccessToolNames = explicitToolNames ?? defaultToolNames;
    // When starting read-only, retain the complete registry so a later
    // full-access turn can re-enable tools that were initially suppressed.
    this.configuredToolNames = explicitToolNames
      ?? (options.accessMode === "read_only"
        ? registeredToolNames?.slice() ?? this.fullAccessToolNames.slice()
        : this.fullAccessToolNames.slice());
    this.applyAccessModeTools();
    this.installToolGuard();
  }

  private applyAccessModeTools(): void {
    if (typeof this.native.setActiveToolsByName !== "function" || this.configuredToolNames.length === 0) return;
    const names = this.accessMode === "read_only"
      ? this.configuredToolNames.filter((name) => READ_ONLY_TOOLS.has(name.trim().toLowerCase()))
      : this.fullAccessToolNames;
    this.native.setActiveToolsByName(names);
  }

  private installToolGuard(): void {
    const previous = this.previousBeforeToolCall;
    this.native.agent.beforeToolCall = async (context: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> => {
      const toolCall = context.toolCall;
      const toolName = boundedLabel(toolCall?.name, "tool");
      const active = this.active;
      const toolId = active
        ? toolIdentity(active.context, toolCall?.id, toolName, context.args, "updated")
        : boundedNativeId(toolCall?.id);
      let request: PiToolAuthorizationInput = {
        toolId,
        toolName,
        input: boundedRecord(context.args),
        cwd: this.cwd,
        accessMode: this.accessMode,
      };
      const requestId = providerEventId(
        active?.context.turnId || this.providerSessionId,
        "permission",
        toolId,
        valueFingerprint(request.input),
      ) as string;
      let permissionEmitted = false;
      const emitPermission = (reason?: string) => {
        if (!active || active.context.settled || active.state.terminalEmitted || active.state.finished || active.state.iteratorClosed) return;
        if (permissionEmitted) return;
        permissionEmitted = true;
        this.push(active.state, event(active.context, "permission.requested", {
          requestId,
          toolId,
          name: toolName,
          input: request.input,
          metadata: {
            sourceType: "before_tool_call",
            accessMode: request.accessMode,
            ...(reason ? { reason: textValue(reason, MAX_TOOL_VALUE_BYTES) } : {}),
          },
        }, requestId));
      };
      const blocked = (reason: string): BeforeToolCallResult => {
        emitPermission(reason);
        return { block: true, reason };
      };

      // Keep the SDK's extension hook in the chain. A hook may intentionally
      // reject a call before the runtime's workspace policy is consulted.
      if (previous) {
        // Extension hooks are outside the runtime's control. Race them with
        // the native abort signal so a stalled hook cannot pin cancellation
        // (and therefore the whole provider turn) indefinitely.
        const previousResult = await raceAbort(Promise.resolve(previous(context, signal)), signal);
        // Pi passes this same validated object to the native tool after the
        // hook returns. Re-read it here so a hook cannot mutate a path after
        // the workspace policy has already inspected the old snapshot.
        request = { ...request, input: boundedRecord(context.args) };
        if (previousResult?.block) return blocked(previousResult.reason || "Tool call was blocked by the Pi hook");
      }
      if (signal?.aborted) return blocked("Operation aborted");
      const normalizedToolName = toolName.toLowerCase();
      // Unknown/custom tools are not assumed to be read-only. This remains an
      // enforcement layer even if a native extension changes the active list.
      if (this.accessMode === "read_only" && !READ_ONLY_TOOLS.has(normalizedToolName)) {
        return blocked(`Tool ${toolName} is unavailable in read-only mode`);
      }
      if (PATH_TOOLS.has(normalizedToolName)) {
        const pathValues: string[] = [];
        for (const key of PATH_KEYS) {
          if (!Object.hasOwn(request.input, key)) continue;
          const value = request.input[key];
          if (typeof value !== "string" || !value.trim()) return blocked(`Tool ${toolName} provided an invalid workspace path`);
          pathValues.push(value);
        }
        if (pathValues.length === 0 && ["read", "write", "edit"].includes(normalizedToolName)) {
          return blocked(`Tool ${toolName} did not provide a workspace path`);
        }
        try {
          for (const pathValue of pathValues) await assertWorkspacePath(pathValue, this.cwd, this.workspaceRoot);
        } catch (error) {
          return blocked(errorValue(error, "Tool path is outside the authorized workspace").message);
        }
        // BeforeToolCallResult cannot replace the validated argument object.
        // Mutate the SDK-owned clone after validation so Pi's native tool
        // resolves virtual aliases against the fenced physical workspace.
        const mutableInput = context.args && typeof context.args === "object" && !Array.isArray(context.args)
          ? context.args as Json
          : undefined;
        if (mutableInput) {
          try {
            mapVirtualToolPaths(mutableInput, this.cwd, this.workspaceRoot);
          } catch {
            return blocked(`Tool ${toolName} provided an invalid workspace path`);
          }
          request = { ...request, input: boundedRecord(mutableInput) };
        }
      }
      if (this.workspaceGuard) {
        try {
          const allowed = await raceAbort(Promise.resolve(this.workspaceGuard(request, signal)), signal);
          if (!allowed) return blocked("Tool access is outside the authorized workspace");
        } catch (error) {
          return blocked(errorValue(error, "Tool access authorization failed").message);
        }
      }
      if (this.authorizeTool) {
        // An authorization callback may wait for an external decision. Emit
        // the request before awaiting it so consumers can observe the pending
        // permission instead of waiting behind an unresolved tool call.
        emitPermission();
        try {
          const allowed = await raceAbort(Promise.resolve(this.authorizeTool(request, signal)), signal);
          if (!allowed) return blocked("Tool call was denied");
        } catch (error) {
          return blocked(errorValue(error, "Tool authorization failed").message);
        }
      }
      return undefined;
    };
  }

  get providerSessionId(): string {
    return this.native.sessionId;
  }

  run(input: LocalRuntimePromptInput, signal?: AbortSignal): AsyncIterable<LocalRuntimeProviderEvent> {
    if (this.closed || this.closing) return failedEvent(this.providerSessionId, "Pi provider session is closed", "session_closed");
    if (this.defaultSignal?.aborted) return failedEvent(this.providerSessionId, "Pi provider session is shutting down", "aborted");
    if (signal?.aborted) return failedEvent(this.providerSessionId, "Pi turn is already aborted", "aborted");
    if (this.active || this.native.isStreaming) return failedEvent(this.providerSessionId, "Pi provider session already has an active turn", "concurrent_turn");
    const requestedCwd = typeof input.options?.cwd === "string" ? resolve(input.options.cwd) : this.cwd;
    let canonicalRequestedCwd = requestedCwd;
    if (typeof input.options?.cwd === "string") {
      try {
        canonicalRequestedCwd = realpathSync.native(requestedCwd);
      } catch {
        return failedEvent(this.providerSessionId, "Pi turn cwd is unavailable", "cwd_unavailable");
      }
    }
    if (canonicalRequestedCwd !== this.cwd) return failedEvent(this.providerSessionId, "Pi turn cwd does not match the session workspace", "cwd_mismatch");
    const requestedAccessMode = input.options?.accessMode;
    if (requestedAccessMode !== undefined
      && requestedAccessMode !== "read_only"
      && requestedAccessMode !== "full_access") {
      return failedEvent(this.providerSessionId, "Pi provider accessMode is invalid", "invalid_access_mode");
    }
    if (requestedAccessMode === "full_access" && this.accessModeCeiling !== "full_access") {
      return failedEvent(this.providerSessionId, "Pi provider accessMode cannot widen a read-only session", "access_mode_widening");
    }
    if (requestedAccessMode === "read_only" || requestedAccessMode === "full_access") {
      this.accessMode = requestedAccessMode;
      this.applyAccessModeTools();
    }
    const state = turnState(randomUUID());
    const assistantMessagesBefore = new Set(this.native.messages.filter((message) => record(message).role === "assistant"));
    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const context: TurnContext = {
      state,
      turnId: state.turnId,
      sessionId: this.providerSessionId,
      assistantMessagesBefore,
      messageCountBefore: this.native.messages.length,
      finalText: "",
      usage: null,
      streamEventIds: new Map(),
      streamRevisions: new Map(),
      streamedTextEventIds: new Set(),
      anonymousToolOccurrences: [],
      anonymousToolCounters: new Map(),
      anonymousToolClock: 0,
      nativeToolOccurrences: [],
      nativeToolCounters: new Map(),
      settled: false,
      settledPromise,
      resolveSettled,
    };
    this.active = { state, context };
    const push = (value: LocalRuntimeProviderEvent) => this.push(state, value);
    try {
      state.unsubscribe = this.native.subscribe((nativeEvent) => this.translate(nativeEvent, context, push));
      push(event(context, "turn.started", {}, `${state.turnId}:started`));
    } catch (error) {
      state.failure = errorValue(error, "Pi provider subscription failed");
      state.iteratorClosed = true;
      this.finish(state);
      return this.iterator(state);
    }
    const signals = [signal, this.defaultSignal].filter(
      (candidate, index, values): candidate is AbortSignal => Boolean(candidate) && values.indexOf(candidate) === index,
    );
    const onAbort = () => { void this.cancelState(state, "runtime cancellation requested"); };
    const abortListeners = signals.map((source) => {
      if (source.aborted) onAbort();
      else source.addEventListener("abort", onAbort, { once: true });
      return { source, onAbort };
    });
    void this.execute(state, context, input, push)
      .catch((error) => {
        if (!state.terminalEmitted && !state.iteratorClosed) this.emitFailure(state, context, errorValue(error, "Pi turn failed"), false, push);
      })
      .finally(() => {
        for (const { source, onAbort: listener } of abortListeners) source.removeEventListener("abort", listener);
        this.finish(state);
      });
    return this.iterator(state);
  }

  private async execute(
    state: TurnState,
    context: TurnContext,
    input: LocalRuntimePromptInput,
    push: (value: LocalRuntimeProviderEvent) => void,
  ): Promise<void> {
    try {
      if (state.controller.signal.aborted) throw abortedError(state.controller.signal.reason);
      const parts = contentParts(input);
      const options = input.options === undefined ? {} : record(input.options);
      if (input.options !== undefined && options !== input.options) throw new Error("Pi prompt options must be an object");
      if (Object.hasOwn(options, "model") && options.model !== undefined && options.model !== null && typeof options.model !== "string") {
        throw new Error("Pi prompt model must be a string or null");
      }
      if (Object.hasOwn(options, "cwd") && options.cwd !== undefined && typeof options.cwd !== "string") {
        throw new Error("Pi prompt cwd must be a string");
      }
      const requestedModel = typeof options.model === "string" ? options.model : undefined;
      if (requestedModel?.trim()) {
        if (!this.modelRuntime) throw new Error("Pi provider model runtime is unavailable");
        const separator = requestedModel.indexOf("/");
        if (separator <= 0 || separator === requestedModel.length - 1) throw new Error(`Pi model must use provider/model format: ${requestedModel}`);
        const model = this.modelRuntime.getModel(requestedModel.slice(0, separator), requestedModel.slice(separator + 1));
        if (!model) throw new Error(`Pi model is not available: ${requestedModel}`);
        await this.native.setModel(model);
      }
      if (state.controller.signal.aborted) throw abortedError(state.controller.signal.reason);
      await this.native.prompt(parts.text, {
        expandPromptTemplates: false,
        source: "rpc",
        ...(parts.images.length ? { images: parts.images } : {}),
      });
      if (!context.settled) {
        if (this.native.isStreaming) await context.settledPromise;
        else context.settled = true;
      }
      const assistant = context.assistantMessage ?? this.native.messages.slice(context.messageCountBefore)
        .reverse()
        .find((message) => record(message).role === "assistant" && !context.assistantMessagesBefore.has(message));
      if (!assistant) {
        const aborted = state.controller.signal.aborted;
        this.emitFailure(
          state,
          context,
          aborted ? abortedError(state.controller.signal.reason) : new Error("Pi provider stream ended without an assistant message"),
          aborted,
          push,
        );
        return;
      }
      const reason = stringValue(record(assistant).stopReason);
      const aborted = state.controller.signal.aborted || reason === "aborted";
      if (aborted || reason === "error") {
        this.emitFailure(state, context, new Error(stringValue(record(assistant).errorMessage) || (aborted ? "Pi turn aborted" : "Pi turn failed")), aborted, push);
        return;
      }
      if (!state.terminalEmitted && !state.iteratorClosed) {
        const output = textValue(finalAssistantText(assistant) || context.finalText, MAX_DELTA_BYTES);
        state.terminalEmitted = true;
        push(event(context, "turn.completed", {
          status: "turn_completed",
          stopReason: reason ? textValue(reason, 4 * 1024) : "stop",
          ...(output ? { output } : {}),
          ...(context.usage ? { usage: context.usage } : {}),
        }, responseId(assistant) || `${state.turnId}:completed`));
      }
    } catch (error) {
      if (!state.terminalEmitted && !state.iteratorClosed) this.emitFailure(state, context, errorValue(error, "Pi turn failed"), state.controller.signal.aborted, push);
    }
  }

  private translate(nativeEvent: AgentSessionEvent, context: TurnContext, push: (value: LocalRuntimeProviderEvent) => void) {
    // `agent_settled` is the completion signal awaited by execute(). It must
    // still be observed after cancellation has emitted a terminal failure;
    // filtering it as a late frame would leave the turn promise hanging.
    if (nativeEvent.type === "agent_settled") {
      context.settled = true;
      context.resolveSettled();
      return;
    }
    // Native Pi listeners are synchronous today, but abort/dispose can race a
    // queued callback. Once the turn has settled (or its iterator is closed),
    // late frames must not leak into the next command or resurrect the queue.
    if (context.settled || context.state.controller.signal.aborted || context.state.terminalEmitted || context.state.finished || context.state.iteratorClosed) return;
    // Pi may transparently retry a retryable assistant error. Any text from
    // that failed attempt must not become the final fallback output when the
    // successful retry has no text block of its own.
    if (nativeEvent.type === "agent_end" && nativeEvent.willRetry) {
      context.assistantMessage = undefined;
      context.finalText = "";
      context.usage = null;
      context.usageFingerprint = undefined;
      return;
    }
    if (nativeEvent.type === "auto_retry_start") {
      context.assistantMessage = undefined;
      context.finalText = "";
      context.usage = null;
      context.usageFingerprint = undefined;
      return;
    }
    if (nativeEvent.type === "message_update") {
      const update = record(nativeEvent.assistantMessageEvent);
      const nativeId = responseId(nativeEvent.message);
      const index = typeof update.contentIndex === "number" ? update.contentIndex : 0;
      if (update.type === "text_delta" && typeof update.delta === "string") {
        const delta = textValue(update.delta);
        const chunks = splitUtf8(delta);
        const providerIds = chunks.length <= 1
          ? [streamingEventId(context, "text", nativeId, index, update, nativeEvent.message)]
          : chunks.map((_, chunkIndex) => streamingEventId(context, "text", nativeId, index, {
              ...update,
              chunkIndex,
              delta: chunks[chunkIndex],
            }, nativeEvent.message));
        const partial = update.partial ?? nativeEvent.message;
        const partialRecord = record(partial);
        const partialText = finalAssistantText(partial);
        if (partialText || Array.isArray(partialRecord.content)) {
          // Pi's `partial`/`message` snapshots are cumulative. Replacing the
          // fallback avoids duplicating text when the SDK replays an update.
          context.finalText = partialText;
        } else if (providerIds[0] !== undefined && !context.streamedTextEventIds.has(providerIds[0])) {
          context.finalText = appendBoundedText(context.finalText, delta, MAX_TEXT_BYTES);
        }
        const itemId = providerEventId(nativeId || context.turnId, "text", index) as string;
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
          const providerId = providerIds[chunkIndex];
          if (providerId === undefined) continue;
          context.streamedTextEventIds.add(providerId);
          push(event(context, "text.delta", { text: chunks[chunkIndex], itemId, metadata: { sourceType: "message_update", contentIndex: index } }, providerId));
        }
      } else if (update.type === "thinking_delta" && typeof update.delta === "string") {
        const itemId = providerEventId(nativeId || context.turnId, "thinking", index) as string;
        const chunks = splitUtf8(textValue(update.delta));
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
          const chunk = chunks[chunkIndex] ?? "";
          const providerId = chunks.length <= 1
            ? streamingEventId(context, "thinking", nativeId, index, update, nativeEvent.message)
            : streamingEventId(context, "thinking", nativeId, index, { ...update, chunkIndex, delta: chunk }, nativeEvent.message);
          push(event(context, "thinking.delta", { text: chunk, itemId, metadata: { sourceType: "message_update", contentIndex: index } }, providerId));
        }
      }
      return;
    }
    if (nativeEvent.type === "tool_execution_start") {
      const toolId = toolIdentity(context, nativeEvent.toolCallId, nativeEvent.toolName, nativeEvent.args, "started");
      const toolName = boundedLabel(nativeEvent.toolName, "tool");
      const input = boundedRecord(nativeEvent.args);
      push(event(context, "tool.started", { id: toolId, name: toolName, input, metadata: { sourceType: nativeEvent.type } }, toolLifecycleEventId(context, "started", toolId, { name: toolName, input })));
      return;
    }
    if (nativeEvent.type === "tool_execution_update") {
      const toolId = toolIdentity(context, nativeEvent.toolCallId, nativeEvent.toolName, nativeEvent.args, "updated");
      const partialResult = outputText(nativeEvent.partialResult);
      const args = boundedRecord(nativeEvent.args);
      const toolName = boundedLabel(nativeEvent.toolName, "tool");
      push(event(context, "tool.updated", { id: toolId, name: toolName, input: args, output: partialResult, metadata: { sourceType: nativeEvent.type } }, toolLifecycleEventId(context, "updated", toolId, { name: toolName, args, partialResult })));
      return;
    }
    if (nativeEvent.type === "tool_execution_end") {
      const toolId = toolIdentity(context, nativeEvent.toolCallId, nativeEvent.toolName, undefined, "completed");
      const isError = nativeEvent.isError === true;
      const toolName = boundedLabel(nativeEvent.toolName, "tool");
      const output = outputText(nativeEvent.result);
      push(event(context, "tool.completed", { id: toolId, name: toolName, output, isError, metadata: { sourceType: nativeEvent.type } }, toolLifecycleEventId(context, "completed", toolId, { name: toolName, output, isError })));
      return;
    }
    if ((nativeEvent.type === "message_end" || nativeEvent.type === "turn_end") && record(nativeEvent.message).role === "assistant") {
      context.assistantMessage = nativeEvent.message;
      const normalized = usage(record(nativeEvent.message).usage);
      if (!normalized) return;
      const fingerprint = JSON.stringify(normalized);
      if (fingerprint === context.usageFingerprint) return;
      context.usageFingerprint = fingerprint;
      context.usage = normalized;
      push(event(context, "usage", { usage: normalized, metadata: { sourceType: nativeEvent.type } }, providerEventId(responseId(nativeEvent.message) || context.turnId, "usage", valueFingerprint(normalized))));
      return;
    }
    if (nativeEvent.type === "agent_end" && !nativeEvent.willRetry) {
      const assistant = nativeEvent.messages
        .slice()
        .reverse()
        .find((message) => record(message).role === "assistant");
      if (assistant) {
        context.assistantMessage = assistant;
        const normalized = usage(record(assistant).usage);
        if (normalized) {
          const fingerprint = JSON.stringify(normalized);
          if (fingerprint !== context.usageFingerprint) {
            context.usageFingerprint = fingerprint;
            context.usage = normalized;
            push(event(context, "usage", { usage: normalized, metadata: { sourceType: nativeEvent.type } }, providerEventId(responseId(assistant) || context.turnId, "usage", valueFingerprint(normalized))));
          }
        }
      }
    }
  }

  private emitFailure(
    state: TurnState,
    context: TurnContext,
    error: Error,
    aborted: boolean,
    push: (value: LocalRuntimeProviderEvent) => void,
  ) {
    if (state.terminalEmitted || state.iteratorClosed) return;
    state.terminalEmitted = true;
    push(event(context, "turn.failed", {
      status: "turn_failed",
      message: textValue(error.message || (aborted ? "Pi turn aborted" : "Pi turn failed"), MAX_TOOL_VALUE_BYTES),
      code: aborted ? "aborted" : "provider_error",
      ...(aborted ? { aborted: true } : {}),
      ...(state.cancelTimedOut ? { unknownOutcome: true } : {}),
    }, `${state.turnId}:failed`));
  }

  private push(state: TurnState, value: LocalRuntimeProviderEvent) {
    if (state.finished || state.iteratorClosed) return;
    const waiter = state.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    if (state.queue.length >= MAX_PENDING_EVENTS) {
      state.queue.length = 0;
      state.failure = new Error("Pi provider event queue overflow");
      state.iteratorClosed = true;
      for (const pending of state.waiters.splice(0)) pending.reject(state.failure);
      void this.cancelState(state, "Pi provider event queue overflow");
      return;
    }
    state.queue.push(value);
  }

  private iterator(state: TurnState): AsyncIterable<LocalRuntimeProviderEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<LocalRuntimeProviderEvent>> => {
          if (state.queue.length > 0 && !state.iteratorClosed) return Promise.resolve({ done: false, value: state.queue.shift() as LocalRuntimeProviderEvent });
          if (state.failure && state.iteratorClosed) return Promise.reject(state.failure);
          if (state.finished || state.iteratorClosed) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve, reject) => state.waiters.push({ resolve, reject }));
        },
        return: async (): Promise<IteratorResult<LocalRuntimeProviderEvent>> => {
          if (!state.finished) {
            const shouldCancel = !state.terminalEmitted;
            state.iteratorClosed = true;
            state.queue.length = 0;
            for (const waiter of state.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
            if (shouldCancel) await this.cancelState(state, "consumer stopped").catch(() => undefined);
            // Once a terminal event is queued, the consumer can stop reading
            // immediately. The active marker remains until native.prompt()
            // settles, so skipping this wait cannot permit concurrent turns.
            if (!state.terminalEmitted || state.cancelTimedOut) {
              await raceTimeout(state.donePromise, this.cancelTimeoutMs).catch(() => undefined);
            }
          }
          return { done: true, value: undefined };
        },
      }),
    };
  }

  private finish(state: TurnState) {
    if (state.finished) return;
    state.finished = true;
    state.unsubscribe?.();
    state.unsubscribe = undefined;
    for (const waiter of state.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
    if (this.active?.state === state) this.active = undefined;
    state.resolveDone();
  }

  private async cancelState(state: TurnState, reason: string): Promise<void> {
    if (state.finished || state.terminalEmitted) return;
    if (!state.controller.signal.aborted) state.controller.abort(new Error(reason));
    state.cancelPromise ??= raceTimeout(Promise.resolve()
      .then(() => this.native.abort()), this.cancelTimeoutMs)
      .catch((error) => {
        if (error instanceof Error && error.message === "Pi provider cancellation timed out") {
          state.cancelTimedOut = true;
        }
      })
      .then(() => undefined);
    await state.cancelPromise;
    if (!state.terminalEmitted && !state.iteratorClosed && this.active?.state === state) {
      this.emitFailure(state, this.active.context, abortedError(reason), true, (value) => this.push(state, value));
    }
  }

  async cancel(reason = "Pi turn cancelled"): Promise<void> {
    const active = this.active;
    if (!active) return;
    await this.cancelState(active.state, reason).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closePromise ??= this.closeInternal();
    await this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closing = true;
    const active = this.active;
    let disposeError: unknown;
    try {
      if (active) await this.cancelState(active.state, "Pi provider session closed").catch(() => undefined);
      if (active && !active.state.cancelTimedOut) await raceTimeout(active.state.donePromise, this.cancelTimeoutMs).catch(() => undefined);
      this.native.dispose();
    } catch (error) {
      disposeError = error;
    }
    try { this.native.agent.beforeToolCall = this.previousBeforeToolCall; } catch { }
    try {
      if (this.previousActiveToolNames && typeof this.native.setActiveToolsByName === "function") {
        this.native.setActiveToolsByName(this.previousActiveToolNames);
      }
    } catch { }
    this.closed = true;
    this.closing = false;
    if (disposeError) throw disposeError;
  }
}

function isolatedSettingsManager(source: SettingsManager): SettingsManager {
  const isolated = SettingsManager.inMemory(source.getGlobalSettings(), {
    projectTrusted: source.isProjectTrusted(),
  });
  isolated.applyOverrides(source.getProjectSettings());
  return isolated;
}

function validateNativeSessionIdentity(session: AgentSession, options: PiProviderOptions): void {
  const raw = session.sessionId as unknown;
  const actual = stringValue(raw);
  if (!actual) throw new Error("Pi provider returned an invalid native session id");
  if (actual.length > MAX_NATIVE_ID_LENGTH || Buffer.byteLength(actual, "utf8") > MAX_NATIVE_ID_LENGTH) {
    throw new Error("Pi provider returned an oversized native session id");
  }
  if (actual !== raw || hasControlCharacters(actual)) {
    throw new Error("Pi provider returned an invalid native session id");
  }
  const requested = options.sessionId?.trim() || undefined;
  if (options.operation === "session.resume" && requested && actual !== requested) {
    throw new Error(`Pi session.resume returned session id ${actual}; expected ${requested}`);
  }
  if (options.operation === "session.fork" && requested && actual === requested) {
    throw new Error("Pi session.fork must return a new providerSessionId");
  }
}

async function validateCwd(value: string): Promise<string> {
  if (!isAbsolute(value)) throw new Error("Pi provider cwd must be absolute");
  const cwd = resolve(value);
  await access(cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error("Pi provider cwd must be a directory");
  // Hand the native SDK a canonical directory. This avoids a symlinked cwd
  // changing identity between session creation and tool execution; the host
  // runner performs the enclosing workspace fence before this point.
  return realpath(cwd);
}

/** Resolve a manager/session path before comparing it with the canonical cwd. */
async function canonicalManagerCwd(value: string): Promise<string | undefined> {
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value.trim())) return undefined;
  try {
    return await realpath(resolve(value.trim()));
  } catch {
    return undefined;
  }
}

async function modelRuntime(agentDir?: string): Promise<ModelRuntime> {
  return agentDir
    ? ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") })
    : ModelRuntime.create();
}

async function managerFor(cwd: string, options: PiProviderOptions): Promise<SessionManager> {
  if (options.sessionManager) {
    if (options.operation === "session.fork") throw new Error("Pi session fork requires a session manager factory");
    const requested = options.sessionId?.trim() || undefined;
    if (options.operation === "session.open" && requested) {
      throw new Error("Pi session.open must not include a providerSessionId");
    }
    if (options.operation === "session.resume") {
      if (!requested) throw new Error("Pi session resume requires a providerSessionId");
      const managerId = typeof options.sessionManager.getSessionId === "function"
        ? options.sessionManager.getSessionId()
        : undefined;
      if (!managerId || managerId !== requested) {
        throw new Error(`Pi provider session was not found: ${requested}`);
      }
    }
    const managerCwdValue = typeof options.sessionManager.getCwd === "function"
      ? options.sessionManager.getCwd()
      : undefined;
    const managerCwd = managerCwdValue === undefined
      ? undefined
      : await canonicalManagerCwd(managerCwdValue);
    if (managerCwdValue !== undefined && managerCwd === undefined) {
      throw new Error("Pi provider session workspace is unavailable");
    }
    if (managerCwd && managerCwd !== cwd) {
      throw new Error("Pi provider session workspace does not match the requested cwd");
    }
    return options.sessionManager;
  }
  const factory = options.sessionManagerFactory ?? sessionManagers;
  const sessionDir = options.sessionDir ?? (options.agentDir ? defaultSessionDir(cwd, options.agentDir) : undefined);
  const requested = options.sessionId?.trim() || undefined;
  if (!requested) {
    if (options.operation === "session.resume") throw new Error("Pi session resume requires a providerSessionId");
    if (options.operation === "session.fork") throw new Error("Pi session fork requires a source providerSessionId");
    return factory.create(cwd, sessionDir);
  }
  if (options.operation === "session.open") {
    throw new Error("Pi session.open must not include a providerSessionId");
  }
  const sessions = await factory.list(cwd, sessionDir);
  let existing: (typeof sessions)[number] | undefined;
  for (const entry of sessions) {
    if (entry.id !== requested) continue;
    if (!entry.cwd) {
      existing = entry;
      break;
    }
    const entryCwd = await canonicalManagerCwd(entry.cwd);
    if (entryCwd === cwd) {
      existing = entry;
      break;
    }
  }
  if (!existing) {
    if (options.operation === "session.resume" || options.operation === "session.fork") {
      throw new Error(`Pi provider session was not found: ${requested}`);
    }
    return factory.create(cwd, sessionDir, { id: requested });
  }
  if (options.operation === "session.fork") {
    if (!factory.fork) throw new Error("Pi session manager does not support native session fork");
    return factory.fork(existing.path, cwd, sessionDir);
  }
  return factory.open(existing.path, sessionDir, cwd);
}

/**
 * Pi intentionally delays creating a session JSONL until the first assistant
 * message. The runtime advertises the native id as soon as `open` succeeds,
 * so persist the complete initial manager state before returning the handle.
 * This makes an opened-but-not-yet-prompted session resumable after a host
 * restart while keeping the SDK's append-only bookkeeping intact.
 */
async function ensurePersistedSession(manager: SessionManager): Promise<void> {
  // Keep the adapter embeddable with lightweight SessionManager facades used
  // by hosts/tests; the native SDK manager exposes these methods in full.
  if (typeof manager.isPersisted !== "function" || !manager.isPersisted()) return;
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Pi persisted session has no session file");

  let exists = true;
  try {
    await access(sessionFile);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code !== "ENOENT") throw error;
    exists = false;
  }

  // A newly-created manager has no entries and may race with another opener
  // that created the same explicit path. Reloading an existing file marks the
  // SDK manager as flushed, preventing its first append from using `wx` on an
  // already-created file.
  if (exists) {
    if (manager.getEntries().length === 0) manager.setSessionFile(sessionFile);
    return;
  }

  const header = manager.getHeader();
  if (!header) throw new Error("Pi session has no header");
  await mkdir(dirname(sessionFile), { recursive: true });
  const entries = [header, ...manager.getEntries()];
  const content = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  let created = false;
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    try {
      handle = await openFile(sessionFile, "wx");
      created = true;
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      // Another process may have won the creation race. Let setSessionFile
      // below load that authoritative file instead of overwriting it.
      if (code !== "EEXIST") throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  } catch (error) {
    if (created) await unlink(sessionFile).catch(() => undefined);
    throw error;
  }
  // Re-read through the public SDK API so its private `flushed` state and
  // indexes match the durable file before the first prompt can append to it.
  manager.setSessionFile(sessionFile);
}

/** Mirrors Pi's default cwd encoding without importing its non-runtime export. */
function defaultSessionDir(cwd: string, agentDir: string): string {
  const safeCwd = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", safeCwd);
}

/** Normalize a tool allowlist and reject malformed remote configuration. */
function toolAllowlist(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`Pi provider ${name} must be a string array`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const trimmed = entry.trim();
    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
  }
  return result;
}

/** Apply the adapter-owned tool ceiling to a payload-selected subset. */
function constrainToolAllowlist(requested: string[] | undefined, ceiling: string[] | undefined): string[] | undefined {
  if (!requested) return ceiling?.slice();
  if (!ceiling) return requested;
  const canonical = new Map<string, string>();
  for (const name of ceiling) canonical.set(name.trim().toLowerCase(), name.trim());
  const outside = requested.filter((name) => !canonical.has(name.toLowerCase()));
  if (outside.length > 0) {
    throw new Error(`Pi provider tools exceed the adapter tool ceiling: ${outside.join(", ")}`);
  }
  // Keep the adapter's spelling so Pi's case-sensitive registry lookup is not
  // defeated by a payload using e.g. "READ".
  return requested.map((name) => canonical.get(name.toLowerCase()) as string);
}

type ExtendedSessionInput = LocalRuntimeSessionInput & {
  model?: string | null;
  accessMode?: "read_only" | "full_access";
};

function optionsForInput(input: ExtendedSessionInput, adapter: PiProviderOptions): PiProviderOptions {
  // Provider-specific options are intentionally payload-only. The runtime
  // metadata channel is routing/observability data and must not configure Pi.
  const providerOptions = input.payload ?? {};
  const stringOption = (name: string): string | undefined => typeof providerOptions[name] === "string" && providerOptions[name] ? providerOptions[name] as string : undefined;
  const normalizeWorkspaceRoot = (value: unknown, name: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim() || !isAbsolute(value.trim())) {
      throw new Error(`${name} must be an absolute path`);
    }
    return resolve(value.trim());
  };
  const workspaceRoot = input.workspaceRoot !== undefined
    ? normalizeWorkspaceRoot(input.workspaceRoot, "workspaceRoot")
    : normalizeWorkspaceRoot(adapter.workspaceRoot, "configured workspaceRoot");
  const configuredTools = toolAllowlist(adapter.tools, "adapter tools");
  const requestedTools = toolAllowlist(providerOptions.tools, "tools");
  const tools = constrainToolAllowlist(requestedTools, configuredTools);
  const payloadAccessMode = providerOptions.accessMode;
  if (payloadAccessMode !== undefined && payloadAccessMode !== "read_only" && payloadAccessMode !== "full_access") {
    throw new Error("Pi provider accessMode is invalid");
  }
  if (input.accessMode !== undefined && input.accessMode !== "read_only" && input.accessMode !== "full_access") {
    throw new Error("Pi provider accessMode is invalid");
  }
  if (adapter.accessMode !== undefined && adapter.accessMode !== "read_only" && adapter.accessMode !== "full_access") {
    throw new Error("Pi provider accessMode is invalid");
  }
  // Top-level accessMode and adapter configuration define the authorization
  // ceiling. Payload options may request a downgrade, but can never widen a
  // read-only session.
  const accessModeCeiling: PiAccessMode = input.accessMode === "read_only" || adapter.accessMode === "read_only"
    ? "read_only"
    : input.accessMode === "full_access" || adapter.accessMode === "full_access"
      ? "full_access"
      : "read_only";
  // Payload options may downgrade a full-access host session for this native
  // session, but the top-level policy remains the authorization ceiling.
  const accessMode = (payloadAccessMode as PiAccessMode | undefined)
    ?? input.accessMode
    ?? adapter.accessMode
    ?? "read_only";
  const effectiveSessionId = input.providerSessionId !== undefined ? input.providerSessionId : adapter.sessionId;
  const normalizedSessionId = typeof effectiveSessionId === "string"
    ? effectiveSessionId.trim() || null
    : effectiveSessionId;
  if (normalizedSessionId !== undefined && normalizedSessionId !== null && typeof normalizedSessionId !== "string") {
    throw new Error("Pi provider session id must be a string or null");
  }
  const operation = input.operation
    ?? adapter.operation
    ?? (normalizedSessionId ? "session.resume" : "session.open");
  if (accessMode === "full_access" && accessModeCeiling !== "full_access") {
    throw new Error("Pi provider accessMode cannot widen a read-only session");
  }
  return {
    ...adapter,
    cwd: input.cwd,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    signal: input.signal ?? adapter.signal,
    sessionId: normalizedSessionId,
    operation,
    model: input.model ?? stringOption("model") ?? adapter.model,
    autoRetry: typeof providerOptions.autoRetry === "boolean" ? providerOptions.autoRetry : adapter.autoRetry,
    cancelTimeoutMs: adapter.cancelTimeoutMs,
    accessMode,
    // Session storage is host configuration, not provider-controlled prompt
    // data. In particular, do not let a remote payload redirect Pi to an
    // arbitrary directory containing credentials or another session journal.
    sessionDir: adapter.sessionDir,
    agentDir: adapter.agentDir,
    tools,
    thinkingLevel: stringOption("thinkingLevel") as CreateAgentSessionOptions["thinkingLevel"] | undefined ?? adapter.thinkingLevel,
  };
}

/** Native Pi adapter. The Pi SDK remains local; only normalized events cross the runtime boundary. */
export class PiProviderAdapter implements LocalProviderAdapter {
  readonly provider = PROVIDER;
  readonly version = ADAPTER_VERSION;
  readonly capabilities: LocalRuntimeCapabilities = {
    streaming: true,
    sessionResume: true,
    sessionFork: true,
    sessionCancel: true,
    permissionRequests: false,
    promptImages: true,
    nativeTools: true,
  };

  constructor(private readonly options: PiProviderOptions = {}) {}

  async open(input: LocalRuntimeSessionInput): Promise<LocalRuntimeSessionHandle> {
    const options = optionsForInput(input as ExtendedSessionInput, this.options);
    if (options.operation !== "session.open" && options.operation !== "session.resume" && options.operation !== "session.fork") {
      throw new Error("Pi provider session operation is invalid");
    }
    if (options.autoRetry === true) {
      throw new Error("Pi native auto-retry is unavailable in local runtime until retry reset events are supported");
    }
    const cwd = await validateCwd(options.cwd ?? input.cwd);
    // Keep the fence anchored to an existing directory. Without this check a
    // missing root could canonicalize to its nearest existing parent.
    if (options.workspaceRoot) options.workspaceRoot = await canonicalWorkspaceRoot(options.workspaceRoot);
    if (options.workspaceRoot && !isWithin(options.workspaceRoot, cwd)) {
      throw new Error("Pi provider cwd must stay inside the workspace");
    }
    const manager = await managerFor(cwd, options);
    const runtime = options.modelRuntime ?? await modelRuntime(options.agentDir);
    const requestedModel = options.model?.trim();
    let model = options.modelObject;
    if (!model && requestedModel) {
      const separator = requestedModel.indexOf("/");
      if (separator <= 0 || separator === requestedModel.length - 1) throw new Error(`Pi model must use provider/model format: ${requestedModel}`);
      model = runtime.getModel(requestedModel.slice(0, separator), requestedModel.slice(separator + 1));
      if (!model) throw new Error(`Pi model is not available: ${requestedModel}`);
    }
    const create = options.createAgentSession ?? ((value: CreateAgentSessionOptions) => createAgentSession(value));
    const settingsManager = options.settingsManager
      ? isolatedSettingsManager(options.settingsManager)
      : SettingsManager.create(cwd, options.agentDir);
    // Keep retry behavior deterministic: partial output from a failed native
    // attempt cannot be retracted by the provider-neutral wire protocol.
    settingsManager.applyOverrides({ retry: { enabled: false } });
    // Keep the native registry complete; PiProviderSession applies the
    // per-session access mode immediately after construction.
    const tools = options.tools;
    let result: { session: AgentSession } | undefined;
    try {
      result = await create({
        cwd,
        ...(options.agentDir ? { agentDir: options.agentDir } : {}),
        modelRuntime: runtime,
        sessionManager: manager,
        settingsManager,
        ...(model ? { model } : {}),
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
        ...(tools !== undefined ? { tools } : {}),
      });
      validateNativeSessionIdentity(result.session, options);
      await ensurePersistedSession(manager);
      const managerSessionId = typeof manager.getSessionId === "function"
        ? stringValue(manager.getSessionId())
        : undefined;
      if (managerSessionId && managerSessionId !== result.session.sessionId) {
        throw new Error(`Pi session manager returned session id ${managerSessionId}; native session returned ${result.session.sessionId}`);
      }
    } catch (error) {
      try { result?.session.dispose(); } catch { /* Preserve the original error. */ }
      throw error;
    }
    if (!result) throw new Error("Pi provider did not return a session");
    try {
      return new PiProviderSession(result.session, { ...options, cwd, modelRuntime: runtime });
    } catch (error) {
      try { result.session.dispose(); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }
}

export const piProviderAdapter = new PiProviderAdapter();
