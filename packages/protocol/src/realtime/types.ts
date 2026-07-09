import type { ContentBlock } from "../core/content.js";
import type { BillingPayload } from "../billing.js";
import type { MessageRecord, SessionRecord, SessionTurnRecord } from "../model/session.js";
import type { SessionTurnSummary } from "../model/turn.js";
import type { TaskRunStatus } from "../task/index.js";
import type { SpaceFsChangedPayload } from "../fs/index.js";
import type { SpacePortsChangedPayload } from "../ports/index.js";

export const WS_COMPACT_STREAM_CAPABILITY = "session.compact_stream.v1";
export const WS_ROOM_SUBSCRIPTION_CAPABILITY = "realtime.rooms.v1";
export const REALTIME_OUTBOUND_CHANNEL = "pubsub:realtime:outbound";
export const AGENT_REALTIME_PATCH_CHANNEL = "pubsub:realtime:agent_patches";

export type RealtimeRoom = `space:${string}` | `user:${string}`;

export const getRealtimeSpaceRoom = (spaceId: string): RealtimeRoom => `space:${spaceId}`;
export const getRealtimeUserRoom = (userId: string): RealtimeRoom => `user:${userId}`;

export const parseRealtimeRoom = (room: string): { kind: "space" | "user"; id: string } | null => {
  const trimmed = room.trim();
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex <= 0) return null;
  const kind = trimmed.slice(0, separatorIndex);
  const id = trimmed.slice(separatorIndex + 1).trim();
  if (!id) return null;
  if (kind !== "space" && kind !== "user") return null;
  return { kind, id };
};

export const normalizeRealtimeRooms = (rooms: readonly string[]): RealtimeRoom[] => {
  const normalized = new Set<RealtimeRoom>();
  for (const room of rooms) {
    const parsed = typeof room === "string" ? parseRealtimeRoom(room) : null;
    if (!parsed) continue;
    normalized.add(`${parsed.kind}:${parsed.id}` as RealtimeRoom);
  }
  return [...normalized];
};

export type WsClientEvent =
  | { type: "auth"; requestId?: string; payload: { token: string; capabilities?: string[] } }
  | { type: "subscribe"; requestId?: string; payload: { rooms: string[] } }
  | { type: "unsubscribe"; requestId?: string; payload: { rooms: string[] } }
  | { type: "session.message.create"; requestId?: string; payload: { spaceId: string; sessionId: string; clientMessageId?: string; content: ContentBlock[]; model?: string; provider?: string } }
  | { type: "canvas.tx"; requestId?: string; payload: { spaceId: string; documentId: string; txId: string; baseVersion?: number | null; clientId?: string | null; undoGroupId?: string | null; ops: Array<Record<string, unknown>> } }
  | { type: "presence.update"; requestId?: string; payload: { spaceId: string; meta?: Record<string, unknown> | null } }
  | { type: "ping"; requestId?: string; payload?: Record<string, unknown> }
  | { type: "ack"; requestId?: string; payload?: { eventId?: string } };

export type RealtimeEnvelope = {
  id: string;
  timestamp: number;
  domain: "system" | "session" | "space" | "label";
  type: string;
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  rooms?: RealtimeRoom[];
  payload: Record<string, unknown>;
};

export type ChannelEnvelope = RealtimeEnvelope;
export type RealtimeEnvelopeBase = RealtimeEnvelope;
export type RealtimeDomain = RealtimeEnvelopeBase["domain"];

export type RealtimeCompactFrame =
  | { t: "d"; sid: string; s: number; b: number; v: unknown }
  | { t: "p"; sid: string; s: number; b: number; o: "append" | "replace" | "add" | "merge" | "remove"; p: string; v?: unknown };

export type SystemReadyEvent = {
  id: string;
  timestamp: number;
  domain: "system";
  type: "system.ready";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: { connectionId: string };
};

export type SystemAuthOkEvent = {
  id: string;
  timestamp: number;
  domain: "system";
  type: "system.auth.ok";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: { connectionId: string; user: Record<string, unknown> };
};

export type SystemRequestErrorEvent = {
  id: string;
  timestamp: number;
  domain: "system";
  type: "system.request.error";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: { code?: string; message: string };
};

export type SystemPongEvent = {
  id: string;
  timestamp: number;
  domain: "system";
  type: "system.pong";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: Record<string, unknown>;
};

export type SystemAckOkEvent = {
  id: string;
  timestamp: number;
  domain: "system";
  type: "system.ack.ok";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: { eventId?: string };
};

export type SystemSubscribeOkEvent = {
  id: string;
  timestamp: number;
  domain: "system";
  type: "system.subscribe.ok";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: { rooms: RealtimeRoom[] };
};

export type SystemSubscribeErrorEvent = {
  id: string;
  timestamp: number;
  domain: "system";
  type: "system.subscribe.error";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: { rejected: Array<{ room: string; code: "BAD_ROOM" | "FORBIDDEN"; message: string }> };
};

export type RealtimeSessionRecord = Pick<
  SessionRecord,
  | "id"
  | "spaceId"
  | "userUuid"
  | "title"
  | "source"
  | "status"
  | "externalSessionId"
  | "latestMessageText"
  | "lastMessageAt"
  | "lastMessageId"
  | "createdAt"
  | "updatedAt"
>;

export type SessionCreatedEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.created";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: { session: RealtimeSessionRecord };
};

export type SessionUpdatedEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.updated";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: { session: RealtimeSessionRecord; changed: string[] };
};

export type SessionRequestAcceptedEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.request.accepted";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: { clientMessageId?: string | null; turnId?: string | null; userMessageId?: string | null; traceId?: string | null };
};

export type SessionRequestErrorEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.request.error";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: { code?: string; message: string; clientMessageId?: string | null; billing?: BillingPayload | null };
};

export type RealtimePatchOperation =
  | { o: "append"; p: string; v: unknown }
  | { o: "replace"; p: string; v: unknown }
  | { o: "add"; p: string; v: unknown }
  | { o: "merge"; p: string; v: Record<string, unknown> }
  | { o: "remove"; p: string }
  | { v: unknown; o?: undefined; p?: undefined };

export type RealtimePatchIdentityInput = {
  turnId?: unknown;
  messageId?: unknown;
  sourceMessageId?: unknown;
  anchorUserMessageId?: unknown;
  messageOrdinal?: unknown;
  sessionId?: unknown;
};

const getNonEmptyString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : null;

export const getSessionTurnPatchStreamKey = (
  input: RealtimePatchIdentityInput,
  options: { includeSessionFallback?: boolean } = {},
) => {
  const turnId = getNonEmptyString(input.turnId);
  const messageKey =
    getNonEmptyString(input.messageId) ??
    getNonEmptyString(input.sourceMessageId) ??
    getNonEmptyString(input.anchorUserMessageId) ??
    (typeof input.messageOrdinal === "number" && Number.isFinite(input.messageOrdinal)
      ? `ordinal:${input.messageOrdinal}`
      : null);

  if (turnId && messageKey) return `${turnId}:${messageKey}`;
  const streamKey = messageKey ?? turnId;
  if (streamKey) return streamKey;
  return options.includeSessionFallback ? getNonEmptyString(input.sessionId) : null;
};

export type SessionTurnPatchEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.turn.patch";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: {
    turnId: string | null;
    messageId: string | null;
    messageOrdinal?: number | null;
    sourceMessageId?: string | null;
    anchorUserMessageId: string | null;
    seq: number;
    baseSeq: number;
    ops: RealtimePatchOperation[];
  };
};

export type SessionTurnErrorEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.turn.error";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: { turnId?: string | null; anchorUserMessageId: string | null; error: string };
};

export type SessionTurnLifecyclePhase = "llm_call_started";

export type SessionTurnLifecycleEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.turn.lifecycle";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: {
    turnId: string | null;
    anchorUserMessageId: string | null;
    phase: SessionTurnLifecyclePhase;
    llmRound: number;
    provider: string | null;
    model: string | null;
    at: string;
  };
};

export type RealtimeTurnRecord = Partial<Pick<
  SessionTurnRecord,
  | "id"
  | "sessionId"
  | "sequence"
  | "status"
  | "intent"
  | "userUuid"
  | "authorProfile"
  | "userContent"
  | "userText"
  | "assistantContent"
  | "assistantText"
  | "provider"
  | "model"
  | "stopReason"
  | "errorMessage"
  | "finalUsage"
  | "totalUsage"
  | "summary"
  | "intermediateIndex"
  | "intermediateSummary"
  | "meta"
  | "startedAt"
  | "completedAt"
  | "durationMs"
  | "createdAt"
  | "updatedAt"
>>;

export type RealtimeMessageRecord = Pick<
  MessageRecord,
  | "id"
  | "sessionId"
  | "role"
  | "content"
  | "text"
  | "sequence"
  | "provider"
  | "model"
  | "stopReason"
  | "errorMessage"
  | "usage"
  | "meta"
  | "startedAt"
  | "completedAt"
  | "durationMs"
  | "createdAt"
>;

export type SessionTurnCreatedEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.turn.created";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: { turn: RealtimeTurnRecord };
};

export type SessionTurnUpdatedEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.turn.updated";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: { turn: RealtimeTurnRecord };
};

export type SessionTurnFinalizedEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.turn.finalized";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: { turn: RealtimeTurnRecord };
};

export type SessionTurnNotifyEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.turn.notify";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: {
    spaceId: string;
    sessionId: string;
    turnId: string;
    status: SessionTurnRecord["status"];
    finishReason?: SessionTurnSummary["finishReason"] | null;
    userPreview: string | null;
    durationMs: number | null;
    stepCount: number | null;
    sequence: number | null;
    provider: string | null;
    model: string | null;
    completedAt: string | null;
  };
};

export type SessionMessagePersistedEvent = {
  id: string;
  timestamp: number;
  domain: "session";
  type: "session.message.persisted";
  requestId?: string | null;
  spaceId: string;
  sessionId: string;
  payload: { message: RealtimeMessageRecord };
};

export type SpaceFsChangedEvent = {
  id: string;
  timestamp: number;
  domain: "space";
  type: "space.fs.changed";
  requestId?: string | null;
  spaceId: string;
  sessionId?: string | null;
  payload: SpaceFsChangedPayload;
};

export type SpacePortsChangedEvent = {
  id: string;
  timestamp: number;
  domain: "space";
  type: "space.ports.changed";
  requestId?: string | null;
  spaceId: string;
  sessionId?: string | null;
  payload: SpacePortsChangedPayload;
};

export type SpacePresenceUser = {
  userId: string;
  connectionCount: number;
  lastSeenAt: string;
  meta: Record<string, unknown> | null;
  metas: Record<string, unknown>[];
  profile: {
    userUuid: string;
    username: string | null;
    displayName: string;
    avatarUrl: string | null;
  };
};

export type SpacePresenceSnapshot = {
  spaceId: string;
  users: SpacePresenceUser[];
  updatedAt: string;
};

export type SpacePresenceUpdatedEvent = {
  id: string;
  timestamp: number;
  domain: "space";
  type: "space.presence.updated";
  requestId?: string | null;
  spaceId: string;
  sessionId?: string | null;
  payload: SpacePresenceSnapshot;
};

export type CanvasTransactionAppliedEvent = {
  id: string;
  timestamp: number;
  domain: "space";
  type: "canvas.tx.applied";
  requestId?: string | null;
  spaceId: string;
  sessionId?: string | null;
  payload: {
    documentId: string;
    actorId: string;
    txId: string;
    version: number;
    ops: Array<Record<string, unknown>>;
  };
};

export type CanvasTransactionAckEvent = {
  id: string;
  timestamp: number;
  domain: "space";
  type: "canvas.tx.ack";
  requestId?: string | null;
  spaceId: string;
  sessionId?: string | null;
  payload: {
    documentId: string;
    txId: string;
    version: number;
  };
};

export type CanvasTransactionErrorEvent = {
  id: string;
  timestamp: number;
  domain: "space";
  type: "canvas.tx.error";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: {
    documentId?: string | null;
    txId?: string | null;
    message: string;
  };
};

export type RealtimeTaskRecord = {
  id: string;
  type: string;
  status: TaskRunStatus;
  jobId: string;
  cronJobId: string | null;
  spaceId: string | null;
  sessionId: string | null;
  turnId: string | null;
  userId: string | null;
  attemptCount: number;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskCreatedEvent = {
  id: string;
  timestamp: number;
  domain: "space";
  type: "task.created";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: { task: RealtimeTaskRecord };
};

export type TaskUpdatedEvent = {
  id: string;
  timestamp: number;
  domain: "space";
  type: "task.updated";
  requestId?: string | null;
  spaceId?: string | null;
  sessionId?: string | null;
  payload: { task: RealtimeTaskRecord; changed: string[] };
};

export type LabelAssignmentsUpdatedEvent = {
  id: string;
  timestamp: number;
  domain: "label";
  type: "label.assignments.updated";
  requestId?: string | null;
  spaceId: string;
  sessionId?: string | null;
  payload: {
    resourceType: "session" | "checkpoint" | "file";
    resourceRef: string;
    labels: unknown[];
    assignments: unknown[];
    items?: unknown[];
    affectedLabelIds: string[];
  };
};

export type RealtimeServerEvent =
  | SystemReadyEvent
  | SystemAuthOkEvent
  | SystemRequestErrorEvent
  | SystemPongEvent
  | SystemAckOkEvent
  | SystemSubscribeOkEvent
  | SystemSubscribeErrorEvent
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | SessionRequestAcceptedEvent
  | SessionRequestErrorEvent
  | SessionTurnCreatedEvent
  | SessionTurnPatchEvent
  | SessionTurnErrorEvent
  | SessionTurnLifecycleEvent
  | SessionTurnUpdatedEvent
  | SessionTurnFinalizedEvent
  | SessionTurnNotifyEvent
  | SessionMessagePersistedEvent
  | SpaceFsChangedEvent
  | SpacePortsChangedEvent
  | SpacePresenceUpdatedEvent
  | CanvasTransactionAppliedEvent
  | CanvasTransactionAckEvent
  | CanvasTransactionErrorEvent
  | TaskCreatedEvent
  | TaskUpdatedEvent
  | LabelAssignmentsUpdatedEvent;

export type WsServerEnvelope = RealtimeEnvelope;
export type ChannelServerEnvelope = ChannelEnvelope;
