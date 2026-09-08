import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  Codex,
  type ApprovalMode,
  type CodexOptions,
  type Input as CodexInput,
  type ModelReasoningEffort,
  type SandboxMode,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
} from "@openai/codex-sdk";
import type { ContentBlock } from "@cohub/protocol/core";
import type {
  LocalProviderAdapter,
  LocalRuntimeCapabilities,
  LocalRuntimePromptInput,
  LocalRuntimeProviderEvent,
  LocalRuntimeSessionHandle,
  LocalRuntimeSessionInput,
} from "@cohub/protocol";
import {
  assertProviderId,
  boundedProviderId,
  providerEventId,
  providerIdValue,
  MAX_PROVIDER_ID_BYTES,
} from "../provider-identity.js";
import { resolveWorkspacePath } from "./workspace-path.js";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_DELTA_BYTES = 512 * 1024;
const MAX_TOOL_VALUE_BYTES = 256 * 1024;
const MAX_PROVIDER_EVENT_ID_LENGTH = MAX_PROVIDER_ID_BYTES;
const MAX_WARNING_COUNT = 32;
const MAX_WARNING_BYTES = 4 * 1024;
const CLOSE_TIMEOUT_MS = 5_000;
const PROVIDER_VERSION = "@openai/codex-sdk@0.153.4";

type Json = Record<string, unknown>;

type CodexStream = {
  events: AsyncIterable<ThreadEvent>;
};

type CodexThread = {
  readonly id: string | null;
  runStreamed(input: CodexInput, options?: { signal?: AbortSignal; outputSchema?: unknown }): Promise<CodexStream>;
};

type CodexClient = {
  startThread(options?: ThreadOptions): CodexThread;
  resumeThread(id: string, options?: ThreadOptions): CodexThread;
};

export type CodexClientFactory = (options?: CodexOptions) => CodexClient | Promise<CodexClient>;

export type CodexAdapterOptions = {
  codex?: CodexOptions;
  clientFactory?: CodexClientFactory;
  model?: string | null;
  accessMode?: "read_only" | "full_access";
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalMode;
  additionalDirectories?: string[];
  networkAccessEnabled?: boolean;
  modelReasoningEffort?: ModelReasoningEffort;
  webSearchMode?: ThreadOptions["webSearchMode"];
  webSearchEnabled?: boolean;
  skipGitRepoCheck?: boolean;
  threadSource?: string;
  turnIdFactory?: () => string;
};

type ExtendedSessionInput = LocalRuntimeSessionInput & {
  model?: string | null;
  accessMode?: "read_only" | "full_access";
  payload?: Record<string, unknown>;
};

type Snapshot = {
  text?: string;
  name?: string;
  input?: Json;
  output?: string;
  status?: string;
  isError?: boolean;
  completed?: boolean;
};

type AnonymousItem = {
  id: string;
  type: string;
  key: string;
  completed: boolean;
  lastSeen: number;
};

export type CodexEventContext = {
  sessionId: string;
  turnId: string;
  finalText: string;
  snapshots: Map<string, Snapshot>;
  usage: Json | null;
  warnings: string[];
  /**
   * Codex currently always sends item ids, but older bridges and test doubles
   * may omit them. Keep a deterministic, turn-local identity for those items
   * so started/updated/completed frames still share one tool block.
   */
  anonymousItems: AnonymousItem[];
  anonymousItemCounters: Map<string, number>;
  anonymousItemClock: number;
};

export function createCodexEventContext(sessionId: string, turnId: string): CodexEventContext {
  return {
    sessionId: boundedProviderId(sessionId) || "",
    turnId: boundedProviderId(turnId) || "",
    finalText: "",
    snapshots: new Map(),
    usage: null,
    warnings: [],
    anonymousItems: [],
    anonymousItemCounters: new Map(),
    anonymousItemClock: 0,
  };
}

const asRecord = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function valueFingerprint(value: unknown): string {
  let serialized = "";
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    serialized = String(value);
  }
  return createHash("sha256").update(serialized, "utf8").digest("hex").slice(0, 16);
}

function boundedIdentifier(value: unknown, fallback: string): string {
  return boundedProviderId(value, fallback) || fallback;
}

const boundedText = (value: unknown, limit = MAX_TEXT_BYTES): string => {
  if (typeof value !== "string") return "";
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  return Buffer.from(value, "utf8").subarray(0, limit).toString("utf8").replace(/[\uFFFD]$/, "");
};

function boundedJson(value: unknown, limit = MAX_TOOL_VALUE_BYTES): unknown {
  if (typeof value === "string") return boundedText(value, limit);
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized, "utf8") > limit) return { truncated: true };
    return value;
  } catch {
    return { unavailable: true };
  }
}

function event(
  context: CodexEventContext,
  kind: LocalRuntimeProviderEvent["kind"],
  payload: Json,
  providerEventIdInput?: string,
): LocalRuntimeProviderEvent {
  // Hash oversized composite ids instead of truncating them: native ids can
  // already be at the protocol limit before a lifecycle prefix is added.
  const id = providerEventId(providerEventIdInput);
  return {
    kind,
    ...(id ? { providerEventId: id } : {}),
    payload: {
      nativeTurnId: boundedProviderId(context.turnId) || null,
      nativeSessionId: boundedProviderId(context.sessionId) || null,
      ...payload,
    },
  };
}

function suffixDelta(previous: string, next: string): string {
  if (!next) return "";
  if (!previous) return next;
  if (next.startsWith(previous)) return next.slice(previous.length);
  let common = 0;
  const max = Math.min(previous.length, next.length);
  while (common < max && previous[common] === next[common]) common += 1;
  return next.slice(common);
}

function splitDelta(value: string, maxBytes = MAX_DELTA_BYTES): string[] {
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

function anonymousItemKey(item: Json, type: string): string {
  // Prefer fields that remain constant while an item streams. Text/output and
  // status are deliberately excluded because they change on every update.
  let identity: unknown;
  switch (type) {
    case "command_execution":
      identity = { command: item.command };
      break;
    case "mcp_tool_call":
      identity = { server: item.server, tool: item.tool, arguments: item.arguments };
      break;
    case "web_search":
      identity = { query: item.query };
      break;
    case "file_change":
      identity = { changes: item.changes };
      break;
    case "todo_list":
      // Todo snapshots are mutable; the active-item fallback below handles
      // their updates while this key gives a useful discriminator at start.
      identity = { items: item.items };
      break;
    default:
      identity = null;
      break;
  }
  return `${type}:${valueFingerprint(identity)}`;
}

function itemId(
  item: ThreadItem,
  context: CodexEventContext,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): string {
  const raw = asRecord(item);
  const native = stringValue(raw.id);
  if (native) return boundedIdentifier(native, `item-${context.turnId}`);

  const type = itemType(item);
  const key = anonymousItemKey(raw, type);
  const touch = () => { context.anonymousItemClock += 1; return context.anonymousItemClock; };
  let match: AnonymousItem | undefined;
  if (lifecycle === "item.started") {
    // A new started frame denotes a new occurrence, even when two commands
    // happen to have identical inputs in one turn.
    match = undefined;
  } else {
    match = context.anonymousItems
      .filter((candidate) => candidate.type === type && !candidate.completed && candidate.key === key)
      .sort((left, right) => right.lastSeen - left.lastSeen)[0]
      // Some mutable item types (notably todo_list) have no stable key. Use
      // the most recently active item of that type as a conservative fallback.
      ?? context.anonymousItems
        .filter((candidate) => candidate.type === type && !candidate.completed)
        .sort((left, right) => right.lastSeen - left.lastSeen)[0]
      // If an SDK emits a late update after completion, preserve the prior id
      // instead of creating a duplicate block.
      ?? context.anonymousItems
        .filter((candidate) => candidate.type === type && candidate.key === key)
        .sort((left, right) => right.lastSeen - left.lastSeen)[0];
  }
  if (!match) {
    const ordinal = (context.anonymousItemCounters.get(type) ?? 0) + 1;
    context.anonymousItemCounters.set(type, ordinal);
    const id = providerEventId("anonymous", context.turnId, type, ordinal)
      || `anonymous-${type}-${ordinal}`;
    match = { id, type, key, completed: false, lastSeen: 0 };
    context.anonymousItems.push(match);
  }
  match.lastSeen = touch();
  if (lifecycle === "item.completed") match.completed = true;
  return match.id;
}

function itemType(item: ThreadItem): string {
  return boundedText(stringValue(asRecord(item).type) || "unknown", MAX_PROVIDER_EVENT_ID_LENGTH);
}

function itemName(item: Json): string {
  switch (item.type) {
    case "command_execution":
    case "file_change":
    case "web_search":
    case "todo_list":
      return item.type;
    case "mcp_tool_call":
      return boundedText(stringValue(item.tool) || "mcp_tool_call", MAX_PROVIDER_EVENT_ID_LENGTH);
    default:
      return boundedText(stringValue(item.type) || "tool", MAX_PROVIDER_EVENT_ID_LENGTH);
  }
}

function itemInput(item: Json): Json {
  switch (item.type) {
    case "command_execution":
      return { command: boundedText(item.command, 64 * 1024) };
    case "file_change":
      return { changes: boundedJson(item.changes) };
    case "mcp_tool_call":
      return {
        server: boundedText(stringValue(item.server) || "", MAX_PROVIDER_EVENT_ID_LENGTH),
        tool: boundedText(stringValue(item.tool) || "", MAX_PROVIDER_EVENT_ID_LENGTH),
        arguments: boundedJson(item.arguments),
      };
    case "web_search":
      return { query: boundedText(item.query, 64 * 1024) };
    case "todo_list":
      return { items: boundedJson(item.items) };
    default: {
      const { id: _id, type: _type, ...details } = item;
      const bounded = boundedJson(details);
      return bounded && typeof bounded === "object" && !Array.isArray(bounded)
        ? bounded as Json
        : { value: bounded };
    }
  }
}

function itemOutput(item: Json): string {
  for (const key of ["aggregated_output", "output", "result"]) {
    if (typeof item[key] === "string") return boundedText(item[key], MAX_TOOL_VALUE_BYTES);
  }
  const result = asRecord(item.result);
  if (result.content !== undefined) {
    if (typeof result.content === "string") return boundedText(result.content, MAX_TOOL_VALUE_BYTES);
    try {
      return boundedText(JSON.stringify(result.content) || "", MAX_TOOL_VALUE_BYTES);
    } catch {
      return "";
    }
  }
  const error = asRecord(item.error);
  return boundedText(error.message, MAX_TOOL_VALUE_BYTES);
}

function itemStatus(item: Json): string | undefined {
  const status = stringValue(item.status);
  return status ? boundedText(status, MAX_PROVIDER_EVENT_ID_LENGTH) : undefined;
}

function toolEvents(
  item: ThreadItem,
  context: CodexEventContext,
  sourceType: string,
  completed: boolean,
  resolvedId?: string,
): LocalRuntimeProviderEvent[] {
  const raw = asRecord(item);
  const lifecycle = sourceType === "item.completed"
    ? "item.completed"
    : sourceType === "item.updated"
      ? "item.updated"
      : "item.started";
  // Resolve an anonymous item once per native frame. Calling itemId twice for
  // the same frame advances the anonymous ordinal and splits one tool's
  // started/updated/completed lifecycle across different ids.
  const id = resolvedId ?? itemId(item, context, lifecycle);
  const name = itemName(raw);
  const input = itemInput(raw);
  const output = itemOutput(raw);
  const status = itemStatus(raw);
  const normalizedStatus = status?.toLowerCase();
  const isError = normalizedStatus === "failed"
    || normalizedStatus === "declined"
    || normalizedStatus === "error"
    || normalizedStatus === "cancelled"
    || normalizedStatus === "canceled"
    || (typeof raw.exit_code === "number" && raw.exit_code !== 0);
  const previous = context.snapshots.get(id);
  const changed = !previous
    || previous.name !== name
    || JSON.stringify(previous.input) !== JSON.stringify(input)
    || previous.output !== output
    || previous.status !== status;
  const metadata = { sourceType, itemType: itemType(item) };
  const revision = valueFingerprint({ name, input, output, status, isError, sourceType, completed });
  const result: LocalRuntimeProviderEvent[] = [];
  if (!previous) {
    result.push(event(context, "tool.started", { id, name, input, metadata }, providerEventId(id, "tool", sourceType, "started", revision)));
  }
  if (!completed && previous && changed) {
    result.push(event(context, "tool.updated", {
      id,
      name,
      input,
      ...(output ? { output } : {}),
      ...(status ? { status } : {}),
      ...(isError ? { isError: true } : {}),
      metadata,
    }, providerEventId(id, "tool", sourceType, "updated", revision)));
  }
  if (completed && !previous?.completed) {
    result.push(event(context, "tool.completed", {
      id,
      name,
      input,
      ...(output ? { output } : {}),
      ...(status ? { status } : {}),
      isError,
      metadata,
    }, providerEventId(id, "tool", sourceType, "completed", revision)));
  }
  context.snapshots.set(id, { name, input, output, status, isError, completed: completed || previous?.completed === true });
  return result;
}

function mapUsage(value: unknown): Json | null {
  const raw = asRecord(value);
  const input = nonNegativeInteger(raw.input_tokens);
  const output = nonNegativeInteger(raw.output_tokens);
  const cacheRead = nonNegativeInteger(raw.cached_input_tokens);
  const cacheWrite = nonNegativeInteger(raw.cache_write_input_tokens);
  const reasoning = nonNegativeInteger(raw.reasoning_output_tokens);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined && reasoning === undefined) return null;
  const values = [input, output, cacheRead, cacheWrite].filter((entry): entry is number => entry !== undefined);
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(values.length ? { totalTokens: values.reduce((sum, value) => sum + value, 0) } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

function warningMetadata(context: CodexEventContext, sourceType: string): Json {
  return {
    sourceType,
    ...(context.warnings.length ? { warnings: [...context.warnings] } : {}),
  };
}

function rememberWarning(context: CodexEventContext, value: unknown): void {
  const message = boundedText(value, MAX_WARNING_BYTES);
  if (!message || context.warnings.includes(message) || context.warnings.length >= MAX_WARNING_COUNT) return;
  context.warnings.push(message);
}

function isTransientStreamError(message: string): boolean {
  return /^Reconnecting\.\.\. (?:waiting for network|\d+\/\d+)$/.test(message);
}

/** Convert one native Codex SDK event into provider-neutral runtime events. */
export function mapCodexEvent(eventValue: ThreadEvent, context: CodexEventContext): LocalRuntimeProviderEvent[] {
  const raw = asRecord(eventValue);
  const type = stringValue(raw.type) || "unknown";
  if (type === "thread.started") {
    const threadId = providerIdValue(raw.thread_id);
    if (!threadId) return [];
    context.sessionId = threadId;
    return [event(context, "session.ready", {
      providerSessionId: threadId,
      metadata: { sourceType: type },
    }, `thread:${threadId}`)];
  }
  if (type === "turn.started") {
    return [event(context, "turn.started", { metadata: { sourceType: type } }, `${context.turnId}:started`)];
  }
  if (type === "turn.completed") {
    const usage = mapUsage(raw.usage);
    const result: LocalRuntimeProviderEvent[] = [];
    if (usage && JSON.stringify(usage) !== JSON.stringify(context.usage)) {
      context.usage = usage;
      result.push(event(context, "usage", { usage, metadata: { sourceType: type } }, `${context.turnId}:usage`));
    }
    result.push(event(context, "turn.completed", {
      status: "turn_completed",
      stopReason: boundedText(stringValue(raw.stop_reason) || "end_turn", MAX_PROVIDER_EVENT_ID_LENGTH),
      ...(usage ? { usage } : {}),
      ...(context.finalText ? { output: boundedText(context.finalText, MAX_DELTA_BYTES) } : {}),
      metadata: warningMetadata(context, type),
    }, `${context.turnId}:completed`));
    return result;
  }
  if (type === "error") {
    const error = asRecord(raw.error);
    const message = boundedText(stringValue(error.message) || stringValue(raw.message) || "Codex stream failed", MAX_TOOL_VALUE_BYTES);
    if (isTransientStreamError(message)) {
      rememberWarning(context, message);
      return [];
    }
    return [event(context, "turn.failed", {
      status: "turn_failed",
      message,
      code: "provider_stream_error",
      unknownOutcome: true,
      retryable: false,
      metadata: warningMetadata(context, type),
    }, providerEventId(context.turnId, "stream-error", valueFingerprint(message)))];
  }
  if (type === "turn.failed") {
    const error = asRecord(raw.error);
    const message = stringValue(error.message) || stringValue(raw.message) || "Codex turn failed";
    return [event(context, "turn.failed", {
      status: "turn_failed",
      message: boundedText(message, MAX_TOOL_VALUE_BYTES),
      code: "provider_error",
      unknownOutcome: false,
      retryable: false,
      metadata: warningMetadata(context, type),
    }, `${context.turnId}:failed` )];
  }
  if (type !== "item.started" && type !== "item.updated" && type !== "item.completed") return [];
  const item = raw.item as ThreadItem | undefined;
  if (!item || typeof item !== "object") return [];
  const itemRaw = asRecord(item);
  const id = itemId(item, context, type as "item.started" | "item.updated" | "item.completed");
  const kind = itemType(item);
  const completed = type === "item.completed";
  const metadata = { sourceType: type, itemType: kind };
  if (kind === "agent_message" || kind === "reasoning") {
    const text = boundedText(itemRaw.text);
    const previous = context.snapshots.get(id)?.text || "";
    const next = suffixDelta(previous, text);
    context.snapshots.set(id, { text });
    if (kind === "agent_message") {
      context.finalText = boundedText(context.finalText + next);
    }
    if (!next) return [];
    const chunks = splitDelta(next);
    return chunks.map((chunk, index) => event(context, kind === "agent_message" ? "text.delta" : "thinking.delta", {
      text: chunk,
      itemId: id,
      metadata,
    }, providerEventId(id, type, valueFingerprint(text), index)));
  }
  if (["command_execution", "file_change", "mcp_tool_call", "web_search", "todo_list"].includes(kind)) {
    return toolEvents(item, context, type, completed, id);
  }
  if (kind === "error") {
    rememberWarning(context, stringValue(itemRaw.message) || "Codex item warning");
    return [];
  }
  if (kind !== "agent_message" && kind !== "reasoning") {
    return toolEvents(item, context, type, completed, id);
  }
  return [];
}

function strictBase64(value: string): Buffer {
  const normalized = value.replace(/\s/g, "");
  const maxEncodedLength = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
  if (!normalized || normalized.length > maxEncodedLength || normalized.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/i.test(normalized)) {
    throw new Error("Codex image content is not valid base64");
  }
  const data = Buffer.from(normalized, "base64");
  if (data.byteLength > MAX_IMAGE_BYTES) throw new Error("Codex image content exceeds the size limit");
  // Node's decoder accepts non-zero trailing bits (for example `AB==`), so
  // compare against the canonical encoding before handing bytes to the CLI.
  const canonical = data.toString("base64");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  if (canonical !== padded) throw new Error("Codex image content is not valid base64");
  return data;
}

function imageExtension(mediaType: string): string {
  const extension = mediaType.split("/", 2)[1]?.replace(/[^a-z0-9]/gi, "").slice(0, 8);
  return extension || "bin";
}

function imageMediaType(value: string): string {
  const normalized = value.trim();
  if (!normalized.toLowerCase().startsWith("image/")) {
    throw new Error("Codex image content MIME type must be an image");
  }
  return normalized;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  const error = new Error(typeof reason === "string" && reason.trim() ? reason : "Codex turn aborted");
  error.name = "AbortError";
  throw error;
}

async function writeTemporaryImage(
  data: string,
  mediaType: string,
  directories: string[],
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const normalizedMediaType = imageMediaType(mediaType);
  const directory = await mkdtemp(join(tmpdir(), "cohub-codex-image-"));
  directories.push(directory);
  throwIfAborted(signal);
  const path = join(directory, `image.${imageExtension(normalizedMediaType)}`);
  await writeFile(path, strictBase64(data), { mode: 0o600, flag: "wx" });
  throwIfAborted(signal);
  return path;
}

function isWithinDirectory(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function authorizedImagePath(
  value: string,
  cwd: string,
  workspaceRoot = cwd,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const candidate = resolveWorkspacePath(value, cwd, workspaceRoot);
  const [workspace, image] = await Promise.all([realpath(workspaceRoot), realpath(candidate)]);
  throwIfAborted(signal);
  if (!isWithinDirectory(workspace, image)) throw new Error("Codex image path is outside the authorized workspace");
  const details = await stat(image);
  if (!details.isFile()) throw new Error("Codex image path must be a regular file");
  if (details.size > MAX_IMAGE_BYTES) throw new Error("Codex image content exceeds the size limit");
  return image;
}

async function imagePathFromValue(
  value: unknown,
  directories: string[],
  cwd: string,
  workspaceRoot = cwd,
  signal?: AbortSignal,
): Promise<string | null> {
  throwIfAborted(signal);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const dataUrl = /^data:([^;,]+);base64,(.*)$/is.exec(trimmed);
    if (dataUrl) return writeTemporaryImage(dataUrl[2] || "", dataUrl[1] || "", directories, signal);
    if (/^https?:\/\//i.test(trimmed)) throw new Error("Codex local provider does not support URL images");
    return authorizedImagePath(trimmed, cwd, workspaceRoot, signal);
  }
  if (!value || typeof value !== "object") return null;
  const image = value as Json;
  if (image.type === "url" || typeof image.url === "string") {
    throw new Error("Codex local provider does not support URL images");
  }
  const data = stringValue(image.data);
  const mediaType = stringValue(image.mimeType) || stringValue(image.media_type) || "application/octet-stream";
  if (data) return writeTemporaryImage(data, mediaType, directories, signal);
  const path = stringValue(image.path);
  return path ? authorizedImagePath(path, cwd, workspaceRoot, signal) : null;
}

async function preparePrompt(
  input: LocalRuntimePromptInput,
  cwd: string,
  workspaceRoot = cwd,
  signal?: AbortSignal,
): Promise<{ input: CodexInput; cleanup: () => Promise<void> }> {
  const directories: string[] = [];
  try {
    throwIfAborted(signal);
    if (input.text !== undefined && typeof input.text !== "string") {
      throw new Error("Codex prompt text must be a string");
    }
    if (input.content !== undefined && !Array.isArray(input.content)) {
      throw new Error("Codex prompt content must be an array");
    }
    const content = input.content ?? [];
    const textParts = content.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Codex prompt content block is malformed");
      }
      const block = value as ContentBlock;
      if (block.type === "text") {
        if (typeof block.text !== "string") throw new Error("Codex text content block is malformed");
        return [block.text];
      }
      if (block.type === "thinking") {
        if (typeof block.thinking !== "string") throw new Error("Codex thinking content block is malformed");
        return [block.thinking];
      }
      if (block.type === "shell_command") {
        if (typeof block.command !== "string" && typeof block.rawText !== "string") throw new Error("Codex shell command content block is malformed");
        return [block.rawText || block.command];
      }
      if (block.type === "system_note") {
        if (typeof block.text !== "string") throw new Error("Codex system note content block is malformed");
        return [block.text];
      }
      if (block.type === "image") return [];
      throw new Error(`Codex prompt content block type is unsupported: ${String((block as Json).type || "unknown")}`);
    });
    const contentText = textParts.join("\n\n");
    const text = input.text && contentText && input.text !== contentText
      ? `${input.text}\n\n${contentText}`
      : input.text || contentText;
    if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) throw new Error("Codex prompt exceeds the text size limit");
    const values: Array<{ type: "text"; text: string } | { type: "local_image"; path: string }> = [];
    if (text) values.push({ type: "text", text });
    for (const value of content) {
      throwIfAborted(signal);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Codex prompt content block is malformed");
      }
      const block = value as ContentBlock;
      if (block.type !== "image") continue;
      if (!block.source || typeof block.source !== "object" || Array.isArray(block.source)) {
        throw new Error("Codex image content block is malformed");
      }
      if (block.source.type === "url") throw new Error("Codex local provider does not support URL images");
      if (block.source.type !== "base64" || typeof block.source.data !== "string" || typeof block.source.media_type !== "string") {
        throw new Error("Codex image content block is malformed");
      }
      values.push({ type: "local_image", path: await writeTemporaryImage(block.source.data, block.source.media_type, directories, signal) });
    }
    if (input.options !== undefined && (!input.options || typeof input.options !== "object" || Array.isArray(input.options))) {
      throw new Error("Codex prompt options must be an object");
    }
    const optionImages = (input.options as Record<string, unknown> | undefined)?.images;
    if (optionImages !== undefined && !Array.isArray(optionImages)) {
      throw new Error("Codex prompt images must be an array");
    }
    if (Array.isArray(optionImages)) {
      for (const value of optionImages) {
        throwIfAborted(signal);
        const path = await imagePathFromValue(value, directories, cwd, workspaceRoot, signal);
        if (!path) throw new Error("Codex image content is malformed");
        values.push({ type: "local_image", path });
      }
    }
    return {
      input: values.length ? values : "",
      cleanup: async () => {
        await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
      },
    };
  } catch (error) {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
    throw error;
  }
}

function payloadRecord(input: ExtendedSessionInput): Record<string, unknown> {
  return input.payload && typeof input.payload === "object" ? input.payload : {};
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Codex forwards a resumed thread id as a single CLI argument. Keep malformed
 * ids out of the SDK boundary so an untrusted runtime command cannot make the
 * native CLI parse control characters or an unbounded argument.
 */
function validateProviderSessionId(value: string): string {
  return assertProviderId(value, "Codex provider session id");
}

const CODEX_WEB_SEARCH_MODES: ReadonlySet<NonNullable<ThreadOptions["webSearchMode"]>> = new Set([
  "disabled",
  "cached",
  "live",
]);

const CODEX_REASONING_EFFORTS: ReadonlySet<ModelReasoningEffort> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
]);

function booleanOption(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Codex provider ${name} must be a boolean`);
  return value;
}

function webSearchModeOption(value: unknown): ThreadOptions["webSearchMode"] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !CODEX_WEB_SEARCH_MODES.has(value as NonNullable<ThreadOptions["webSearchMode"]>)) {
    throw new Error("Codex provider webSearchMode is invalid");
  }
  return value as ThreadOptions["webSearchMode"];
}

function modelReasoningEffortOption(value: unknown): ModelReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !CODEX_REASONING_EFFORTS.has(value.trim() as ModelReasoningEffort)) {
    throw new Error("Codex provider modelReasoningEffort is invalid");
  }
  return value.trim() as ModelReasoningEffort;
}

function threadOptions(config: CodexAdapterOptions, input: ExtendedSessionInput): ThreadOptions {
  const payload = payloadRecord(input);
  const accessMode = input.accessMode ?? config.accessMode ?? "read_only";
  if (accessMode !== "read_only" && accessMode !== "full_access") {
    throw new Error("Codex provider accessMode is invalid");
  }
  const model = stringOption(input.model) || stringOption(config.model) || stringOption(payload.model);
  // Access mode is a server-authorized boundary. Do not let provider payloads
  // (or a stale local config) widen it to danger-full-access or solicit an
  // approval interaction that this protocol cannot service.
  const sandboxMode: SandboxMode = accessMode === "full_access" ? "workspace-write" : "read-only";
  const approvalPolicy: ApprovalMode = "never";
  const modelReasoningEffort = modelReasoningEffortOption(payload.modelReasoningEffort)
    ?? modelReasoningEffortOption(config.modelReasoningEffort);
  // Directory expansion is host policy, not prompt data. Ignore a remote
  // payload's `additionalDirectories`; the adapter validates the configured
  // list against the bound workspace before handing it to Codex.
  const additionalDirectories = config.additionalDirectories
    ?.map((value) => resolve(input.cwd, value));
  const requestedNetworkAccess = booleanOption(payload.networkAccessEnabled, "networkAccessEnabled");
  const configuredNetworkAccess = booleanOption(config.networkAccessEnabled, "networkAccessEnabled");
  const requestedWebSearchMode = webSearchModeOption(payload.webSearchMode);
  const configuredWebSearchMode = webSearchModeOption(config.webSearchMode);
  const requestedWebSearchEnabled = booleanOption(payload.webSearchEnabled, "webSearchEnabled");
  const configuredWebSearchEnabled = booleanOption(config.webSearchEnabled, "webSearchEnabled");
  // Read-only sessions must not gain an outbound network or live-search path
  // through provider options. Explicitly pass the disabled values so a local
  // Codex config cannot re-enable them behind the SDK's defaults.
  const networkAccessEnabled = accessMode === "read_only"
    ? false
    : requestedNetworkAccess ?? configuredNetworkAccess;
  const webSearchMode = accessMode === "read_only"
    ? "disabled"
    : requestedWebSearchMode ?? configuredWebSearchMode;
  const webSearchEnabled = accessMode === "read_only"
    ? false
    : requestedWebSearchEnabled ?? configuredWebSearchEnabled;
  // Replicas intentionally omit `.git`; the local runtime already fences the
  // physical workspace, so Codex's repository preflight must not reject a
  // valid snapshot by default. Callers can opt back into the check.
  const skipGitRepoCheck = typeof payload.skipGitRepoCheck === "boolean"
    ? payload.skipGitRepoCheck
    : config.skipGitRepoCheck ?? true;
  const threadSource = stringOption(payload.threadSource) || stringOption(config.threadSource);
  return {
    ...(model ? { model } : {}),
    workingDirectory: input.cwd,
    sandboxMode,
    approvalPolicy,
    ...(additionalDirectories?.length ? { additionalDirectories } : {}),
    ...(networkAccessEnabled !== undefined ? { networkAccessEnabled } : {}),
    ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
    ...(webSearchMode ? { webSearchMode } : {}),
    ...(webSearchEnabled !== undefined ? { webSearchEnabled } : {}),
    ...(skipGitRepoCheck !== undefined ? { skipGitRepoCheck } : {}),
    ...(threadSource ? { threadSource } : {}),
  };
}

function failureEvent(
  context: CodexEventContext,
  error: unknown,
  aborted = false,
  unknownOutcome = !aborted,
): LocalRuntimeProviderEvent {
  const message = boundedText(error instanceof Error ? error.message : String(error), MAX_TOOL_VALUE_BYTES) || "Codex turn failed";
  return event(context, "turn.failed", {
    status: "turn_failed",
    message,
    code: aborted ? "cancelled" : "provider_error",
    unknownOutcome,
    retryable: false,
    ...(aborted ? { aborted: true } : {}),
    metadata: warningMetadata(context, "local"),
  }, `${context.turnId}:failed`);
}

/** Keep shutdown bounded when the native CLI does not acknowledge abort. */
function raceTimeout<T>(promise: Promise<T>, timeoutMs = CLOSE_TIMEOUT_MS): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => settle(() => rejectPromise(new Error("Codex provider shutdown timed out"))), timeoutMs);
    timer.unref?.();
    void promise.then(
      (value) => settle(() => resolvePromise(value)),
      (error) => settle(() => rejectPromise(error)),
    );
  });
}

class CodexRuntimeSession implements LocalRuntimeSessionHandle {
  private readonly thread: CodexThread;
  private readonly cwd: string;
  private readonly workspaceRoot: string;
  private readonly turnIdFactory: () => string;
  private readonly defaultSignal?: AbortSignal;
  private activeController: AbortController | null = null;
  private activeRunDone: Promise<void> | null = null;
  private closed = false;

  constructor(
    thread: CodexThread,
    cwd: string,
    workspaceRoot: string,
    turnIdFactory: () => string,
    defaultSignal?: AbortSignal,
  ) {
    this.thread = thread;
    this.cwd = cwd;
    this.workspaceRoot = workspaceRoot;
    this.turnIdFactory = turnIdFactory;
    this.defaultSignal = defaultSignal;
  }

  /** Native Codex assigns a new thread id after `thread.started`. */
  get providerSessionId(): string {
    return this.thread.id || "";
  }

  async *run(input: LocalRuntimePromptInput, signal?: AbortSignal): AsyncIterable<LocalRuntimeProviderEvent> {
    if (this.closed) throw new Error("Codex provider session is closed");
    if (this.activeController) throw new Error("Codex provider session already has an active turn");
    const controller = new AbortController();
    const signals = [signal, this.defaultSignal].filter(
      (candidate, index, values): candidate is AbortSignal => Boolean(candidate) && values.indexOf(candidate) === index,
    );
    const abortListeners = signals.map((source) => {
      const onAbort = () => {
        if (!controller.signal.aborted) controller.abort(source.reason);
      };
      if (source.aborted) onAbort();
      else source.addEventListener("abort", onAbort, { once: true });
      return { source, onAbort };
    });
    this.activeController = controller;
    let resolveRunDone!: () => void;
    const runDone = new Promise<void>((resolve) => { resolveRunDone = resolve; });
    this.activeRunDone = runDone;
    const initialThreadId = providerIdValue(this.thread.id) || undefined;
    const context = createCodexEventContext(initialThreadId || "", this.turnIdFactory());
    let terminal = false;
    let streamStarted = false;
    // The SDK deliberately leaves a newly-created thread id null until it
    // yields `thread.started`. Do not let a malformed/partial stream commit a
    // turn under the runner's provisional id; without the native id the turn
    // cannot be resumed or safely deduplicated after a disconnect.
    const requiresThreadStarted = !initialThreadId;
    let sawThreadStarted = !requiresThreadStarted;
    let prepared: { input: CodexInput; cleanup: () => Promise<void> } | null = null;
    try {
      yield event(context, "turn.started", { metadata: { sourceType: "local" } }, `${context.turnId}:started`);
      prepared = await preparePrompt(input, this.cwd, this.workspaceRoot, controller.signal);
      const options = input.options as Record<string, unknown> | undefined;
      const stream = await this.thread.runStreamed(prepared.input, {
        signal: controller.signal,
        ...(options?.outputSchema ? { outputSchema: options.outputSchema } : {}),
      });
      streamStarted = true;
      outer: for await (const nativeEvent of stream.events) {
    if (nativeEvent.type === "thread.started") {
          const threadId = providerIdValue(nativeEvent.thread_id);
          if (!threadId) {
            terminal = true;
            yield failureEvent(
              context,
              new Error("Codex provider stream returned an invalid thread.started event"),
              false,
              true,
            );
            break;
          }
          if ((initialThreadId && threadId !== initialThreadId)
            || (sawThreadStarted && context.sessionId && threadId !== context.sessionId)) {
            terminal = true;
            yield failureEvent(
              context,
              new Error("Codex provider stream returned a different thread id"),
              false,
              true,
            );
            break;
          }
          sawThreadStarted = true;
        } else if (requiresThreadStarted && !sawThreadStarted) {
          terminal = true;
          yield failureEvent(
            context,
            new Error("Codex provider stream did not begin with thread.started"),
            false,
            true,
          );
          break;
        }
        for (const output of mapCodexEvent(nativeEvent, context)) {
          if (output.kind === "turn.completed" || output.kind === "turn.failed") terminal = true;
          yield output;
          if (terminal) break outer;
        }
      }
      if (!terminal && requiresThreadStarted && !sawThreadStarted) {
        terminal = true;
        yield failureEvent(
          context,
          new Error("Codex provider stream ended without thread.started"),
          false,
          true,
        );
      }
      if (!terminal) {
        terminal = true;
        yield failureEvent(context, new Error("Codex provider stream ended before a result"));
      }
    } catch (error) {
      if (!terminal) {
        terminal = true;
        const aborted = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
        yield failureEvent(context, error, aborted, streamStarted && !aborted);
      }
    } finally {
      // A consumer may stop after an intermediate event. Abort the native
      // turn before releasing the active slot so the Codex CLI cannot keep
      // running (and mutating the workspace) after the wire iterator closes.
      if (!terminal && !controller.signal.aborted) {
        controller.abort(new Error("Codex turn iterator closed"));
      }
      for (const { source, onAbort } of abortListeners) source.removeEventListener("abort", onAbort);
      await prepared?.cleanup().catch(() => undefined);
      if (this.activeController === controller) this.activeController = null;
      if (this.activeRunDone === runDone) this.activeRunDone = null;
      resolveRunDone();
    }
  }

  async cancel(reason = "Codex turn cancelled"): Promise<void> {
    this.activeController?.abort(new Error(reason));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.cancel("Codex provider session closed");
    const activeRun = this.activeRunDone;
    if (activeRun) await raceTimeout(activeRun).catch(() => undefined);
  }
}

const runtimeCapabilities: LocalRuntimeCapabilities = {
  streaming: true,
  sessionResume: true,
  sessionFork: false,
  sessionCancel: true,
  permissionRequests: false,
  promptImages: true,
  nativeTools: true,
};

/** Native Codex adapter. Only normalized runtime events cross the wire. */
export class CodexAdapter implements LocalProviderAdapter {
  readonly provider = "codex" as const;
  readonly version = PROVIDER_VERSION;
  readonly capabilities = runtimeCapabilities;

  private readonly options: CodexAdapterOptions;

  constructor(options: CodexAdapterOptions | CodexClientFactory = {}) {
    this.options = typeof options === "function" ? { clientFactory: options } : options;
  }

  async open(input: LocalRuntimeSessionInput): Promise<LocalRuntimeSessionHandle> {
    const extended = input as ExtendedSessionInput;
    const cwd = extended.cwd?.trim();
    if (!cwd) throw new Error("Codex provider cwd is required");
    if (!isAbsolute(cwd)) throw new Error("Codex provider cwd must be absolute");
    const workspaceRootValue = typeof extended.workspaceRoot === "string"
      ? extended.workspaceRoot.trim()
      : "";
    if (extended.workspaceRoot !== undefined && (!workspaceRootValue || !isAbsolute(workspaceRootValue))) {
      throw new Error("Codex provider workspaceRoot must be an absolute path");
    }
    const workspaceRoot = resolve(workspaceRootValue || cwd);
    if (workspaceRootValue) {
      let canonicalWorkspace: string;
      let canonicalCwd: string;
      try {
        [canonicalWorkspace, canonicalCwd] = await Promise.all([realpath(workspaceRoot), realpath(cwd)]);
      } catch {
        throw new Error("Codex provider workspace root is unavailable");
      }
      if (!isWithinDirectory(canonicalWorkspace, canonicalCwd)) {
        throw new Error("Codex provider cwd must stay inside the workspace");
      }
    }
    const normalizedInput = { ...extended, cwd, workspaceRoot };
    const requestedSessionId = input.providerSessionId
      ? validateProviderSessionId(input.providerSessionId)
      : null;
    const operation = input.operation ?? (requestedSessionId ? "session.resume" : "session.open");
    if (operation !== "session.open" && operation !== "session.resume") {
      if (operation === "session.fork") throw new Error("Codex provider does not support session fork");
      throw new Error("Codex provider session operation is invalid");
    }
    if (operation === "session.open" && requestedSessionId) {
      throw new Error("Codex provider session.open must not include a providerSessionId");
    }
    if (operation === "session.resume" && !requestedSessionId) {
      throw new Error("Codex provider session.resume requires a providerSessionId");
    }
    const options = threadOptions(this.options, normalizedInput);
    if (options.additionalDirectories?.length) {
      const workspace = await realpath(workspaceRoot);
      const canonicalDirectories: string[] = [];
      for (const directory of options.additionalDirectories) {
        const canonical = await realpath(directory);
        if (!(await stat(canonical)).isDirectory() || !isWithinDirectory(workspace, canonical)) {
          throw new Error("Codex provider additionalDirectories must stay inside the authorized workspace");
        }
        canonicalDirectories.push(canonical);
      }
      Object.assign(options, { additionalDirectories: canonicalDirectories });
    }
    const client = await (this.options.clientFactory || ((options?: CodexOptions) => new Codex(options) as unknown as CodexClient))(this.options.codex);
    const thread = requestedSessionId
      ? client.resumeThread(requestedSessionId, options)
      : client.startThread(options);
    if (!thread || typeof thread.runStreamed !== "function") throw new Error("Codex SDK returned an invalid thread");
    if (thread.id !== null && thread.id !== undefined) {
      const nativeThreadId = validateProviderSessionId(thread.id);
      if (nativeThreadId !== thread.id) {
        throw new Error("Codex SDK returned an invalid provider session id");
      }
    }
    if (requestedSessionId && thread.id !== requestedSessionId) {
      throw new Error("Codex SDK returned a different provider session id");
    }
    return new CodexRuntimeSession(thread, cwd, workspaceRoot, this.options.turnIdFactory || randomUUID, input.signal);
  }
}

export const codexAdapter = new CodexAdapter();
