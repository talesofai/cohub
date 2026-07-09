import "dotenv/config";
import "./tracing.js";
import { createLogger } from "@cohub/infra/logging";


import { createHash, randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { httpInstrumentationMiddleware } from "@hono/otel";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { ContentBlock } from "@cohub/protocol/core";
import type {
  RealtimeCompactFrame,
  RealtimeEnvelope,
  RealtimePatchOperation,
  RealtimeRoom,
  RealtimeServerEvent,
  WsClientEvent,
} from "@cohub/protocol/realtime";

import type { PlannedGatewayOutboundCommand } from "@cohub/protocol/gateway";
import {
  getRealtimeSpaceRoom,
  getRealtimeUserRoom,
  getSessionTurnPatchStreamKey,
  normalizeRealtimeRooms,
  realtimeEnvelopeSchema,
  WS_COMPACT_STREAM_CAPABILITY,
  WS_ROOM_SUBSCRIPTION_CAPABILITY,
  wsClientEventSchema,
} from "@cohub/protocol/realtime";
import { getOrCreateRequestId } from "@cohub/infra/tracing";
import { authenticateRealtimeToken, authorizeRealtimeRooms, notifySpacePresenceUpdated, requestGatewayChannelReconcile, submitCanvasTransaction, submitInternalSessionPrompt, InternalPromptError, type RealtimeAuthResult } from "./api-client.js";
import { listenOutboundCommands, initOutboundConsumerGroup } from "./bus.js";
import { summarizeRedisUrl } from "./logging.js";
import { gatewayConfig } from "./config.js";
import { GatewayManager } from "./manager/index.js";
import { handleAsrWebSocketConnection } from "./asr/session.js";
import { handleRelayControlConnection, handleRelayDataConnection, handleRelayPeerConnection } from "./relay/index.js";
import {
  createPubSubRedisClient,
  redisCommandClient,
  REALTIME_OUTBOUND_CHANNEL,
  AGENT_REALTIME_PATCH_CHANNEL,
} from "./redis.js";

const logger = createLogger({ serviceName: "cohub-gateway" });
type WsConnectionContext = {
  connectionId: string;
  userId?: string;
  userName?: string;
  userAvatarUrl?: string;
  token?: string;
  capabilities: Set<string>;
  rooms: Set<RealtimeRoom>;
  presenceMetaBySpace: Map<string, Record<string, unknown> | null>;
  compactStreamAliases: Map<string, string>;
  nextCompactStreamAlias: number;
};

type GatewayWsBroadcastPayload = RealtimeServerEvent & {
  rooms?: RealtimeRoom[];
};

const WS_CONNECTION_TTL_SECONDS = 60 * 5;
const WS_MAX_MESSAGE_BYTES = 64 * 1024;
const ROOM_AUTH_CACHE_TTL_MS = 30_000;
const PRESENCE_UPDATE_DEBOUNCE_MS = 200;
const ROOM_AUTH_CACHE_MAX_ENTRIES = 10_000;

type RealtimeRoomRejection = { room: string; code: "BAD_ROOM" | "FORBIDDEN"; message: string };

const wsConnections = new Map<string, WsConnectionContext>();
const wsConnectionIdsByRoom = new Map<RealtimeRoom, Set<string>>();
const wsSockets = new Map<string, WebSocket>();
const roomAuthCache = new Map<string, { expiresAt: number; accepted: boolean; rejection?: RealtimeRoomRejection }>();
const presenceUpdateTimers = new Map<string, ReturnType<typeof setTimeout>>();

const getWsConnectionKey = (connectionId: string) => `gateway:ws:connection:${connectionId}`;
const getSpacePresenceConnectionsKey = (spaceId: string) => `gateway:presence:space:${spaceId}:connections`;

const getSpaceIdFromRoom = (room: RealtimeRoom) => {
  if (!room.startsWith("space:")) return null;
  const spaceId = room.slice("space:".length).trim();
  return spaceId || null;
};

const scheduleSpacePresenceUpdate = (spaceId: string) => {
  const existing = presenceUpdateTimers.get(spaceId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    presenceUpdateTimers.delete(spaceId);
    notifySpacePresenceUpdated(spaceId).catch((error) => {
      logger.warn("[Gateway] failed to notify space presence update", { spaceId, error });
    });
  }, PRESENCE_UPDATE_DEBOUNCE_MS);
  presenceUpdateTimers.set(spaceId, timer);
};

const writeSpacePresenceConnection = async (ctx: WsConnectionContext, spaceId: string) => {
  if (!ctx.userId) return;
  await redisCommandClient.hset(
    getSpacePresenceConnectionsKey(spaceId),
    ctx.connectionId,
    JSON.stringify({
      connectionId: ctx.connectionId,
      userId: ctx.userId,
      lastSeenAt: Date.now(),
      meta: ctx.presenceMetaBySpace.get(spaceId) ?? null,
    }),
  );
  await redisCommandClient.expire(getSpacePresenceConnectionsKey(spaceId), WS_CONNECTION_TTL_SECONDS).catch(() => undefined);
};

const removeSpacePresenceConnection = async (connectionId: string, spaceId: string) => {
  await redisCommandClient.hdel(getSpacePresenceConnectionsKey(spaceId), connectionId).catch(() => undefined);
};

function logStartupInfo() {
  logger.info("=".repeat(60));
  logger.info("[Gateway] Starting with configuration:");
  logger.info(`  NODE_ID: ${process.env.POD_NAME || process.env.HOSTNAME || "unknown"}`);
  logger.info(`  ENV: ${process.env.ENV || "unknown"}`);
  logger.info(`  DEBUG_MODE: ${process.env.DEBUG_MODE || "false"}`);
  logger.info("  REDIS_URL", { redis: summarizeRedisUrl(process.env.REDIS_URL) });
  logger.info(`  API_BASE_URL: ${gatewayConfig.apiBaseUrl}`);
  logger.info(`  PORT: ${gatewayConfig.port}`);
  logger.info("=".repeat(60));
}

const subscribeConnectionToRoom = (ctx: WsConnectionContext, room: RealtimeRoom) => {
  if (ctx.rooms.has(room)) return;
  ctx.rooms.add(room);
  let connectionIds = wsConnectionIdsByRoom.get(room);
  if (!connectionIds) {
    connectionIds = new Set<string>();
    wsConnectionIdsByRoom.set(room, connectionIds);
  }
  connectionIds.add(ctx.connectionId);
  const spaceId = getSpaceIdFromRoom(room);
  if (spaceId) {
    void writeSpacePresenceConnection(ctx, spaceId)
      .then(() => scheduleSpacePresenceUpdate(spaceId))
      .catch((error) => logger.warn("[Gateway] failed to write space presence", { spaceId, error }));
  }
};

const unsubscribeConnectionFromRoom = (ctx: WsConnectionContext, room: RealtimeRoom) => {
  const hadRoom = ctx.rooms.delete(room);
  const connectionIds = wsConnectionIdsByRoom.get(room);
  if (connectionIds) {
    connectionIds.delete(ctx.connectionId);
    if (connectionIds.size === 0) wsConnectionIdsByRoom.delete(room);
  }
  const spaceId = hadRoom ? getSpaceIdFromRoom(room) : null;
  if (spaceId) {
    void removeSpacePresenceConnection(ctx.connectionId, spaceId)
      .then(() => scheduleSpacePresenceUpdate(spaceId))
      .catch((error) => logger.warn("[Gateway] failed to remove space presence", { spaceId, error }));
  }
};

const unsubscribeConnectionFromAllRooms = (ctx: WsConnectionContext) => {
  for (const room of [...ctx.rooms]) unsubscribeConnectionFromRoom(ctx, room);
};

const persistWsConnection = async (ctx: WsConnectionContext) => {
  await redisCommandClient.set(getWsConnectionKey(ctx.connectionId), JSON.stringify({
    connectionId: ctx.connectionId,
    userId: ctx.userId ?? null,
    userName: ctx.userName ?? null,
    userAvatarUrl: ctx.userAvatarUrl ?? null,
    capabilities: [...ctx.capabilities],
    rooms: [...ctx.rooms],
    connectedAt: Date.now(),
    nodeId: process.env.POD_NAME || process.env.HOSTNAME || "unknown",
  }), "EX", WS_CONNECTION_TTL_SECONDS);
};

const cleanupWsConnection = async (ctx: WsConnectionContext | undefined) => {
  if (!ctx) return;
  unsubscribeConnectionFromAllRooms(ctx);
  wsSockets.delete(ctx.connectionId);
  wsConnections.delete(ctx.connectionId);
  await redisCommandClient.del(getWsConnectionKey(ctx.connectionId)).catch(() => undefined);
};

const sendWsEnvelope = (socket: WebSocket, envelope: RealtimeEnvelope) => {
  socket.send(JSON.stringify(envelope));
};

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const getPatchStreamId = (envelope: RealtimeEnvelope) => {
  if (envelope.type !== "session.turn.patch") return null;
  return getSessionTurnPatchStreamKey(envelope.payload);
};

const getPersistedTurnId = (envelope: RealtimeEnvelope) => {
  if (envelope.type !== "session.message.persisted") return null;
  const message = envelope.payload.message;
  if (!message || typeof message !== "object") return null;
  const meta = (message as { meta?: Record<string, unknown> | null }).meta;
  return typeof meta?.turnId === "string" && meta.turnId.trim()
    ? meta.turnId
    : null;
};

const buildCompactFrame = (envelope: RealtimeEnvelope, sid: string): RealtimeCompactFrame | null => {
  if (envelope.type !== "session.turn.patch") return null;
  const payload = envelope.payload as Record<string, unknown>;
  if (!isNonNegativeInteger(payload.seq) || !isNonNegativeInteger(payload.baseSeq)) return null;
  if (payload.baseSeq === 0) return null;
  if (!Array.isArray(payload.ops) || payload.ops.length !== 1) return null;

  const op = payload.ops[0] as Partial<RealtimePatchOperation> | undefined;
  if (!op || typeof op !== "object") return null;
  if (!("o" in op) && !("p" in op) && "v" in op) {
    return { t: "d", sid, s: payload.seq, b: payload.baseSeq, v: op.v };
  }
  if (op.o === "append" && typeof op.p === "string" && "v" in op) {
    return {
      t: "p",
      sid,
      s: payload.seq,
      b: payload.baseSeq,
      o: "append",
      p: op.p,
      v: op.v,
    };
  }
  return null;
};

const getOrCreateCompactStreamAlias = (ctx: WsConnectionContext, streamId: string) => {
  const existing = ctx.compactStreamAliases.get(streamId);
  if (existing) return existing;
  ctx.nextCompactStreamAlias += 1;
  const alias = ctx.nextCompactStreamAlias.toString(36);
  ctx.compactStreamAliases.set(streamId, alias);
  return alias;
};

const withCompactStreamMetadata = (
  envelope: RealtimeEnvelope,
  sid: string,
): RealtimeEnvelope => ({
  ...envelope,
  payload: {
    ...envelope.payload,
    _rt: { sid },
  },
});

const rememberRealtimeEnvelopeForConnection = (
  ctx: WsConnectionContext | undefined,
  envelope: RealtimeEnvelope,
) => {
  if (!ctx) return;
  const patchStreamId = getPatchStreamId(envelope);
  if (patchStreamId) {
    getOrCreateCompactStreamAlias(ctx, patchStreamId);
    return;
  }
  const persistedTurnId = getPersistedTurnId(envelope);
  if (persistedTurnId) ctx.compactStreamAliases.delete(persistedTurnId);
};

const sendWsRealtime = (
  socket: WebSocket,
  ctx: WsConnectionContext | undefined,
  envelope: RealtimeEnvelope,
) => {
  const streamId = ctx ? getPatchStreamId(envelope) : null;
  const canUseCompact = Boolean(
    ctx?.capabilities.has(WS_COMPACT_STREAM_CAPABILITY) && streamId,
  );
  const existingSid = canUseCompact && ctx && streamId
    ? ctx.compactStreamAliases.get(streamId)
    : null;
  if (ctx && streamId && existingSid) {
    const compactFrame = buildCompactFrame(envelope, existingSid);
    if (compactFrame) {
      socket.send(JSON.stringify(compactFrame));
      return;
    }
  }
  const envelopeToSend = ctx && streamId && canUseCompact
    ? withCompactStreamMetadata(envelope, getOrCreateCompactStreamAlias(ctx, streamId))
    : envelope;
  sendWsEnvelope(socket, envelopeToSend);
  rememberRealtimeEnvelopeForConnection(ctx, envelope);
};

const buildRealtimeEnvelope = (input: Omit<RealtimeEnvelope, "id" | "timestamp">): RealtimeEnvelope => ({
  id: randomUUID(),
  timestamp: Date.now(),
  ...input,
});

const sendWsError = (
  socket: WebSocket,
  code: string,
  message: string,
  requestId?: string,
  options?: { spaceId?: string | null; sessionId?: string | null; clientMessageId?: string | null },
) => {
  const isSessionScoped = Boolean(options?.sessionId);
  sendWsEnvelope(socket, buildRealtimeEnvelope({
    domain: isSessionScoped ? "session" : "system",
    type: isSessionScoped ? "session.request.error" : "system.request.error",
    requestId: requestId ?? null,
    spaceId: options?.spaceId ?? null,
    sessionId: options?.sessionId ?? null,
    payload: isSessionScoped
      ? { code, message, clientMessageId: options?.clientMessageId ?? null }
      : { code, message },
  }));
};

class WsClientInputError extends Error {
  readonly requestId?: string;

  constructor(message: string, requestId?: string) {
    super(message);
    this.name = "WsClientInputError";
    this.requestId = requestId;
  }
}

const getWsRequestId = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : undefined;
};

const formatWsValidationError = (issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>) => {
  const details = issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  }).join("; ");
  return details ? `invalid websocket message: ${details}` : "invalid websocket message";
};

const parseWsJson = (value: string): WsClientEvent => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new WsClientInputError("invalid JSON");
  }

  const requestId = getWsRequestId(parsed);
  const result = wsClientEventSchema.safeParse(parsed);
  if (!result.success) {
    throw new WsClientInputError(formatWsValidationError(result.error.issues), requestId);
  }
  return result.data as WsClientEvent;
};

const touchWsConnection = async (ctx: WsConnectionContext) => {
  await redisCommandClient.expire(getWsConnectionKey(ctx.connectionId), WS_CONNECTION_TTL_SECONDS).catch(() => undefined);
  const spaceIds = [...ctx.rooms]
    .map(getSpaceIdFromRoom)
    .filter((spaceId): spaceId is string => Boolean(spaceId));
  if (spaceIds.length === 0 || !ctx.userId) return;
  await Promise.all(spaceIds.map((spaceId) => writeSpacePresenceConnection(ctx, spaceId))).catch(() => undefined);
};

const getRoomAuthCacheKey = (authToken: string, room: RealtimeRoom) => {
  const tokenHash = createHash("sha256").update(authToken).digest("base64url");
  return `${tokenHash}:${room}`;
};

const getCachedRoomAuth = (authToken: string, room: RealtimeRoom) => {
  const key = getRoomAuthCacheKey(authToken, room);
  const cached = roomAuthCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    roomAuthCache.delete(key);
    return null;
  }
  return cached;
};

const pruneRoomAuthCache = () => {
  const now = Date.now();
  for (const [key, value] of roomAuthCache) {
    if (value.expiresAt <= now) roomAuthCache.delete(key);
  }
  while (roomAuthCache.size >= ROOM_AUTH_CACHE_MAX_ENTRIES) {
    const firstKey = roomAuthCache.keys().next().value;
    if (!firstKey) break;
    roomAuthCache.delete(firstKey);
  }
};

const setCachedRoomAuth = (authToken: string, room: RealtimeRoom, value: { accepted: boolean; rejection?: RealtimeRoomRejection }) => {
  if (roomAuthCache.size >= ROOM_AUTH_CACHE_MAX_ENTRIES) pruneRoomAuthCache();
  roomAuthCache.set(getRoomAuthCacheKey(authToken, room), {
    ...value,
    expiresAt: Date.now() + ROOM_AUTH_CACHE_TTL_MS,
  });
};

const authorizeRoomsForConnection = async (ctx: WsConnectionContext, rooms: RealtimeRoom[]) => {
  if (!ctx.token) throw new Error("authentication required");

  const accepted: RealtimeRoom[] = [];
  const rejected: RealtimeRoomRejection[] = [];
  const misses: RealtimeRoom[] = [];

  for (const room of rooms) {
    const cached = getCachedRoomAuth(ctx.token, room);
    if (!cached) {
      misses.push(room);
      continue;
    }
    if (cached.accepted) accepted.push(room);
    else if (cached.rejection) rejected.push(cached.rejection);
  }

  if (misses.length > 0) {
    const result = await authorizeRealtimeRooms({ authToken: ctx.token, rooms: misses });
    accepted.push(...result.rooms);
    rejected.push(...result.rejected);
    for (const room of result.rooms) setCachedRoomAuth(ctx.token, room, { accepted: true });
    for (const rejection of result.rejected) {
      const room = normalizeRealtimeRooms([rejection.room])[0];
      if (room) setCachedRoomAuth(ctx.token, room, { accepted: false, rejection });
    }
  }

  return { rooms: accepted, rejected };
};

const startWsConnectionSweeper = () => {
  setInterval(async () => {
    const now = Date.now();
    for (const [connectionId, ctx] of wsConnections.entries()) {
      const raw = await redisCommandClient.get(getWsConnectionKey(connectionId)).catch(() => null);
      if (raw) continue;
      const socket = wsSockets.get(connectionId);
      if (socket && socket.readyState === socket.OPEN) {
        socket.close(4001, `expired:${now}`);
      }
      await cleanupWsConnection(ctx);
    }
  }, 30_000);
};

const resolveRealtimeRoomsForEnvelope = (payload: GatewayWsBroadcastPayload): RealtimeRoom[] => {
  const payloadRecord = (payload.payload ?? {}) as Record<string, unknown>;
  const explicitRooms = normalizeRealtimeRooms(Array.isArray(payload.rooms) ? payload.rooms : []);
  if (explicitRooms.length > 0) return explicitRooms;

  if (typeof payload.spaceId === "string" && payload.spaceId.trim()) {
    return [getRealtimeSpaceRoom(payload.spaceId.trim())];
  }

  const task = payloadRecord.task;
  if (task && typeof task === "object") {
    const taskRecord = task as { spaceId?: unknown; userId?: unknown };
    if (typeof taskRecord.spaceId === "string" && taskRecord.spaceId.trim()) {
      return [getRealtimeSpaceRoom(taskRecord.spaceId.trim())];
    }
    if (typeof taskRecord.userId === "string" && taskRecord.userId.trim()) {
      return [getRealtimeUserRoom(taskRecord.userId.trim())];
    }
  }

  const userId = typeof payloadRecord.userId === "string" ? payloadRecord.userId.trim() : "";
  return userId ? [getRealtimeUserRoom(userId)] : [];
};

async function fanOutBroadcastToLocalSockets(payload: GatewayWsBroadcastPayload) {
  const envelope = payload as RealtimeEnvelope;
  const deliveredConnectionIds = new Set<string>();

  const deliverConnection = (connectionId: string) => {
    if (deliveredConnectionIds.has(connectionId)) return;
    const socket = wsSockets.get(connectionId);
    if (!socket) return;
    deliveredConnectionIds.add(connectionId);
    sendWsRealtime(socket, wsConnections.get(connectionId), envelope);
  };

  for (const room of resolveRealtimeRoomsForEnvelope(payload)) {
    const connectionIds = wsConnectionIdsByRoom.get(room);
    if (!connectionIds) continue;
    for (const connectionId of connectionIds) deliverConnection(connectionId);
  }
}

async function startSpaceOutputSubscriber() {
  const client = createPubSubRedisClient();
  if (client.status === "wait") {
    await client.connect();
  }

  await client.subscribe(REALTIME_OUTBOUND_CHANNEL, AGENT_REALTIME_PATCH_CHANNEL);
  client.on("message", (channel, message) => {
    if (![REALTIME_OUTBOUND_CHANNEL, AGENT_REALTIME_PATCH_CHANNEL].includes(channel)) return;
    try {
      const parsed = realtimeEnvelopeSchema.safeParse(JSON.parse(message));
      if (!parsed.success) {
        logger.error("[Gateway] Invalid realtime payload:", parsed.error.issues);
        return;
      }
      void fanOutBroadcastToLocalSockets(parsed.data as GatewayWsBroadcastPayload).catch((error) => {
        logger.error("[Gateway] Failed to fan out realtime payload:", error);
      });
    } catch (error) {
      logger.error("[Gateway] Failed to handle realtime payload:", error);
    }
  });
}

const submitWebsocketSessionMessage = async (ctx: WsConnectionContext, requestId: string | undefined, payload: Record<string, unknown>) => {
  const spaceId = typeof payload.spaceId === "string" ? payload.spaceId.trim() : "";
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
  const clientMessageId = typeof payload.clientMessageId === "string" && payload.clientMessageId.trim()
    ? payload.clientMessageId.trim()
    : randomUUID();
  const content = Array.isArray(payload.content)
    ? payload.content as ContentBlock[]
    : [];
  const model = typeof payload.model === "string" && payload.model.trim()
    ? payload.model.trim()
    : null;
  const provider = typeof payload.provider === "string" && payload.provider.trim()
    ? payload.provider.trim()
    : null;

  if (!ctx.userId) throw new WsClientInputError("authentication required");
  if (!spaceId || !sessionId) throw new WsClientInputError("spaceId and sessionId are required");
  if (content.length === 0) throw new WsClientInputError("content is required");

  const effectiveRequestId = getOrCreateRequestId(requestId);
  const result = await submitInternalSessionPrompt({
    spaceId,
    sessionId,
    userId: ctx.userId,
    authToken: ctx.token,
    clientMessageId,
    content,
    source: "websocket",
    model,
    provider,
    context: {
      kind: "websocket",
      requestId: effectiveRequestId,
      connectionId: ctx.connectionId,
    },
  });

  return { ...result, spaceId, sessionId, clientMessageId, requestId: effectiveRequestId };
};

async function main() {
  logStartupInfo();

  startWsConnectionSweeper();
  await startSpaceOutputSubscriber();

  const reconcileRetryDelaysMs = [1_000, 3_000, 10_000, 30_000];
  let reconcileInFlight = false;
  let pendingReconcileReason: string | null = null;
  let lastChannelReconcileOk = false;
  let lastChannelReconcileAt: number | null = null;
  const sleep = (delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs));
  const requestChannelReconcileOnce = async (reason: string) => {
    for (let attempt = 0; attempt <= reconcileRetryDelaysMs.length; attempt += 1) {
      try {
        const { stats } = await requestGatewayChannelReconcile();
        lastChannelReconcileOk = true;
        lastChannelReconcileAt = Date.now();
        logger.info("[Gateway] Channel reconcile requested", { reason, attempt: attempt + 1, stats });
        return true;
      } catch (error) {
        const retryDelayMs = reconcileRetryDelaysMs[attempt];
        if (retryDelayMs == null) {
          lastChannelReconcileOk = false;
          lastChannelReconcileAt = Date.now();
          logger.error("[Gateway] Failed to request channel reconcile", { reason, attempt: attempt + 1, error });
          return false;
        }
        logger.warn("[Gateway] Failed to request channel reconcile; retrying", { reason, attempt: attempt + 1, retryDelayMs, error });
        await sleep(retryDelayMs);
      }
    }
    return false;
  };

  const requestChannelReconcile = async (reason: string) => {
    if (reconcileInFlight) {
      pendingReconcileReason = pendingReconcileReason ? `${pendingReconcileReason},${reason}` : reason;
      return false;
    }

    reconcileInFlight = true;
    let currentReason = reason;
    let lastResult = false;
    try {
      while (true) {
        lastResult = await requestChannelReconcileOnce(currentReason);
        if (!pendingReconcileReason) break;
        currentReason = pendingReconcileReason;
        pendingReconcileReason = null;
      }
      return lastResult;
    } finally {
      reconcileInFlight = false;
    }
  };

  const manager = new GatewayManager({
    onStaleNodesPruned: (nodeIds) => requestChannelReconcile(`stale_nodes_pruned:${nodeIds.join(",")}`),
  });
  await initOutboundConsumerGroup(manager.nodeId);
  await manager.start();
  void requestChannelReconcile("node_started");

  logger.info("[Gateway] Listening for outbound commands from API...");

  listenOutboundCommands(manager.nodeId, async (cmd: PlannedGatewayOutboundCommand) => {
    logger.info("[Gateway] Received outbound command:", {
      commandId: cmd.commandId,
      channelId: cmd.channelId,
      provider: cmd.provider,
      externalChatId: cmd.externalChatId,
      contentPreview: cmd.content.map((c: { type: string }) => c.type).join(", "),
    });

    const targetNodeId = typeof cmd.meta?.targetNodeId === "string" ? cmd.meta.targetNodeId : null;
    if (targetNodeId && targetNodeId !== manager.nodeId) {
      logger.warn("[Gateway] Command rejected: wrong target node", { commandId: cmd.commandId, channelId: cmd.channelId, targetNodeId, nodeId: manager.nodeId });
      return { success: false, error: `Wrong target node ${targetNodeId}` };
    }

    const provider = manager.getProvider(cmd.channelId);
    if (!provider) {
      logger.warn(`[Gateway] Command rejected: provider not found for channel ${cmd.channelId}`);
      logger.warn(`[Gateway] Active channels: ${manager.getActiveChannelIds().join(", ") || "none"}`);
      return { success: false, error: `Provider not found for channel ${cmd.channelId}` };
    }

    logger.info(`[Gateway] Routing command ${cmd.commandId} to ${cmd.provider} provider`);
    const result = await provider.handleOutbound(cmd);
    logger.info(`[Gateway] Command ${cmd.commandId} result:`, result.success ? "success" : `failed: ${result.error}`);
    return result;
  }).catch((error) => {
    logger.error("[Gateway] Fatal error listening to outbound stream:", error);
  });

  const app = new Hono();
  app.use(
    "*",
    httpInstrumentationMiddleware({
      serviceName: "cohub-gateway",
    }),
  );
  app.use("*", cors());

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/readyz", async (c) => {
    const checks: Record<string, boolean> = {};
    try {
      await redisCommandClient.ping();
      checks.redis = true;
    } catch {
      checks.redis = false;
    }
    checks.manager = manager.started;
    return c.json({
      ready: Object.values(checks).every(Boolean),
      checks,
      channelReconcile: {
        ok: lastChannelReconcileOk,
        inFlight: reconcileInFlight,
        pendingReason: pendingReconcileReason,
        checkedAt: lastChannelReconcileAt,
      },
    }, Object.values(checks).every(Boolean) ? 200 : 503);
  });

  const server = serve({ fetch: app.fetch, port: gatewayConfig.port }) as unknown as import("node:http").Server;
  const wss = new WebSocketServer({ noServer: true });
  const asrWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  // Local sandbox relay: control (runner⇒gateway), data (runner dial-out), and
  // peer (agent/worker⇒gateway) channels. Large payloads flow on data channels.
  const relayControlWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const relayDataWss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024 });
  const relayPeerWss = new WebSocketServer({ noServer: true, maxPayload: 50 * 1024 * 1024 });

  const websocketRoutes = new Map<string, WebSocketServer>([
    ["/ws", wss],
    ["/asr/ws", asrWss],
    ["/sandbox/relay", relayControlWss],
    ["/sandbox/relay/data", relayDataWss],
  ]);

  // Match /internal/sandbox-relay/:spaceId for cloud peers.
  const RELAY_PEER_PREFIX = "/internal/sandbox-relay/";

  server.on("upgrade", (request, socket, head) => {
    const pathname = request.url ? new URL(request.url, "http://localhost").pathname : "";

    if (pathname.startsWith(RELAY_PEER_PREFIX)) {
      const spaceId = decodeURIComponent(pathname.slice(RELAY_PEER_PREFIX.length)).trim();
      if (!spaceId) {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      relayPeerWss.handleUpgrade(request, socket, head, (websocket) => {
        handleRelayPeerConnection(websocket, request, spaceId);
      });
      return;
    }

    const websocketServer = websocketRoutes.get(pathname);
    if (!websocketServer) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  asrWss.on("connection", handleAsrWebSocketConnection);
  relayControlWss.on("connection", (socket, request) => void handleRelayControlConnection(socket, request));
  relayDataWss.on("connection", (socket, request) => handleRelayDataConnection(socket, request));

  wss.on("connection", (socket: WebSocket) => {
    const connectionId = randomUUID();
    const ctx: WsConnectionContext = {
      connectionId,
      capabilities: new Set(),
      rooms: new Set(),
      presenceMetaBySpace: new Map(),
      compactStreamAliases: new Map(),
      nextCompactStreamAlias: 0,
    };
    wsConnections.set(connectionId, ctx);
    wsSockets.set(connectionId, socket);
    sendWsEnvelope(socket, buildRealtimeEnvelope({
      domain: "system",
      type: "system.ready",
      payload: { connectionId },
    }));

    socket.on("message", async (data: RawData) => {
      let requestId: string | undefined;
      try {
        const raw = typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf-8")
            : Array.isArray(data)
              ? Buffer.concat(data.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString("utf-8")
              : Buffer.from(data).toString("utf-8");
        if (Buffer.byteLength(raw, "utf-8") > WS_MAX_MESSAGE_BYTES) {
          sendWsError(socket, "MESSAGE_TOO_LARGE", "message too large");
          return;
        }

        const message = parseWsJson(raw);
        requestId = typeof message.requestId === "string" ? message.requestId : undefined;

        if (message.type === "ping") {
          await touchWsConnection(ctx);
          sendWsEnvelope(socket, buildRealtimeEnvelope({
            domain: "system",
            type: "system.pong",
            requestId: requestId ?? null,
            payload: {},
          }));
          return;
        }

        if (message.type === "auth") {
          const token = typeof message.payload?.token === "string" ? message.payload.token.trim() : "";
          if (!token) {
            sendWsError(socket, "UNAUTHORIZED", "token is required", requestId);
            return;
          }
          const result: RealtimeAuthResult = await authenticateRealtimeToken({ token });
          if (!result.ok) {
            sendWsError(socket, "UNAUTHORIZED", result.error.message, requestId);
            return;
          }
          unsubscribeConnectionFromAllRooms(ctx);
          ctx.compactStreamAliases.clear();
          ctx.presenceMetaBySpace.clear();
          ctx.userId = result.user.uuid;
          ctx.userName = typeof result.user.nick_name === "string" ? result.user.nick_name : undefined;
          ctx.userAvatarUrl = typeof result.user.avatar_url === "string" ? result.user.avatar_url : undefined;
          ctx.token = token;
          ctx.capabilities = new Set(
            Array.isArray(message.payload.capabilities)
              ? message.payload.capabilities.filter((value) => typeof value === "string" && value.trim())
              : [],
          );
          subscribeConnectionToRoom(ctx, getRealtimeUserRoom(result.user.uuid));
          await persistWsConnection(ctx);
          sendWsEnvelope(socket, buildRealtimeEnvelope({
            domain: "system",
            type: "system.auth.ok",
            requestId: requestId ?? null,
            payload: { connectionId, user: result.user, capabilities: [WS_ROOM_SUBSCRIPTION_CAPABILITY] },
          }));
          return;
        }

        if (!ctx.userId || !ctx.token) {
          sendWsError(socket, "UNAUTHORIZED", "authentication required", requestId);
          return;
        }

        await touchWsConnection(ctx);

        if (message.type === "subscribe") {
          const rooms = normalizeRealtimeRooms(message.payload.rooms);
          if (rooms.length === 0) {
            sendWsError(socket, "BAD_REQUEST", "rooms are required", requestId);
            return;
          }
          try {
            const result = await authorizeRoomsForConnection(ctx, rooms);
            for (const room of result.rooms) subscribeConnectionToRoom(ctx, room);
            await persistWsConnection(ctx);
            sendWsEnvelope(socket, buildRealtimeEnvelope({
              domain: "system",
              type: "system.subscribe.ok",
              requestId: requestId ?? null,
              payload: { rooms: result.rooms },
            }));
            if (result.rejected.length > 0) {
              sendWsEnvelope(socket, buildRealtimeEnvelope({
                domain: "system",
                type: "system.subscribe.error",
                requestId: requestId ?? null,
                payload: { rejected: result.rejected },
              }));
            }
          } catch (error) {
            logger.warn("[Gateway] Realtime room authorization failed", { connectionId, error });
            sendWsEnvelope(socket, buildRealtimeEnvelope({
              domain: "system",
              type: "system.subscribe.error",
              requestId: requestId ?? null,
              payload: {
                rejected: rooms.map((room) => ({
                  room,
                  code: "FORBIDDEN",
                  message: "Failed to authorize realtime room",
                })),
              },
            }));
          }
          return;
        }

        if (message.type === "unsubscribe") {
          for (const room of normalizeRealtimeRooms(message.payload.rooms)) {
            if (room === getRealtimeUserRoom(ctx.userId)) continue;
            const spaceId = getSpaceIdFromRoom(room);
            if (spaceId) ctx.presenceMetaBySpace.delete(spaceId);
            unsubscribeConnectionFromRoom(ctx, room);
          }
          await persistWsConnection(ctx);
          sendWsEnvelope(socket, buildRealtimeEnvelope({
            domain: "system",
            type: "system.subscribe.ok",
            requestId: requestId ?? null,
            payload: { rooms: [...ctx.rooms] },
          }));
          return;
        }

        if (message.type === "presence.update") {
          const spaceId = typeof message.payload.spaceId === "string" ? message.payload.spaceId : "";
          const room = getRealtimeSpaceRoom(spaceId);
          if (!ctx.rooms.has(room)) {
            const result = await authorizeRoomsForConnection(ctx, [room]);
            if (result.rooms.length === 0) {
              sendWsEnvelope(socket, buildRealtimeEnvelope({
                domain: "system",
                type: "system.subscribe.error",
                requestId: requestId ?? null,
                payload: { rejected: result.rejected },
              }));
              return;
            }
            subscribeConnectionToRoom(ctx, room);
            await persistWsConnection(ctx);
          }
          ctx.presenceMetaBySpace.set(spaceId, message.payload.meta ?? null);
          await writeSpacePresenceConnection(ctx, spaceId);
          scheduleSpacePresenceUpdate(spaceId);
          return;
        }

        if (message.type === "canvas.tx") {
          try {
            const payload = message.payload ?? {};
            const spaceId = typeof payload.spaceId === "string" ? payload.spaceId : "";
            const documentId = typeof payload.documentId === "string" ? payload.documentId : "";
            const txId = typeof payload.txId === "string" ? payload.txId : "";
            const ops = Array.isArray(payload.ops) ? payload.ops.filter((op): op is Record<string, unknown> => Boolean(op && typeof op === "object" && !Array.isArray(op))) : [];
            if (!spaceId || !documentId || !txId || ops.length === 0) throw new WsClientInputError("invalid canvas transaction");
            const result = await submitCanvasTransaction({
              userId: ctx.userId,
              spaceId,
              documentId,
              txId,
              baseVersion: typeof payload.baseVersion === "number" ? payload.baseVersion : null,
              clientId: typeof payload.clientId === "string" ? payload.clientId : null,
              undoGroupId: typeof payload.undoGroupId === "string" ? payload.undoGroupId : null,
              ops,
            });
            sendWsEnvelope(socket, buildRealtimeEnvelope({
              domain: "space",
              type: "canvas.tx.ack",
              requestId: requestId ?? null,
              spaceId,
              sessionId: null,
              payload: { documentId, txId, version: result.document.version },
            }));
          } catch (error) {
            if (error instanceof WsClientInputError) throw error;
            const payload = message.payload ?? {};
            sendWsEnvelope(socket, buildRealtimeEnvelope({
              domain: "space",
              type: "canvas.tx.error",
              requestId: requestId ?? null,
              spaceId: typeof payload.spaceId === "string" ? payload.spaceId : null,
              sessionId: null,
              payload: {
                documentId: typeof payload.documentId === "string" ? payload.documentId : null,
                txId: typeof payload.txId === "string" ? payload.txId : null,
                message: error instanceof Error ? error.message : String(error),
              },
            }));
          }
          return;
        }

        if (message.type === "session.message.create") {
          try {
            const result = await submitWebsocketSessionMessage(ctx, requestId, message.payload ?? {});
            sendWsEnvelope(socket, buildRealtimeEnvelope({
              domain: "session",
              type: "session.request.accepted",
              requestId: result.requestId,
              spaceId: result.spaceId,
              sessionId: result.sessionId,
              payload: {
                clientMessageId: result.clientMessageId,
                turnId: result.turnId,
                userMessageId: result.userMessageId,
                traceId: result.trace.traceId,
              },
            }));
          } catch (error) {
            if (error instanceof WsClientInputError) throw error;
            const payload = message.payload ?? {};
            const isBillingError = error instanceof InternalPromptError;
            sendWsEnvelope(socket, buildRealtimeEnvelope({
              domain: "session",
              type: "session.request.error",
              requestId: requestId ?? null,
              spaceId: typeof payload.spaceId === "string" ? payload.spaceId : null,
              sessionId: typeof payload.sessionId === "string" ? payload.sessionId : null,
              payload: {
                code: isBillingError ? error.code : "SUBMIT_FAILED",
                message: error instanceof Error ? error.message : String(error),
                clientMessageId: typeof payload.clientMessageId === "string" ? payload.clientMessageId : null,
                billing: isBillingError ? error.billing : null,
              },
            }));
          }
          return;
        }

        if (message.type === "ack") {
          sendWsEnvelope(socket, buildRealtimeEnvelope({
            domain: "system",
            type: "system.ack.ok",
            requestId: requestId ?? null,
            payload: {},
          }));
          return;
        }

        sendWsError(socket, "UNSUPPORTED_EVENT", "unsupported event type", requestId);
      } catch (error) {
        if (error instanceof WsClientInputError) {
          sendWsError(socket, "BAD_REQUEST", error.message, error.requestId ?? requestId);
          return;
        }
        logger.error("[Gateway] WebSocket message handling failed:", error);
        sendWsError(socket, "INTERNAL_ERROR", "internal error", requestId);
      }
    });

    socket.on("close", () => {
      void cleanupWsConnection(wsConnections.get(connectionId));
    });
    socket.on("error", () => {
      void cleanupWsConnection(wsConnections.get(connectionId));
    });
  });

  logger.info(`@cohub/gateway listening on :${gatewayConfig.port}`);

  const shutdown = async () => {
    logger.info("[Gateway] Received shutdown signal, stopping...");
    await manager.stop();
    logger.info("[Gateway] Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  if (process.env.DEBUG_MODE === "true") {
    logger.info("[Gateway] DEBUG_MODE enabled.");

    const startDebugProvider = async (channelId: string, providerType: string, credential: string | { appId: string; appSecret: string; brand?: string }) => {
      logger.info(`[Debug] Initializing test channel: ${channelId} (${providerType})`);

      if (providerType === "discord" && typeof credential === "string") {
        const { DiscordProvider } = await import("./providers/discord/index.js");
        const provider = new DiscordProvider(channelId, credential);
        // @ts-expect-error
        manager.providers.set(channelId, provider);
      } else if (providerType === "feishu" && typeof credential === "object") {
        const { FeishuProvider } = await import("./providers/feishu/index.js");
        const provider = new FeishuProvider(channelId, {
          appId: credential.appId,
          appSecret: credential.appSecret,
          brand: (credential.brand as "feishu" | "lark") ?? "feishu",
        });
        // @ts-expect-error
        manager.providers.set(channelId, provider);
      }
    };

    if (process.env.DEBUG_DISCORD_BOT_TOKEN) {
      await startDebugProvider("debug-discord", "discord", process.env.DEBUG_DISCORD_BOT_TOKEN);
    }
    if (process.env.DEBUG_TELEGRAM_BOT_TOKEN) {
      await startDebugProvider("debug-telegram", "telegram", process.env.DEBUG_TELEGRAM_BOT_TOKEN);
    }
    if (process.env.DEBUG_FEISHU_APP_ID) {
      await startDebugProvider("debug-feishu", "feishu", {
        appId: process.env.DEBUG_FEISHU_APP_ID,
        appSecret: process.env.DEBUG_FEISHU_APP_SECRET ?? "",
        brand: process.env.DEBUG_FEISHU_BRAND ?? "feishu",
      });
    }

  }
}

main().catch((error) => logger.error("[Gateway] main failed", error));
