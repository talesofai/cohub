import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import {
  query as claudeQuery,
  type CanUseTool,
  type HookCallback,
  type HookJSONOutput,
  type Options as ClaudeOptions,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlock } from "@cohub/protocol/core";
import type {
  LocalRuntimeProviderEvent,
  LocalRuntimeOperation,
} from "@cohub/protocol";
import type { LocalProviderAdapter, LocalRuntimePromptInput, LocalRuntimeSessionHandle, LocalRuntimeSessionInput } from "../types.js";
import { boundedProviderId, providerEventId, providerIdValue, MAX_PROVIDER_ID_BYTES } from "../provider-identity.js";
import { pathInside, resolveWorkspacePath, workspaceFenceRoot } from "./workspace-path.js";

const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
// Provider events are wrapped with runtime routing metadata before they are
// serialized. Keep each raw value comfortably below the wire limit so JSON
// escaping and multiple fields in one event cannot push it over the boundary.
const MAX_DELTA_BYTES = 512 * 1024;
const MAX_VALUE_BYTES = 256 * 1024;
const MAX_EVENT_JSON_BYTES = 3 * 1024 * 1024;
const MAX_PROVIDER_EVENT_ID_LENGTH = MAX_PROVIDER_ID_BYTES;
const CLOSE_TIMEOUT_MS = 5_000;
const MAX_EVENT_QUEUE_ITEMS = 256;
const MAX_EVENT_QUEUE_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_QUEUE_PENDING_ITEMS = 64;
const MAX_EVENT_QUEUE_PENDING_BYTES = 32 * 1024 * 1024;

type Json = Record<string, unknown>;

type ClaudePermissionMode = NonNullable<ClaudeOptions["permissionMode"]>;
type ClaudeSettingSource = NonNullable<ClaudeOptions["settingSources"]>[number];

const CLAUDE_PERMISSION_MODES: ReadonlySet<string> = new Set([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);

const CLAUDE_SETTING_SOURCES: ReadonlySet<string> = new Set(["user", "project", "local"]);

// The runtime protocol has no permission-response command. Keep the default
// policy deterministic: read-only sessions expose local inspection tools only,
// while full-access sessions let the native SDK execute its configured tools.
// Network-capable tools are intentionally excluded from read-only mode: a
// read-only workspace must not become an unrestricted data-exfiltration path.
const CLAUDE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "glob",
  "grep",
  "ls",
  "notebookread",
]);

const CLAUDE_READ_ONLY_TOOL_NAMES = ["Read", "Glob", "Grep", "LS", "NotebookRead"] as const;
const CLAUDE_MUTATING_TOOL_NAMES = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "MultiEdit",
  "Task",
  "Agent",
  "Skill",
  "TodoWrite",
  "ExitPlanMode",
] as const;

const CLAUDE_ESCALATING_PERMISSION_MODES: ReadonlySet<ClaudePermissionMode> = new Set([
  "acceptEdits",
  "auto",
  "bypassPermissions",
]);

const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const textValue = (value: unknown, limit = MAX_TEXT_BYTES): string => {
  if (typeof value !== "string") return "";
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  return Buffer.from(value, "utf8").subarray(0, limit).toString("utf8").replace(/[\uFFFD]$/, "");
};

const integerValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function workspaceCandidate(raw: string, cwd: string, workspaceRoot = cwd): string {
  // The runtime wire uses /workspace as a stable virtual root. Resolve that
  // alias before canonical fencing; native Claude still receives the physical
  // cwd and therefore cannot escape the replica through an alias.
  return resolveWorkspacePath(raw, cwd, workspaceRoot);
}

/** Resolve the existing path prefix so symlinked files cannot escape cwd. */
async function canonicalPath(candidate: string): Promise<string> {
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

/** An explicit replica root must exist; otherwise the fence could widen to a parent. */
async function canonicalWorkspaceRoot(root: string): Promise<string> {
  let details: Awaited<ReturnType<typeof stat>>;
  try {
    details = await stat(root);
  } catch {
    throw new Error("Claude provider workspace root is unavailable");
  }
  if (!details.isDirectory()) throw new Error("Claude provider workspace root must be a directory");
  try {
    return await realpath(root);
  } catch {
    throw new Error("Claude provider workspace root is unavailable");
  }
}

async function workspacePathAllowed(raw: unknown, cwd: string, workspaceRoot?: string): Promise<boolean> {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) return false;
  let candidate: string;
  try {
    candidate = workspaceCandidate(raw.trim(), cwd, workspaceRoot ?? cwd);
  } catch {
    return false;
  }
  try {
    const root = workspaceRoot === undefined
      ? await canonicalPath(cwd)
      : await canonicalWorkspaceRoot(workspaceRoot);
    const canonical = await canonicalPath(candidate);
    return pathInside(root, canonical);
  } catch {
    return false;
  }
}

function toolInputPaths(toolName: string, input: Json): string[] {
  const keys = toolName.trim().toLowerCase() === "notebookread" || toolName.trim().toLowerCase() === "notebookedit"
    ? ["notebook_path", "path"]
    : ["file_path", "path", "directory", "root"];
  return keys.flatMap((key) => typeof input[key] === "string" ? [input[key] as string] : []);
}

function hasInvalidToolPath(toolName: string, input: Json): boolean {
  const keys = toolName.trim().toLowerCase() === "notebookread" || toolName.trim().toLowerCase() === "notebookedit"
    ? ["notebook_path", "path"]
    : ["file_path", "path", "directory", "root"];
  return keys.some((key) => Object.hasOwn(input, key) && (typeof input[key] !== "string" || !String(input[key]).trim()));
}

function virtualWorkspacePath(value: string): boolean {
  const normalized = value.trim();
  return normalized === "/workspace"
    || normalized.startsWith("/workspace/")
    || normalized.startsWith("/workspace\\")
    || normalized === "@/workspace"
    || normalized.startsWith("@/workspace/")
    || normalized.startsWith("@/workspace\\")
    || /^file:\/\/\/workspace(?:[\\/]|$)/i.test(normalized);
}

/**
 * Convert only path aliases that the native process cannot resolve itself.
 * Relative paths intentionally remain relative to Claude's physical cwd.
 */
function mappedToolInput(
  toolName: string,
  input: Json,
  cwd: string,
  workspaceRoot = cwd,
): Json | undefined {
  const mapped: Json = { ...input };
  let changed = false;
  for (const key of toolInputPaths(toolName, input).length > 0
    ? (toolName.trim().toLowerCase() === "notebookread" || toolName.trim().toLowerCase() === "notebookedit"
      ? ["notebook_path", "path"]
      : ["file_path", "path", "directory", "root"])
    : []) {
    const value = input[key];
    if (typeof value !== "string" || !virtualWorkspacePath(value)) continue;
    const next = workspaceCandidate(value, cwd, workspaceRoot);
    if (next !== value) {
      mapped[key] = next;
      changed = true;
    }
  }
  if (toolName.trim().toLowerCase() === "glob" && typeof input.pattern === "string" && virtualWorkspacePath(input.pattern)) {
    const next = workspaceCandidate(input.pattern, cwd, workspaceRoot);
    if (next !== input.pattern) {
      mapped.pattern = next;
      changed = true;
    }
  }
  return changed ? mapped : undefined;
}

/**
 * Glob's `pattern` is itself a path expression and is not covered by the
 * ordinary `path`/`directory` fields. Validate its static prefix before the
 * native tool receives it so a pattern such as `/etc/**` or `../**` cannot
 * turn a workspace read into an arbitrary filesystem scan.
 */
type GlobClassToken = { value: number; next: number };

function globClassToken(pattern: string, index: number): GlobClassToken | undefined {
  const character = pattern[index];
  if (character === undefined) return undefined;
  if (character !== "\\") {
    const value = character.codePointAt(0);
    return value === undefined ? undefined : { value, next: index + character.length };
  }
  const escaped = pattern[index + 1];
  if (escaped === undefined) return undefined;
  if (escaped === "x") {
    const value = Number.parseInt(pattern.slice(index + 2, index + 4), 16);
    if (Number.isInteger(value) && pattern.slice(index + 2, index + 4).length === 2) return { value, next: index + 4 };
  }
  if (escaped === "u") {
    if (pattern[index + 2] === "{") {
      const closing = pattern.indexOf("}", index + 3);
      if (closing >= 0) {
        const value = Number.parseInt(pattern.slice(index + 3, closing), 16);
        if (Number.isInteger(value)) return { value, next: closing + 1 };
      }
    } else {
      const digits = pattern.slice(index + 2, index + 6);
      const value = Number.parseInt(digits, 16);
      if (digits.length === 4 && Number.isInteger(value)) return { value, next: index + 6 };
    }
  }
  const value = escaped.codePointAt(0);
  return value === undefined ? undefined : { value, next: index + 1 + escaped.length };
}

function globClassMayMatchDot(pattern: string, start: number): { end: number; mayMatchDot: boolean } {
  let index = start + 1;
  let first = true;
  // Negated classes and nested/POSIX classes have implementation-specific
  // matching rules. Fail closed because either can include a dot component.
  if (pattern[index] === "!" || pattern[index] === "^" || pattern[index] === "[") {
    return { end: pattern.length, mayMatchDot: true };
  }
  while (index < pattern.length) {
    if (pattern[index] === "]" && !first) return { end: index, mayMatchDot: false };
    const token = globClassToken(pattern, index);
    if (!token) return { end: pattern.length, mayMatchDot: true };
    if (token.value === 0x2e) return { end: token.next, mayMatchDot: true };
    index = token.next;
    first = false;
    if (pattern[index] === "-" && pattern[index + 1] !== "]") {
      const rangeEnd = globClassToken(pattern, index + 1);
      if (!rangeEnd) return { end: pattern.length, mayMatchDot: true };
      const low = Math.min(token.value, rangeEnd.value);
      const high = Math.max(token.value, rangeEnd.value);
      if (low <= 0x2e && high >= 0x2e) return { end: rangeEnd.next, mayMatchDot: true };
      index = rangeEnd.next;
    }
  }
  return { end: pattern.length, mayMatchDot: true };
}

function globHasAbsoluteAlternative(pattern: string): boolean {
  let inClass = false;
  let escaped = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (character === "]") inClass = false;
      continue;
    }
    if (character === "[") {
      inClass = true;
      continue;
    }
    if (!character || !"{,(|".includes(character)) continue;
    const next = pattern[index + 1];
    if (next === "/" || next === "\\" || next === "~") return true;
    if (next && /^[A-Za-z]:[\\/]/.test(pattern.slice(index + 1))) return true;
  }
  return false;
}

async function globPatternAllowed(raw: unknown, cwd: string, workspaceRoot?: string): Promise<boolean> {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) return false;
  const pattern = raw.trim();
  // Do not let glob syntax manufacture a parent path component. A literal
  // `..` is easy to spot in ordinary segments, but the same component can be
  // hidden in brace alternatives (`{src,../etc}`), escaped dots, or character
  // classes (`[.][.]`). Reject those spellings before checking the static
  // prefix. This is intentionally conservative: denying a rare dot-matching
  // pattern is preferable to allowing a provider tool to scan outside the
  // replica root.
  const traversalBoundary = (character: string | undefined): boolean =>
    character === undefined || "\\/{},()[]!|".includes(character);
  for (let index = 0; index + 1 < pattern.length; index += 1) {
    if (pattern[index] !== "." || pattern[index + 1] !== ".") continue;
    if (traversalBoundary(pattern[index - 1]) && traversalBoundary(pattern[index + 2])) return false;
  }
  if (/(?:%2e){2}/i.test(pattern) || /\\(?:\.|x2e|u0*2e|u\{0*2e\})/i.test(pattern)) return false;
  if (globHasAbsoluteAlternative(pattern)) return false;
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] !== "[") continue;
    const parsedClass = globClassMayMatchDot(pattern, index);
    if (parsedClass.mayMatchDot) return false;
    index = parsedClass.end;
  }
  const segments = pattern.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) return false;
  const wildcard = /[*?[\]{}()!]/.exec(pattern);
  const staticPrefix = (wildcard ? pattern.slice(0, wildcard.index) : pattern)
    .replace(/[\\/]+$/, "") || ".";
  return workspacePathAllowed(staticPrefix, cwd, workspaceRoot);
}

const validUuid = (value: unknown): value is string =>
  // Claude Code's SDK accepts canonical UUIDs generated by newer runtimes as
  // well (including UUIDv7); do not reject valid native session identities by
  // restricting the version nibble to v1-v5.
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Native IDs are normalized before they become map keys or payload IDs. */
function nativeId(value: unknown): string | undefined {
  return boundedProviderId(value);
}

type MergedAbortSignal = {
  signal?: AbortSignal;
  cleanup: () => void;
};

function mergeAbortSignals(signals: Array<AbortSignal | undefined | null>): MergedAbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return { signal: undefined, cleanup: () => undefined };
  if (active.length === 1) return { signal: active[0], cleanup: () => undefined };
  if (typeof AbortSignal.any === "function") return { signal: AbortSignal.any(active), cleanup: () => undefined };
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
    listeners.length = 0;
  };
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
    cleanup();
  };
  for (const signal of active) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    const listener = () => abort(signal);
    listeners.push({ signal, listener });
    signal.addEventListener("abort", listener, { once: true });
  }
  return { signal: controller.signal, cleanup };
}

function jsonText(value: unknown, limit = MAX_VALUE_BYTES): string {
  if (typeof value === "string") return textValue(value, limit);
  try {
    return textValue(JSON.stringify(value) ?? "", limit);
  } catch {
    return "";
  }
}

function boundedJson(value: unknown, limit = MAX_VALUE_BYTES): unknown {
  if (typeof value === "string") return textValue(value, limit);
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized, "utf8") > limit) return { truncated: true };
    return value;
  } catch {
    return { unavailable: true };
  }
}

function boundedRecord(value: unknown, limit = MAX_VALUE_BYTES): Json {
  const bounded = boundedJson(record(value), limit);
  return bounded && typeof bounded === "object" && !Array.isArray(bounded)
    ? bounded as Json
    : { truncated: true };
}

/** Split a UTF-8 string without cutting a code point across events. */
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

function fitEventPayload(context: ClaudeEventContext, payload: Json): Json {
  const result: Json = {
    nativeTurnId: nativeId(context.turnId) || null,
    nativeSessionId: nativeId(context.sessionId) || null,
    ...payload,
  };
  // IDs may originate in extension payloads rather than Claude's typed SDK
  // objects. Normalize them at the final provider boundary so no multibyte,
  // control-heavy, or oversized value reaches the runtime schema.
  for (const key of ["id", "itemId", "toolId", "requestId", "providerSessionId", "nativeSessionId", "nativeTurnId"] as const) {
    if (typeof result[key] !== "string") continue;
    const normalized = nativeId(result[key]);
    if (normalized) result[key] = normalized;
    else delete result[key];
  }
  for (const key of ["text", "output", "message", "summary", "description"] as const) {
    if (typeof result[key] === "string") result[key] = textValue(result[key], MAX_DELTA_BYTES);
  }
  if (Object.hasOwn(result, "input")) result.input = boundedRecord(result.input);
  if (Object.hasOwn(result, "metadata")) result.metadata = boundedRecord(result.metadata);
  if (Object.hasOwn(result, "options")) result.options = boundedJson(result.options);
  try {
    if (Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_EVENT_JSON_BYTES) return result;
  } catch {
    // Fall through to the minimal, explicitly-truncated event below.
  }
  const minimal: Json = {
    nativeTurnId: context.turnId,
    nativeSessionId: context.sessionId || null,
    truncated: true,
  };
  for (const key of ["id", "name", "itemId", "toolId", "requestId"] as const) {
    if (typeof payload[key] === "string") minimal[key] = textValue(payload[key], MAX_PROVIDER_EVENT_ID_LENGTH);
  }
  if (payload.metadata && typeof payload.metadata === "object") {
    const sourceType = stringValue(record(payload.metadata).sourceType);
    if (sourceType) minimal.metadata = { sourceType, truncated: true };
  }
  return minimal;
}

function toolOutput(value: unknown): string {
  if (typeof value === "string") return textValue(value, MAX_VALUE_BYTES);
  if (Array.isArray(value)) {
    let text = "";
    for (const entry of value) {
      const block = record(entry);
      if (block.type !== "text") continue;
      const remaining = MAX_VALUE_BYTES - Buffer.byteLength(text, "utf8");
      if (remaining <= 0) break;
      text += textValue(block.text, remaining);
    }
    return text || jsonText(value);
  }
  const raw = record(value);
  for (const key of ["output", "result", "text", "content"]) {
    if (typeof raw[key] === "string") return textValue(raw[key], MAX_VALUE_BYTES);
  }
  return jsonText(value);
}

function valueFingerprint(value: unknown): string {
  let serialized = "";
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    serialized = String(value);
  }
  return createHash("sha256").update(serialized, "utf8").digest("hex").slice(0, 16);
}

function imageMime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

function imageBase64(value: string): string {
  const normalized = value.replace(/\s/g, "");
  const maxEncodedLength = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
  if (!normalized || normalized.length > maxEncodedLength || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("Claude image content is not valid base64");
  }
  const data = Buffer.from(normalized, "base64");
  if (data.byteLength > MAX_IMAGE_BYTES) throw new Error("Claude image exceeds the size limit");
  const canonical = data.toString("base64");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  if (canonical !== padded) throw new Error("Claude image content is not valid base64");
  return normalized;
}

type ClaudeImageSource =
  | { type: "url"; url: string }
  | { type: "base64"; media_type: string; data: string };

/** A slash in a bare image string is ambiguous, so require structured base64. */
function looksLikeImagePath(value: string): boolean {
  return value === "."
    || value === ".."
    || value.startsWith("./")
    || value.startsWith("../")
    || value.startsWith("/")
    || value.startsWith("\\")
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.includes("/")
    || value.includes("\\");
}

function httpImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim())) return undefined;
  const url = value.trim();
  return Buffer.byteLength(url, "utf8") <= 4096 ? url : undefined;
}

async function imageSource(value: string, cwd: string, workspaceRoot?: string): Promise<ClaudeImageSource> {
  const candidate = value.trim();
  if (httpImageUrl(candidate)) {
    throw new Error("Claude remote image URLs are not supported; provide a workspace path or base64 image data");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(candidate)) {
    throw new Error("Claude image URL must use a bounded http or https URL");
  }
  const dataUrl = /^data:([^;,]+);base64,(.*)$/is.exec(candidate);
  if (dataUrl) {
    const mediaType = dataUrl[1] ?? "";
    if (!mediaType.toLowerCase().startsWith("image/")) throw new Error("Claude image media type must be an image");
    const data = imageBase64(dataUrl[2] || "");
    return { type: "base64", media_type: mediaType || "image/png", data };
  }
  // Bare base64 payloads can contain `/`, but a short payload can also be a
  // perfectly valid workspace filename. Prefer an existing workspace file and
  // only fall back to base64 when path resolution reports a missing file.
  const looksLikeBase64 = candidate.length > 0
    && candidate.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(candidate);
  // A path-like value must never be reinterpreted as base64 after an
  // authorization failure. Callers can use {type:"base64", data} when a
  // legitimate bare payload contains a slash.
  const allowBareBase64Fallback = looksLikeBase64 && !looksLikeImagePath(candidate);
  if (/^[A-Za-z]:[\\/]/.test(candidate)) {
    throw new Error("Claude image path is outside the authorized workspace");
  }
  const path = workspaceCandidate(candidate, cwd, workspaceRoot ?? cwd);
  if (!(await workspacePathAllowed(path, cwd, workspaceRoot))) {
    if (allowBareBase64Fallback) return { type: "base64", media_type: "image/png", data: imageBase64(candidate) };
    throw new Error("Claude image path is outside the authorized workspace");
  }
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (allowBareBase64Fallback && (code === "ENOENT" || code === "ENOTDIR")) {
      return { type: "base64", media_type: "image/png", data: imageBase64(candidate) };
    }
    throw error;
  }
  if (data.byteLength > MAX_IMAGE_BYTES) throw new Error("Claude image exceeds the size limit");
  return { type: "base64", media_type: imageMime(path), data: data.toString("base64") };
}

async function promptMessage(input: LocalRuntimePromptInput, cwd: string, workspaceRoot?: string): Promise<SDKUserMessage["message"]> {
  const blocks: Json[] = [];
  if (input.options !== undefined && record(input.options) !== input.options) {
    throw new Error("Claude prompt options must be an object");
  }
  const options = record(input.options);
  if (input.text !== undefined && typeof input.text !== "string") {
    throw new Error("Claude prompt text must be a string");
  }
  if (options.images !== undefined && !Array.isArray(options.images)) {
    throw new Error("Claude prompt images must be an array");
  }
  const inputImages: unknown[] = Array.isArray(options.images) ? options.images : [];
  for (const image of inputImages) {
    if (typeof image === "string") {
      blocks.push({ type: "image", source: await imageSource(image, cwd, workspaceRoot) });
      continue;
    }
    if (!image || typeof image !== "object" || Array.isArray(image)) {
      throw new Error("Claude image content is malformed");
    }
    const value = image as Json;
    const mimeType = stringValue(value.mimeType) || stringValue(value.media_type);
    if ((value.type === "base64" || value.data !== undefined) && typeof value.data === "string" && mimeType) {
      if (!mimeType.toLowerCase().startsWith("image/")) throw new Error("Claude image media type must be an image");
      blocks.push({ type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64(value.data) } });
    } else if (value.type === "url") {
      const url = httpImageUrl(value.url);
      if (url) throw new Error("Claude remote image URLs are not supported; provide a workspace path or base64 image data");
      throw new Error("Claude image URL must use http or https");
    } else if (typeof value.path === "string") {
      blocks.push({ type: "image", source: await imageSource(value.path, cwd, workspaceRoot) });
    } else throw new Error("Claude image content is malformed");
  }
  const content = input.content ?? [];
  if (!Array.isArray(content)) throw new Error("Claude prompt content must be an array");
  const contentText = content
    .filter((value): value is Extract<ContentBlock, { type: "text" }> => Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as ContentBlock).type === "text" && typeof (value as Extract<ContentBlock, { type: "text" }>).text === "string"))
    .map((value) => value.text)
    .join("\n\n");
  const duplicateText = Boolean(input.text && contentText && input.text === contentText);
  if (input.text && !duplicateText) blocks.push({ type: "text", text: textValue(input.text) });
  for (const value of content) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Claude prompt content block is malformed");
    }
    const block = value as ContentBlock;
    if (block.type === "text") {
      if (typeof block.text !== "string") throw new Error("Claude text content block is malformed");
      blocks.push({ type: "text", text: textValue(block.text) });
    }
    else if (block.type === "image") {
      const source = record(block.source);
      if (source.type === "url") {
        const url = httpImageUrl(source.url);
        if (url) throw new Error("Claude remote image URLs are not supported; provide a workspace path or base64 image data");
        throw new Error("Claude image URL must use http or https");
      } else if (source.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") {
        if (!source.media_type.toLowerCase().startsWith("image/")) throw new Error("Claude image media type must be an image");
        blocks.push({ type: "image", source: { type: "base64", media_type: source.media_type, data: imageBase64(source.data) } });
      } else throw new Error("Claude image content block is malformed");
    } else if (block.type === "thinking") {
      if (typeof block.thinking !== "string") throw new Error("Claude thinking content block is malformed");
      blocks.push({ type: "text", text: textValue(block.thinking, MAX_VALUE_BYTES) });
    } else if (block.type === "shell_command") {
      if (typeof block.command !== "string" && typeof block.rawText !== "string") throw new Error("Claude shell command content block is malformed");
      blocks.push({ type: "text", text: textValue(block.rawText || block.command, MAX_VALUE_BYTES) });
    } else if (block.type === "system_note") {
      if (typeof block.text !== "string") throw new Error("Claude system note content block is malformed");
      blocks.push({ type: "text", text: textValue(block.text, MAX_VALUE_BYTES) });
    } else throw new Error(`Claude prompt content block type is unsupported: ${String((block as Json).type || "unknown")}`);
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });
  const textBytes = blocks.reduce((total, block) => total + (block.type === "text" ? Buffer.byteLength(String(block.text || ""), "utf8") : 0), 0);
  if (textBytes > MAX_TEXT_BYTES) throw new Error("Claude prompt exceeds the text size limit");
  return { role: "user", content: blocks } as unknown as SDKUserMessage["message"];
}

function usage(value: unknown, totalCost: unknown): Json | null {
  const raw = record(value);
  const input = integerValue(raw.input_tokens) ?? integerValue(raw.inputTokens);
  const output = integerValue(raw.output_tokens) ?? integerValue(raw.outputTokens);
  const cacheRead = integerValue(raw.cache_read_input_tokens) ?? integerValue(raw.cached_input_tokens) ?? integerValue(raw.cacheRead);
  const cacheWrite = integerValue(raw.cache_creation_input_tokens) ?? integerValue(raw.cache_write_input_tokens) ?? integerValue(raw.cacheWrite);
  const explicitTotal = integerValue(raw.total_tokens) ?? integerValue(raw.totalTokens);
  const cost = typeof totalCost === "number" && Number.isFinite(totalCost) && totalCost >= 0 ? totalCost : undefined;
  const values = [input, output, cacheRead, cacheWrite].filter((item): item is number => item !== undefined);
  if (values.length === 0 && explicitTotal === undefined && cost === undefined) return null;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(explicitTotal !== undefined ? { totalTokens: explicitTotal } : values.length ? { totalTokens: values.reduce((sum, item) => sum + item, 0) } : {}),
    ...(cost !== undefined ? { cost: { total: cost } } : {}),
  };
}

export type ClaudeEventContext = {
  sessionId: string;
  turnId: string;
  /** Whether assistant text/thinking from Task subagents is user-visible. */
  forwardSubagentText: boolean;
  /** Last cumulative SDK cost observed before this turn, when available. */
  cumulativeCostUsd: number | null;
  finalText: string;
  partialMessageId: string | null;
  textBlocks: Map<string, string>;
  thinkingBlocks: Map<string, string>;
  partialTextBlocks: Set<string>;
  partialThinkingBlocks: Set<string>;
  partialTextValues: Map<string, string>;
  partialThinkingValues: Map<string, string>;
  /** Native stream UUIDs are replay-safe; malformed producers without UUIDs
   * use a local revision so repeated chunks still receive distinct ids. */
  streamEventIds: Map<string, string>;
  streamRevisions: Map<string, number>;
  streamSeenEvents: Set<string>;
  textBlockCounts: Map<string, number>;
  thinkingBlockCounts: Map<string, number>;
  textBlockSnapshots: Map<string, string>;
  thinkingBlockSnapshots: Map<string, string>;
  partialTools: Map<string, { id: string; name: string; json: string; input: Json; truncated?: boolean }>;
  /** Tool state keyed by a canonical tool-use id (or task id when absent). */
  tools: Map<string, {
    name: string;
    input: Json;
    completed: boolean;
    completionSource?: ClaudeToolCompletionSource;
    completionOutput?: string;
    completionStatus?: string;
    completionIsError?: boolean;
  }>;
  /** Claude emits task_id and tool_use_id independently across SDK versions. */
  taskToolIds: Map<string, string>;
  toolAliases: Map<string, string>;
  usage: Json | null;
};

type ClaudeToolCompletionSource =
  | "tool_result"
  | "task_updated"
  | "task_notification"
  | "permission_denied"
  | "result_permission";

export function createClaudeEventContext(
  sessionId: string,
  turnId: string,
  cumulativeCostUsd: number | null = null,
  forwardSubagentText = false,
): ClaudeEventContext {
  return {
    sessionId,
    turnId,
    forwardSubagentText,
    cumulativeCostUsd,
    finalText: "",
    partialMessageId: null,
    textBlocks: new Map(),
    thinkingBlocks: new Map(),
    partialTextBlocks: new Set(),
    partialThinkingBlocks: new Set(),
    partialTextValues: new Map(),
    partialThinkingValues: new Map(),
    streamEventIds: new Map(),
    streamRevisions: new Map(),
    streamSeenEvents: new Set(),
    textBlockCounts: new Map(),
    thinkingBlockCounts: new Map(),
    textBlockSnapshots: new Map(),
    thinkingBlockSnapshots: new Map(),
    partialTools: new Map(),
    tools: new Map(),
    taskToolIds: new Map(),
    toolAliases: new Map(),
    usage: null,
  };
}

function event(
  context: ClaudeEventContext,
  kind: LocalRuntimeProviderEvent["kind"],
  payload: Json,
  eventId?: string,
): LocalRuntimeProviderEvent {
  const id = eventId ? providerEventId(eventId) : undefined;
  return {
    kind,
    ...(id ? { providerEventId: id } : {}),
    payload: fitEventPayload(context, payload),
  };
}

function metadata(message: Json, extra?: Json): Json {
  return {
    sourceType: typeof message.type === "string" ? textValue(message.type, 128) : "unknown",
    ...(typeof message.subtype === "string" ? { sourceSubtype: textValue(message.subtype, 128) } : {}),
    ...(nativeId(message.parent_tool_use_id) ? { parentToolUseId: nativeId(message.parent_tool_use_id) } : {}),
    ...(nativeId(message.request_id) ? { requestId: nativeId(message.request_id) } : {}),
    ...extra,
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

function blockKey(messageId: string | undefined, index: number, fallback: string): string {
  return `${messageId || fallback}:${index}`;
}

function consumePartialBlock(
  values: Map<string, string>,
  messageId: string | undefined,
  text: string,
): { key: string; remainder: string } | undefined {
  const prefix = messageId ? `${messageId}:` : undefined;
  for (const [key, partial] of values) {
    if (prefix && !key.startsWith(prefix)) continue;
    if (partial === text) return { key, remainder: "" };
    if (partial && text.startsWith(partial)) return { key, remainder: text.slice(partial.length) };
  }
  return undefined;
}

function completeBlockKey(
  counts: Map<string, number>,
  base: string,
  wrapperId: string | undefined,
): string {
  const occurrence = counts.get(base) || 0;
  counts.set(base, occurrence + 1);
  return occurrence === 0 ? base : `${base}:${wrapperId || occurrence}`;
}

/** Resolve the aliases Claude uses for a spawned task and its tool call. */
function canonicalToolId(context: ClaudeEventContext, id: string): string {
  return context.toolAliases.get(id) || id;
}

function taskToolId(context: ClaudeEventContext, taskId: string, toolUseId?: string): string {
  const knownTaskId = context.taskToolIds.get(taskId);
  const knownToolId = toolUseId ? canonicalToolId(context, toolUseId) : undefined;
  // Once a task has emitted a lifecycle event, keep its first canonical id so
  // a later optional tool_use_id cannot strand the already-projected tool.
  const canonical = knownTaskId || knownToolId || toolUseId || taskId;
  context.taskToolIds.set(taskId, canonical);
  context.toolAliases.set(taskId, canonical);
  if (toolUseId) context.toolAliases.set(toolUseId, canonical);
  return canonical;
}

function completionRank(source: ClaudeToolCompletionSource): number {
  switch (source) {
    case "task_notification":
    case "permission_denied":
    case "result_permission":
      return 4;
    case "task_updated":
      return 3;
    case "tool_result":
      return 2;
    default:
      return 0;
  }
}

function streamEventId(
  context: ClaudeEventContext,
  kind: "text" | "thinking" | "tool",
  nativeId: string | undefined,
  index: number,
  value: unknown,
): string {
  const base = `${kind}:${nativeId || context.turnId}:${index}`;
  const fingerprint = valueFingerprint(value);
  const stableKey = `${base}:${fingerprint}`;
  // A native frame UUID is a replay-safe identity. Without one, two equal
  // chunks are still distinct arrivals, so assign a fresh local revision.
  // This preserves streamed text instead of collapsing repeated words.
  const existing = nativeId ? context.streamEventIds.get(stableKey) : undefined;
  if (existing) return existing;
  const revision = (context.streamRevisions.get(base) || 0) + 1;
  context.streamRevisions.set(base, revision);
  const id = providerEventId(nativeId || context.turnId, "stream", kind, index, revision, fingerprint) as string;
  context.streamEventIds.set(stableKey, id);
  return id;
}

function toolStart(context: ClaudeEventContext, block: Json, id: string | undefined, meta: Json): LocalRuntimeProviderEvent[] {
  const rawToolId = nativeId(block.id);
  if (!rawToolId) return [];
  const toolId = canonicalToolId(context, rawToolId);
  context.toolAliases.set(rawToolId, toolId);
  const name = textValue(stringValue(block.name) || "tool", MAX_PROVIDER_EVENT_ID_LENGTH);
  const input = boundedRecord(block.input);
  const previous = context.tools.get(toolId);
  context.tools.set(toolId, {
    name,
    input,
    completed: previous?.completed ?? false,
    ...(previous?.completionSource ? { completionSource: previous.completionSource } : {}),
    ...(previous?.completionOutput !== undefined ? { completionOutput: previous.completionOutput } : {}),
    ...(previous?.completionStatus ? { completionStatus: previous.completionStatus } : {}),
    ...(previous?.completionIsError !== undefined ? { completionIsError: previous.completionIsError } : {}),
  });
  const baseId = id || toolId;
  const fingerprint = valueFingerprint({ name, input });
  if (!previous) return [event(context, "tool.started", { id: toolId, name, input, metadata: meta }, providerEventId(baseId, "tool", toolId, "started", fingerprint))];
  if (previous.name !== name || JSON.stringify(previous.input) !== JSON.stringify(input)) {
    return [event(context, "tool.updated", { id: toolId, name, input, metadata: meta }, providerEventId(baseId, "tool", toolId, "updated", fingerprint))];
  }
  return [];
}

function toolComplete(
  context: ClaudeEventContext,
  block: Json,
  id: string | undefined,
  meta: Json,
  source: ClaudeToolCompletionSource = "tool_result",
): LocalRuntimeProviderEvent[] {
  const rawToolId = nativeId(block.tool_use_id);
  if (!rawToolId) return [];
  const toolId = canonicalToolId(context, rawToolId);
  context.toolAliases.set(rawToolId, toolId);
  const previous = context.tools.get(toolId);
  const name = textValue(previous?.name || stringValue(block.name) || "tool", MAX_PROVIDER_EVENT_ID_LENGTH);
  const output = toolOutput(block.content);
  const isError = block.is_error === true;
  const status = stringValue(block.status);
  const result: LocalRuntimeProviderEvent[] = [];
  const baseId = id || toolId;
  if (!previous) result.push(event(context, "tool.started", { id: toolId, name, input: {}, metadata: meta }, providerEventId(baseId, "tool", toolId, "started", valueFingerprint({ name, input: {} }))));
  const previousRank = previous?.completionSource ? completionRank(previous.completionSource) : 0;
  const incomingRank = completionRank(source);
  const differs = previous?.completionOutput !== output
    || previous?.completionIsError !== isError
    || previous?.completionStatus !== status;
  // A terminal task patch can be followed by a tool result or task
  // notification containing the real output. Allow that authoritative frame
  // to replace the status snapshot while keeping replays idempotent.
  const replaceCompletion = previous?.completed === true
    && differs
    && (incomingRank > previousRank
      || (source === "tool_result" && previous.completionSource === "task_updated"));
  if (!previous?.completed || replaceCompletion) {
    result.push(event(context, "tool.completed", {
      id: toolId,
      name,
      ...(status ? { status } : {}),
      output,
      isError,
      metadata: meta,
    }, providerEventId(baseId, "tool", toolId, "completed", valueFingerprint({ output, isError, status, source }))));
    context.tools.set(toolId, {
      name,
      input: previous?.input || {},
      completed: true,
      completionSource: source,
      completionOutput: output,
      ...(status ? { completionStatus: status } : {}),
      completionIsError: isError,
    });
  }
  return result;
}

function partialMessage(message: Json, context: ClaudeEventContext): LocalRuntimeProviderEvent[] {
  const raw = record(message.event);
  const type = typeof raw.type === "string" ? raw.type : "";
  const wrapperId = nativeId(message.uuid);
  if (wrapperId) {
    const seenKey = `${wrapperId}:${valueFingerprint(raw)}`;
    if (context.streamSeenEvents.has(seenKey)) return [];
    context.streamSeenEvents.add(seenKey);
  }
  const meta = metadata(message, { streamEventType: type });
  const nativeEventId = wrapperId || undefined;
  if (type === "message_start") {
    const id = nativeId(record(raw.message).id);
    context.partialMessageId = id || null;
    return [];
  }
  const index = typeof raw.index === "number" && Number.isSafeInteger(raw.index) ? raw.index : 0;
  // UUIDs identify stream frames, not content blocks. A malformed producer may
  // omit both the message and frame UUID; keep all chunks for the same turn and
  // block index together so the eventual complete assistant frame can reconcile
  // them instead of replaying the entire streamed text.
  const key = blockKey(context.partialMessageId || undefined, index, context.turnId);
  if (type === "content_block_start") {
    const block = record(raw.content_block);
    if (block.type !== "tool_use") return [];
    const id = nativeId(block.id);
    if (!id) return [];
    const name = stringValue(block.name) || "tool";
    const input = record(block.input);
    context.partialTools.set(key, { id, name, json: "", input });
    return toolStart(context, { id, name, input }, streamEventId(context, "tool", nativeEventId, index, { type, id, name, input }), meta);
  }
  if (type === "content_block_delta") {
    const delta = record(raw.delta);
    if (delta.type === "text_delta") {
      if (message.parent_tool_use_id && !context.forwardSubagentText) return [];
      const text = textValue(delta.text);
      if (!text) return [];
      context.partialTextBlocks.add(key);
      context.partialTextValues.set(key, textValue(`${context.partialTextValues.get(key) || ""}${text}`, MAX_TEXT_BYTES));
      context.finalText = textValue(context.finalText + text, MAX_TEXT_BYTES);
      return splitUtf8(text).map((chunk, chunkIndex) => event(
        context,
        "text.delta",
        { text: chunk, itemId: key, metadata: meta },
        streamEventId(context, "text", nativeEventId, index, { type, text, chunkIndex }),
      ));
    }
    if (delta.type === "thinking_delta") {
      if (message.parent_tool_use_id && !context.forwardSubagentText) return [];
      const text = textValue(delta.thinking);
      if (!text) return [];
      context.partialThinkingBlocks.add(key);
      context.partialThinkingValues.set(key, textValue(`${context.partialThinkingValues.get(key) || ""}${text}`, MAX_TEXT_BYTES));
      return splitUtf8(text).map((chunk, chunkIndex) => event(
        context,
        "thinking.delta",
        { text: chunk, itemId: key, metadata: meta },
        streamEventId(context, "thinking", nativeEventId, index, { type, text, chunkIndex }),
      ));
    }
    if (delta.type === "input_json_delta") {
      const partial = context.partialTools.get(key);
      if (!partial) return [];
      if (partial.truncated) return [];
      const nextJson = textValue(delta.partial_json, MAX_VALUE_BYTES);
      if (Buffer.byteLength(partial.json, "utf8") + Buffer.byteLength(nextJson, "utf8") > MAX_VALUE_BYTES) {
        partial.truncated = true;
        partial.input = { truncated: true };
        const toolId = canonicalToolId(context, partial.id);
        const previous = context.tools.get(toolId);
        context.tools.set(toolId, { name: partial.name, input: partial.input, completed: previous?.completed ?? false, ...(previous?.completionSource ? { completionSource: previous.completionSource } : {}), ...(previous?.completionOutput !== undefined ? { completionOutput: previous.completionOutput } : {}), ...(previous?.completionStatus ? { completionStatus: previous.completionStatus } : {}), ...(previous?.completionIsError !== undefined ? { completionIsError: previous.completionIsError } : {}) });
        return [event(context, "tool.updated", { id: toolId, name: partial.name, input: partial.input, metadata: meta }, streamEventId(context, "tool", nativeEventId, index, { type, id: toolId, truncated: true }))];
      }
      partial.json += nextJson;
      try {
        partial.input = record(JSON.parse(partial.json));
      } catch {
        return [];
      }
      partial.input = boundedRecord(partial.input);
      const toolId = canonicalToolId(context, partial.id);
      const previous = context.tools.get(toolId);
      context.tools.set(toolId, { name: partial.name, input: partial.input, completed: previous?.completed ?? false, ...(previous?.completionSource ? { completionSource: previous.completionSource } : {}), ...(previous?.completionOutput !== undefined ? { completionOutput: previous.completionOutput } : {}), ...(previous?.completionStatus ? { completionStatus: previous.completionStatus } : {}), ...(previous?.completionIsError !== undefined ? { completionIsError: previous.completionIsError } : {}) });
      return [event(context, "tool.updated", { id: toolId, name: partial.name, input: partial.input, metadata: meta }, streamEventId(context, "tool", nativeEventId, index, { type, id: toolId, input: partial.input }))];
    }
  }
  if (type === "content_block_stop") {
    const partial = context.partialTools.get(key);
    if (partial) {
      const toolId = canonicalToolId(context, partial.id);
      return [event(context, "tool.updated", { id: toolId, name: partial.name, input: partial.input, metadata: meta }, streamEventId(context, "tool", nativeEventId, index, { type, id: toolId, input: partial.input }))];
    }
  }
  return [];
}

/** Project one Claude Agent SDK message into the local-runtime event contract. */
export function mapClaudeMessage(message: SDKMessage, context: ClaudeEventContext): LocalRuntimeProviderEvent[] {
  const raw = record(message);
  // `--replay-user-messages` emits historical user/tool-result frames on
  // resume. They are transcript replay, not a result for the active prompt;
  // projecting them would duplicate tool completion events.
  if (raw.type === "user" && raw.isReplay === true) return [];
  const wrapperId = nativeId(raw.uuid);
  const incomingSessionId = providerIdValue(raw.session_id);
  if (incomingSessionId) context.sessionId = incomingSessionId;
  if (raw.type === "stream_event") return partialMessage(raw, context);
  const meta = metadata(raw);
  if (raw.type === "system") {
    if (raw.subtype === "init") {
      return [event(context, "session.ready", {
        providerSessionId: context.sessionId,
        metadata: meta,
      }, providerEventId(wrapperId || context.sessionId || context.turnId, "system", "init"))];
    }
    if (raw.subtype === "task_notification") {
      const taskId = nativeId(raw.task_id);
      if (!taskId) return [];
      const toolId = taskToolId(context, taskId, nativeId(raw.tool_use_id));
      const status = stringValue(raw.status);
      const output = textValue(raw.summary, MAX_VALUE_BYTES) || status || "Task completed";
      return toolComplete(context, {
        tool_use_id: toolId,
        content: output,
        status,
        is_error: status === "failed" || status === "stopped",
      }, providerEventId(wrapperId || context.turnId, "task", toolId), {
        ...meta,
        taskId: textValue(taskId, MAX_PROVIDER_EVENT_ID_LENGTH),
      }, "task_notification");
    }
    if (raw.subtype === "permission_denied") {
      const rawId = nativeId(raw.tool_use_id);
      if (!rawId) return [];
      const id = canonicalToolId(context, rawId);
      context.toolAliases.set(rawId, id);
      const previous = context.tools.get(id);
      if (previous?.completed) return [];
      // SDK releases have used both `message` and `errors` for this payload;
      // preserve whichever native reason is available instead of replacing it
      // with a generic denial string.
      const errors = Array.isArray(raw.errors)
        ? raw.errors.filter((value): value is string => typeof value === "string").join("; ")
        : "";
      const message = textValue(raw.message, MAX_VALUE_BYTES)
        || textValue(errors, MAX_VALUE_BYTES)
        || textValue(raw.decision_reason, MAX_VALUE_BYTES)
        || "Permission denied";
      const name = textValue(previous?.name || stringValue(raw.tool_name) || "tool", MAX_PROVIDER_EVENT_ID_LENGTH);
      context.tools.set(id, {
        name,
        input: previous?.input || {},
        completed: true,
        completionSource: "permission_denied",
        completionOutput: message,
        completionIsError: true,
      });
      return [event(context, "tool.completed", { id, name, output: message, isError: true, metadata: meta }, providerEventId(wrapperId || context.turnId, "permission", id, "completed", valueFingerprint(message)))];
    }
    if (raw.subtype === "task_progress") {
      const taskId = nativeId(raw.task_id);
      if (!taskId) return [];
      const toolId = taskToolId(context, taskId, nativeId(raw.tool_use_id));
      const previous = context.tools.get(toolId);
      if (previous?.completed) return [];
      const name = textValue(previous?.name || stringValue(raw.subagent_type) || "task", MAX_PROVIDER_EVENT_ID_LENGTH);
      if (!previous) context.tools.set(toolId, { name, input: {}, completed: false });
      return [event(context, "tool.updated", {
        id: toolId,
        name,
        input: previous?.input || {},
        ...(typeof raw.summary === "string" ? { summary: textValue(raw.summary, MAX_VALUE_BYTES) } : {}),
        ...(typeof raw.description === "string" ? { description: textValue(raw.description, MAX_VALUE_BYTES) } : {}),
        metadata: { ...meta, taskId: textValue(taskId, MAX_PROVIDER_EVENT_ID_LENGTH) },
      }, providerEventId(wrapperId || context.turnId, "task_progress", toolId, valueFingerprint(raw)))];
    }
    if (raw.subtype === "task_started") {
      const taskId = nativeId(raw.task_id);
      if (!taskId) return [];
      const toolId = taskToolId(context, taskId, nativeId(raw.tool_use_id));
      const previous = context.tools.get(toolId);
      const name = textValue(previous?.name || stringValue(raw.subagent_type) || "task", MAX_PROVIDER_EVENT_ID_LENGTH);
      context.tools.set(toolId, {
        name,
        input: previous?.input || {},
        completed: previous?.completed ?? false,
        ...(previous?.completionSource ? { completionSource: previous.completionSource } : {}),
        ...(previous?.completionOutput !== undefined ? { completionOutput: previous.completionOutput } : {}),
        ...(previous?.completionStatus ? { completionStatus: previous.completionStatus } : {}),
        ...(previous?.completionIsError !== undefined ? { completionIsError: previous.completionIsError } : {}),
      });
      return previous
        ? []
        : [event(context, "tool.started", {
          id: toolId,
          name,
          input: {},
          metadata: { ...meta, taskId: textValue(taskId, MAX_PROVIDER_EVENT_ID_LENGTH) },
        }, providerEventId(wrapperId || context.turnId, "task_started", toolId))];
    }
    if (raw.subtype === "task_updated") {
      const taskId = nativeId(raw.task_id);
      if (!taskId) return [];
      const patch = record(raw.patch);
      const status = stringValue(patch.status);
      const completed = status === "completed" || status === "failed" || status === "killed";
      const toolId = taskToolId(context, taskId);
      const taskMeta = { ...meta, taskId: textValue(taskId, MAX_PROVIDER_EVENT_ID_LENGTH), patch: boundedRecord(patch) };
      if (completed) {
        const output = textValue(stringValue(patch.error) || status || "Task completed", MAX_VALUE_BYTES);
        return toolComplete(context, {
          tool_use_id: toolId,
          content: output,
          status,
          is_error: status !== "completed",
        }, providerEventId(wrapperId || context.turnId, "task_updated", taskId, valueFingerprint(patch)), taskMeta, "task_updated");
      }
      const current = context.tools.get(toolId);
      if (current?.completed) return [];
      const name = textValue(current?.name || "task", MAX_PROVIDER_EVENT_ID_LENGTH);
      const input = current?.input || {};
      context.tools.set(toolId, { name, input, completed: current?.completed === true, ...(current?.completionSource ? { completionSource: current.completionSource } : {}), ...(current?.completionOutput !== undefined ? { completionOutput: current.completionOutput } : {}), ...(current?.completionStatus ? { completionStatus: current.completionStatus } : {}), ...(current?.completionIsError !== undefined ? { completionIsError: current.completionIsError } : {}) });
      return [event(context, "tool.updated", {
        id: toolId,
        name,
        input,
        ...(status ? { status } : {}),
        metadata: taskMeta,
      }, providerEventId(wrapperId || context.turnId, "task_updated", taskId, valueFingerprint(patch)))];
    }
    return [];
  }
  if (raw.type === "assistant") {
    const assistant = record(raw.message);
    const messageId = nativeId(assistant.id);
    const isSubagent = Boolean(raw.parent_tool_use_id);
    const blocks = Array.isArray(assistant.content) ? assistant.content : [];
    const result: LocalRuntimeProviderEvent[] = [];
    blocks.forEach((value, index) => {
      const block = record(value);
      const baseKey = blockKey(messageId, index, context.turnId);
      const blockEventId = providerEventId(wrapperId || messageId || baseKey, "assistant", "block", index);
      if (block.type === "text") {
        if (isSubagent && !context.forwardSubagentText) return;
        const text = textValue(block.text);
        const partial = consumePartialBlock(context.partialTextValues, messageId, text);
        if (partial) {
          context.partialTextValues.delete(partial.key);
          context.partialTextBlocks.delete(partial.key);
        }
        // A complete assistant frame may be replayed by the bridge. Suppress
        // an exact snapshot replay while preserving a second block that has
        // the same message id but different content.
        if (!partial && context.textBlockSnapshots.get(baseKey) === text) return;
        const key = completeBlockKey(context.textBlockCounts, baseKey, wrapperId);
        const previous = context.textBlocks.get(key) || "";
        const delta = partial ? partial.remainder : suffixDelta(previous, text);
        context.textBlocks.set(key, text);
        context.textBlockSnapshots.set(baseKey, text);
        if (delta) {
          context.finalText = textValue(context.finalText + delta, MAX_TEXT_BYTES);
          result.push(...splitUtf8(delta).map((chunk, chunkIndex) => event(
            context,
            "text.delta",
            { text: chunk, itemId: key, metadata: meta },
            providerEventId(blockEventId || context.turnId, "text", valueFingerprint(delta), chunkIndex),
          )));
        }
      } else if (block.type === "thinking") {
        if (isSubagent && !context.forwardSubagentText) return;
        const text = textValue(block.thinking);
        const partial = consumePartialBlock(context.partialThinkingValues, messageId, text);
        if (partial) {
          context.partialThinkingValues.delete(partial.key);
          context.partialThinkingBlocks.delete(partial.key);
        }
        if (!partial && context.thinkingBlockSnapshots.get(baseKey) === text) return;
        const key = completeBlockKey(context.thinkingBlockCounts, baseKey, wrapperId);
        const previous = context.thinkingBlocks.get(key) || "";
        const delta = partial ? partial.remainder : suffixDelta(previous, text);
        context.thinkingBlocks.set(key, text);
        context.thinkingBlockSnapshots.set(baseKey, text);
        if (delta) result.push(...splitUtf8(delta).map((chunk, chunkIndex) => event(
          context,
          "thinking.delta",
          { text: chunk, itemId: key, metadata: meta },
          providerEventId(blockEventId || context.turnId, "thinking", valueFingerprint(delta), chunkIndex),
        )));
      } else if (block.type === "tool_use") {
        result.push(...toolStart(context, block, providerEventId(blockEventId || context.turnId, "tool"), meta));
      } else if (block.type === "tool_result") {
        result.push(...toolComplete(context, block, providerEventId(blockEventId || context.turnId, "tool"), meta));
      }
    });
    return result;
  }
  if (raw.type === "user") {
    const user = record(raw.message);
    const blocks = Array.isArray(user.content) ? user.content : [];
    return blocks.flatMap((value, index) => {
      const block = record(value);
      const blockEventId = providerEventId(wrapperId || context.turnId, "user", "block", index);
      return block.type === "tool_result" ? toolComplete(context, block, providerEventId(blockEventId || context.turnId, "tool"), meta) : [];
    });
  }
  if (raw.type === "tool_progress") {
    const toolId = nativeId(raw.tool_use_id);
    if (!toolId) return [];
    const name = stringValue(raw.tool_name) || context.tools.get(toolId)?.name || "tool";
    const previous = context.tools.get(toolId);
    const result: LocalRuntimeProviderEvent[] = [];
    const progressEventId = providerEventId(wrapperId || context.turnId, "tool_progress", toolId);
    if (!previous) {
      context.tools.set(toolId, { name, input: {}, completed: false });
      result.push(event(context, "tool.started", {
        id: toolId,
        name,
        input: {},
        metadata: meta,
      }, providerEventId(progressEventId || context.turnId, "started")));
    }
    result.push(event(context, "tool.updated", {
      id: toolId,
      name,
      input: previous?.input || {},
      ...(typeof raw.elapsed_time_seconds === "number" ? { elapsedTimeSeconds: raw.elapsed_time_seconds } : {}),
      metadata: meta,
    }, providerEventId(progressEventId || context.turnId, "updated", valueFingerprint(raw))));
    return result;
  }
  if (raw.type === "result") {
    const result: LocalRuntimeProviderEvent[] = [];
    const totalCost = typeof raw.total_cost_usd === "number" && Number.isFinite(raw.total_cost_usd) && raw.total_cost_usd >= 0
      ? raw.total_cost_usd
      : undefined;
    const turnCost = totalCost === undefined
      ? undefined
      : context.cumulativeCostUsd === null || totalCost < context.cumulativeCostUsd
        ? totalCost
        : totalCost - context.cumulativeCostUsd;
    if (totalCost !== undefined) context.cumulativeCostUsd = totalCost;
    const normalizedUsage = usage(raw.usage, turnCost);
    if (normalizedUsage && JSON.stringify(normalizedUsage) !== JSON.stringify(context.usage)) {
      context.usage = normalizedUsage;
      result.push(event(context, "usage", { usage: normalizedUsage, metadata: meta }, providerEventId(wrapperId || context.turnId, "result", "usage", valueFingerprint(normalizedUsage))));
    }
    const denials = Array.isArray(raw.permission_denials) ? raw.permission_denials : [];
    for (const [index, value] of denials.entries()) {
      const denial = record(value);
      const rawId = nativeId(denial.tool_use_id);
      if (!rawId) continue;
      const id = canonicalToolId(context, rawId);
      context.toolAliases.set(rawId, id);
      if (context.tools.get(id)?.completed) continue;
      const previous = context.tools.get(id);
      const denialName = textValue(previous?.name || stringValue(denial.tool_name) || "tool", MAX_PROVIDER_EVENT_ID_LENGTH);
      context.tools.set(id, {
        name: denialName,
        input: previous?.input || boundedRecord(denial.tool_input),
        completed: true,
        completionSource: "result_permission",
        completionOutput: "Permission denied",
        completionIsError: true,
      });
      result.push(event(context, "tool.completed", { id, name: denialName, output: "Permission denied", isError: true, metadata: meta }, providerEventId(wrapperId || context.turnId, "result", "permission", id || index, "completed", valueFingerprint(denial))));
    }
    const subtype = typeof raw.subtype === "string" ? raw.subtype : "error_during_execution";
    const output = textValue(raw.result, MAX_VALUE_BYTES) || textValue(context.finalText, MAX_VALUE_BYTES);
    if (subtype === "success" && raw.is_error !== true) {
      result.push(event(context, "turn.completed", { status: "turn_completed", stopReason: typeof raw.stop_reason === "string" ? raw.stop_reason : null, ...(output ? { output } : {}), ...(normalizedUsage ? { usage: normalizedUsage } : {}), metadata: meta }, providerEventId(wrapperId || context.turnId, "result", "completed", valueFingerprint({ output, stopReason: raw.stop_reason, usage: normalizedUsage }))));
    } else {
      const errors = Array.isArray(raw.errors) ? raw.errors.filter((value): value is string => typeof value === "string") : [];
      const message = textValue(errors.join("; ") || output || `Claude turn failed (${subtype})`, MAX_VALUE_BYTES);
      result.push(event(context, "turn.failed", { status: "turn_failed", message, code: subtype, metadata: meta }, providerEventId(wrapperId || context.turnId, "result", "failed", valueFingerprint({ message, code: subtype }))));
    }
    return result;
  }
  return [];
}

class InputQueue implements AsyncIterable<SDKUserMessage>, AsyncIterator<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private readonly waiters: Array<{ resolve: (value: IteratorResult<SDKUserMessage>) => void; reject: (error: unknown) => void }> = [];
  private ended = false;
  private failure: unknown = null;

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> { return this; }

  next(): Promise<IteratorResult<SDKUserMessage>> {
    const value = this.values.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  write(value: SDKUserMessage): void {
    if (this.ended || this.failure) throw new Error("Claude input stream is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended || this.failure) return;
    this.ended = true;
    while (this.waiters.length) this.waiters.shift()?.resolve({ done: true, value: undefined });
  }
}

class EventQueue implements AsyncIterable<LocalRuntimeProviderEvent>, AsyncIterator<LocalRuntimeProviderEvent> {
  private readonly values: LocalRuntimeProviderEvent[] = [];
  private readonly waiters: Array<{ resolve: (value: IteratorResult<LocalRuntimeProviderEvent>) => void; reject: (error: unknown) => void }> = [];
  private readonly pending: Array<{
    value: LocalRuntimeProviderEvent;
    bytes: number;
    resolve: (accepted: boolean) => void;
    reject: (error: unknown) => void;
  }> = [];
  private valueBytes = 0;
  private pendingBytes = 0;
  private ended = false;
  private failure: unknown = null;
  private terminalValue: LocalRuntimeProviderEvent | null = null;

  [Symbol.asyncIterator](): AsyncIterator<LocalRuntimeProviderEvent> { return this; }

  /**
   * Async generators call `return()` on an inner iterator when their consumer
   * closes early. Reject blocked producers immediately instead of leaving a
   * native Claude query suspended on queue capacity forever.
   */
  return(): Promise<IteratorResult<LocalRuntimeProviderEvent>> {
    this.fail(new Error("Claude provider event consumer closed"));
    return Promise.resolve({ done: true, value: undefined });
  }

  next(): Promise<IteratorResult<LocalRuntimeProviderEvent>> {
    this.drainPending();
    const value = this.values.shift();
    if (value) {
      this.valueBytes = Math.max(0, this.valueBytes - this.eventBytes(value));
      this.drainPending();
      return Promise.resolve({ done: false, value });
    }
    if (this.terminalValue && this.pending.length === 0) {
      const terminal = this.terminalValue;
      this.terminalValue = null;
      return Promise.resolve({ done: false, value: terminal });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  push(value: LocalRuntimeProviderEvent): Promise<boolean> {
    if (this.ended || this.failure || this.terminalValue) return Promise.resolve(false);
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return Promise.resolve(true);
    }
    const bytes = this.eventBytes(value);
    if (this.canAccept(bytes)) {
      this.values.push(value);
      this.valueBytes += bytes;
      return Promise.resolve(true);
    }
    if (this.pending.length >= MAX_EVENT_QUEUE_PENDING_ITEMS
      || this.pendingBytes + bytes > MAX_EVENT_QUEUE_PENDING_BYTES) {
      return Promise.reject(new Error("Claude provider event queue is full"));
    }
    this.pendingBytes += bytes;
    return new Promise((resolve, reject) => this.pending.push({ value, bytes, resolve, reject }));
  }

  /** Queue a terminal event without waiting for consumer capacity. */
  pushTerminal(value: LocalRuntimeProviderEvent): void {
    if (this.failure || this.terminalValue) return;
    this.ended = true;
    this.terminalValue = value;
    this.drainPending();
    this.finishIfDrained();
  }

  end(): void {
    if (this.failure) return;
    this.ended = true;
    this.drainPending();
    this.finishIfDrained();
  }

  fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error;
    this.ended = true;
    this.pendingBytes = 0;
    while (this.pending.length > 0) this.pending.shift()?.reject(error);
    this.finishIfDrained();
  }

  private eventBytes(value: LocalRuntimeProviderEvent): number {
    try {
      return Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch {
      return MAX_EVENT_QUEUE_BYTES;
    }
  }

  private canAccept(bytes: number): boolean {
    return bytes <= MAX_EVENT_QUEUE_BYTES
      && this.values.length < MAX_EVENT_QUEUE_ITEMS
      && this.valueBytes + bytes <= MAX_EVENT_QUEUE_BYTES;
  }

  private drainPending(): void {
    while (this.pending.length > 0) {
      const next = this.pending[0];
      if (!next || !this.canAccept(next.bytes)) break;
      this.pending.shift();
      this.pendingBytes = Math.max(0, this.pendingBytes - next.bytes);
      this.values.push(next.value);
      this.valueBytes += next.bytes;
      next.resolve(true);
    }
  }

  private finishIfDrained(): void {
    if (this.values.length > 0 || this.pending.length > 0) return;
    if (this.terminalValue) {
      const waiter = this.waiters.shift();
      if (waiter) {
        const terminal = this.terminalValue;
        this.terminalValue = null;
        waiter.resolve({ done: false, value: terminal });
      }
      return;
    }
    if (this.failure) {
      while (this.waiters.length) this.waiters.shift()?.reject(this.failure);
      return;
    }
    if (this.ended) {
      while (this.waiters.length) this.waiters.shift()?.resolve({ done: true, value: undefined });
    }
  }

}

export type ClaudePermissionRequest = {
  requestId: string;
  toolName: string;
  toolUseId: string;
  input: Json;
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
  suggestions?: unknown[];
};

export type ClaudePermissionResolver = (request: ClaudePermissionRequest) => Promise<PermissionResult | null> | PermissionResult | null;

export type ClaudeQueryFactory = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeOptions }) => Query;

export type ClaudeAdapterOptions = {
  queryFactory?: ClaudeQueryFactory;
  permissionResolver?: ClaudePermissionResolver;
  /** Provider-owned configuration; never read from a remote command payload. */
  configDir?: string;
  env?: Record<string, string | undefined>;
  settingSources?: ClaudeSettingSource[];
  persistSession?: boolean;
  forwardSubagentText?: boolean;
  additionalDirectories?: string[];
  allowDangerouslySkipPermissions?: boolean;
};

type SessionOptions = {
  cwd: string;
  /** Physical replica root corresponding to the wire-level `/workspace`. */
  workspaceRoot?: string;
  providerSessionId: string | null;
  newSessionId: string;
  operation: Extract<LocalRuntimeOperation, "session.open" | "session.resume">;
  model: string | null;
  accessMode: "read_only" | "full_access";
  allowDangerouslySkipPermissions?: boolean;
  configDir?: string;
  settingSources?: ClaudeSettingSource[];
  persistSession?: boolean;
  forwardSubagentText?: boolean;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
  queryFactory?: ClaudeQueryFactory;
  permissionResolver?: ClaudePermissionResolver;
  signal?: AbortSignal;
};

type ActiveTurn = {
  turnId: string;
  /** UUID stamped onto the SDK user message that starts this turn. */
  inputUuid: string;
  context: ClaudeEventContext;
  events: EventQueue;
  /** Set after the first frame attributable to this input is observed. */
  bound: boolean;
  terminal: boolean;
};

function messageInputUuids(message: Json): string[] {
  const values: string[] = [];
  const single = nativeId(message.user_message_uuid);
  if (single) values.push(single);
  if (Array.isArray(message.user_message_uuids)) {
    for (const value of message.user_message_uuids) {
      const uuid = nativeId(value);
      if (uuid && !values.includes(uuid)) values.push(uuid);
    }
  }
  return values;
}

function taskIdentity(message: Json): string | undefined {
  return nativeId(message.tool_use_id) || nativeId(message.task_id);
}

function taskEvent(message: Json): boolean {
  if (message.type === "tool_progress") return true;
  if (message.type !== "system") return false;
  return message.subtype === "task_started"
    || message.subtype === "task_progress"
    || message.subtype === "task_notification"
    || message.subtype === "task_updated"
    || message.subtype === "permission_denied";
}

function turnFrame(message: Json): boolean {
  return message.type === "stream_event"
    || message.type === "assistant"
    || message.type === "user"
    || message.type === "result";
}

function abortError(reason: unknown): Error {
  const error = new Error(reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Claude turn aborted");
  error.name = "AbortError";
  return error;
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(abortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(error);
      },
    );
  });
}

/** Keep shutdown bounded when a native Claude process ignores close(). */
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
    const timer = setTimeout(() => settle(() => rejectPromise(new Error("Claude provider shutdown timed out"))), timeoutMs);
    timer.unref?.();
    void promise.then(
      (value) => settle(() => resolvePromise(value)),
      (error) => settle(() => rejectPromise(error)),
    );
  });
}

class ClaudeRuntimeSession implements LocalRuntimeSessionHandle {
  private readonly inputQueue = new InputQueue();
  private readonly options: SessionOptions;
  private readonly expectedSessionId: string;
  private query: Query | null = null;
  private consumer: Promise<void> | null = null;
  private active: ActiveTurn | null = null;
  private closed = false;
  private currentModel: string | undefined;
  private currentAccessMode: "read_only" | "full_access";
  private currentPermissionMode: ClaudePermissionMode;
  private cumulativeCostUsd: number | null = null;
  private readonly queryAbortController = new AbortController();
  private queryAction: Promise<void> = Promise.resolve();
  private queryClosed = false;
  private queryEnded = false;
  private queryFailure: unknown = null;
  private removeSessionAbort: (() => void) | null = null;
  /**
   * Background task notifications may arrive after the result that closed a
   * turn. Keep the task ids already attributed to a completed turn so a late
   * notification cannot be mistaken for the next turn's first frame.
   */
  private readonly retiredTaskIds = new Set<string>();

  constructor(options: SessionOptions) {
    this.options = options;
    this.expectedSessionId = options.providerSessionId || options.newSessionId;
    this.currentModel = options.model || undefined;
    this.currentAccessMode = options.accessMode;
    this.currentPermissionMode = options.accessMode === "full_access" ? "acceptEdits" : "default";
    this.assertPermissionMode(this.currentPermissionMode, this.currentAccessMode);
    if (options.signal) {
      const abortQuery = () => {
        if (!this.queryAbortController.signal.aborted) this.queryAbortController.abort(options.signal?.reason);
      };
      if (options.signal.aborted) abortQuery();
      else {
        options.signal.addEventListener("abort", abortQuery, { once: true });
        this.removeSessionAbort = () => options.signal?.removeEventListener("abort", abortQuery);
      }
    }
  }

  get providerSessionId(): string { return this.expectedSessionId; }

  private queryOptions(): ClaudeOptions {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this.options.env,
      ...(this.options.configDir ? { CLAUDE_CONFIG_DIR: this.options.configDir } : {}),
    };
    // Match the SDK's own defaulting: an embedding host may intentionally
    // provide a different entrypoint through its inherited environment.
    if (!env.CLAUDE_CODE_ENTRYPOINT) env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
    const sessionIdentity = this.options.operation === "session.open"
      ? { sessionId: this.options.newSessionId }
      : { resume: this.options.providerSessionId as string };
    return {
      cwd: this.options.cwd,
      env,
      abortController: this.queryAbortController,
      includePartialMessages: true,
      ...(this.options.settingSources ? { settingSources: this.options.settingSources } : {}),
      ...(this.options.persistSession !== undefined ? { persistSession: this.options.persistSession } : {}),
      ...(this.options.forwardSubagentText !== undefined ? { forwardSubagentText: this.options.forwardSubagentText } : {}),
      permissionMode: this.currentPermissionMode,
      permissionPrompts: "host",
      ...(this.currentAccessMode === "read_only"
        ? {
            tools: [...CLAUDE_READ_ONLY_TOOL_NAMES],
            disallowedTools: [...CLAUDE_MUTATING_TOOL_NAMES],
          }
        : {}),
      hooks: { PreToolUse: [{ hooks: [this.guardToolUse] }] },
      ...sessionIdentity,
      ...(this.currentModel ? { model: this.currentModel } : {}),
      ...(this.options.additionalDirectories?.length ? { additionalDirectories: this.options.additionalDirectories } : {}),
      ...(this.options.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: this.canUseTool,
    };
  }

  private enqueueQueryAction(action: () => Promise<void> | void): Promise<void> {
    const next = this.queryAction.then(() => action());
    this.queryAction = next.then(() => undefined, () => undefined);
    return next;
  }

  private async closeNativeQuery(): Promise<void> {
    const query = this.query;
    if (!query || this.queryClosed) return;
    await this.enqueueQueryAction(async () => {
      if (this.queryClosed) return;
      this.queryClosed = true;
      query.close();
    });
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, details) => {
    const active = this.active;
    const request: ClaudePermissionRequest = {
      requestId: nativeId(details.requestId) || randomUUID(),
      toolName,
      toolUseId: nativeId(details.toolUseID) || nativeId(details.requestId) || randomUUID(),
      input,
      ...(details.blockedPath ? { blockedPath: details.blockedPath } : {}),
      ...(details.decisionReason ? { decisionReason: details.decisionReason } : {}),
      ...(details.title ? { title: details.title } : {}),
      ...(details.displayName ? { displayName: details.displayName } : {}),
      ...(details.description ? { description: details.description } : {}),
      ...(details.suggestions ? { suggestions: details.suggestions } : {}),
    };
    const emitPermissionRequest = async (reason?: string): Promise<void> => {
      if (!active) return;
      await active.events.push(event(active.context, "permission.requested", {
        requestId: request.requestId,
        toolId: request.toolUseId,
        name: toolName,
        input,
        ...(details.suggestions ? { options: details.suggestions } : {}),
        metadata: metadata({ type: "permission_request" }, {
          toolName,
          accessMode: this.currentAccessMode,
          ...(reason ? { reason } : {}),
        }),
        }, request.requestId));
    };
    const deny = async (reason: string): Promise<PermissionResult> => {
      await emitPermissionRequest(reason);
      return { behavior: "deny", message: reason, decisionClassification: "user_reject" };
    };
    const blockedPath = stringValue(details.blockedPath);
    if (blockedPath && !(await workspacePathAllowed(blockedPath, this.options.cwd, this.options.workspaceRoot))) {
      return deny(`Tool ${toolName} requested a path outside the authorized workspace`);
    }
    const inputError = await this.toolInputError(toolName, input);
    if (inputError) return deny(inputError);
    if (this.currentAccessMode === "read_only") {
      const normalizedToolName = toolName.trim().toLowerCase();
      if (!CLAUDE_READ_ONLY_TOOLS.has(normalizedToolName)) {
        const reason = `Tool ${toolName} is unavailable in read-only mode`;
        return deny(reason);
      }
      // The native bridge sets blockedPath when a read crosses its allowed
      // directory boundary. There is no response channel to safely override it.
      if (blockedPath) {
        const reason = `Tool ${toolName} requested a blocked path`;
        return deny(reason);
      }
    }
    const defaultUpdatedInput = mappedToolInput(toolName, input, this.options.cwd, this.options.workspaceRoot);
    if (!this.options.permissionResolver) {
      return defaultUpdatedInput ? { behavior: "allow", updatedInput: defaultUpdatedInput } : { behavior: "allow" };
    }
    await emitPermissionRequest();
    try {
      const decision = normalizePermission(await raceAbort(Promise.resolve(this.options.permissionResolver(request)), details.signal));
      if (decision.behavior === "allow") {
        const decisionInput = decision.updatedInput ?? input;
        const updatedInputError = await this.toolInputError(toolName, decisionInput);
        if (updatedInputError) return deny(updatedInputError);
        const mapped = mappedToolInput(toolName, decisionInput, this.options.cwd, this.options.workspaceRoot);
        if (mapped) return { ...decision, updatedInput: mapped };
      }
      return decision;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Permission request failed";
      return { behavior: "deny", message, decisionClassification: "user_reject" };
    }
  };

  /** Enforce the server-authorized mode even when native allow rules shadow canUseTool. */
  private readonly guardToolUse: HookCallback = async (hookInput): Promise<HookJSONOutput> => {
    if (hookInput.hook_event_name !== "PreToolUse") return {};
    const toolName = hookInput.tool_name;
    const input = hookInput.tool_input;
    const normalized = toolName.trim().toLowerCase();
    if (this.currentAccessMode === "read_only" && !CLAUDE_READ_ONLY_TOOLS.has(normalized)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Tool ${toolName} is unavailable in read-only mode`,
        },
      };
    }
    const inputError = await this.toolInputError(toolName, input);
    if (inputError) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: inputError,
        },
      };
    }
    const updatedInput = mappedToolInput(toolName, record(input), this.options.cwd, this.options.workspaceRoot);
    return updatedInput
      ? { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } }
      : {};
  };

  private assertPermissionMode(mode: ClaudePermissionMode, accessMode: "read_only" | "full_access"): void {
    if (accessMode === "read_only" && CLAUDE_ESCALATING_PERMISSION_MODES.has(mode)) {
      throw new Error(`Claude permissionMode ${mode} is unavailable in read-only mode`);
    }
    if (mode === "bypassPermissions" && !this.options.allowDangerouslySkipPermissions) {
      throw new Error("Claude bypassPermissions requires explicit local opt-in");
    }
  }

  private async toolInputError(toolName: string, input: unknown): Promise<string | undefined> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return `Tool ${toolName} provided invalid input`;
    }
    const normalizedInput = input as Json;
    if (hasInvalidToolPath(toolName, normalizedInput)) {
      return `Tool ${toolName} provided an invalid workspace path`;
    }
    if (toolName.trim().toLowerCase() === "glob" && !(await globPatternAllowed(normalizedInput.pattern, this.options.cwd, this.options.workspaceRoot))) {
      return `Tool ${toolName} provided a pattern outside the authorized workspace`;
    }
    for (const pathValue of toolInputPaths(toolName, normalizedInput)) {
      if (!(await workspacePathAllowed(pathValue, this.options.cwd, this.options.workspaceRoot))) {
        return `Tool ${toolName} requested a path outside the authorized workspace`;
      }
    }
    return undefined;
  }

  private static normalizeSessionError(error: unknown): { message: string; code: string } {
    const message = textValue(error instanceof Error ? error.message : String(error)) || "Claude provider failed";
    const explicitCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
    return { message, code: explicitCode || (error instanceof Error && error.name === "AbortError" ? "aborted" : "provider_error") };
  }

  private ensureQuery(): void {
    if (this.queryEnded) {
      const normalized = ClaudeRuntimeSession.normalizeSessionError(this.queryFailure ?? new Error("Claude query stream ended"));
      const error = new Error(`Claude provider query is no longer available: ${normalized.message}`) as Error & { code?: string };
      error.code = this.queryFailure ? normalized.code : "provider_stream_ended";
      throw error;
    }
    if (this.query) return;
    const factory = this.options.queryFactory || claudeQuery;
    this.query = factory({ prompt: this.inputQueue, options: this.queryOptions() });
    const query = this.query;
    this.consumer = this.consume(query);
    this.consumer.catch(() => undefined);
  }

  private retireTaskIds(active: ActiveTurn): void {
    for (const id of active.context.tools.keys()) this.retiredTaskIds.add(id);
    for (const value of active.context.partialTools.values()) this.retiredTaskIds.add(value.id);
    for (const [taskId, toolId] of active.context.taskToolIds) {
      this.retiredTaskIds.add(taskId);
      this.retiredTaskIds.add(toolId);
    }
    for (const [alias, toolId] of active.context.toolAliases) {
      this.retiredTaskIds.add(alias);
      this.retiredTaskIds.add(toolId);
    }
    // A hostile/native process should not be able to grow this set forever.
    while (this.retiredTaskIds.size > 4096) {
      const oldest = this.retiredTaskIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.retiredTaskIds.delete(oldest);
    }
  }

  /**
   * Bind native frames to the SDK user message that started the active turn.
   * New SDKs stamp the first reply (and result) with that UUID. Older SDKs do
   * not, so we retain a conservative legacy fallback while dropping generic
   * informational frames that can legally follow a terminal result.
   */
  private acceptsMessage(message: Json, active: ActiveTurn): boolean {
    if (active.terminal) return false;
    // Replay frames carry no current-turn UUID and would otherwise bind an
    // unstarted turn to stale history before the first live reply arrives.
    if (message.type === "user" && message.isReplay === true) return false;
    if (message.type === "user" && !active.bound) {
      // Tool results are emitted as synthetic user frames by Claude. A result
      // that arrives after the previous turn's terminal frame has no
      // user_message_uuid, so without this fence it could become the first
      // frame of the next turn and project a duplicate completion.
      const content = record(message.message).content;
      const toolIds = Array.isArray(content)
        ? content.flatMap((value) => {
            const block = record(value);
            const id = nativeId(block.tool_use_id);
            return block.type === "tool_result" && id ? [id] : [];
          })
        : [];
      if (toolIds.length > 0 && toolIds.every((id) => this.retiredTaskIds.has(id))) return false;
    }
    const uuids = messageInputUuids(message);
    if (uuids.length > 0) {
      if (!uuids.includes(active.inputUuid)) {
        // A result for another queued/stale input would otherwise leave this
        // turn waiting forever. Surface an explicit correlation failure.
        if (message.type === "result") {
          active.terminal = true;
            active.events.pushTerminal(event(active.context, "turn.failed", {
            status: "turn_failed",
            message: "Claude provider returned a result for a different input",
            code: "turn_correlation_mismatch",
          }, nativeId(message.uuid)));
          active.events.end();
          this.retireTaskIds(active);
        }
        return false;
      }
      active.bound = true;
      return true;
    }

    if (taskEvent(message)) {
      const id = taskIdentity(message);
      // Task bookends are normally emitted before their notification. A task
      // id seen on a prior turn is therefore a reliable late-message marker;
      // unknown ids are allowed to preserve old SDKs that omit UUID stamps.
      if (id && this.retiredTaskIds.has(id) && !active.context.tools.has(id)) return false;
      if (!active.bound) active.bound = true;
      return true;
    }

    if (message.type === "keep_alive") return false;
    if (!active.bound && message.type === "system" && message.subtype !== "init") {
      // Non-init system messages (notifications, status banners, etc.) may be
      // emitted after a result. Do not let one become the apparent next turn.
      return false;
    }
    if (message.type === "system" && message.subtype === "init") return true;
    if (turnFrame(message)) {
      active.bound = true;
      return true;
    }
    // Unknown informational message types are safe to pass through only once
    // a turn has already been bound; mapClaudeMessage will intentionally ignore
    // types it does not understand.
    return active.bound;
  }

  private permissionMode(value: unknown): ClaudePermissionMode | undefined {
    if (typeof value !== "string" || !CLAUDE_PERMISSION_MODES.has(value)) return undefined;
    return value as ClaudePermissionMode;
  }

  private async applyTurnOptions(input: LocalRuntimePromptInput): Promise<void> {
    const options = input.options || {};
    const requestedCwd = stringValue(options.cwd);
    if (requestedCwd && resolve(requestedCwd) !== resolve(this.options.cwd)) {
      throw new Error("Claude provider cwd cannot change within a session");
    }

    let nextModel = this.currentModel;
    if (Object.hasOwn(options, "model")) {
      const model = options.model;
      if (model === null || model === "") nextModel = undefined;
      else if (typeof model === "string" && model.trim()) nextModel = model.trim();
      else throw new Error("Claude provider model must be a non-empty string or null");
    }

    let nextPermissionMode = this.currentPermissionMode;
    const requestedPermissionValue = options.permissionMode;
    const requestedPermissionMode = this.permissionMode(requestedPermissionValue);
    if (requestedPermissionValue !== undefined && requestedPermissionMode === undefined) {
      throw new Error("Claude provider permissionMode is invalid");
    }
    if (requestedPermissionMode) nextPermissionMode = requestedPermissionMode;
    let nextAccessMode = this.currentAccessMode;
    const requestedAccessMode = options.accessMode;
    if (requestedAccessMode !== undefined) {
      if (requestedAccessMode !== "read_only" && requestedAccessMode !== "full_access") {
        throw new Error("Claude provider accessMode is invalid");
      }
      if (requestedAccessMode === "full_access" && this.options.accessMode !== "full_access") {
        throw new Error("Claude provider accessMode cannot widen a read-only session");
      }
      nextAccessMode = requestedAccessMode;
      if (requestedPermissionValue === undefined) {
        nextPermissionMode = requestedAccessMode === "full_access" ? "acceptEdits" : "default";
      }
    }
    this.assertPermissionMode(nextPermissionMode, nextAccessMode);

    const query = this.query;
    if (!query) throw new Error("Claude query is not initialized");
    if (nextModel !== this.currentModel && typeof query.setModel === "function") {
      await query.setModel(nextModel);
    }
    if ((nextPermissionMode !== this.currentPermissionMode || requestedPermissionValue !== undefined || requestedAccessMode !== undefined)
      && typeof query.setPermissionMode === "function") {
      await query.setPermissionMode(nextPermissionMode);
    }
    this.currentAccessMode = nextAccessMode;
    this.currentModel = nextModel;
    this.currentPermissionMode = nextPermissionMode;
  }

  private async consume(query: Query): Promise<void> {
    try {
      for await (const message of query) {
        const raw = record(message);
        const nativeSessionId = providerIdValue(raw.session_id);
        if (typeof raw.session_id === "string" && (!nativeSessionId || nativeSessionId !== this.expectedSessionId)) {
          const active = this.active;
          if (active && !active.terminal) {
            active.terminal = true;
            active.events.pushTerminal(event(active.context, "turn.failed", { status: "turn_failed", message: "Claude provider returned a different session id", code: "session_id_mismatch" }, nativeId(raw.uuid)));
            active.events.end();
          }
          void this.closeNativeQuery();
          return;
        }
        const active = this.active;
        if (!active) continue;
        if (!this.acceptsMessage(raw, active)) continue;
        for (const output of mapClaudeMessage(message, active.context)) {
          await active.events.push(output);
          if (output.kind === "turn.completed" || output.kind === "turn.failed") {
            active.terminal = true;
            active.events.end();
            this.retireTaskIds(active);
          }
        }
        this.cumulativeCostUsd = active.context.cumulativeCostUsd;
      }
      const active = this.active;
      if (active && !active.terminal) {
        active.terminal = true;
        active.events.pushTerminal(event(active.context, "turn.failed", { status: "turn_failed", message: "Claude stream ended before a result", code: "provider_stream_ended" }));
        active.events.end();
        this.retireTaskIds(active);
      }
    } catch (error) {
      this.queryFailure = error;
      const active = this.active;
      if (active && !active.terminal) {
        active.terminal = true;
        const normalized = ClaudeRuntimeSession.normalizeSessionError(error);
        active.events.pushTerminal(event(active.context, "turn.failed", { status: "turn_failed", message: normalized.message, code: normalized.code, ...(normalized.code === "aborted" ? { aborted: true } : {}) }));
        active.events.end();
        this.retireTaskIds(active);
      }
    } finally {
      // A Query is single-lived: once its async iterator exits, writes to the
      // input stream can no longer produce a turn. Close the queue so future
      // runs fail synchronously instead of waiting forever.
      this.queryEnded = true;
      this.inputQueue.end();
    }
  }

  async *run(input: LocalRuntimePromptInput, signal?: AbortSignal): AsyncIterable<LocalRuntimeProviderEvent> {
    if (this.closed) throw new Error("Claude provider session is closed");
    if (this.active) throw new Error("Claude provider session already has an active turn");
    const mergedSignal = mergeAbortSignals([this.options.signal, signal]);
    const activeSignal = mergedSignal.signal;
    if (activeSignal?.aborted) throw abortError(activeSignal.reason);
    const turnId = randomUUID();
    const inputUuid = randomUUID();
    const active: ActiveTurn = {
      turnId,
      inputUuid,
      context: createClaudeEventContext(
        this.providerSessionId,
        turnId,
        this.cumulativeCostUsd,
        this.options.forwardSubagentText === true,
      ),
      events: new EventQueue(),
      bound: false,
      terminal: false,
    };
    this.active = active;
    const abort = () => { void this.cancel("runtime cancellation requested"); };
    activeSignal?.addEventListener("abort", abort, { once: true });
    try {
      yield event(active.context, "turn.started", {}, `${turnId}:started`);
      if (!active.terminal) {
        if (activeSignal?.aborted) throw abortError(activeSignal.reason);
        // Validate and normalize the prompt before starting the native query.
        // Otherwise a fast-ending SDK stream can race this work and replace a
        // deterministic input error with a misleading stream-ended failure.
        const message = await promptMessage(input, this.options.cwd, this.options.workspaceRoot);
        if (activeSignal?.aborted && !active.terminal) throw abortError(activeSignal.reason);
        if (active.terminal) {
          // A cancellation may have arrived while image/path validation was
          // awaiting the filesystem; do not initialize a new native query.
          for await (const output of active.events) yield output;
          return;
        }
        this.ensureQuery();
        await this.applyTurnOptions(input);
        if (activeSignal?.aborted && !active.terminal) throw abortError(activeSignal.reason);
        if (!active.terminal) {
          this.inputQueue.write({ type: "user", session_id: this.providerSessionId, message, parent_tool_use_id: null, uuid: inputUuid as SDKUserMessage["uuid"] });
        }
      }
      for await (const output of active.events) yield output;
    } catch (error) {
      if (!active.terminal) {
        active.terminal = true;
        const normalized = ClaudeRuntimeSession.normalizeSessionError(error);
        active.events.pushTerminal(event(active.context, "turn.failed", { status: "turn_failed", message: normalized.message, code: normalized.code, ...(normalized.code === "aborted" ? { aborted: true } : {}) }));
        active.events.end();
      }
      // Cancellation may have happened while the generator was suspended at
      // the initial turn.started yield. Drain the already-queued terminal
      // event so callers never observe a turn with no outcome.
      for await (const output of active.events) yield output;
    } finally {
      // A consumer can close its async iterator without draining the native
      // turn (for example, after receiving the first text delta). Interrupt
      // that turn before releasing `active`, otherwise the SDK can continue
      // producing frames that race with the next run.
      if (!active.terminal && !this.closed) {
        await this.cancel("Claude turn iterator closed");
      }
      mergedSignal.cleanup();
      activeSignal?.removeEventListener("abort", abort);
      if (this.active === active) this.active = null;
    }
  }

  async cancel(reason = "Claude turn cancelled"): Promise<void> {
    if (this.closed) return;
    const active = this.active;
    if (active && !active.terminal) {
      active.terminal = true;
      active.events.pushTerminal(event(active.context, "turn.failed", { status: "turn_failed", message: reason, code: "cancelled", aborted: true }));
      active.events.end();
      this.retireTaskIds(active);
    }
    const query = this.query;
    if (query && !this.queryClosed && typeof query.interrupt === "function") {
      await this.enqueueQueryAction(async () => {
        if (!this.queryClosed) await query.interrupt();
      }).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active = this.active;
    if (active && !active.terminal) {
      active.terminal = true;
      active.events.pushTerminal(event(active.context, "turn.failed", { status: "turn_failed", message: "Claude provider session closed", code: "session_closed", aborted: true }));
      active.events.end();
      this.retireTaskIds(active);
    }
    this.inputQueue.end();
    this.removeSessionAbort?.();
    this.removeSessionAbort = null;
    if (!this.queryAbortController.signal.aborted) this.queryAbortController.abort(new Error("Claude provider session closed"));
    await raceTimeout(this.closeNativeQuery()).catch(() => undefined);
    if (this.consumer) await raceTimeout(this.consumer).catch(() => undefined);
    this.query = null;
    this.consumer = null;
  }
}

function normalizePermission(value: PermissionResult | null | undefined): PermissionResult {
  if (value?.behavior === "allow" || value?.behavior === "deny") return value;
  return { behavior: "deny", message: "Permission denied by local runtime", decisionClassification: "user_reject" };
}

function settingSources(value: unknown): ClaudeSettingSource[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !CLAUDE_SETTING_SOURCES.has(entry))) {
    throw new Error("Claude provider settingSources must contain only user, project, or local");
  }
  return [...new Set(value)] as ClaudeSettingSource[];
}

function environment(value: unknown): Record<string, string | undefined> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Claude provider env must be an object");
  const result: Record<string, string | undefined> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Claude provider env key is invalid: ${key}`);
    if (entry !== undefined && typeof entry !== "string") throw new Error(`Claude provider env value must be a string: ${key}`);
    result[key] = entry;
  }
  return result;
}

function booleanOption(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Claude provider ${name} must be a boolean`);
  return value;
}

function sessionOptions(input: LocalRuntimeSessionInput, adapterOptions: ClaudeAdapterOptions): SessionOptions {
  const workspaceRootValue = typeof input.workspaceRoot === "string" ? input.workspaceRoot.trim() : "";
  if (input.workspaceRoot !== undefined && (!workspaceRootValue || !isAbsolute(workspaceRootValue))) {
    throw new Error("Claude provider workspaceRoot must be an absolute path");
  }
  const workspaceRoot = workspaceRootValue ? resolve(workspaceRootValue) : undefined;
  if (input.accessMode !== undefined && input.accessMode !== "read_only" && input.accessMode !== "full_access") {
    throw new Error("Claude provider accessMode is invalid");
  }
  const providerSessionId = typeof input.providerSessionId === "string" ? input.providerSessionId.trim() || null : null;
  const operation = input.operation ?? (providerSessionId ? "session.resume" : "session.open");
  if (operation !== "session.open" && operation !== "session.resume") {
    throw new Error("Claude provider session operation is invalid");
  }
  if (operation === "session.open" && providerSessionId) {
    throw new Error("Claude provider session.open must not include a providerSessionId");
  }
  if (operation === "session.resume" && !providerSessionId) {
    throw new Error(`Claude provider ${operation} requires a providerSessionId`);
  }
  const newSessionId = providerSessionId || randomUUID();
  // Access mode is an authorization decision from the runtime command.
  const accessMode = input.accessMode === "full_access" ? "full_access" : "read_only";
  const additionalDirectories = Array.isArray(adapterOptions.additionalDirectories)
    ? adapterOptions.additionalDirectories
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => workspaceCandidate(value, input.cwd, workspaceRoot ?? input.cwd))
    : undefined;
  if (additionalDirectories?.some((directory) => !pathInside(workspaceFenceRoot(input.cwd, workspaceRoot), directory))) {
    throw new Error("Claude provider additionalDirectories must stay inside the workspace");
  }
  const configDirValue = stringValue(adapterOptions.configDir);
  if (adapterOptions.configDir !== undefined && !configDirValue) throw new Error("Claude provider configDir must be a non-empty string");
  const configDir = configDirValue ? resolve(configDirValue) : undefined;
  const persistSession = booleanOption(adapterOptions.persistSession, "persistSession");
  const forwardSubagentText = booleanOption(adapterOptions.forwardSubagentText, "forwardSubagentText");
  const allowDangerouslySkipPermissions = booleanOption(adapterOptions.allowDangerouslySkipPermissions, "allowDangerouslySkipPermissions") === true;
  if (operation === "session.resume" && persistSession === false) {
    throw new Error(`Claude ${operation} requires persistSession to remain enabled`);
  }
  let requestedModel: string | undefined;
  if (input.model !== undefined && input.model !== null) {
    if (typeof input.model !== "string") {
      throw new Error("Claude provider model must be a string or null");
    }
    requestedModel = input.model.trim() || undefined;
  }
  return {
    cwd: input.cwd,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    providerSessionId,
    newSessionId,
    operation,
    model: requestedModel || null,
    accessMode,
    allowDangerouslySkipPermissions,
    ...(configDir ? { configDir } : {}),
    settingSources: settingSources(adapterOptions.settingSources),
    persistSession: persistSession === undefined ? true : persistSession,
    forwardSubagentText,
    env: environment(adapterOptions.env),
    additionalDirectories,
    signal: input.signal,
  };
}

/** Native Claude Code adapter. The SDK stays local; only normalized events cross the runtime wire. */
export class ClaudeAdapter implements LocalProviderAdapter {
  readonly provider = "claude_code" as const;

  private readonly adapterOptions: ClaudeAdapterOptions;

  constructor(options: ClaudeAdapterOptions | ClaudeQueryFactory = {}) {
    this.adapterOptions = typeof options === "function" ? { queryFactory: options } : options ?? {};
  }

  async open(input: LocalRuntimeSessionInput): Promise<LocalRuntimeSessionHandle> {
    const options = sessionOptions(input, this.adapterOptions);
    if (!isAbsolute(options.cwd)) throw new Error("Claude provider cwd must be absolute");
    if (options.workspaceRoot) {
      options.workspaceRoot = await canonicalWorkspaceRoot(options.workspaceRoot);
      // The runner normally fences cwd before calling an adapter, but adapters
      // are also a public embedding boundary. Do not let a direct caller point
      // Claude at a sibling or parent directory while supplying a replica root.
      const canonicalCwd = await canonicalWorkspaceRoot(options.cwd);
      if (!pathInside(options.workspaceRoot, canonicalCwd)) {
        throw new Error("Claude provider cwd must stay inside the workspace");
      }
    }
    if (options.providerSessionId && !validUuid(options.providerSessionId)) throw new Error("Claude provider session id must be a UUID");
    for (const directory of options.additionalDirectories ?? []) {
      if (!(await workspacePathAllowed(directory, options.cwd, options.workspaceRoot))) {
        throw new Error("Claude provider additionalDirectories must stay inside the workspace");
      }
    }
    if (options.configDir) await mkdir(options.configDir, { recursive: true, mode: 0o700 });
    options.queryFactory = this.adapterOptions.queryFactory;
    options.permissionResolver = this.adapterOptions.permissionResolver;
    return new ClaudeRuntimeSession(options);
  }
}
