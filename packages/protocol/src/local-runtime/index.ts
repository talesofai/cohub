import { z } from "zod";

/**
 * Wire protocol used between the cloud runtime relay and the local provider
 * host. Provider SDKs speak their native APIs behind this boundary; only the
 * normalized frames below cross the network.
 */
export const LOCAL_RUNTIME_PROTOCOL_VERSION = 1 as const;
export const LOCAL_RUNTIME_WIRE_PROTOCOL = "local-runtime-v1" as const;

export const LOCAL_RUNTIME_STALE_AFTER_MS = 90_000;

export const isLocalRuntimeHeartbeatFresh = (
  lastSeenAt: Date | string | number | null | undefined,
  now = Date.now(),
): boolean => {
  const timestamp = lastSeenAt instanceof Date
    ? lastSeenAt.getTime()
    : typeof lastSeenAt === "number"
      ? lastSeenAt
      : typeof lastSeenAt === "string"
        ? Date.parse(lastSeenAt)
        : Number.NaN;
  return Number.isFinite(timestamp) && now - timestamp <= LOCAL_RUNTIME_STALE_AFTER_MS;
};

export const LocalRuntimeProviderSchema = z.enum(["pi", "codex", "claude_code"]);
export type LocalRuntimeProvider = z.infer<typeof LocalRuntimeProviderSchema>;

export const LocalRuntimeStatusSchema = z.enum([
  "offline",
  "connecting",
  "ready",
  "busy",
  "error",
  "revoked",
]);
export type LocalRuntimeStatus = z.infer<typeof LocalRuntimeStatusSchema>;

const JsonObjectSchema = z.record(z.string(), z.unknown());
const PositiveIntegerSchema = z.number().int().positive();

/** Capabilities are descriptive and must not be used to widen workspace scope. */
export const LocalRuntimeCapabilitiesSchema = z.object({
  streaming: z.boolean().default(true),
  sessionResume: z.boolean().default(false),
  sessionFork: z.boolean().default(false),
  sessionCancel: z.boolean().default(true),
  // local-runtime-v1 has no permission-response command. Providers may emit
  // informational permission.requested events, but callers cannot answer
  // them over the wire, so this capability is intentionally unavailable.
  permissionRequests: z.literal(false).default(false),
  promptImages: z.boolean().default(false),
  nativeTools: z.boolean().default(true),
}).strict();
export type LocalRuntimeCapabilities = z.infer<typeof LocalRuntimeCapabilitiesSchema>;

/** Identity and negotiated capabilities advertised by a local runtime. */
export const LocalRuntimeRegistrationSchema = z.object({
  version: z.literal(LOCAL_RUNTIME_PROTOCOL_VERSION),
  runtimeId: z.string().min(1).max(255),
  spaceId: z.string().min(1).max(255),
  replicaId: z.string().min(1).max(255),
  deviceId: z.string().min(1).max(255),
  provider: LocalRuntimeProviderSchema,
  providerVersion: z.string().min(1).max(120),
  adapterVersion: z.string().min(1).max(120),
  protocolVersion: z.literal(LOCAL_RUNTIME_PROTOCOL_VERSION),
  capabilities: LocalRuntimeCapabilitiesSchema,
}).strict();
export type LocalRuntimeRegistration = z.infer<typeof LocalRuntimeRegistrationSchema>;

/** Control-channel registration frame sent by the local runtime. */
export const LocalRuntimeRegisterFrameSchema = LocalRuntimeRegistrationSchema.extend({
  type: z.literal("register"),
  kind: z.literal("runtime"),
  protocol: z.literal(LOCAL_RUNTIME_WIRE_PROTOCOL),
});
export type LocalRuntimeRegisterFrame = z.infer<typeof LocalRuntimeRegisterFrameSchema>;

export const LocalRuntimeRegisteredFrameSchema = z.object({
  type: z.literal("registered"),
  runtimeId: z.string().min(1).max(255),
  spaceId: z.string().min(1).max(255),
  provider: LocalRuntimeProviderSchema,
  protocol: z.literal(LOCAL_RUNTIME_WIRE_PROTOCOL),
  connectionEpoch: PositiveIntegerSchema,
  capabilities: LocalRuntimeCapabilitiesSchema,
}).strict();
export type LocalRuntimeRegisteredFrame = z.infer<typeof LocalRuntimeRegisteredFrameSchema>;

export const LocalRuntimeOpenFrameSchema = z.object({
  type: z.literal("open"),
  channel: z.string().min(1).max(255),
  protocol: z.literal(LOCAL_RUNTIME_WIRE_PROTOCOL),
  binding: JsonObjectSchema.optional(),
}).strict();
export type LocalRuntimeOpenFrame = z.infer<typeof LocalRuntimeOpenFrameSchema>;

export const LocalRuntimePingFrameSchema = z.object({ type: z.literal("ping") }).strict();
export const LocalRuntimePongFrameSchema = z.object({ type: z.literal("pong") }).strict();
export const LocalRuntimeErrorFrameSchema = z.object({
  type: z.literal("error"),
  status: z.number().int().min(400).max(599),
  message: z.string().min(1).max(1024),
}).strict();

export const LocalRuntimeControlFrameSchema = z.discriminatedUnion("type", [
  LocalRuntimeRegisterFrameSchema,
  LocalRuntimeRegisteredFrameSchema,
  LocalRuntimeOpenFrameSchema,
  LocalRuntimePingFrameSchema,
  LocalRuntimePongFrameSchema,
  LocalRuntimeErrorFrameSchema,
]);
export type LocalRuntimeControlFrame = z.infer<typeof LocalRuntimeControlFrameSchema>;

export const LocalRuntimeCommandStatusSchema = z.enum([
  "prepared",
  "sent",
  "completed",
  "failed",
  "unknown",
]);
export type LocalRuntimeCommandStatus = z.infer<typeof LocalRuntimeCommandStatusSchema>;

export const LocalRuntimeOperationSchema = z.enum([
  "session.open",
  "session.resume",
  "session.fork",
  "turn.start",
  "turn.cancel",
  "session.close",
]);
export type LocalRuntimeOperation = z.infer<typeof LocalRuntimeOperationSchema>;

/**
 * A command is deliberately provider-neutral. `payload` is interpreted only
 * by the selected adapter and never forwarded to another provider.
 */
export const LocalRuntimeCommandSchema = z.object({
  version: z.literal(LOCAL_RUNTIME_PROTOCOL_VERSION),
  type: z.literal("command"),
  commandId: z.string().min(1).max(255),
  runtimeId: z.string().min(1).max(255),
  spaceId: z.string().min(1).max(255),
  runtimeSessionId: z.string().min(1).max(255),
  cohubSessionId: z.string().min(1).max(255),
  executionAttemptId: z.string().min(1).max(255).nullable(),
  turnId: z.string().min(1).max(255).nullable(),
  provider: LocalRuntimeProviderSchema,
  providerSessionId: z.string().min(1).max(255).nullable(),
  operation: LocalRuntimeOperationSchema,
  cwd: z.string().min(1).max(4096),
  model: z.string().min(1).max(255).nullable().optional(),
  accessMode: z.enum(["read_only", "full_access"]).default("read_only"),
  leaseEpoch: PositiveIntegerSchema.nullable().optional(),
  leaseExpiresAt: z.string().max(80).nullable().optional(),
  payload: JsonObjectSchema.default({}),
  connectionEpoch: PositiveIntegerSchema,
}).strict();
export type LocalRuntimeCommand = z.infer<typeof LocalRuntimeCommandSchema>;

export const LocalRuntimeEventKindSchema = z.enum([
  "turn.started",
  "text.delta",
  "thinking.delta",
  "tool.started",
  "tool.updated",
  "tool.completed",
  "permission.requested",
  "usage",
  "turn.completed",
  "turn.failed",
  "session.ready",
]);
export type LocalRuntimeEventKind = z.infer<typeof LocalRuntimeEventKindSchema>;

/** Normalized streaming event emitted by every provider adapter. */
export const LocalRuntimeEventSchema = z.object({
  version: z.literal(LOCAL_RUNTIME_PROTOCOL_VERSION),
  type: z.literal("event"),
  runtimeId: z.string().min(1).max(255),
  runtimeSessionId: z.string().min(1).max(255),
  cohubSessionId: z.string().min(1).max(255),
  executionAttemptId: z.string().min(1).max(255).nullable(),
  turnId: z.string().min(1).max(255).nullable(),
  provider: LocalRuntimeProviderSchema,
  providerSessionId: z.string().min(1).max(255),
  eventId: z.string().min(1).max(255),
  providerEventId: z.string().min(1).max(255).nullable().optional(),
  sequence: PositiveIntegerSchema,
  kind: LocalRuntimeEventKindSchema,
  payload: JsonObjectSchema,
  connectionEpoch: PositiveIntegerSchema,
  emittedAt: z.string().max(80).optional(),
}).strict();
export type LocalRuntimeEvent = z.infer<typeof LocalRuntimeEventSchema>;

/** Provider-facing event shape before the runtime host adds routing metadata. */
export const LocalRuntimeProviderEventSchema = z.object({
  kind: LocalRuntimeEventKindSchema,
  payload: JsonObjectSchema,
  providerEventId: z.string().min(1).max(255).nullable().optional(),
}).strict();
export type LocalRuntimeProviderEvent = z.infer<typeof LocalRuntimeProviderEventSchema>;

export const LocalRuntimeDataFrameSchema = z.discriminatedUnion("type", [
  LocalRuntimeCommandSchema,
  LocalRuntimeEventSchema,
]);
export type LocalRuntimeDataFrame = z.infer<typeof LocalRuntimeDataFrameSchema>;

export type LocalRuntimeSession = {
  runtimeId: string;
  runtimeSessionId: string;
  cohubSessionId: string;
  provider: LocalRuntimeProvider;
  providerSessionId: string;
  connectionEpoch: number;
  lastEventSequence: number;
  lastEventHash: string | null;
  status: "active" | "closed" | "disconnected" | "error" | "revoked";
};

export type LocalRuntimeCommandRecord = {
  commandId: string;
  runtimeId: string;
  runtimeSessionId: string;
  executionAttemptId: string | null;
  operation: LocalRuntimeOperation;
  sequence: number;
  status: LocalRuntimeCommandStatus;
  payloadHash: string;
  response: Record<string, unknown> | null;
  errorMessage: string | null;
};

export type LocalRuntimeEventReceipt = {
  runtimeSessionId: string;
  eventId: string;
  sequence: number;
  kind: LocalRuntimeEventKind;
  payloadHash: string;
};

/** Provider adapters run locally and expose only normalized events. */
export type LocalRuntimeSessionInput = {
  cwd: string;
  /** Physical replica root corresponding to the wire-level `/workspace`. */
  workspaceRoot?: string;
  providerSessionId?: string | null;
  /** Model selected for this Cohub session, when one was requested. */
  model?: string | null;
  /** Workspace permission policy selected by the server. */
  accessMode?: "read_only" | "full_access";
  /** The provider-neutral session operation being performed. */
  operation?: LocalRuntimeOperation;
  /** Provider-specific session options. Adapters must validate their own keys. */
  payload?: Record<string, unknown>;
  signal?: AbortSignal;
};

export type LocalRuntimePromptInput = {
  text: string;
  content?: unknown[];
  options?: Record<string, unknown>;
};

export type LocalRuntimeSessionHandle = {
  providerSessionId: string;
  run(input: LocalRuntimePromptInput, signal?: AbortSignal): AsyncIterable<LocalRuntimeProviderEvent>;
  cancel(reason?: string): Promise<void>;
  close(): Promise<void>;
};

export interface LocalProviderAdapter {
  readonly provider: LocalRuntimeProvider;
  readonly version: string;
  readonly capabilities: LocalRuntimeCapabilities;
  open(input: LocalRuntimeSessionInput): Promise<LocalRuntimeSessionHandle>;
}

export const parseLocalRuntimeControlFrame = (value: unknown): LocalRuntimeControlFrame =>
  LocalRuntimeControlFrameSchema.parse(value);

export const parseLocalRuntimeDataFrame = (value: unknown): LocalRuntimeDataFrame =>
  LocalRuntimeDataFrameSchema.parse(value);
