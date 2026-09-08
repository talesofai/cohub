import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import type { LocalProviderAdapter, LocalRuntimeCommand, LocalRuntimeEvent, LocalRuntimeProvider, LocalRuntimeProviderEvent, LocalRuntimeSessionHandle, LocalRuntimeSessionInput } from "@cohub/protocol";
import {
  LocalRuntimeCommandSchema,
  LocalRuntimeEventSchema,
  LocalRuntimeProviderEventSchema,
} from "@cohub/protocol";
import {
  LOCAL_RUNTIME_MAX_EVENT_BYTES,
  LOCAL_RUNTIME_MAX_FRAME_BYTES,
  LOCAL_RUNTIME_MAX_FRAME_BYTES_HARD,
  LOCAL_RUNTIME_MAX_COMMANDS,
  LOCAL_RUNTIME_MAX_SESSIONS,
  type LocalRuntimeAdapterFactory,
  type LocalRuntimeAdapterRegistry,
  type LocalRuntimeLogger,
  type LocalRuntimeRunnerOptions,
} from "./types.js";
import { providerIdValue } from "./provider-identity.js";
import { pathInside, resolveWorkspacePath } from "./providers/workspace-path.js";

const DEFAULT_CANCEL_GRACE_MS = 5_000;
const DEFAULT_MAX_RETAINED_COMMAND_EVENTS = 128;
type InputChunk = Uint8Array | ArrayBuffer | string | unknown;

type RuntimeSessionState = {
  runtimeSessionId: string;
  cohubSessionId: string;
  provider: LocalRuntimeProvider;
  cwd: string;
  /** Access mode is a session ceiling; turns may narrow it but never widen it. */
  accessMode: "read_only" | "full_access";
  connectionEpoch: number;
  providerSessionId: string;
  /** Codex creates its native thread id lazily on the first stream event. */
  providerSessionIdProvisional: boolean;
  adapter: LocalProviderAdapter;
  handle: LocalRuntimeSessionHandle;
  sequence: number;
  status: "active" | "closed" | "error";
  lastError: string | null;
};

type CommandState = {
  fingerprint: string;
  status: "prepared" | "sent" | "completed" | "failed";
  events: LocalRuntimeEvent[];
};

type ActiveTurn = {
  command: LocalRuntimeCommand;
  session: RuntimeSessionState;
  controller: AbortController;
  done: Promise<void>;
  cancelRequested: boolean;
  cancelIssued: boolean;
  terminal: boolean;
  retainedEvents: LocalRuntimeEvent[];
};

type EventContext = {
  session: RuntimeSessionState;
  command: LocalRuntimeCommand | null;
  turnId: string | null;
  executionAttemptId: string | null;
};

const PROVISIONAL_PROVIDER_SESSION_PREFIX = "pending:";

function provisionalProviderSessionId(runtimeSessionId: string): string {
  return `${PROVISIONAL_PROVIDER_SESSION_PREFIX}${runtimeSessionId}`;
}

function isProvisionalProviderSessionId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PROVISIONAL_PROVIDER_SESSION_PREFIX);
}

/**
 * Resolve the existing portion of a path before applying the workspace fence.
 *
 * `resolve()` alone is insufficient here: a lexical child can traverse a
 * symlink to an entirely different tree. Walking up to the nearest existing
 * parent also covers writes to paths that do not exist yet.
 */
function realpathForWorkspaceFence(candidate: string): string | null {
  let probe = candidate;
  while (true) {
    try {
      const resolvedProbe = realpathSync.native(probe);
      const suffix = relative(probe, candidate);
      return suffix ? resolve(resolvedProbe, suffix) : resolvedProbe;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

function providerSessionIdValue(value: unknown): string | null {
  return providerIdValue(value);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const textValue = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const boundedMessage = (value: unknown, fallback: string, max = 4_096): string => {
  const message = value instanceof Error
    ? value.message
    : typeof value === "string"
      ? value
      : String(value);
  const trimmed = message.trim() || fallback;
  if (Buffer.byteLength(trimmed, "utf8") <= max) return trimmed;
  const bytes = Buffer.from(trimmed, "utf8").subarray(0, max);
  return bytes.toString("utf8").replace(/[\uFFFD]$/, "") || fallback;
};

/** Stable enough for command-id reuse checks; arrays retain their order. */
function stableJson(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (typeof value === "undefined") return "null";
  if (typeof value !== "object") return JSON.stringify(String(value));
  if (ancestors.has(value)) throw new Error("cyclic JSON value");
  ancestors.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => stableJson(item, ancestors)).join(",")}]`;
  } else {
    const object = value as Record<string, unknown>;
    result = `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key], ancestors)}`).join(",")}}`;
  }
  ancestors.delete(value);
  return result;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function asUint8Array(chunk: InputChunk): Uint8Array {
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  throw new LocalRuntimeRunnerError("input stream emitted a non-text chunk", "invalid_input_chunk");
}

function errorCode(error: unknown, fallback = "runtime_error"): string {
  if (error instanceof LocalRuntimeRunnerError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return fallback;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && (error.name === "AbortError" || /\babort(?:ed|ing)?\b/i.test(error.message))) return true;
  return false;
}

function adapterFromRegistry(
  registry: LocalRuntimeAdapterRegistry | undefined,
  provider: LocalRuntimeProvider,
): LocalRuntimeAdapterFactory | undefined {
  if (!registry) return undefined;
  if (registry instanceof Map) return registry.get(provider);
  if (typeof registry === "object" && !Array.isArray(registry) && "open" in registry) {
    return (registry as unknown as LocalProviderAdapter).provider === provider
      ? registry as unknown as LocalProviderAdapter
      : undefined;
  }
  if (typeof registry === "object" && !Array.isArray(registry) && provider in registry) {
    return (registry as Partial<Record<LocalRuntimeProvider, LocalRuntimeAdapterFactory>>)[provider];
  }
  if (typeof (registry as Iterable<LocalProviderAdapter>)[Symbol.iterator] !== "function") return undefined;
  for (const adapter of registry as Iterable<LocalProviderAdapter>) {
    if (adapter.provider === provider) return adapter;
  }
  return undefined;
}

async function writeChunk(output: NodeJS.WritableStream, chunk: string): Promise<void> {
  const state = output as NodeJS.WritableStream & { destroyed?: boolean; writableEnded?: boolean };
  if (state.destroyed || state.writableEnded) throw new LocalRuntimeRunnerError("runtime output is closed", "output_closed");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const emitter = output as NodeJS.WritableStream & {
      once?: (name: string, listener: (...args: unknown[]) => void) => unknown;
      removeListener?: (name: string, listener: (...args: unknown[]) => void) => unknown;
    };
    const cleanup = () => {
      emitter.removeListener?.("drain", onDrain);
      emitter.removeListener?.("error", onError);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    let writeReturned = false;
    let drainSeen = false;
    const onDrain = () => {
      drainSeen = true;
      if (writeReturned) finish();
    };
    const onError = (error: unknown) => finish(error);
    try {
      // Install listeners before write: small test streams are allowed to
      // invoke their callback synchronously, and a false return can emit
      // `drain` immediately.
      if (typeof emitter.once === "function") {
        emitter.once("error", onError);
        emitter.once("drain", onDrain);
      }
      let canContinue = true;
      let callbackError: Error | null | undefined;
      let callbackCalled = false;
      canContinue = output.write(chunk, "utf8", (error?: Error | null) => {
        callbackCalled = true;
        callbackError = error;
        if (!writeReturned) return;
        if (error) finish(error);
        else if (canContinue) finish();
      });
      writeReturned = true;
      if (callbackCalled && callbackError) finish(callbackError);
      else if (canContinue) finish();
      else if (drainSeen) finish();
      else if (typeof emitter.once !== "function") finish();
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * Decode LF-delimited JSON without relying on readline's Unicode line
 * splitting. The byte limit is enforced before JSON parsing, so malformed or
 * unterminated input cannot grow the process indefinitely.
 */
export async function* readLocalRuntimeFrames(
  input: NodeJS.ReadableStream,
  maxFrameBytes = LOCAL_RUNTIME_MAX_FRAME_BYTES,
): AsyncGenerator<{ value: unknown; line: number }> {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0 || maxFrameBytes > LOCAL_RUNTIME_MAX_FRAME_BYTES_HARD) {
    throw new LocalRuntimeRunnerError(`maxFrameBytes must be a positive integer no larger than ${LOCAL_RUNTIME_MAX_FRAME_BYTES_HARD}`, "invalid_limit");
  }
  let pending = Buffer.alloc(0);
  let lineNumber = 0;
  let firstLine = true;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of input as AsyncIterable<InputChunk>) {
    const bytes = asUint8Array(chunk);
    if (bytes.byteLength > 0) pending = Buffer.concat([pending, Buffer.from(bytes)]);
    while (true) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) {
        if (pending.byteLength > maxFrameBytes) {
          throw new LocalRuntimeRunnerError(`input frame exceeds ${maxFrameBytes} bytes`, "frame_too_large");
        }
        break;
      }
      const rawLine = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      lineNumber += 1;
      if (rawLine.byteLength > maxFrameBytes) {
        throw new LocalRuntimeRunnerError(`input frame exceeds ${maxFrameBytes} bytes at line ${lineNumber}`, "frame_too_large");
      }
      let line = rawLine;
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.byteLength - 1);
      if (firstLine && line.byteLength >= 3 && line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf) {
        line = line.subarray(3);
      }
      firstLine = false;
      if (line.every((byte) => byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a)) continue;
      let text: string;
      try {
        text = decoder.decode(line, { stream: false });
      } catch {
        throw new LocalRuntimeRunnerError(`input frame is not valid UTF-8 at line ${lineNumber}`, "invalid_encoding");
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (error) {
        throw new LocalRuntimeRunnerError(`invalid JSON at line ${lineNumber}: ${boundedMessage(error, "invalid JSON", 512)}`, "invalid_json");
      }
      yield { value, line: lineNumber };
    }
  }
  if (pending.byteLength > maxFrameBytes) {
    throw new LocalRuntimeRunnerError(`input frame exceeds ${maxFrameBytes} bytes`, "frame_too_large");
  }
  if (pending.byteLength === 0) return;
  let line = pending;
  lineNumber += 1;
  if (line.at(-1) === 0x0d) line = line.subarray(0, line.byteLength - 1);
  if (line.every((byte) => byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a)) return;
  let text: string;
  try {
    text = decoder.decode(line, { stream: false });
  } catch {
    throw new LocalRuntimeRunnerError(`input frame is not valid UTF-8 at line ${lineNumber}`, "invalid_encoding");
  }
  try {
    yield { value: JSON.parse(text), line: lineNumber };
  } catch (error) {
    throw new LocalRuntimeRunnerError(`invalid JSON at line ${lineNumber}: ${boundedMessage(error, "invalid JSON", 512)}`, "invalid_json");
  }
}

export class LocalRuntimeRunnerError extends Error {
  readonly code: string;

  constructor(message: string, code = "runtime_error") {
    super(message);
    this.name = "LocalRuntimeRunnerError";
    this.code = code;
  }
}

export class LocalRuntimeRunner {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly adapters?: LocalRuntimeAdapterRegistry;
  private readonly adapterFactory?: LocalRuntimeRunnerOptions["adapterFactory"];
  private readonly logger: LocalRuntimeLogger;
  private readonly maxFrameBytes: number;
  private readonly maxEventBytes: number;
  private readonly endOutput: boolean;
  private readonly externalSignal?: AbortSignal;
  private readonly workspaceRoot?: string;
  private readonly workspaceRootReal?: string;
  private readonly runtimeAbort = new AbortController();
  private readonly sessions = new Map<string, RuntimeSessionState>();
  private readonly commands = new Map<string, CommandState>();
  private expectedRuntimeId: string | undefined;
  private expectedSpaceId: string | undefined;
  private expectedExecutionAttemptId: string | undefined;
  private expectedProvider: LocalRuntimeProvider | undefined;
  private expectedConnectionEpoch: number | undefined;
  private activeTurn: ActiveTurn | null = null;
  private writeTail: Promise<void> = Promise.resolve();
  private runPromise: Promise<void> | null = null;
  private stopped = false;
  private removeExternalAbortListener: (() => void) | null = null;

  constructor(options: LocalRuntimeRunnerOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.adapters = options.adapters;
    this.adapterFactory = options.adapterFactory;
    this.logger = options.logger ?? {};
    this.maxFrameBytes = options.maxFrameBytes ?? LOCAL_RUNTIME_MAX_FRAME_BYTES;
    this.maxEventBytes = options.maxEventBytes ?? LOCAL_RUNTIME_MAX_EVENT_BYTES;
    this.endOutput = options.endOutput === true;
    this.externalSignal = options.signal;
    if (options.workspaceRoot !== undefined) {
      const workspaceRoot = options.workspaceRoot.trim();
      if (!workspaceRoot || !isAbsolute(workspaceRoot)) {
        throw new LocalRuntimeRunnerError("workspaceRoot must be an absolute path", "invalid_workspace");
      }
      this.workspaceRoot = resolve(workspaceRoot);
      this.workspaceRootReal = realpathForWorkspaceFence(this.workspaceRoot) ?? this.workspaceRoot;
    }
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes <= 0 || this.maxFrameBytes > LOCAL_RUNTIME_MAX_FRAME_BYTES_HARD) {
      throw new LocalRuntimeRunnerError(`maxFrameBytes must be a positive integer no larger than ${LOCAL_RUNTIME_MAX_FRAME_BYTES_HARD}`, "invalid_limit");
    }
    if (!Number.isSafeInteger(this.maxEventBytes) || this.maxEventBytes <= 0 || this.maxEventBytes > this.maxFrameBytes) {
      throw new LocalRuntimeRunnerError("maxEventBytes must be a positive integer no larger than maxFrameBytes", "invalid_limit");
    }
    this.expectedRuntimeId = options.runtimeId?.trim() || undefined;
    this.expectedSpaceId = options.spaceId?.trim() || undefined;
    this.expectedExecutionAttemptId = options.executionAttemptId?.trim() || undefined;
    if (options.executionAttemptId !== undefined && !this.expectedExecutionAttemptId) {
      throw new LocalRuntimeRunnerError("executionAttemptId must not be empty", "invalid_identity");
    }
    this.expectedProvider = options.provider;
    this.expectedConnectionEpoch = options.connectionEpoch;
    if (this.expectedConnectionEpoch !== undefined && (!Number.isSafeInteger(this.expectedConnectionEpoch) || this.expectedConnectionEpoch < 1)) {
      throw new LocalRuntimeRunnerError("connectionEpoch must be a positive integer", "invalid_identity");
    }
    if (this.externalSignal) {
      const onAbort = () => this.stop(this.externalSignal?.reason);
      if (this.externalSignal.aborted) onAbort();
      else {
        this.externalSignal.addEventListener("abort", onAbort, { once: true });
        this.removeExternalAbortListener = () => this.externalSignal?.removeEventListener("abort", onAbort);
      }
    }
  }

  getSession(runtimeSessionId: string): Readonly<RuntimeSessionState> | null {
    return this.sessions.get(runtimeSessionId) ?? null;
  }

  get activeTurnId(): string | null {
    return this.activeTurn?.command.turnId ?? null;
  }

  /** Run until EOF, stop(), or an unrecoverable framing error. */
  run(): Promise<void> {
    if (this.runPromise) return this.runPromise;
    this.runPromise = this.runLoop();
    return this.runPromise;
  }

  /** Stop accepting commands and cancel provider work. Safe to call repeatedly. */
  stop(reason?: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.runtimeAbort.abort(reason instanceof Error ? reason : reason ? new Error(String(reason)) : undefined);
    } catch {
      // AbortController.abort is idempotent, but custom runtimes can monkey
      // patch globals; stopping must remain best effort.
    }
    const destroyable = this.input as NodeJS.ReadableStream & { destroy?: (error?: Error) => unknown };
    if (typeof destroyable.destroy === "function" && destroyable !== process.stdin) {
      try { destroyable.destroy(); } catch { /* already closed */ }
    }
  }

  private async runLoop(): Promise<void> {
    try {
      for await (const frame of readLocalRuntimeFrames(this.input, this.maxFrameBytes)) {
        if (this.stopped) break;
        await this.dispatchFrame(frame.value, frame.line);
      }
    } catch (error) {
      // `stop()` destroys non-stdin inputs to unblock an async iterator. Node
      // reports that deliberate close as ERR_STREAM_PREMATURE_CLOSE; it is not
      // a protocol failure and should not mask the original stop reason.
      if (!this.stopped) throw error;
    } finally {
      this.stopped = true;
      await this.shutdown();
      await this.writeTail.catch(() => undefined);
      this.removeExternalAbortListener?.();
      this.removeExternalAbortListener = null;
      if (this.endOutput) {
        const endable = this.output as NodeJS.WritableStream & { end?: () => void };
        try { endable.end?.(); } catch { /* output may already be closed */ }
      }
    }
  }

  private async dispatchFrame(value: unknown, line: number): Promise<void> {
    const parsed = LocalRuntimeCommandSchema.safeParse(value);
    if (!parsed.success) {
      throw new LocalRuntimeRunnerError(`invalid runtime command at line ${line}: ${parsed.error.message}`, "invalid_command");
    }
    const command = parsed.data;
    this.assertIdentity(command);
    const key = `${command.runtimeSessionId}:${command.commandId}`;
    const fingerprint = stableJson(command);
    const previous = this.commands.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new LocalRuntimeRunnerError("commandId was reused with different content", "command_id_reused");
      }
      // A retry is intentionally a no-op. Durable server ledgers replay the
      // original events; rerunning a provider turn here could mutate files a
      // second time after a relay retry.
      this.logger.debug?.("duplicate local runtime command ignored", { commandId: command.commandId, operation: command.operation });
      return;
    }
    if (this.commands.size >= LOCAL_RUNTIME_MAX_COMMANDS) {
      throw new LocalRuntimeRunnerError("runtime command state limit reached", "command_state_limit");
    }
    this.commands.set(key, { fingerprint, status: "prepared", events: [] });
    try {
      switch (command.operation) {
        case "session.open":
        case "session.resume":
        case "session.fork":
          await this.openSession(command);
          break;
        case "turn.start":
          await this.startTurn(command);
          break;
        case "turn.cancel":
          await this.cancelTurn(command);
          break;
        case "session.close":
          await this.closeSession(command);
          break;
      }
      const state = this.commands.get(key);
      if (state && state.status === "prepared") state.status = "completed";
    } catch (error) {
      const state = this.commands.get(key);
      if (state) state.status = "failed";
      await this.reportCommandFailure(command, error);
    }
  }

  private assertIdentity(command: LocalRuntimeCommand): void {
    if (this.expectedRuntimeId === undefined) this.expectedRuntimeId = command.runtimeId;
    if (this.expectedSpaceId === undefined) this.expectedSpaceId = command.spaceId;
    if (this.expectedProvider === undefined) this.expectedProvider = command.provider;
    if (this.expectedConnectionEpoch === undefined) this.expectedConnectionEpoch = command.connectionEpoch;
    if (command.runtimeId !== this.expectedRuntimeId) throw new LocalRuntimeRunnerError("runtimeId does not match this host", "runtime_mismatch");
    if (command.spaceId !== this.expectedSpaceId) throw new LocalRuntimeRunnerError("spaceId does not match this host", "space_mismatch");
    if (this.expectedExecutionAttemptId !== undefined && command.executionAttemptId !== this.expectedExecutionAttemptId) {
      throw new LocalRuntimeRunnerError("executionAttemptId does not match this host channel", "attempt_mismatch");
    }
    if (command.provider !== this.expectedProvider) throw new LocalRuntimeRunnerError("provider does not match this host", "provider_mismatch");
    if (command.connectionEpoch !== this.expectedConnectionEpoch) throw new LocalRuntimeRunnerError("connectionEpoch is stale", "stale_connection");
  }

  private async resolveAdapter(command: LocalRuntimeCommand): Promise<LocalProviderAdapter> {
    const candidate = adapterFromRegistry(this.adapters, command.provider)
      ?? (this.adapterFactory
        ? await this.adapterFactory({
            provider: command.provider,
            command,
            session: this.sessionInput(command),
          })
        : undefined);
    if (!candidate) throw new LocalRuntimeRunnerError(`no adapter is configured for provider ${command.provider}`, "provider_unavailable");
    const adapter = typeof candidate === "function"
      ? await candidate({
          provider: command.provider,
          command,
          session: this.sessionInput(command),
        })
      : candidate;
    if (!adapter || typeof adapter.open !== "function" || adapter.provider !== command.provider) {
      throw new LocalRuntimeRunnerError("provider adapter identity is invalid", "provider_adapter_invalid");
    }
    return adapter;
  }

  /** Keep provider-specific options on the local side of the wire boundary. */
  private sessionInput(command: LocalRuntimeCommand): LocalRuntimeSessionInput {
    const payload = { ...command.payload };
    const cwd = this.mapWorkspacePath(command.cwd);
    if (typeof payload.cwd === "string") payload.cwd = this.mapWorkspacePath(payload.cwd);
    // Provider-specific additional directories could otherwise bypass the
    // replica fence. The host process is already launched inside workspaceRoot.
    delete payload.additionalDirectories;
    return {
      cwd,
      ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
      providerSessionId: command.providerSessionId,
      model: command.model ?? null,
      accessMode: command.accessMode,
      operation: command.operation,
      payload,
      signal: this.runtimeAbort.signal,
    };
  }

  private mapWorkspacePath(value: string): string {
    if (!this.workspaceRoot) return value;
    const candidate = value.trim();
    if (!candidate) throw new LocalRuntimeRunnerError("workspace path is empty", "invalid_workspace");
    let mapped: string;
    try {
      // Use the same alias parser as provider tool guards. This covers
      // `/workspace`, backslash spellings, @ aliases, and file URLs on every
      // host platform before the canonical fence is applied.
      mapped = resolveWorkspacePath(candidate, this.workspaceRoot, this.workspaceRoot);
    } catch {
      throw new LocalRuntimeRunnerError("workspace path is invalid", "invalid_workspace");
    }
    // Check both the lexical path and its canonical existing prefix. The
    // latter rejects symlink escapes while still allowing a new output file.
    const mappedReal = realpathForWorkspaceFence(mapped) ?? mapped;
    if (!pathInside(this.workspaceRootReal ?? this.workspaceRoot, mappedReal)) {
      throw new LocalRuntimeRunnerError("workspace path is outside the authorized replica", "workspace_escape");
    }
    return mapped;
  }

  private async openSession(command: LocalRuntimeCommand): Promise<void> {
    if (command.turnId !== null) throw new LocalRuntimeRunnerError(`${command.operation} must not include a turnId`, "invalid_session_command");
    if (command.operation === "session.open" && command.providerSessionId !== null) {
      throw new LocalRuntimeRunnerError("session.open must not include a providerSessionId", "invalid_session_open");
    }
    if (command.operation === "session.resume") {
      if (!command.providerSessionId?.trim() || isProvisionalProviderSessionId(command.providerSessionId)) {
        throw new LocalRuntimeRunnerError("session.resume requires a native providerSessionId", "invalid_session_resume");
      }
    }
    if (command.operation === "session.fork") {
      if (!command.providerSessionId?.trim() || isProvisionalProviderSessionId(command.providerSessionId)) {
        throw new LocalRuntimeRunnerError("session.fork requires a native source providerSessionId", "invalid_session_fork");
      }
    }
    const existing = this.sessions.get(command.runtimeSessionId);
    if (existing) {
      if (existing.status === "closed") throw new LocalRuntimeRunnerError("runtime session is already closed", "session_closed");
      if (existing.cohubSessionId !== command.cohubSessionId || existing.provider !== command.provider || existing.cwd !== command.cwd) {
        throw new LocalRuntimeRunnerError("runtime session identity cannot be changed", "session_identity_mismatch");
      }
      if (existing.accessMode === "read_only" && command.accessMode === "full_access") {
        throw new LocalRuntimeRunnerError("runtime session accessMode cannot widen a read-only session", "access_mode_widening");
      }
      // A runtime session id represents one native session. Only an exact
      // replay of the original open/resume operation may reuse it; accepting
      // a new fork or a resume with a different lifecycle would otherwise
      // silently bind a second provider side effect to the same ledger row.
      if (command.operation === "session.fork") {
        throw new LocalRuntimeRunnerError("runtime session already exists; fork requires a new runtimeSessionId", "session_exists");
      }
      if (command.operation === "session.resume" && command.providerSessionId !== existing.providerSessionId) {
        throw new LocalRuntimeRunnerError("provider session identity cannot be changed", "provider_session_mismatch");
      }
      if (command.operation === "session.open" && existing.providerSessionId.length === 0) {
        throw new LocalRuntimeRunnerError("runtime session has no provider session identity", "provider_session_invalid");
      }
      await this.emitEvent({ session: existing, command, turnId: null, executionAttemptId: command.executionAttemptId }, {
        kind: "session.ready",
        payload: { commandId: command.commandId, operation: command.operation, providerSessionId: existing.providerSessionId, reused: true },
      });
      return;
    }
    if (this.sessions.size >= LOCAL_RUNTIME_MAX_SESSIONS) {
      throw new LocalRuntimeRunnerError("runtime session limit reached", "session_state_limit");
    }
    const adapter = await this.resolveAdapter(command);
    if (command.operation === "session.resume" && adapter.capabilities?.sessionResume === false) {
      throw new LocalRuntimeRunnerError("provider does not support session resume", "capability_missing");
    }
    if (command.operation === "session.fork" && adapter.capabilities?.sessionFork === false) {
      throw new LocalRuntimeRunnerError("provider does not support session fork", "capability_missing");
    }
    const handle = await adapter.open(this.sessionInput(command));
    if (!handle || typeof handle.run !== "function" || typeof handle.close !== "function") {
      throw new LocalRuntimeRunnerError("provider returned an invalid session handle", "provider_session_invalid");
    }
    let providerSessionId = providerSessionIdValue(handle.providerSessionId);
    let providerSessionIdProvisional = false;
    if (!providerSessionId && command.provider === "codex" && command.operation === "session.open" && command.providerSessionId === null) {
      // Codex does not expose a thread id until `thread.started` arrives. A
      // scoped placeholder lets the first turn start without pretending that
      // the native id is known; the adapter's `session.ready` event replaces it.
      providerSessionId = provisionalProviderSessionId(command.runtimeSessionId);
      providerSessionIdProvisional = true;
    }
    if (!providerSessionId) {
      throw new LocalRuntimeRunnerError("provider returned an invalid providerSessionId", "provider_session_invalid");
    }
    const session: RuntimeSessionState = {
      runtimeSessionId: command.runtimeSessionId,
      cohubSessionId: command.cohubSessionId,
      provider: command.provider,
      cwd: command.cwd,
      accessMode: command.accessMode,
      connectionEpoch: command.connectionEpoch,
      providerSessionId,
      adapter,
      handle,
      providerSessionIdProvisional,
      sequence: 0,
      status: "active",
      lastError: null,
    };
    this.sessions.set(session.runtimeSessionId, session);
    await this.emitEvent({ session, command, turnId: null, executionAttemptId: command.executionAttemptId }, {
      kind: "session.ready",
      payload: {
        commandId: command.commandId,
        operation: command.operation,
        providerSessionId,
        ...(providerSessionIdProvisional ? { provisional: true } : {}),
        capabilities: adapter.capabilities,
      },
    });
  }

  private sessionFor(command: LocalRuntimeCommand): RuntimeSessionState {
    const session = this.sessions.get(command.runtimeSessionId);
    if (!session) throw new LocalRuntimeRunnerError("runtime session has not been opened", "session_not_open");
    if (session.status !== "active") throw new LocalRuntimeRunnerError(`runtime session is ${session.status}`, "session_unavailable");
    if (session.cohubSessionId !== command.cohubSessionId) throw new LocalRuntimeRunnerError("cohub session identity does not match", "session_identity_mismatch");
    if (session.provider !== command.provider) throw new LocalRuntimeRunnerError("provider identity does not match", "provider_mismatch");
    if (session.connectionEpoch !== command.connectionEpoch) throw new LocalRuntimeRunnerError("session connectionEpoch is stale", "stale_connection");
    if (session.cwd !== command.cwd) throw new LocalRuntimeRunnerError("session cwd cannot be changed", "cwd_mismatch");
    if (session.accessMode === "read_only" && command.accessMode === "full_access") {
      throw new LocalRuntimeRunnerError("runtime session accessMode cannot widen a read-only session", "access_mode_widening");
    }
    if (command.providerSessionId !== null && command.providerSessionId !== session.providerSessionId) {
      throw new LocalRuntimeRunnerError("providerSessionId does not match the opened session", "provider_session_mismatch");
    }
    return session;
  }

  private promptFrom(command: LocalRuntimeCommand): { text: string; content?: unknown[]; options?: Record<string, unknown> } {
    const payload = command.payload;
    const text = textValue(payload.text) ?? "";
    const content = Array.isArray(payload.content) ? payload.content : undefined;
    const derivedText = text || (content
      ? content.map((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : "").filter(Boolean).join("\n\n")
      : "");
    if (!derivedText && !content?.length) throw new LocalRuntimeRunnerError("turn.start payload must include text or content", "prompt_missing");
    const options = isRecord(payload.options) ? { ...payload.options } : {};
    if (this.workspaceRoot && typeof options.cwd === "string") {
      options.cwd = this.mapWorkspacePath(options.cwd);
    }
    if (this.workspaceRoot) delete options.additionalDirectories;
    return {
      text: derivedText,
      ...(content ? { content } : {}),
      ...(Object.keys(options).length > 0 ? { options } : {}),
    };
  }

  private async startTurn(command: LocalRuntimeCommand): Promise<void> {
    if (!command.turnId) throw new LocalRuntimeRunnerError("turn.start requires a turnId", "turn_id_required");
    if (!command.providerSessionId) throw new LocalRuntimeRunnerError("turn.start requires a providerSessionId", "provider_session_required");
    const session = this.sessionFor(command);
    if (this.activeTurn) throw new LocalRuntimeRunnerError("runtime already has an active turn", "concurrent_turn");
    const prompt = this.promptFrom(command);
    const controller = new AbortController();
    const active: ActiveTurn = {
      command,
      session,
      controller,
      done: Promise.resolve(),
      cancelRequested: false,
      cancelIssued: false,
      terminal: false,
      retainedEvents: [],
    };
    this.activeTurn = active;
    const commandState = this.commands.get(`${command.runtimeSessionId}:${command.commandId}`);
    if (commandState) commandState.status = "sent";
    try {
      await this.emitEvent({ session, command, turnId: command.turnId, executionAttemptId: command.executionAttemptId }, {
        kind: "turn.started",
        payload: { commandId: command.commandId },
      }, active);
      active.done = this.executeTurn(active, prompt);
      void active.done.catch((error) => {
        this.logger.error?.("local runtime turn task failed", { turnId: command.turnId, error: boundedMessage(error, "turn failed") });
      });
    } catch (error) {
      this.activeTurn = null;
      throw error;
    }
  }

  private async executeTurn(active: ActiveTurn, prompt: { text: string; content?: unknown[]; options?: Record<string, unknown> }): Promise<void> {
    const { command, session } = active;
    let sawTerminal = false;
    let failedOutcome = false;
    let unknownOutcome = false;
    try {
      const iterable = await Promise.resolve(session.handle.run(prompt, active.controller.signal));
      for await (const rawEvent of iterable) {
        const parsed = LocalRuntimeProviderEventSchema.safeParse(rawEvent);
        if (!parsed.success) throw new LocalRuntimeRunnerError(`provider emitted an invalid event: ${parsed.error.message}`, "invalid_provider_event");
        const providerEvent = parsed.data;
        const providerSessionChanged = this.syncProviderSessionId(session, providerEvent);
        if (providerSessionChanged) {
          // Codex only learns a new thread id from the first stream event. Keep
          // that identity transition explicit on the wire so the Agent can
          // durably rebind its session before accepting subsequent events.
          const providerMetadata = isRecord(providerEvent.payload.metadata)
            ? { ...providerEvent.payload.metadata, providerSessionTransition: true }
            : { providerSessionTransition: true };
          await this.emitEvent({
            session,
            command,
            turnId: command.turnId,
            executionAttemptId: command.executionAttemptId,
          }, {
            kind: "session.ready",
            providerEventId: providerEvent.providerEventId,
            payload: {
              ...providerEvent.payload,
              providerSessionId: session.providerSessionId,
              provisional: false,
              metadata: providerMetadata,
            },
          }, active);
        }
        if (providerEvent.kind === "turn.started" || providerEvent.kind === "session.ready") {
          // The runner owns turn/session boundaries. Adapters may emit these
          // native lifecycle markers so the runner can rebind a lazily-created
          // provider session, but forwarding them would duplicate the host's
          // canonical lifecycle event.
          continue;
        }
        const terminal = providerEvent.kind === "turn.completed" || providerEvent.kind === "turn.failed";
        if (terminal) {
          sawTerminal = true;
          failedOutcome = providerEvent.kind === "turn.failed";
          unknownOutcome = providerEvent.kind === "turn.failed" && providerEvent.payload.unknownOutcome === true;
        }
        await this.emitEvent({ session, command, turnId: command.turnId, executionAttemptId: command.executionAttemptId }, providerEvent, active);
        if (terminal) break;
      }
      if (!sawTerminal) {
        if (active.cancelRequested || active.controller.signal.aborted || this.runtimeAbort.signal.aborted) {
          failedOutcome = true;
          await this.emitTerminalFailure(active, "turn cancelled", "cancelled", false);
        } else {
          failedOutcome = true;
          unknownOutcome = true;
          await this.emitTerminalFailure(active, "provider stream ended without a terminal event", "unknown_outcome", true);
        }
      }
      active.terminal = true;
      const commandState = this.commands.get(`${command.runtimeSessionId}:${command.commandId}`);
      if (commandState) commandState.status = failedOutcome ? "failed" : "completed";
      if (unknownOutcome) {
        session.status = "error";
        session.lastError = "provider turn outcome is unknown; reconnect required";
      }
    } catch (error) {
      if (!sawTerminal && !active.terminal) {
        const aborted = active.cancelRequested || active.controller.signal.aborted || this.runtimeAbort.signal.aborted || isAbortError(error);
        await this.emitTerminalFailure(
          active,
          aborted ? "turn cancelled" : boundedMessage(error, "provider turn failed"),
          aborted ? "cancelled" : errorCode(error, "provider_error"),
          !aborted,
        ).catch((terminalError) => {
          this.logger.error?.("failed to emit local runtime terminal event", { turnId: command.turnId, error: boundedMessage(terminalError, "terminal event failed") });
        });
      }
      active.terminal = true;
      const commandState = this.commands.get(`${command.runtimeSessionId}:${command.commandId}`);
      if (commandState) commandState.status = "failed";
      session.status = active.cancelRequested ? "active" : "error";
      session.lastError = boundedMessage(error, "provider turn failed");
    } finally {
      if (this.activeTurn === active) this.activeTurn = null;
    }
  }

  private async emitTerminalFailure(active: ActiveTurn, message: string, code: string, unknownOutcome: boolean): Promise<void> {
    if (active.terminal) return;
    active.terminal = true;
    await this.emitEvent({
      session: active.session,
      command: active.command,
      turnId: active.command.turnId,
      executionAttemptId: active.command.executionAttemptId,
    }, {
      kind: "turn.failed",
      payload: {
        commandId: active.command.commandId,
        message: boundedMessage(message, "provider turn failed"),
        code,
        unknownOutcome,
        retryable: false,
        ...(code === "cancelled" ? { aborted: true } : {}),
      },
    }, active);
  }

  /**
   * Native providers may discover their session id asynchronously. Accept a
   * single transition from the provisional id and reject any later identity
   * change, which prevents events from being rebound across Cohub sessions.
   */
  private syncProviderSessionId(session: RuntimeSessionState, providerEvent?: LocalRuntimeProviderEvent): boolean {
    const announced = providerEvent?.kind === "session.ready"
      ? providerSessionIdValue(providerEvent.payload.providerSessionId)
      : null;
    const observed = providerSessionIdValue(session.handle.providerSessionId);
    const next = announced ?? observed;
    if (!next || next === session.providerSessionId) return false;
    if (!session.providerSessionIdProvisional) {
      throw new LocalRuntimeRunnerError("provider session identity changed after initialization", "provider_session_changed");
    }
    if (isProvisionalProviderSessionId(next)) {
      throw new LocalRuntimeRunnerError("provider emitted a provisional session id during identity transition", "provider_session_changed");
    }
    session.providerSessionId = next;
    session.providerSessionIdProvisional = false;
    return true;
  }

  private async cancelTurn(command: LocalRuntimeCommand): Promise<void> {
    if (!command.turnId) throw new LocalRuntimeRunnerError("turn.cancel requires a turnId", "turn_id_required");
    const session = this.sessionFor(command);
    const active = this.activeTurn;
    if (!active || active.command.turnId !== command.turnId || active.session.runtimeSessionId !== session.runtimeSessionId) {
      await this.emitEvent({ session, command, turnId: command.turnId, executionAttemptId: command.executionAttemptId }, {
        kind: "session.ready",
        payload: { commandId: command.commandId, operation: command.operation, status: "no_active_turn", turnId: command.turnId },
      });
      return;
    }
    const reason = textValue(command.payload.reason) ?? "turn cancelled";
    // Abort synchronously, but do not let a provider SDK that hangs during
    // cancellation block the command reader from handling the next frame.
    void this.requestCancel(active, reason);
  }

  private async cancelHandle(handle: LocalRuntimeSessionHandle, reason: string): Promise<void> {
    if (typeof handle.cancel !== "function") return;
    try {
      await this.withTimeout(handle.cancel(reason), DEFAULT_CANCEL_GRACE_MS);
    } catch (error) {
      this.logger.warn?.("provider cancellation failed", { error: boundedMessage(error, "provider cancellation failed") });
    }
  }

  private requestCancel(active: ActiveTurn, reason: string): Promise<void> {
    active.cancelRequested = true;
    if (active.cancelIssued) return Promise.resolve();
    active.cancelIssued = true;
    try { active.controller.abort(new Error(reason)); } catch { /* already aborted */ }
    return this.cancelHandle(active.session.handle, reason);
  }

  private async closeSession(command: LocalRuntimeCommand): Promise<void> {
    const session = this.sessions.get(command.runtimeSessionId);
    if (!session) throw new LocalRuntimeRunnerError("runtime session has not been opened", "session_not_open");
    if (session.cohubSessionId !== command.cohubSessionId || session.provider !== command.provider || session.connectionEpoch !== command.connectionEpoch || session.cwd !== command.cwd) {
      throw new LocalRuntimeRunnerError("session identity does not match", "session_identity_mismatch");
    }
    if (command.providerSessionId !== null && command.providerSessionId !== session.providerSessionId) {
      throw new LocalRuntimeRunnerError("providerSessionId does not match the opened session", "provider_session_mismatch");
    }
    if (command.turnId !== null) throw new LocalRuntimeRunnerError("session.close must not include a turnId", "invalid_session_close");
    const active = this.activeTurn;
    if (active?.session === session) {
      await this.requestCancel(active, "session closed");
      await this.withTimeout(active.done, DEFAULT_CANCEL_GRACE_MS).catch(() => undefined);
    }
    try {
      await session.handle.close();
    } catch (error) {
      session.status = "error";
      session.lastError = boundedMessage(error, "provider session close failed");
      throw new LocalRuntimeRunnerError(session.lastError, "provider_close_failed");
    }
    session.status = "closed";
    await this.emitEvent({ session, command, turnId: null, executionAttemptId: command.executionAttemptId }, {
      kind: "session.ready",
      payload: { commandId: command.commandId, operation: command.operation, status: "closed", providerSessionId: session.providerSessionId },
    });
  }

  private async reportCommandFailure(command: LocalRuntimeCommand, error: unknown): Promise<void> {
    const message = boundedMessage(error, "local runtime command failed");
    const code = errorCode(error, "command_failed");
    const session = this.sessions.get(command.runtimeSessionId);
    if (!session || session.providerSessionId.length === 0) {
      this.logger.warn?.("local runtime command rejected", { commandId: command.commandId, operation: command.operation, code, message });
      // There is no valid provider session id with which to construct an event;
      // closing the stream is safer than emitting an unverifiable frame.
      if (["session.open", "session.resume", "session.fork"].includes(command.operation)) this.stop(error);
      return;
    }
    if (command.operation === "turn.start") {
      try {
        await this.emitEvent({ session, command, turnId: command.turnId, executionAttemptId: command.executionAttemptId }, {
          kind: "turn.failed",
          payload: { commandId: command.commandId, message, code, unknownOutcome: false, retryable: false },
        });
      } catch (emitError) {
        this.logger.error?.("failed to report local runtime command error", { commandId: command.commandId, error: boundedMessage(emitError, "error report failed") });
      }
    } else if (command.operation !== "turn.cancel") {
      try {
        await this.emitEvent({ session, command, turnId: null, executionAttemptId: command.executionAttemptId }, {
          kind: "session.ready",
          payload: { commandId: command.commandId, operation: command.operation, status: "error", code, message },
        });
      } catch (emitError) {
        this.logger.error?.("failed to report local runtime command error", { commandId: command.commandId, error: boundedMessage(emitError, "error report failed") });
      }
    }
  }

  private async emitEvent(context: EventContext, providerEvent: LocalRuntimeProviderEvent, active?: ActiveTurn): Promise<LocalRuntimeEvent> {
    const providerEventParsed = LocalRuntimeProviderEventSchema.safeParse(providerEvent);
    if (!providerEventParsed.success) throw new LocalRuntimeRunnerError(`invalid provider event: ${providerEventParsed.error.message}`, "invalid_provider_event");
    this.syncProviderSessionId(context.session, providerEventParsed.data);
    const sequence = context.session.sequence + 1;
    const event: LocalRuntimeEvent = {
      version: 1,
      type: "event",
      runtimeId: this.expectedRuntimeId ?? context.command?.runtimeId ?? "runtime",
      runtimeSessionId: context.session.runtimeSessionId,
      cohubSessionId: context.session.cohubSessionId,
      executionAttemptId: context.executionAttemptId,
      turnId: context.turnId,
      provider: context.session.provider,
      providerSessionId: context.session.providerSessionId,
      eventId: randomUUID(),
      ...(providerEventParsed.data.providerEventId !== undefined ? { providerEventId: providerEventParsed.data.providerEventId } : {}),
      sequence,
      kind: providerEventParsed.data.kind,
      payload: providerEventParsed.data.payload,
      connectionEpoch: context.session.connectionEpoch,
      emittedAt: new Date().toISOString(),
    };
    const parsed = LocalRuntimeEventSchema.safeParse(event);
    if (!parsed.success) throw new LocalRuntimeRunnerError(`runtime event failed validation: ${parsed.error.message}`, "invalid_runtime_event");
    const serialized = JSON.stringify(parsed.data);
    const bytes = byteLength(serialized) + 1;
    if (bytes > this.maxEventBytes || bytes > this.maxFrameBytes) {
      throw new LocalRuntimeRunnerError(`runtime event exceeds ${this.maxEventBytes} bytes`, "event_too_large");
    }
    context.session.sequence = sequence;
    const commandKey = context.command ? `${context.command.runtimeSessionId}:${context.command.commandId}` : null;
    if (commandKey) {
      const commandState = this.commands.get(commandKey);
      if (commandState) {
        commandState.events.push(parsed.data);
        if (commandState.events.length > DEFAULT_MAX_RETAINED_COMMAND_EVENTS) commandState.events.shift();
      }
      if (active) {
        active.retainedEvents.push(parsed.data);
        if (active.retainedEvents.length > DEFAULT_MAX_RETAINED_COMMAND_EVENTS) active.retainedEvents.shift();
      }
    }
    await this.enqueueSerialized(`${serialized}\n`);
    return parsed.data;
  }

  private enqueueSerialized(serialized: string): Promise<void> {
    const task = this.writeTail.then(() => writeChunk(this.output, serialized));
    this.writeTail = task.catch((error) => {
      this.stopped = true;
      this.logger.error?.("local runtime output failed", { error: boundedMessage(error, "output failed") });
    });
    return task;
  }

  private async shutdown(): Promise<void> {
    const active = this.activeTurn;
    if (active) {
      await this.requestCancel(active, "runtime shutting down");
      await this.withTimeout(active.done, DEFAULT_CANCEL_GRACE_MS).catch(() => undefined);
    }
    for (const session of this.sessions.values()) {
      if (session.status === "closed") continue;
      try { await session.handle.close(); }
      catch (error) { this.logger.warn?.("provider session cleanup failed", { runtimeSessionId: session.runtimeSessionId, error: boundedMessage(error, "cleanup failed") }); }
      session.status = "closed";
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new LocalRuntimeRunnerError("provider operation timed out", "provider_timeout")), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function createLocalRuntimeRunner(options: LocalRuntimeRunnerOptions = {}): LocalRuntimeRunner {
  return new LocalRuntimeRunner(options);
}

export function runLocalRuntime(options: LocalRuntimeRunnerOptions = {}): Promise<void> {
  return new LocalRuntimeRunner(options).run();
}
