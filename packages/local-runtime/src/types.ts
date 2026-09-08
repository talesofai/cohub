import type {
  LocalRuntimeOperation,
  LocalRuntimePromptInput,
  LocalRuntimeProvider,
  LocalRuntimeProviderEvent,
} from "@cohub/protocol";

export type { LocalRuntimePromptInput };

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

export type LocalRuntimeSessionInput = {
  cwd: string;
  workspaceRoot?: string;
  providerSessionId?: string | null;
  model?: string | null;
  accessMode?: "read_only" | "full_access";
  operation?: LocalRuntimeOperation;
  signal?: AbortSignal;
};

export type LocalRuntimeSessionHandle = {
  providerSessionId: string;
  run(input: LocalRuntimePromptInput, signal?: AbortSignal): AsyncIterable<LocalRuntimeProviderEvent>;
  cancel(reason?: string): Promise<void>;
  close(): Promise<void>;
};

export interface LocalProviderAdapter {
  readonly provider: LocalRuntimeProvider;
  open(input: LocalRuntimeSessionInput): Promise<LocalRuntimeSessionHandle>;
}

export type LocalRuntimeAdapterFactory = (
  provider: LocalRuntimeProvider,
) => LocalProviderAdapter | Promise<LocalProviderAdapter>;

export type LocalRuntimeRunnerOptions = {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  adapterFactory: LocalRuntimeAdapterFactory;
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
