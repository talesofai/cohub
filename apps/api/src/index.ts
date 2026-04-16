import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { Hono, type Context } from "hono";

import {
  fetchAuthUser,
  getTokenFromRequest,
  type AuthUserProfile,
} from "./auth.js";
import {
  createSpaceDirectory,
  deleteSpaceNode,
  listSpaceDirectory,
  moveSpaceNode,
  readSpaceFile,
  spaceFsJsonError,
  streamSpaceFile,
  writeSpaceFile,
} from "./space-fs.js";
import { assertRequiredConfig, config } from "./config.js";
import { ensureUserGitAccount } from "./git-accounts.js";
import { createRepository } from "./gitea.js";
import { provisionSpaceInBackground } from "./space-sandboxes.js";
import type {
  PersistMessageInput,
  UpdateSessionInfoInput,
  RegisterSessionInput,
  ContentBlock,
} from "@cohub/protocol";
import {
  createInitialSpaceSession,
  getSpaceById,
  getSpaceSessionBootstrap,
  getSpaceSessionById,
  listSpaceSessions,
  listSessionMessages,
  normalizeSpaceEnv,
  persistMessageNode,
  readSpaceOutputStream,
  registerSpaceSession,
  updateSpaceSessionInfo,
  validateSpaceEnv,
  enqueueSpacePrompt,
  updateSpaceStatus,
  SandboxNotReadyError,
} from "./space-sessions.js";
import { db } from "./db/index.js";
import { userChannels, resourcePermissions, spaceChannels, spaces } from "./db/schema-v2.js";
import { eq, and, inArray, desc } from "drizzle-orm";
import { syncSpaceChannelConfigCache, getSpaceChannelsBySpaceId } from "./channels.js";
import { createBlockingRedisClient, redisCommandClient, ensureConsumerGroup, isRedisReady, GATEWAY_INBOUND_STREAM, INBOUND_CONSUMER_GROUP, GATEWAY_LOGS_STREAM, getStreamInfo, checkPendingMessages } from "./redis.js";
import { getSpaceSandboxBySpaceId } from "./space-sandboxes.js";
import type { GatewayInboundEvent, TaskScheduleConfig } from "@cohub/protocol";
import { normalizeWorkspaceSlug } from "@cohub/protocol";
import { canRead, canReadForSession, canWrite } from "./permissions.js";
import { handleInboundEvent } from "./channels.js";
import * as cronParser from "cron-parser";
const { CronExpressionParser } = cronParser;

const buildSpaceListItem = async (space: typeof spaces.$inferSelect) => {
  const sandbox = await getSpaceSandboxBySpaceId(space.id);
  return {
    ...space,
    sandboxStatus: sandbox?.status ?? null,
  };
};

const MODELS_CATALOG_URL = "https://gitea.cohub.run/global/configs/raw/branch/main/.pi/agent/models.json";
const MODELS_REDIS_KEY = "configs:models";
const MODELS_CACHE_TTL_SEC = 30 * 60;

type ModelCatalogEntry = {
  provider: string;
  id: string;
  model: Record<string, unknown>;
};

let modelsCachePromise: Promise<ModelCatalogEntry[]> | null = null;

async function fetchModelsCatalog(): Promise<ModelCatalogEntry[]> {
  if (modelsCachePromise) return modelsCachePromise;
  modelsCachePromise = (async () => {
    const cached = await redisCommandClient.get(MODELS_REDIS_KEY);
    if (cached) {
      try {
        return JSON.parse(cached) as ModelCatalogEntry[];
      } catch {}
    }
    const response = await fetch(MODELS_CATALOG_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch models catalog: ${response.status} ${response.statusText}`);
    }
    const raw = await response.json() as { providers: Record<string, { models?: Array<Record<string, unknown>> }> };
    const entries: ModelCatalogEntry[] = [];
    for (const [provider, providerConfig] of Object.entries(raw.providers ?? {})) {
      for (const model of providerConfig.models ?? []) {
        entries.push({ provider, id: String(model.id), model });
      }
    }
    await redisCommandClient.set(MODELS_REDIS_KEY, JSON.stringify(entries), "EX", MODELS_CACHE_TTL_SEC);
    return entries;
  })();
  try {
    return await modelsCachePromise;
  } finally {
    modelsCachePromise = null;
  }
}

const CONSUMER_NAME = `api-${process.env.POD_NAME || process.env.HOSTNAME || Math.random().toString(36).slice(2, 8)}`;
const INBOUND_BATCH_SIZE = 10;
const INBOUND_BLOCK_MS = 5000;

const initInboundConsumerGroup = async () => {
  await ensureConsumerGroup(GATEWAY_INBOUND_STREAM, INBOUND_CONSUMER_GROUP, "0");
};

const startGatewayInboundListener = async () => {
  await initInboundConsumerGroup();
  const client = createBlockingRedisClient();
  await client.connect();
  while (true) {
    try {
      const entries = await client.xreadgroup(
        "GROUP",
        INBOUND_CONSUMER_GROUP,
        CONSUMER_NAME,
        "COUNT",
        INBOUND_BATCH_SIZE,
        "BLOCK",
        INBOUND_BLOCK_MS,
        "STREAMS",
        GATEWAY_INBOUND_STREAM,
        ">",
      );
      if (!entries || entries.length === 0) continue;
      for (const [, messages] of entries as Array<[string, Array<[string, string[]]>]>) {
        for (const [id, fields] of messages) {
          const payloadIndex = fields.findIndex((field) => field === "payload");
          const payload = payloadIndex >= 0 ? fields[payloadIndex + 1] : null;
          if (!payload) continue;
          try {
            const event = JSON.parse(payload) as GatewayInboundEvent;
            await handleInboundEvent(event);
            await client.xack(GATEWAY_INBOUND_STREAM, INBOUND_CONSUMER_GROUP, id);
          } catch {
            await client.xack(GATEWAY_INBOUND_STREAM, INBOUND_CONSUMER_GROUP, id).catch(() => undefined);
          }
        }
      }
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
};

startGatewayInboundListener().catch(console.error);

const app = new Hono<{
  Variables: {
    token: string | null;
    authUser: AuthUserProfile | null;
  };
}>();

app.use(cors({
  origin: (origin) => origin || "*",
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));

app.use(async (c, next) => {
  const token = getTokenFromRequest(c);
  c.set("token", token);
  if (token) {
    try {
      c.set("authUser", await fetchAuthUser(token));
    } catch {
      c.set("authUser", null);
    }
  } else {
    c.set("authUser", null);
  }
  await next();
});

const ensureInternalRequest = (c: Context) => {
  const secret = c.req.header("x-worker-secret");
  const expectedSecret = config.workerSecret;
  if (!secret || !expectedSecret) return c.json({ message: "forbidden" }, 403);
  const provided = new TextEncoder().encode(secret);
  const expected = new TextEncoder().encode(expectedSecret);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return c.json({ message: "forbidden" }, 403);
  }
  return null;
};

const requireValidId = (value: string | null | undefined) => Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));

app.get("/healthz", async (c) => {
  const redisReady = await isRedisReady();
  const inboundInfo = await getStreamInfo(GATEWAY_INBOUND_STREAM);
  const outboundInfo = await getStreamInfo(GATEWAY_LOGS_STREAM);
  const pendingInbound = await checkPendingMessages(GATEWAY_INBOUND_STREAM, INBOUND_CONSUMER_GROUP);
  return c.json({ ok: true, redisReady, inboundInfo, outboundInfo, pendingInbound, consumer: CONSUMER_NAME });
});

app.get("/readyz", async (c) => {
  return c.json({ ok: true });
});

app.get("/api/models", async (c) => {
  try {
    const catalog = await fetchModelsCatalog();
    const grouped: Record<string, ModelCatalogEntry[]> = {};
    for (const entry of catalog) {
      let list = grouped[entry.provider];
      if (!list) {
        list = [];
        grouped[entry.provider] = list;
      }
      list.push(entry);
    }
    return c.json(grouped);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "Failed to fetch models catalog" }, 502);
  }
});

app.post("/api/spaces", async (c) => {
  const token = c.get("token");
  if (!token) return c.json({ message: "unauthorized" }, 401);
  const user = c.get("authUser");
  if (!user?.uuid) return c.json({ message: "unauthorized" }, 401);

  const body = (await c.req.json<{
    name?: string;
    description?: string | null;
    source?: string;
    cwd?: string;
    protocol?: "pi" | "acp" | "internal";
    meta?: Record<string, unknown>;
    extraEnv?: Array<{ name: string; value: string }>;
    channelBindings?: Array<{ channelId: string; config?: Record<string, unknown> | null }>;
  }>().catch(() => ({}))) as {
    name?: string;
    description?: string | null;
    source?: string;
    cwd?: string;
    protocol?: "pi" | "acp" | "internal";
    meta?: Record<string, unknown>;
    extraEnv?: Array<{ name: string; value: string }>;
    channelBindings?: Array<{ channelId: string; config?: Record<string, unknown> | null }>;
  };

  const name = body.name?.trim();
  if (!name) return c.json({ message: "name is required" }, 400);

  const repoSlug = normalizeWorkspaceSlug(name);
  const existingSpace = await db.select({ id: spaces.id }).from(spaces).where(and(eq(spaces.userUuid, user.uuid), eq(spaces.giteaRepoName, repoSlug))).limit(1);
  if (existingSpace.length > 0) return c.json({ message: "space already exists" }, 409);

  const gitAccount = await ensureUserGitAccount(user.uuid);
  const repo = await createRepository(gitAccount.giteaAccessToken, repoSlug, true).catch((error) => error as Error);
  if (repo instanceof Error) return c.json({ message: repo.message }, 500);

  const normalizedExtraEnv = normalizeSpaceEnv(body.extraEnv);
  validateSpaceEnv(normalizedExtraEnv);

  const normalizedChannelBindings = Array.isArray(body.channelBindings)
    ? body.channelBindings.filter((binding) => binding?.channelId && requireValidId(binding.channelId)).map((binding) => ({ channelId: binding.channelId, config: binding.config ?? null }))
    : [];

  if (normalizedChannelBindings.length > 0) {
    const ids = normalizedChannelBindings.map((binding) => binding.channelId);
    const channels = await db.select({ id: userChannels.id }).from(userChannels).where(and(eq(userChannels.userUuid, user.uuid), inArray(userChannels.id, ids)));
    if (channels.length !== ids.length) return c.json({ message: "one or more channels are invalid" }, 400);
  }

  const occupiedChannels = normalizedChannelBindings.length
    ? await db.select({ channelId: spaceChannels.channelId }).from(spaceChannels).where(inArray(spaceChannels.channelId, normalizedChannelBindings.map((binding) => binding.channelId)))
    : [];
  if (occupiedChannels.length > 0) return c.json({ message: "channel binding already exists for this channel" }, 409);

  const spaceId = crypto.randomUUID();
  const [space] = await db.insert(spaces).values({
    id: spaceId,
    userUuid: user.uuid,
    name,
    description: body.description ?? null,
    giteaRepoName: repoSlug,
    baseCheckpointId: null,
    meta: {
      ...(body.meta ?? {}),
      extraEnv: normalizedExtraEnv,
      cwd: body.cwd ?? null,
      protocol: body.protocol ?? "pi",
    },
  }).returning();

  if (!space) return c.json({ message: "failed to create space" }, 500);

  if (normalizedChannelBindings.length > 0) {
    const insertedChannels = await db.insert(spaceChannels).values(normalizedChannelBindings.map((binding) => ({ spaceId: space.id, channelId: binding.channelId, config: binding.config }))).returning();
    await Promise.all(insertedChannels.map((channel) => syncSpaceChannelConfigCache({ spaceChannelId: channel.id, config: (channel.config as Record<string, unknown> | null) ?? null })));
  }

  const session = await createInitialSpaceSession({
    spaceId: space.id,
    sessionId: crypto.randomUUID(),
    title: null,
    source: body.source ?? null,
    protocol: body.protocol ?? "pi",
    cwd: body.cwd ?? null,
    externalSessionId: null,
    meta: { createdBy: "api_space_create", channelBindings: normalizedChannelBindings.length },
  });

  void provisionSpaceInBackground({
    spaceId: space.id,
    userUuid: user.uuid,
    extraEnv: normalizedExtraEnv,
  }).catch(console.error);

  return c.json({ space, session });
});

app.get("/api/spaces", async (c) => {
  const token = c.get("token");
  if (!token) return c.json({ message: "unauthorized" }, 401);
  const user = c.get("authUser");
  if (!user?.uuid) return c.json({ message: "unauthorized" }, 401);
  const spaceList = await db.select().from(spaces).where(eq(spaces.userUuid, user.uuid)).orderBy(desc(spaces.updatedAt), desc(spaces.createdAt));
  const items = await Promise.all(spaceList.map((space) => buildSpaceListItem(space)));
  return c.json(items);
});

app.get("/api/spaces/:id", async (c) => {
  const user = c.get("authUser");
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!user?.uuid) return c.json({ message: "unauthorized" }, 401);
  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space || space.userUuid !== user.uuid) return c.json({ message: "space not found" }, 404);
  const sandbox = await getSpaceSandboxBySpaceId(space.id);
  return c.json({ ...space, sandboxStatus: sandbox?.status ?? null });
});

app.post("/api/spaces/:id/sessions", async (c) => {
  const user = c.get("authUser");
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!user?.uuid) return c.json({ message: "unauthorized" }, 401);
  if (!await canWrite(user, spaceId)) return c.json({ message: "not found" }, 404);
  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);
  const body = await c.req.json<{ title?: string; source?: string; cwd?: string; protocol?: "pi" | "acp" | "internal" }>().catch(() => ({ title: undefined, source: undefined, cwd: undefined, protocol: undefined }));
  const session = await createInitialSpaceSession({
    spaceId: space.id,
    sessionId: crypto.randomUUID(),
    title: body.title ?? null,
    source: body.source ?? null,
    protocol: body.protocol ?? ((space.meta as Record<string, unknown>)?.protocol as "pi" | "acp" | "internal" | undefined) ?? "pi",
    cwd: body.cwd ?? ((space.meta as Record<string, unknown>)?.cwd as string | undefined) ?? null,
    externalSessionId: null,
    meta: { createdBy: "api_space_session_create" },
  });
  return c.json({ ok: true, session });
});

app.get("/api/spaces/:id/sessions", async (c) => {
  const user = c.get("authUser");
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!await canRead(user, spaceId)) return c.json({ message: "not found" }, 404);
  const space = await getSpaceById(spaceId);
  const [spaceRow] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space || !spaceRow) return c.json({ message: "space not found" }, 404);
  const sessions = await listSpaceSessions(space.id);
  const permissions = await db.select().from(resourcePermissions).where(inArray(resourcePermissions.resourceId, [spaceId, ...sessions.map((s) => s.id)]));
  const sessionShareLevels = new Map(permissions.filter((p) => p.resourceType === "session").map((p) => [p.resourceId, p.level]));
  const isOwner = user?.uuid === space.userUuid;
  const isCollaborator = !isOwner && permissions.some((p) => p.resourceType === "space" && p.resourceId === spaceId && p.granteeUuid === user?.uuid);
  const visibleSessions = isOwner || isCollaborator ? sessions : (await Promise.all(sessions.map(async (s) => ((await canReadForSession(user, spaceId, s.id)) ? s : null)))).filter((s): s is NonNullable<typeof s> => Boolean(s));
  return c.json({ space: spaceRow, sessions: visibleSessions.map((session) => ({ ...session, shareLevel: sessionShareLevels.get(session.id) ?? null })) });
});

app.get("/api/sessions/:id", async (c) => {
  const user = c.get("authUser");
  const sessionId = c.req.param("id");
  if (!requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);
  const session = await getSpaceSessionById(sessionId);
  if (!session) return c.json({ message: "session not found" }, 404);
  if (!await canRead(user, session.spaceId, sessionId)) return c.json({ message: "session not found" }, 404);
  const space = await getSpaceById(session.spaceId);
  if (!space) return c.json({ message: "session not found" }, 404);
  return c.json({ space, session });
});

app.get("/api/spaces/:id/channels", async (c) => {
  const user = c.get("authUser");
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!user?.uuid) return c.json({ message: "unauthorized" }, 401);
  const space = await getSpaceById(spaceId);
  if (!space || space.userUuid !== user.uuid) return c.json({ message: "space not found" }, 404);
  const channels = await getSpaceChannelsBySpaceId(space.id);
  const channelIds = channels.map((item) => item.channelId);
  const channelList = channelIds.length > 0 ? await db.select().from(userChannels).where(and(eq(userChannels.userUuid, user.uuid), inArray(userChannels.id, channelIds))) : [];
  const userChannelById = new Map(channelList.map((item) => [item.id, item]));
  return c.json(channels.map((channel) => ({ ...channel, channel: userChannelById.get(channel.channelId) ?? null })));
});

app.get("/api/spaces/:id/fs/tree", async (c) => {
  const user = c.get("authUser");
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!await canWrite(user, spaceId)) return c.json({ message: "not found" }, 404);
  const path = c.req.query("path") ?? "";
  try {
    return c.json(await listSpaceDirectory(spaceId, path));
  } catch (error) {
    const { status, body } = spaceFsJsonError(error);
    return c.json(body, status as never);
  }
});

app.get("/api/spaces/:id/fs/file", async (c) => {
  const user = c.get("authUser");
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!await canWrite(user, spaceId)) return c.json({ message: "not found" }, 404);
  const path = c.req.query("path") ?? "";
  try {
    return c.json(await readSpaceFile(spaceId, path));
  } catch (error) {
    const { status, body } = spaceFsJsonError(error);
    return c.json(body, status as never);
  }
});

app.put("/api/spaces/:id/fs/file", async (c) => {
  const user = c.get("authUser");
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!await canWrite(user, spaceId)) return c.json({ message: "not found" }, 404);
  const body = await c.req.json<{ path: string; content: string; encoding: "utf-8" | "base64" }>().catch(() => null);
  if (!body?.path || typeof body.content !== "string" || !body.encoding) return c.json({ message: "path, content and encoding are required" }, 400);
  try {
    return c.json(await writeSpaceFile(spaceId, body));
  } catch (error) {
    const { status, body } = spaceFsJsonError(error);
    return c.json(body, status as never);
  }
});

app.post("/api/spaces/:id/fs/dir", async (c) => {
  const user = c.get("authUser");
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!await canWrite(user, spaceId)) return c.json({ message: "not found" }, 404);
  const body = await c.req.json<{ path: string }>().catch(() => null);
  if (!body?.path) return c.json({ message: "path is required" }, 400);
  try {
    return c.json(await createSpaceDirectory(spaceId, body.path));
  } catch (error) {
    const { status, body } = spaceFsJsonError(error);
    return c.json(body, status as never);
  }
});

app.delete("/api/spaces/:id/fs/node", async (c) => {
  const user = c.get("authUser");
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!await canWrite(user, spaceId)) return c.json({ message: "not found" }, 404);
  const path = c.req.query("path") ?? "";
  const recursive = c.req.query("recursive") === "true";
  try {
    return c.json(await deleteSpaceNode(spaceId, path, recursive));
  } catch (error) {
    const { status, body } = spaceFsJsonError(error);
    return c.json(body, status as never);
  }
});

app.post("/api/spaces/:id/fs/move", async (c) => {
  const user = c.get("authUser");
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!await canWrite(user, spaceId)) return c.json({ message: "not found" }, 404);
  const body = await c.req.json<{ fromPath: string; toPath: string }>().catch(() => null);
  if (!body?.fromPath || !body?.toPath) return c.json({ message: "fromPath and toPath are required" }, 400);
  try {
    return c.json(await moveSpaceNode(spaceId, body));
  } catch (error) {
    const { status, body } = spaceFsJsonError(error);
    return c.json(body, status as never);
  }
});

app.get("/api/spaces/:id/fs/download", async (c) => {
  const user = c.get("authUser");
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!await canWrite(user, spaceId)) return c.json({ message: "not found" }, 404);
  const path = c.req.query("path") ?? "";
  try {
    const info = await streamSpaceFile(spaceId, path);
    const buffer = await readFile(info.target);
    return c.body(new Uint8Array(buffer), 200, {
      "content-type": info.mimeType ?? "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(info.name)}`,
    });
  } catch (error) {
    const { status, body } = spaceFsJsonError(error);
    return c.json(body, status as never);
  }
});

app.get("/api/spaces/:id/stream", async (c) => {
  const user = c.get("authUser");
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!await canRead(user, spaceId)) return c.json({ message: "not found" }, 404);
  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);
  const lastEventId = c.req.header("last-event-id") ?? c.req.query("lastEventId") ?? undefined;
  return streamSSE(c, async (stream) => {
    const heartbeatMs = 25000;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
      if (c.req.raw.signal.aborted || stream.aborted || stream.closed) return;
      void stream.write(`: ping ${Date.now()}\n\n`).catch(() => undefined);
    }, heartbeatMs);
    stream.onAbort(() => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    });
    try {
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ spaceId: space.id }) });
      const output = await readSpaceOutputStream({ spaceId: space.id, lastEventId, signal: c.req.raw.signal });
      for await (const item of output) {
        if (stream.aborted || stream.closed) break;
        if (!item.payload) continue;
        await stream.writeSSE({ id: item.id, event: "message", data: item.payload });
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  });
});

app.post("/internal/spaces/:id/status", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);
  const body = await c.req.json<{ status?: string }>().catch(() => null);
  if (!body?.status) return c.json({ message: "status is required" }, 400);
  await updateSpaceStatus(spaceId, body.status);
  return c.json({ ok: true });
});

app.post("/internal/spaces/:id/sessions", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);
  const body = await c.req.json<RegisterSessionInput>().catch(() => null);
  if (!body?.sessionId) return c.json({ message: "sessionId is required" }, 400);
  const existing = await getSpaceSessionById(body.sessionId);
  if (existing) {
    const bootstrap = await getSpaceSessionBootstrap(existing.id);
    return c.json({ ok: true, session: existing, bootstrap });
  }
  const session = await registerSpaceSession({ spaceId, sessionId: body.sessionId, title: body.title, protocol: body.protocol, externalSessionId: body.externalSessionId, cwd: body.cwd, meta: body.meta });
  const bootstrap = await getSpaceSessionBootstrap(session.id);
  return c.json({ ok: true, session, bootstrap });
});

app.post("/internal/spaces/:spaceId/sessions/:sessionId/info", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;
  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);
  const session = await getSpaceSessionById(sessionId);
  if (!session || session.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);
  const body = await c.req.json<UpdateSessionInfoInput>().catch(() => null);
  if (!body) return c.json({ message: "invalid body" }, 400);
  await updateSpaceSessionInfo({ spaceId, sessionId, title: body.title, updatedAt: body.updatedAt, meta: body.meta });
  return c.json({ ok: true });
});

app.post("/internal/spaces/:spaceId/sessions/:sessionId/messages", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;
  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);
  const session = await getSpaceSessionById(sessionId);
  if (!session || session.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);
  const body = await c.req.json<{ previousMessageId?: string | null; anchorUserMessageId?: string | null; idempotencyKey?: string; message?: PersistMessageInput["message"] & { id?: string | null } }>().catch(() => null);
  if (!body?.idempotencyKey?.trim()) return c.json({ message: "idempotencyKey is required" }, 400);
  if (!body.message || !Array.isArray(body.message.content)) return c.json({ message: "message.content is required" }, 400);
  const messageNode = await persistMessageNode({
    spaceId,
    sessionId,
    previousMessageId: body.previousMessageId ?? null,
    anchorUserMessageId: body.anchorUserMessageId ?? null,
    idempotencyKey: body.idempotencyKey,
    message: {
      ...(body.message as PersistMessageInput["message"]),
      id: body.message.id ?? undefined,
      content: body.message.content as never,
    } as PersistMessageInput["message"] & { id?: string },
  });
  return c.json({ ok: true, message: messageNode });
});

app.post("/internal/spaces/:spaceId/sessions/:sessionId/prompt", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;
  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);
  const session = await getSpaceSessionById(sessionId);
  if (!session || session.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);
  const body = await c.req.json<{ content: ContentBlock[]; userMessageId?: string | null; meta?: Record<string, unknown> | null }>().catch(() => null);
  if (!body || !Array.isArray(body.content) || body.content.length === 0) return c.json({ message: "content is required" }, 400);
  const userMessageId = body.userMessageId?.trim() || crypto.randomUUID();
  try {
    await enqueueSpacePrompt({ spaceId, sessionId, userMessageId, content: body.content, meta: body.meta ?? null });
  } catch (error) {
    if (error instanceof SandboxNotReadyError) return c.json({ message: error.message }, 409);
    throw error;
  }
  return c.json({ ok: true, userMessageId });
});

app.onError((error, c) => {
  const path = c.req.path;
  const method = c.req.method;
  console.error(`[API Error] ${method} ${path}:`, {
    message: error.message,
    stack: error.stack,
    name: error.name,
  });
  return c.json({ message: error.message || "internal server error" }, 500);
});

const port = Number(process.env.PORT ?? 8787);
assertRequiredConfig();
const server = serve({
  fetch: app.fetch,
  port,
  serverOptions: {
    requestTimeout: 0,
    keepAliveTimeout: 75_000,
  },
});
server.setTimeout(0);
console.log(`@cohub/api listening on :${port}`);
