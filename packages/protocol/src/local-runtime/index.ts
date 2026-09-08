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
  "ready",
  "busy",
  "error",
  "revoked",
]);
export type LocalRuntimeStatus = z.infer<typeof LocalRuntimeStatusSchema>;

const JsonObjectSchema = z.record(z.string(), z.unknown());
const PositiveIntegerSchema = z.number().int().positive();

/** Metadata recorded when the CLI registers a local runtime through the API. */
export const LocalRuntimeRegistrationSchema = z.object({
  version: z.literal(LOCAL_RUNTIME_PROTOCOL_VERSION),
  runtimeId: z.string().min(1).max(255),
  spaceId: z.string().min(1).max(255),
  replicaId: z.string().min(1).max(255),
  deviceId: z.string().min(1).max(255),
  provider: LocalRuntimeProviderSchema,
  protocolVersion: z.literal(LOCAL_RUNTIME_PROTOCOL_VERSION),
}).strict();
export type LocalRuntimeRegistration = z.infer<typeof LocalRuntimeRegistrationSchema>;

/** Control-channel identity for a runtime already registered through the API. */
export const LocalRuntimeRegisterFrameSchema = LocalRuntimeRegistrationSchema.pick({
  runtimeId: true,
  spaceId: true,
  replicaId: true,
  provider: true,
}).extend({
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

export const LocalRuntimeOperationSchema = z.enum([
  "session.open",
  "session.resume",
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

export type LocalRuntimePromptInput = {
  text: string;
  content?: unknown[];
  options?: Record<string, unknown>;
};

export const LocalRuntimeDataFrameSchema = z.discriminatedUnion("type", [
  LocalRuntimeCommandSchema,
  LocalRuntimeEventSchema,
]);
export type LocalRuntimeDataFrame = z.infer<typeof LocalRuntimeDataFrameSchema>;

export const parseLocalRuntimeControlFrame = (value: unknown): LocalRuntimeControlFrame =>
  LocalRuntimeControlFrameSchema.parse(value);

export const parseLocalRuntimeDataFrame = (value: unknown): LocalRuntimeDataFrame =>
  LocalRuntimeDataFrameSchema.parse(value);
