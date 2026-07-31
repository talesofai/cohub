import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { boards } from "@cohub/db";
import { createLogger } from "@cohub/infra/logging";
import { getTracer, extractTrace } from "@cohub/infra/tracing/propagator";
import { GATEWAY_ATTACHMENT_MAX_BYTES, gatewayInboundEventSchema, type GatewayInboundEvent } from "@cohub/protocol/gateway";
import { parseRealtimeRoom } from "@cohub/protocol/realtime";
import { dispatchSpacePresenceUpdated } from "../../realtime-events.js";
import { getSpacePresenceSnapshot } from "../../space-presence.js";
import { Hono } from "hono";
import { bindAllActiveSpaceChannelsToGateway, handleInboundEvent, resolveChannelInboundForEventWithLock } from "../../channels.js";
import { hasPermission } from "../../permissions.js";
import { ensureInternalRequest, getOptionalAuth, requireValidId } from "../../lib/middleware.js";
import { getSpaceById } from "../../space-sessions.js";
import { getSpaceSandboxBySpaceId, updateSpaceSandbox } from "../../space-sandboxes.js";
import { normalizeSandboxLifecycleStatus, normalizeSandboxRuntimeStatus } from "@cohub/sandbox-controller";
import {
  PublicAssetConfigError,
  PublicAssetValidationError,
  consumePublicAssetUploadQuota,
  createInternalPublicAssetUploadPlan,
  isAllowedPublicAssetDownloadUrl,
} from "../../public-asset-storage.js";
import { UserUploadConfigError } from "../../user-upload-storage.js";
import {
  beginSpaceUploadComplete,
  buildSpaceUploadObjectKey,
  cancelSpaceUploadComplete,
  consumeSpaceUploadQuota,
  createPresignedGetUrl,
  createPresignedPutUrl,
  createSpaceUploadId,
  deleteSpaceUploadManifest,
  getSpaceUploadManifest,
  saveSpaceUploadManifest,
  SpaceUploadRateLimitError,
  type SpaceUploadManifestEntry,
} from "../../space-upload-storage.js";
import { enqueueSandboxUploadFilesJob } from "../../sandbox-bash-queue.js";
import { db } from "../../db/index.js";
import { eq } from "drizzle-orm";

const logger = createLogger({ serviceName: "cohub-api" });
const tracer = getTracer("cohub-api");
const router = new Hono();

const MAX_GATEWAY_ATTACHMENT_IMAGES = 8;
const MAX_GATEWAY_ATTACHMENT_FILES = 20;
const invalidUploadPathChars = new Set(["<", ">", ":", "\"", "/", "\\", "|", "?", "*"]);

const isSafeUploadPathPart = (part: string) =>
  part.length > 0 &&
  part.length <= 255 &&
  part !== "." &&
  part !== ".." &&
  Array.from(part).every((char) => !invalidUploadPathChars.has(char) && char.charCodeAt(0) > 0x1f);

const safeUploadPath = (value: string) => {
  const parts = value.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => !isSafeUploadPathPart(part))) return null;
  return parts.join("/");
};

const attachmentPlanErrorResponse = (error: unknown) => {
  if (error instanceof PublicAssetValidationError) {
    const status = error.message.includes("too large") ? 413 : 400;
    return { status, body: { message: error.message } };
  }
  if (error instanceof PublicAssetConfigError || error instanceof UserUploadConfigError) {
    return { status: 503, body: { message: "public asset storage is not configured" } };
  }
  return null;
};

const recordSpanError = (span: ReturnType<typeof tracer.startSpan>, error: unknown) => {
  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
};

router.post("/reconcile-channels", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const span = tracer.startSpan("api.gateway_channels.reconcile");
  try {
    const stats = await bindAllActiveSpaceChannelsToGateway();
    return c.json({ ok: true, stats });
  } catch (error) {
    recordSpanError(span, error);
    logger.error("[GatewayBinding] reconcile failed", error);
    return c.json({ ok: false, message: "gateway channel reconcile failed" }, 500);
  } finally {
    span.end();
  }
});

router.post("/space-presence-updated", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const body = await c.req.json<{ spaceId?: string }>().catch(() => null);
  const spaceId = typeof body?.spaceId === "string" ? body.spaceId.trim() : "";
  if (!spaceId || !requireValidId(spaceId)) return c.json({ ok: false, message: "spaceId is required" }, 400);

  const snapshot = await getSpacePresenceSnapshot(spaceId);
  await dispatchSpacePresenceUpdated(snapshot);
  return c.json({ ok: true, snapshot });
});

router.post("/authorize-realtime-rooms", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const user = getOptionalAuth(c);
  if (!user) return c.json({ ok: false, message: "authentication is required" }, 401);

  const body = await c.req.json<{ rooms?: string[] }>().catch(() => null);
  const requestedRooms = Array.isArray(body?.rooms) ? Array.from(new Set(body.rooms.filter((room): room is string => typeof room === "string").map((room) => room.trim()).filter(Boolean))) : [];
  if (requestedRooms.length === 0) return c.json({ ok: true, rooms: [], rejected: [] });

  const accepted: string[] = [];
  const rejected: Array<{ room: string; code: "BAD_ROOM" | "FORBIDDEN"; message: string }> = [];

  for (const room of requestedRooms) {
    const parsed = parseRealtimeRoom(room);
    if (!parsed) {
      rejected.push({ room, code: "BAD_ROOM", message: "Invalid room" });
      continue;
    }
    const normalizedRoom = `${parsed.kind}:${parsed.id}`;

    if (parsed.kind === "user") {
      if (parsed.id === user.uuid) {
        accepted.push(normalizedRoom);
      } else {
        rejected.push({ room, code: "FORBIDDEN", message: "Cannot subscribe to another user" });
      }
      continue;
    }

    if (parsed.kind === "board") {
      const [board] = await db
        .select({ spaceId: boards.spaceId })
        .from(boards)
        .where(eq(boards.id, parsed.id))
        .limit(1);
      const allowed = board
        ? await hasPermission(user, "file.view", { spaceId: board.spaceId }).catch((error) => {
            logger.warn("[RealtimeRooms] failed to authorize Board room", { room, userId: user.uuid, error });
            return false;
          })
        : false;
      if (allowed) accepted.push(normalizedRoom);
      else rejected.push({ room, code: "FORBIDDEN", message: "Missing Board view permission" });
      continue;
    }

    const allowed = await hasPermission(user, "space.view", { spaceId: parsed.id }).catch((error) => {
      logger.warn("[RealtimeRooms] failed to authorize room", { room, userId: user.uuid, error });
      return false;
    });
    if (allowed) {
      accepted.push(normalizedRoom);
    } else {
      rejected.push({ room, code: "FORBIDDEN", message: "Missing space.view permission" });
    }
  }

  return c.json({ ok: true, rooms: accepted, rejected });
});

router.post("/authorize-board-awareness", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const user = getOptionalAuth(c);
  if (!user) return c.json({ ok: false, message: "authentication is required" }, 401);

  const body = await c.req.json<{
    boardId?: string;
    spaceId?: string;
    permission?: "view" | "edit";
  }>().catch(() => null);
  const boardId = typeof body?.boardId === "string" ? body.boardId.trim() : "";
  const spaceId = typeof body?.spaceId === "string" ? body.spaceId.trim() : "";
  const permission = body?.permission === "edit" ? "edit" : "view";
  if (!requireValidId(boardId) || !requireValidId(spaceId)) {
    return c.json({ ok: false, message: "valid boardId and spaceId are required" }, 400);
  }

  const [board] = await db
    .select({ spaceId: boards.spaceId })
    .from(boards)
    .where(eq(boards.id, boardId))
    .limit(1);
  if (!board || board.spaceId !== spaceId) {
    return c.json({ ok: false, message: "board not found" }, 404);
  }

  const requiredPermission = permission === "edit" ? "file.edit" : "file.view";
  const allowed = await hasPermission(user, requiredPermission, { spaceId }).catch((error) => {
    logger.warn("[BoardAwareness] failed to authorize update", {
      boardId,
      spaceId,
      permission,
      userId: user.uuid,
      error,
    });
    return false;
  });
  if (!allowed) return c.json({ ok: false, message: `missing ${requiredPermission} permission` }, 403);
  return c.json({ ok: true, boardId, spaceId, permission });
});

// POST /internal/gateway/local-sandbox/authorize
// Called by the gateway relay when a local sandbox runner opens its control
// connection. Verifies the forwarded user token has sandbox.manage on the space
// and that the space is configured for a local sandbox provider.
router.post("/local-sandbox/authorize", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const user = getOptionalAuth(c);
  if (!user) return c.json({ ok: false, message: "authentication is required" }, 401);

  const body = await c.req.json<{ spaceId?: string }>().catch(() => null);
  const spaceId = typeof body?.spaceId === "string" ? body.spaceId.trim() : "";
  if (!spaceId || !requireValidId(spaceId)) return c.json({ ok: false, message: "spaceId is required" }, 400);

  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ ok: false, message: "space not found" }, 404);

  const allowed = await hasPermission(user, "sandbox.manage", { spaceId }).catch((error) => {
    logger.warn("[LocalSandbox] failed to authorize connect", { spaceId, userId: user.uuid, error });
    return false;
  });
  if (!allowed) return c.json({ ok: false, message: "missing sandbox.manage permission" }, 403);

  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  if (sandbox?.provider !== "local") {
    return c.json({ ok: false, message: "space is not configured for a local sandbox" }, 409);
  }

  return c.json({ ok: true, spaceId, userId: user.uuid });
});

// POST /internal/gateway/local-sandbox/status
// Called by the gateway relay to report a local sandbox's connection state. The
// gateway is the sole status reporter for local sandboxes: on connect it
// publishes a ready status plus the relay wsEndpoint; on disconnect it marks the
// sandbox stopped(disconnected).
router.post("/local-sandbox/status", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const body = await c.req.json<{
    spaceId?: string;
    status?: "ready" | "stopped";
    wsEndpoint?: string | null;
    hostname?: string | null;
    gatewayNodeId?: string | null;
  }>().catch(() => null);
  const spaceId = typeof body?.spaceId === "string" ? body.spaceId.trim() : "";
  if (!spaceId || !requireValidId(spaceId)) return c.json({ ok: false, message: "spaceId is required" }, 400);
  const status = body?.status === "ready" ? "ready" : "stopped";

  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  if (sandbox?.provider !== "local") {
    return c.json({ ok: false, message: "local sandbox not found" }, 404);
  }

  const prevMeta = (sandbox.meta as Record<string, unknown> | null) ?? {};
  const now = new Date();
  if (status === "ready") {
    const wsEndpoint = typeof body?.wsEndpoint === "string" ? body.wsEndpoint.trim() : "";
    await updateSpaceSandbox({
      spaceId,
      status: normalizeSandboxLifecycleStatus("ready"),
      runtimeStatus: normalizeSandboxRuntimeStatus("ready"),
      reportedAt: now,
      lastHeartbeatAt: now,
      lastActivityAt: now,
      stoppedAt: null,
      stopReason: null,
      meta: {
        ...prevMeta,
        kind: "local",
        wsEndpoint: wsEndpoint || null,
        hostname: body?.hostname ?? null,
        gatewayNodeId: body?.gatewayNodeId ?? null,
      },
    });
  } else {
    await updateSpaceSandbox({
      spaceId,
      status: "stopped",
      runtimeStatus: normalizeSandboxRuntimeStatus("error"),
      stoppedAt: now,
      stopReason: "disconnected",
      meta: { ...prevMeta, wsEndpoint: null },
    });
  }

  return c.json({ ok: true });
});



router.post("/attachments/plan", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const body = await c.req.json<{
    event: GatewayInboundEvent;
    images?: Array<{ id: string; size: number; mimeType: string; filename?: string | null }>;
    files?: Array<{ id: string; name: string; relativePath?: string | null; size: number; mimeType?: string | null }>;
  }>().catch(() => null);
  const parsed = gatewayInboundEventSchema.safeParse(body?.event);
  if (!parsed.success) return c.json({ message: "invalid gateway attachment event", issues: parsed.error.issues }, 400);

  const resolved = await resolveChannelInboundForEventWithLock(parsed.data);
  if (!resolved) return c.json({ message: "gateway inbound already processed" }, 409);

  const requestedImages = Array.isArray(body?.images) ? body.images : [];
  const requestedFiles = Array.isArray(body?.files) ? body.files : [];
  if (requestedImages.length > MAX_GATEWAY_ATTACHMENT_IMAGES) return c.json({ message: "too many images" }, 413);
  // Image demote slots use ids prefixed with `imgfile-` and share image quota, not ordinary file quota.
  const ordinaryFileCount = requestedFiles.filter((file) => !String(file?.id ?? "").startsWith("imgfile-")).length;
  const imageFileSlotCount = requestedFiles.length - ordinaryFileCount;
  if (ordinaryFileCount > MAX_GATEWAY_ATTACHMENT_FILES) return c.json({ message: "too many files" }, 413);
  if (imageFileSlotCount > MAX_GATEWAY_ATTACHMENT_IMAGES) return c.json({ message: "too many images" }, 413);
  if (imageFileSlotCount > 0 && imageFileSlotCount !== requestedImages.length) {
    return c.json({ message: "image file slot count must match images" }, 400);
  }

  const seenImageIds = new Set<string>();
  const imagePlans = [];
  for (const image of requestedImages) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(image.id) || seenImageIds.has(image.id)) return c.json({ message: "image ids must be unique safe strings" }, 400);
    seenImageIds.add(image.id);
    try {
      const plan = createInternalPublicAssetUploadPlan({
        purpose: "chat_attachment",
        userUuid: resolved.userId,
        spaceId: resolved.spaceId,
        sessionId: resolved.sessionId,
        file: {
          size: image.size,
          mimeType: image.mimeType,
          filename: image.filename ?? undefined,
        },
      });
      imagePlans.push({
        id: image.id,
        filename: image.filename ?? null,
        ...plan.asset,
        expiresAt: plan.expiresAt,
      });
    } catch (error) {
      const response = attachmentPlanErrorResponse(error);
      if (response) return c.json(response.body, response.status as never);
      throw error;
    }
  }
  // Rate-limit durable image plans after validation (same quota as web chat_attachment).
  try {
    await consumePublicAssetUploadQuota(resolved.userId, "chat_attachment", imagePlans.length);
  } catch (error) {
    if (error instanceof PublicAssetValidationError) {
      return c.json({ message: error.message }, error.message.startsWith("too many") ? 429 : 400);
    }
    throw error;
  }

  const files = requestedFiles;
  const uploadId = files.length > 0 ? createSpaceUploadId() : null;
  const fileEntries: SpaceUploadManifestEntry[] = [];
  if (uploadId) {
    const seenFileIds = new Set<string>();
    const seenRelativePaths = new Set<string>();
    for (const file of files) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(file.id) || seenFileIds.has(file.id)) return c.json({ message: "file ids must be unique safe strings" }, 400);
      seenFileIds.add(file.id);
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > GATEWAY_ATTACHMENT_MAX_BYTES) return c.json({ message: "file too large" }, 413);
      const relativePath = safeUploadPath(file.relativePath?.trim() || file.name);
      if (!relativePath) return c.json({ message: "invalid upload path" }, 400);
      if (seenRelativePaths.has(relativePath)) return c.json({ message: "duplicate upload path" }, 400);
      seenRelativePaths.add(relativePath);
      const name = relativePath.split("/").at(-1) ?? file.name;
      fileEntries.push({
        id: file.id,
        name,
        relativePath,
        size: file.size,
        mimeType: file.mimeType ?? null,
        objectKey: buildSpaceUploadObjectKey({ spaceId: resolved.spaceId, uploadId, entryId: file.id }),
      });
    }
  }
  // Space materialize quota after file entry validation.
  if (fileEntries.length > 0) {
    try {
      await consumeSpaceUploadQuota(resolved.userId, fileEntries.length);
    } catch (error) {
      if (error instanceof SpaceUploadRateLimitError) {
        return c.json({ message: error.message }, 429);
      }
      throw error;
    }
  }
  if (uploadId && fileEntries.length > 0) {
    await saveSpaceUploadManifest({
      uploadId,
      spaceId: resolved.spaceId,
      userId: resolved.userId,
      destination: { kind: "sandbox_tmp", sessionId: resolved.sessionId || undefined },
      entries: fileEntries,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  }
  const filePlans = fileEntries.map((file) => {
    if (!file.objectKey) throw new Error("upload objectKey is required");
    const signed = createPresignedPutUrl(file.objectKey, file.mimeType);
    return { id: file.id, name: file.name, relativePath: file.relativePath, objectKey: file.objectKey, uploadUrl: signed.uploadUrl, uploadHeaders: signed.headers, expiresAt: signed.expiresAt };
  });

  return c.json({
    ok: true,
    spaceId: resolved.spaceId,
    sessionId: resolved.sessionId,
    userId: resolved.userId,
    bindingKey: resolved.bindingKey,
    images: imagePlans,
    files: { uploadId, entries: filePlans },
  });
});


/** Materialize durable public URLs into sandbox without a second gateway upload. */
router.post("/attachments/materialize", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const body = await c.req.json<{
    spaceId?: string;
    sessionId?: string | null;
    userId?: string;
    files?: Array<{
      id?: string;
      name: string;
      relativePath: string;
      size: number;
      mimeType?: string | null;
      downloadUrl: string;
    }>;
  }>().catch(() => null);

  const spaceId = body?.spaceId?.trim();
  const sessionIdHint = body?.sessionId?.trim() || null;
  const userId = body?.userId?.trim() || null;
  const files = Array.isArray(body?.files) ? body.files : [];
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (files.length === 0) return c.json({ message: "files are required" }, 400);
  if (files.length > MAX_GATEWAY_ATTACHMENT_FILES + MAX_GATEWAY_ATTACHMENT_IMAGES) {
    return c.json({ message: "too many files" }, 413);
  }

  try {
    const seenPaths = new Set<string>();
    let totalBytes = 0;
    const prepared: Array<{
      id: string | null;
      relativePath: string;
      name: string;
      size: number;
      mimeType: string | null;
      downloadUrl: string;
    }> = [];

    for (const file of files) {
      if (typeof file.name !== "string" || !file.name || file.name.length > 255) {
        return c.json({ message: "invalid file name" }, 400);
      }
      const relativePath = safeUploadPath(file.relativePath?.trim() || file.name);
      if (!relativePath) return c.json({ message: "invalid upload path" }, 400);
      if (seenPaths.has(relativePath)) return c.json({ message: "duplicate upload path" }, 400);
      seenPaths.add(relativePath);
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > GATEWAY_ATTACHMENT_MAX_BYTES) {
        return c.json({ message: "file too large" }, 413);
      }
      if (typeof file.downloadUrl !== "string" || !isAllowedPublicAssetDownloadUrl(file.downloadUrl)) {
        return c.json({ message: "invalid download url" }, 400);
      }
      totalBytes += file.size;
      if (totalBytes > 2 * 1024 * 1024 * 1024) return c.json({ message: "upload too large" }, 413);
      prepared.push({
        id: typeof file.id === "string" ? file.id : null,
        relativePath,
        name: relativePath.split("/").at(-1) ?? file.name,
        size: file.size,
        mimeType: file.mimeType ?? null,
        downloadUrl: file.downloadUrl,
      });
    }

    if (userId) {
      await consumeSpaceUploadQuota(userId, prepared.length);
    }

    const uploadId = createSpaceUploadId();
    const destinationRoot = `/tmp/uploads/${uploadId}`;
    const sessionId = sessionIdHint && requireValidId(sessionIdHint) ? sessionIdHint : `upload:${uploadId}`;
    const result = await enqueueSandboxUploadFilesJob({
      spaceId,
      sessionId,
      uploadId,
      destinationRoot,
      files: prepared.map((file) => ({
        relativePath: file.relativePath,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        downloadUrl: file.downloadUrl,
      })),
    });

    // Best-effort id → path mapping by relativePath.
    const pathById: Record<string, string> = {};
    for (const file of prepared) {
      if (!file.id) continue;
      const match = result.uploaded.find(
        (uploaded) =>
          uploaded.path.endsWith(`/${file.relativePath}`) ||
          uploaded.path.endsWith(file.relativePath) ||
          uploaded.name === file.name,
      );
      if (match?.path) pathById[file.id] = match.path;
    }

    return c.json({ ok: true, uploaded: result.uploaded, pathById });
  } catch (error) {
    if (error instanceof SpaceUploadRateLimitError) {
      return c.json({ message: error.message }, 429);
    }
    logger.error("[GatewayAttachment] failed to materialize remote files", error, { spaceId });
    return c.json({ message: "failed to materialize" }, 500);
  }
});

router.post("/attachments/complete", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const body = await c.req.json<{ spaceId?: string; uploadId?: string; entryIds?: string[] }>().catch(() => null);
  const spaceId = body?.spaceId?.trim();
  const uploadId = body?.uploadId?.trim();
  const entryIds = Array.isArray(body?.entryIds) ? body.entryIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
  if (!spaceId || !uploadId || entryIds.length === 0) return c.json({ message: "spaceId, uploadId and entryIds are required" }, 400);

  const completeState = await beginSpaceUploadComplete(spaceId, uploadId);
  if (!completeState.acquired) return c.json({ message: "upload is already being completed" }, 409);

  try {
    const manifest = await getSpaceUploadManifest(spaceId, uploadId);
    if (!manifest) {
      await cancelSpaceUploadComplete(spaceId, uploadId);
      return c.json({ message: "upload not found" }, 404);
    }
    const completedIds = new Set(entryIds);
    const entries = manifest.entries.filter((entry) => completedIds.has(entry.id));
    if (entries.length === 0) {
      await cancelSpaceUploadComplete(spaceId, uploadId);
      return c.json({ message: "no completed entries" }, 400);
    }

    const destinationRoot = manifest.destination.kind === "sandbox_tmp"
      ? `/tmp/uploads/${manifest.uploadId}`
      : "/workspace";
    const sessionId = manifest.destination.kind === "sandbox_tmp"
      ? (manifest.destination.sessionId || `upload:${uploadId}`)
      : `upload:${uploadId}`;
    const result = await enqueueSandboxUploadFilesJob({
      spaceId,
      sessionId,
      uploadId,
      destinationRoot,
      files: entries.map((entry) => {
        const rawUrl = entry.downloadUrl
          ? entry.downloadUrl
          : createPresignedGetUrl(entry.objectKey as string).downloadUrl;
        return {
          relativePath: entry.relativePath,
          name: entry.name,
          size: entry.size,
          mimeType: entry.mimeType,
          downloadUrl: rawUrl,
        };
      }),
    });
    await deleteSpaceUploadManifest(spaceId, uploadId);
    return c.json({ ok: true, uploaded: result.uploaded });
  } catch (error) {
    await cancelSpaceUploadComplete(spaceId, uploadId);
    logger.error("[GatewayAttachment] failed to complete upload", error, { spaceId, uploadId });
    return c.json({ message: "failed to complete upload" }, 500);
  }
});

router.post("/inbound", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const body = await c.req.json().catch(() => null);
  const parsed = gatewayInboundEventSchema.safeParse(body);
  if (!parsed.success) return c.json({ message: "invalid gateway inbound event", issues: parsed.error.issues }, 400);

  const event = parsed.data;
  const parentCtx = extractTrace(event as unknown as Record<string, unknown>);
  const span = tracer.startSpan("api.gateway_inbound.handle", {
    attributes: {
      "event.id": event.eventId,
      "event.type": event.eventType,
      "channel.id": event.channelId,
      provider: event.provider,
    },
  });

  try {
    await context.with(trace.setSpan(parentCtx, span), async () => {
      await handleInboundEvent(event);
    });
    return c.json({ ok: true });
  } catch (error) {
    recordSpanError(span, error);
    throw error;
  } finally {
    span.end();
  }
});

export default router;
