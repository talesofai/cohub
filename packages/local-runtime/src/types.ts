/**
 * Runtime-host types live in the shared protocol package.  Keeping this file
 * as a small re-export gives local callers one stable import path without
 * creating a second, subtly different wire contract.
 */
export {
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  LOCAL_RUNTIME_WIRE_PROTOCOL,
  LocalRuntimeCapabilitiesSchema,
  LocalRuntimeCommandSchema,
  LocalRuntimeControlFrameSchema,
  LocalRuntimeDataFrameSchema,
  LocalRuntimeEventKindSchema,
  LocalRuntimeEventSchema,
  LocalRuntimeOperationSchema,
  LocalRuntimeProviderEventSchema,
  LocalRuntimeProviderSchema,
  LocalRuntimeRegistrationSchema,
  LocalRuntimeRegisteredFrameSchema,
  LocalRuntimeRegisterFrameSchema,
  LocalRuntimeOpenFrameSchema,
  LocalRuntimePingFrameSchema,
  LocalRuntimePongFrameSchema,
  LocalRuntimeErrorFrameSchema,
  LocalRuntimeCommandStatusSchema,
  LocalRuntimeStatusSchema,
  parseLocalRuntimeControlFrame,
  parseLocalRuntimeDataFrame,
} from "@cohub/protocol";

export type {
  LocalProviderAdapter,
  LocalRuntimeCapabilities,
  LocalRuntimeCommand,
  LocalRuntimeCommandRecord,
  LocalRuntimeCommandStatus,
  LocalRuntimeControlFrame,
  LocalRuntimeDataFrame,
  LocalRuntimeEvent,
  LocalRuntimeEventKind,
  LocalRuntimeEventReceipt,
  LocalRuntimeOperation,
  LocalRuntimeOpenFrame,
  LocalRuntimeProvider,
  LocalRuntimeProviderEvent,
  LocalRuntimeRegisteredFrame,
  LocalRuntimeRegisterFrame,
  LocalRuntimeRegistration,
  LocalRuntimeSession,
  LocalRuntimeSessionHandle,
  LocalRuntimeSessionInput,
  LocalRuntimePromptInput,
  LocalRuntimeStatus,
} from "@cohub/protocol";

import type {
  LocalProviderAdapter,
  LocalRuntimeCommand,
  LocalRuntimeProvider,
  LocalRuntimeSessionInput,
} from "@cohub/protocol";

/** Maximum accepted input line, including JSON bytes but excluding LF. */
export const LOCAL_RUNTIME_MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Maximum emitted event line. Provider payloads are bounded independently. */
export const LOCAL_RUNTIME_MAX_EVENT_BYTES = 4 * 1024 * 1024;
/** Absolute input/event ceiling shared with the locald WebSocket transport. */
export const LOCAL_RUNTIME_MAX_FRAME_BYTES_HARD = 32 * 1024 * 1024;
/** A channel normally owns one session; keep malformed peers from growing state forever. */
export const LOCAL_RUNTIME_MAX_SESSIONS = 64;
/** Retain enough command identities for retries without allowing unbounded growth. */
export const LOCAL_RUNTIME_MAX_COMMANDS = 512;

export type LocalRuntimeLogger = {
  debug?: (message: string, details?: Record<string, unknown>) => void;
  info?: (message: string, details?: Record<string, unknown>) => void;
  warn?: (message: string, details?: Record<string, unknown>) => void;
  error?: (message: string, details?: Record<string, unknown>) => void;
};

/**
 * A factory may return a shared adapter or create one lazily for a runtime.
 * The runner calls it once per provider/session and never passes wire frames
 * directly to an SDK.
 */
export type LocalRuntimeAdapterFactory =
  | LocalProviderAdapter
  | ((input: {
      provider: LocalRuntimeProvider;
      command: LocalRuntimeCommand;
      session: LocalRuntimeSessionInput;
    }) => LocalProviderAdapter | Promise<LocalProviderAdapter>);

export type LocalRuntimeAdapterRegistry =
  | Partial<Record<LocalRuntimeProvider, LocalRuntimeAdapterFactory>>
  | ReadonlyMap<LocalRuntimeProvider, LocalRuntimeAdapterFactory>
  | Iterable<LocalProviderAdapter>;

export type LocalRuntimeRunnerOptions = {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  adapters?: LocalRuntimeAdapterRegistry;
  /** Alias useful for hosts that construct adapters from configuration. */
  adapterFactory?: (input: {
    provider: LocalRuntimeProvider;
    command: LocalRuntimeCommand;
    session: LocalRuntimeSessionInput;
  }) => LocalProviderAdapter | Promise<LocalProviderAdapter>;
  runtimeId?: string;
  spaceId?: string;
  /**
   * Execution attempt bound to the local runtime channel. When set, every
   * command must carry this exact attempt identity, including non-nullness.
   */
  executionAttemptId?: string;
  provider?: LocalRuntimeProvider;
  /**
   * Physical workspace used by the host process. When set, the canonical
   * `/workspace` path on the wire is resolved beneath this directory before
   * it reaches a provider SDK. Leave unset for embedders that already use
   * physical paths in their commands.
   */
  workspaceRoot?: string;
  connectionEpoch?: number;
  maxFrameBytes?: number;
  maxEventBytes?: number;
  logger?: LocalRuntimeLogger;
  /** End the output stream when the runner finishes (disabled by default). */
  endOutput?: boolean;
  /** Abort in-flight turns when the host receives this signal. */
  signal?: AbortSignal;
};
