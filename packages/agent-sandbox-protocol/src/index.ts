export const AGENT_SANDBOX_PROTOCOL_VERSION = "1" as const;

export const SANDBOX_STATUSES = [
  "connecting",
  "preparing",
  "ready",
  "degraded",
  "busy",
  "error",
] as const;

export type SandboxStatus = (typeof SANDBOX_STATUSES)[number];

export const RPC_METHODS = [
  "fs.read",
  "fs.write",
  "fs.stat",
  "fs.ls",
  "fs.find",
  "fs.grep",
  "process.start",
  "process.abort",
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

export const RPC_ERROR_CODES = [
  "BAD_REQUEST",
  "UNSUPPORTED_METHOD",
  "NOT_FOUND",
  "NOT_DIRECTORY",
  "INVALID_PATH",
  "ACCESS_DENIED",
  "READ_ONLY_FILESYSTEM",
  "TIMEOUT",
  "PROCESS_SPAWN_FAILED",
  "PROCESS_ABORT_FAILED",
  "IO_ERROR",
  "INTERNAL_ERROR",
] as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

export type BaseMessage = {
  version: typeof AGENT_SANDBOX_PROTOCOL_VERSION;
  type: string;
  spaceId: string;
  sandboxId: string;
  timestamp: number;
};

export type RequestScopedMessage = BaseMessage & {
  requestId: string;
  sessionId?: string | null;
  toolCallId?: string | null;
};

export type OperationScopedMessage = BaseMessage & {
  opId: string;
  requestId: string;
  seq: number;
  sessionId?: string | null;
  toolCallId?: string | null;
};

export type SandboxCapabilities = {
  fsRead: boolean;
  fsWrite: boolean;
  fsStat: boolean;
  fsLs: boolean;
  fsFind: boolean;
  fsGrep: boolean;
  processStart: boolean;
  processAbort: boolean;
};

export type SandboxFilesystemRoot = {
  path: string;
  writable: boolean;
  label?: string;
};

export type SandboxHeartbeat = BaseMessage & {
  type: "sandbox.heartbeat";
  status: SandboxStatus;
  capabilities?: SandboxCapabilities;
  filesystem?: {
    roots: SandboxFilesystemRoot[];
    defaultCwd: string;
    mode?: "host-like";
    notes?: string[];
  };
  metadata?: {
    podName?: string;
    hostname?: string;
    imageVersion?: string;
    startedAt?: string;
    setup?: SandboxSetupInfo;
  };
};

export type WorkspaceFsChanged = BaseMessage & {
  type: "workspace.fs.changed";
  eventId: string;
  count: number;
};

export type SandboxSetupInfo = {
  ran: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: string;
  error?: string;
};

export type SessionAttach = BaseMessage & {
  type: "session.attach";
  requestId: string;
  identity: string;
};

export type SessionAttachOk = BaseMessage & {
  type: "session.attach.ok";
  requestId: string;
  connectionId: string;
  identity: string;
};

export type FsReadParams = {
  path: string;
  cwd?: string;
  offset?: number;
  limit?: number;
  /** Return content as base64 for binary-safe reading */
  binary?: boolean;
};

export type FsReadResult = {
  path: string;
  content: string;
  /** Base64-encoded content when binary=true */
  contentBase64?: string;
  /** MIME type detected for binary content */
  mimeType?: string;
};

export type FsWriteParams = {
  path: string;
  cwd?: string;
  content: string;
};

export type FsWriteResult = {
  path: string;
  bytesWritten: number;
};

export type FsStatParams = {
  path?: string;
  cwd?: string;
};

export type FsStatResult = {
  path?: string;
  exists: boolean;
  isDirectory: boolean;
};

export type FsLsParams = {
  path?: string;
  cwd?: string;
  limit?: number;
};

export type FsLsResult = {
  path: string;
  entries: string[];
  truncated?: boolean;
};

export type FsFindParams = {
  pattern: string;
  path?: string;
  cwd?: string;
  limit?: number;
  /** Search mode: "glob" (default), "regex", or "fixed-strings" */
  mode?: "glob" | "regex" | "fixed-strings";
  /** Maximum number of results (--max-results) */
  maxResults?: number;
  /** Include hidden files/directories */
  hidden?: boolean;
  /** Require a git repository to apply .gitignore rules (false = apply even outside git repos, i.e. --no-require-git) */
  requireGit?: boolean;
  /** Skip VCS ignore rules entirely (i.e. --no-ignore-vcs) */
  ignoreVcs?: boolean;
  /** Match against full path instead of basename */
  fullPath?: boolean;
  /** Glob patterns to exclude (e.g. node_modules, .git) */
  ignore?: string[];
};

export type FsFindResult = {
  path: string;
  matches: string[];
  truncated?: boolean;
};

export type FsGrepParams = {
  pattern: string;
  path?: string;
  cwd?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
  /** Maximum matches per file (-m/--max-count) */
  maxCount?: number;
  /** Output in JSON format for structured parsing (--json) */
  json?: boolean;
  /** Require a git repository to apply .gitignore rules (false = apply even outside git repos, i.e. --no-require-git) */
  requireGit?: boolean;
  /** Include hidden files/directories */
  hidden?: boolean;
};

export type FsGrepResult = {
  path: string;
  lines: string[];
  truncated?: boolean;
};

export type ProcessStartParams = {
  command: string;
  timeoutSecs?: number;
  cwd?: string;
  env?: Record<string, string>;
};

export type ProcessStartResult = {
  processId: string;
  exitCode: number | null;
};

export type ProcessAbortParams = {
  processId: string;
};

export type ProcessAbortResult = {
  processId: string;
  aborted: boolean;
};

export type RpcRequestMap = {
  "fs.read": {
    params: FsReadParams;
    result: FsReadResult;
  };
  "fs.write": {
    params: FsWriteParams;
    result: FsWriteResult;
  };
  "fs.stat": {
    params: FsStatParams;
    result: FsStatResult;
  };
  "fs.ls": {
    params: FsLsParams;
    result: FsLsResult;
  };
  "fs.find": {
    params: FsFindParams;
    result: FsFindResult;
  };
  "fs.grep": {
    params: FsGrepParams;
    result: FsGrepResult;
  };
  "process.start": {
    params: ProcessStartParams;
    result: ProcessStartResult;
  };
  "process.abort": {
    params: ProcessAbortParams;
    result: ProcessAbortResult;
  };
};

export type RpcRequest<M extends RpcMethod = RpcMethod> = RequestScopedMessage & {
  type: "rpc.request";
  method: M;
  params: RpcRequestMap[M]["params"];
};

export type RpcAccepted = RequestScopedMessage & {
  type: "rpc.accepted";
  opId: string;
};

export type RpcEventPayload =
  | { type: "started"; processId: string }
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | { type: "exit"; exitCode: number | null };

export type RpcEvent = OperationScopedMessage & {
  type: "rpc.event";
  event: RpcEventPayload;
};

export type RpcCompleted<M extends RpcMethod = RpcMethod> = OperationScopedMessage & {
  type: "rpc.completed";
  result: RpcRequestMap[M]["result"];
};

export type RpcFailed = OperationScopedMessage & {
  type: "rpc.failed";
  error: {
    code: RpcErrorCode;
    message: string;
    retryable?: boolean;
  };
};

export type AgentSandboxMessage =
  | SandboxHeartbeat
  | WorkspaceFsChanged
  | SessionAttach
  | SessionAttachOk
  | RpcRequest
  | RpcAccepted
  | RpcEvent
  | RpcCompleted
  | RpcFailed;

export function isRpcMethod(value: string): value is RpcMethod {
  return RPC_METHODS.includes(value as RpcMethod);
}

export function isRpcErrorCode(value: string): value is RpcErrorCode {
  return RPC_ERROR_CODES.includes(value as RpcErrorCode);
}
