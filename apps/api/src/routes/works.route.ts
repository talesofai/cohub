import { Hono, type Context } from "hono";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { spaces, works, workAssetReservations, workVersions, workViewerGrants, userProfiles } from "@cohub/db";
import { createWorkAssetPublicUrl, deleteWorkAssetsByObjectKeys, isConfiguredWorkAssetPublicUrl } from "../work-asset-storage.js";
import { publishWorkAssetInWorker, type WorkPublishAssetJobResult } from "../work-publish-asset-queue.js";
import type { Permission } from "@cohub/core/permissions";
import { db } from "../db/index.js";
import { authzDenied, getOptionalAuth, getSpacePublicProfile, requireValidId, useAuth } from "../lib/middleware.js";
import { hasPermission } from "../permissions.js";
import { createWorkSessionToken, WORK_SESSION_TTL_SECONDS } from "../work-sessions.js";
import { getSandboxPublicEndpoints } from "../sandbox-public-network.js";
import { SANDBOX_PUBLIC_PORTS } from "@cohub/protocol/ports";
import { createLogger } from "@cohub/infra/logging";
import { billingOperations, COHUB_BILLING_FEATURES } from "@cohub/billing";
import { config } from "../config.js";
import { enqueueWorkAssetCleanup } from "../work-asset-cleanup-queue.js";
import { markWorkAssetReservationCleaned, startWorkAssetReservation } from "../work-asset-reservation.js";
import { hasSameWorkPublishTarget } from "../work-publish-target.js";
import { getWorkUpdateVersionState } from "../work-update-state.js";
import {
  createWorkAssetCleanupScope,
  createWorkAssetObjectKey,
  createWorkAssetPublishJobId,
  selectWorkAssetCleanupKey,
} from "../work-asset-publish-cleanup.js";
import { featureGateResponse } from "../lib/feature-gate.js";
import { createWorkPublicUrl } from "../lib/work-public-url.js";
import {
  WorkAssetCleanupError,
  collectHistoricalWorkAssetKeys,
  collectWorkAssetKeys,
  deleteWorkAssetKeys,
  detachWorkWithAssetCleanupScheduled,
} from "./work-delete.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

const WORK_STATUSES = new Set(["published", "disabled"]);
const WORK_VISIBILITIES = new Set(["public", "space"]);
const TARGET_TYPES = new Set(["file", "directory", "port"]);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/;
const SANDBOX_PUBLIC_PORT_SET = new Set<number>(SANDBOX_PUBLIC_PORTS as readonly number[]);
const ALLOWED_WORK_SCOPES = new Set<Permission>(["space.view", "session.view", "file.view", "taskrun.view"]);
const ALLOWED_VIEWER_SCOPES = new Set<Permission>([
  "session.prompt.readonly",
  "session.prompt.fullaccess",
  "generation.create",
  "user.space.list",
  "user.session.list",
  "user.usage.read",
]);
const WORK_ASSET_CLEANUP_WATCHDOG_DELAY_MS = 5 * 60_000;


const normalizeScopes = (value: unknown, allowed: Set<Permission>): Permission[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is Permission => typeof item === "string" && allowed.has(item as Permission))));
};

type WorkMeta = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

const getWorkMeta = (value: unknown): WorkMeta | null => isRecord(value) ? value : null;

const getHideCohubBar = (meta: WorkMeta | null | undefined): boolean => {
  const presentation = isRecord(meta?.presentation) ? meta.presentation : null;
  return presentation?.hideCohubBar === true;
};

async function canHideCohubBar(userId: string) {
  try {
    const entitlement = await billingOperations.getFeatureEntitlement({
      userId,
      featureKey: COHUB_BILLING_FEATURES.workPublishHideCohubBar,
    });
    return Boolean(entitlement?.enabled);
  } catch (error) {
    logger.warn("[works] failed to check hide Cohub bar entitlement", { userId, error });
    return false;
  }
}

async function ensureWorkPresentationAllowed(c: Context, input: { userId: string; meta: WorkMeta | null | undefined }) {
  if (!getHideCohubBar(input.meta)) return null;
  if (await canHideCohubBar(input.userId)) return null;
  return workHideCohubBarRequiredResponse(c);
}

const isSubset = (requested: Permission[], allowed: string[]) => requested.every((scope) => allowed.includes(scope));

const pgErrorCode = (error: unknown) => typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : null;
const pgErrorConstraint = (error: unknown) => typeof error === "object" && error !== null && "constraint" in error ? String((error as { constraint?: unknown }).constraint) : null;
const isWorkSlugConflict = (error: unknown) => pgErrorCode(error) === "23505" && pgErrorConstraint(error) === "v2_uq_works_space_slug";
const invalidWorkStatusResponse = (c: Context) => c.json({ message: "status must be one of: published, disabled" }, 400);
const invalidWorkVisibilityResponse = (c: Context) => c.json({ message: "visibility must be one of: public, space" }, 400);
const requiresSpaceWorkAccess = (work: Pick<typeof works.$inferSelect, "visibility">) => (work.visibility ?? "public") === "space";
const workHideCohubBarRequiredResponse = (c: Context) =>
  featureGateResponse(c, {
    source: "work_hide_cohub_bar",
    message: "This option is available on Pro and Max.",
    title: "Upgrade to hide the Cohub bar",
    conversionMessage: "Hiding the Cohub bar is available on Pro and Max.",
  });
async function getMissingPublicWorkIdentity(spaceId: string) {
  const [row] = await db
    .select({ spaceSlug: spaces.slug, ownerUsername: userProfiles.username })
    .from(spaces)
    .leftJoin(userProfiles, eq(userProfiles.userUuid, spaces.userUuid))
    .where(eq(spaces.id, spaceId))
    .limit(1);
  return {
    ownerUsername: row?.ownerUsername?.trim() || null,
    spaceSlug: row?.spaceSlug?.trim() || null,
  };
}

async function ensureWorkPublicIdentity(c: Context, spaceId: string) {
  const identity = await getMissingPublicWorkIdentity(spaceId);
  const missingOwner = !identity.ownerUsername;
  const missingSpaceSlug = !identity.spaceSlug;
  if (!missingOwner && !missingSpaceSlug) return null;
  if (missingOwner && missingSpaceSlug) {
    return c.json({ message: "works require an owner username and a space slug" }, 400);
  }
  if (missingOwner) return c.json({ message: "works require an owner username" }, 400);
  return c.json({ message: "works require a space slug" }, 400);
}

const ensureUniqueWorkSlug = async (input: { spaceId: string; slug: string; excludeId?: string }) => {
  const conditions = [eq(works.spaceId, input.spaceId), eq(works.slug, input.slug)];
  if (input.excludeId) conditions.push(ne(works.id, input.excludeId));
  const [existingWork] = await db
    .select({ id: works.id })
    .from(works)
    .where(and(...conditions))
    .limit(1);
  return !existingWork;
};

const normalizePortRef = (value: string) => {
  if (!/^\d{2,5}$/.test(value)) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || !SANDBOX_PUBLIC_PORT_SET.has(port)) return null;
  return String(port);
};

const isAllowedWorkContentUrl = (url: string, kind: "asset" | "port") => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (kind === "asset") return isConfiguredWorkAssetPublicUrl(url);
    return parsed.hostname === "cohub.run" || parsed.hostname.endsWith(".cohub.run");
  } catch {
    return false;
  }
};

const serializeWork = (work: typeof works.$inferSelect) => ({
  id: work.id,
  spaceId: work.spaceId,
  userUuid: work.userUuid,
  slug: work.slug,
  status: work.status,
  visibility: work.visibility ?? "public",
  targetType: work.targetType,
  targetRef: work.targetRef,
  assetKey: work.assetKey,
  currentVersionId: work.currentVersionId,
  latestVersion: work.latestVersion ?? 0,
  publishedAt: work.publishedAt?.toISOString() ?? null,
  workScopes: work.workScopes ?? [],
  allowedViewerScopes: work.allowedViewerScopes ?? [],
  meta: work.meta ?? null,
  createdAt: work.createdAt?.toISOString() ?? null,
  updatedAt: work.updatedAt?.toISOString() ?? null,
});

const serializeWorkVersion = (version: typeof workVersions.$inferSelect) => ({
  id: version.id,
  workId: version.workId,
  version: version.version,
  targetType: version.targetType,
  targetRef: version.targetRef,
  assetKey: version.assetKey,
  createdAt: version.createdAt?.toISOString() ?? null,
});

async function getWorkById(id: string) {
  const [work] = await db.select().from(works).where(eq(works.id, id)).limit(1);
  return work ?? null;
}

class WorkAssetPublishError extends Error {
  constructor(public result: Extract<WorkPublishAssetJobResult, { ok: false }>) {
    super(result.message);
  }
}

async function writeWorkAsset(input: {
  spaceId: string;
  slug: string;
  assetKey: string | null;
  publishJobId: string | null;
  targetType: string;
  targetRef: string;
  status: string;
}) {
  const { spaceId, slug, assetKey, publishJobId, targetType, targetRef, status } = input;
  if (status !== "published" || (targetType !== "file" && targetType !== "directory")) return null;
  if (!assetKey) throw new Error("published work asset key was not reserved");
  if (!publishJobId) throw new Error("published work asset job id was not reserved");
  const result = await publishWorkAssetInWorker(
    { spaceId, slug, assetKey, targetType, targetRef },
    { jobId: publishJobId },
  );
  if (!result.ok) throw new WorkAssetPublishError(result);
  if (result.assetKey !== assetKey) {
    throw new WorkAssetPublishError({
      ok: false,
      status: 502,
      message: "work asset worker returned an unexpected key",
      code: "work_asset_key_mismatch",
      cleanupAssetKey: result.assetKey,
    });
  }
  return result.assetKey;
}

async function scheduleWorkAssetCleanupWatchdog(input: {
  assetKey: string;
  scope: ReturnType<typeof createWorkAssetCleanupScope>;
  publishJobId: string;
  reason: string;
}) {
  return enqueueWorkAssetCleanup(
    {
      assetKeys: [input.assetKey],
      scope: input.scope,
      publishJobId: input.publishJobId,
      reason: input.reason,
    },
    { delayMs: WORK_ASSET_CLEANUP_WATCHDOG_DELAY_MS },
  );
}

function workAssetErrorResponse(c: Context, error: unknown, context: { spaceId: string; targetType: string; targetRef: string }) {
  if (error instanceof WorkAssetPublishError) {
    return c.json({ message: error.result.message.toLowerCase().replace(/\.$/, ""), code: error.result.code }, error.result.status as never);
  }
  logger.warn("[works] failed to write work asset", { ...context, error });
  return c.json({ message: "work asset storage failed" }, 502);
}

async function cleanupWorkAssets(
  assetKey: string | null | undefined,
  context: {
    workId: string;
    spaceId: string;
    slug: string;
    reason: string;
    publishJobId?: string;
    deferUntilPublishTerminal?: boolean;
  },
) {
  if (!assetKey) return;
  if (context.deferUntilPublishTerminal) {
    const retryJob = await enqueueWorkAssetCleanup({
      assetKeys: [assetKey],
      scope: { env: config.env, spaceId: context.spaceId, slug: context.slug },
      publishJobId: context.publishJobId,
      reason: context.reason,
    });
    logger.error("[works] work asset cleanup deferred until publish job is terminal", {
      ...context,
      assetKey,
      retryJobId: retryJob.id,
    });
    return;
  }
  try {
    await deleteWorkAssetKeys(
      [assetKey],
      { env: config.env, spaceId: context.spaceId, slug: context.slug },
      deleteWorkAssetsByObjectKeys,
    );
    if (context.publishJobId) await markWorkAssetReservationCleaned(context.publishJobId);
  } catch (error) {
    let retryJob;
    try {
      retryJob = await enqueueWorkAssetCleanup({
        assetKeys: [assetKey],
        scope: { env: config.env, spaceId: context.spaceId, slug: context.slug },
        publishJobId: context.publishJobId,
        reason: context.reason,
      });
    } catch (queueError) {
      logger.error("[works] failed to schedule durable work asset cleanup", {
        ...context,
        assetKey,
        cleanupError: error,
        queueError,
      });
      throw new AggregateError([error, queueError], "work asset cleanup and retry scheduling failed");
    }
    logger.error("[works] failed to delete stale work asset; durable retry scheduled", {
      ...context,
      assetKey,
      retryJobId: retryJob.id,
      error,
    });
    throw error;
  }
}

const getWorkContent = (input: { spaceId: string; targetType: string; targetRef: string; assetKey: string | null }) => {
  if (input.targetType === "port") {
    const portRef = normalizePortRef(input.targetRef);
    if (!portRef) return null;
    const url = getSandboxPublicEndpoints(input.spaceId)[portRef]?.url;
    if (!url || !isAllowedWorkContentUrl(url, "port")) return null;
    return { url, targetType: "port" as const, port: portRef };
  }
  if (!input.assetKey) return null;
  const url = createWorkAssetPublicUrl(input.assetKey);
  if (!isAllowedWorkContentUrl(url, "asset")) return null;
  return { url, targetType: input.targetType, path: input.targetRef };
};

async function getPublishedWorkContent(work: typeof works.$inferSelect) {
  if (work.status !== "published" || !work.currentVersionId) return null;
  const [version] = await db.select().from(workVersions).where(eq(workVersions.id, work.currentVersionId)).limit(1);
  if (!version) return null;
  return getWorkContent({
    spaceId: work.spaceId,
    targetType: version.targetType,
    targetRef: version.targetRef,
    assetKey: version.assetKey,
  });
}

router.get("/by-slug/:username/:spaceSlug/:workSlug", async (c) => {
  const user = getOptionalAuth(c);
  const username = c.req.param("username");
  const spaceSlug = c.req.param("spaceSlug");
  const workSlug = c.req.param("workSlug");
  if (!username || !SLUG_RE.test(spaceSlug) || !SLUG_RE.test(workSlug)) return c.json({ message: "work not found" }, 404);

  const [row] = await db
    .select({
      owner: { userUuid: userProfiles.userUuid, username: userProfiles.username, displayName: userProfiles.displayName, avatarUrl: userProfiles.avatarUrl },
      space: spaces,
      work: works,
    })
    .from(userProfiles)
    .innerJoin(spaces, and(eq(spaces.userUuid, userProfiles.userUuid), eq(spaces.slug, spaceSlug)))
    .innerJoin(works, and(eq(works.spaceId, spaces.id), eq(works.slug, workSlug), eq(works.status, "published")))
    .where(eq(userProfiles.username, username))
    .limit(1);
  if (!row) return c.json({ message: "work not found" }, 404);
  if (!row.owner.username || !row.space.slug) return c.json({ message: "work public identity is incomplete" }, 409);
  if (requiresSpaceWorkAccess(row.work) && !(await hasPermission(user, "space.view", { spaceId: row.space.id }))) return authzDenied(c);

  return c.json({
    work: serializeWork(row.work),
    space: { id: row.space.id, slug: row.space.slug, name: row.space.name, userUuid: row.space.userUuid, publicProfile: getSpacePublicProfile(row.space) },
    owner: { ...row.owner, username: row.owner.username },
    publicUrl: createWorkPublicUrl({ ownerUsername: row.owner.username, spaceSlug: row.space.slug, workSlug: row.work.slug, status: row.work.status }),
    content: await getPublishedWorkContent(row.work),
  });
});


router.get("/space/:spaceId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("spaceId");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.view", { spaceId }))) return authzDenied(c);
  const rows = await db.select().from(works).where(eq(works.spaceId, spaceId));
  return c.json({ works: rows.map(serializeWork) });
});

router.get("/:id/public", async (c) => {
  // Public endpoint used by the standalone work auth broker page to load work
  // metadata + owner info by workId. Mirrors the by-slug access model: only
  // space-visibility works require space.view; public works are open.
  const user = getOptionalAuth(c);
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "work not found" }, 404);
  const work = await getWorkById(id);
  if (work?.status !== "published") return c.json({ message: "work not found" }, 404);
  if (requiresSpaceWorkAccess(work) && !(await hasPermission(user, "space.view", { spaceId: work.spaceId }))) return authzDenied(c);
  const [row] = await db
    .select({
      owner: { userUuid: userProfiles.userUuid, username: userProfiles.username, displayName: userProfiles.displayName, avatarUrl: userProfiles.avatarUrl },
      space: spaces,
    })
    .from(spaces)
    .innerJoin(userProfiles, eq(userProfiles.userUuid, spaces.userUuid))
    .where(eq(spaces.id, work.spaceId))
    .limit(1);
  if (!row) return c.json({ message: "work not found" }, 404);
  if (!row.owner.username || !row.space.slug) return c.json({ message: "work public identity is incomplete" }, 409);
  const space = { id: row.space.id, slug: row.space.slug, name: row.space.name, userUuid: row.space.userUuid, publicProfile: getSpacePublicProfile(row.space) };
  return c.json({
    work: serializeWork(work),
    space,
    owner: { ...row.owner, username: row.owner.username },
  });
});

router.get("/:id", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "work not found" }, 404);
  const work = await getWorkById(id);
  if (!work) return c.json({ message: "work not found" }, 404);
  if (!(await hasPermission(user, "space.view", { spaceId: work.spaceId }))) return authzDenied(c);
  const [row] = await db
    .select({
      owner: { userUuid: userProfiles.userUuid, username: userProfiles.username, displayName: userProfiles.displayName, avatarUrl: userProfiles.avatarUrl },
      space: spaces,
    })
    .from(spaces)
    .innerJoin(userProfiles, eq(userProfiles.userUuid, spaces.userUuid))
    .where(eq(spaces.id, work.spaceId))
    .limit(1);
  if (!row) return c.json({ message: "work not found" }, 404);
  if (!row.owner.username || !row.space.slug) return c.json({ message: "work public identity is incomplete" }, 409);
  const space = { id: row.space.id, slug: row.space.slug, name: row.space.name, userUuid: row.space.userUuid, publicProfile: getSpacePublicProfile(row.space) };
  return c.json({
    work: serializeWork(work),
    space,
    owner: { ...row.owner, username: row.owner.username },
    publicUrl: createWorkPublicUrl({ ownerUsername: row.owner.username, spaceSlug: row.space.slug, workSlug: work.slug, status: work.status }),
    content: await getPublishedWorkContent(work),
  });
});

router.post("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const spaceId = typeof body?.spaceId === "string" ? body.spaceId : "";
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const slug = typeof body?.slug === "string" ? body.slug.trim().toLowerCase() : "";
  if (!SLUG_RE.test(slug)) return c.json({ message: "slug must use lowercase letters, numbers, hyphens, or underscores" }, 400);
  const targetType = typeof body?.targetType === "string" ? body.targetType : "";
  let targetRef = typeof body?.targetRef === "string" ? body.targetRef.trim() : "";
  if (!TARGET_TYPES.has(targetType) || !targetRef) return c.json({ message: "target is invalid" }, 400);
  if (targetType === "file" && !/\.html?$/i.test(targetRef)) {
    return c.json({ message: "only HTML files can be published as work" }, 400);
  }
  if (targetType === "port") {
    const portRef = normalizePortRef(targetRef);
    if (!portRef) return c.json({ message: "port is invalid" }, 400);
    targetRef = portRef;
  }
  if (body?.status !== undefined && (typeof body.status !== "string" || !WORK_STATUSES.has(body.status))) {
    return invalidWorkStatusResponse(c);
  }
  if (body?.visibility !== undefined && (typeof body.visibility !== "string" || !WORK_VISIBILITIES.has(body.visibility))) {
    return invalidWorkVisibilityResponse(c);
  }
  const status = typeof body?.status === "string" ? body.status : "published";
  const visibility = typeof body?.visibility === "string" ? body.visibility : "public";
  const identityError = await ensureWorkPublicIdentity(c, spaceId);
  if (identityError) return identityError;
  const meta = getWorkMeta(body?.meta);
  const presentationError = await ensureWorkPresentationAllowed(c, { userId: user.uuid, meta });
  if (presentationError) return presentationError;
  const now = new Date();

  const [existingWork] = await db.select().from(works).where(and(eq(works.spaceId, spaceId), eq(works.slug, slug))).limit(1);
  if (existingWork) return c.json({ message: "slug already exists" }, 409);

  let assetKey = status === "published" && (targetType === "file" || targetType === "directory")
    ? createWorkAssetObjectKey(config.env, { spaceId, slug })
    : null;
  let publishJobId: string | null = null;
  let reservation: Awaited<ReturnType<typeof startWorkAssetReservation>> | null = null;
  let uploadMayHaveStarted = false;
  let uploadJobTerminal = false;
  if (assetKey) {
    publishJobId = createWorkAssetPublishJobId(assetKey);
    try {
      reservation = await startWorkAssetReservation({ publishJobId, assetKey, spaceId, slug });
      await scheduleWorkAssetCleanupWatchdog({
        assetKey,
        scope: createWorkAssetCleanupScope(config.env, { spaceId, slug }),
        publishJobId,
        reason: "create_upload_watchdog",
      });
      uploadMayHaveStarted = true;
    } catch (error) {
      if (reservation) await reservation.abandon();
      logger.error("[works] failed to schedule work creation upload watchdog", { spaceId, slug, error });
      return c.json({ message: "work asset cleanup queue unavailable" }, 502);
    }
  }
  try {
    assetKey = await writeWorkAsset({ spaceId, slug, assetKey, publishJobId, targetType, targetRef, status });
    uploadJobTerminal = true;
  } catch (error) {
    const publishJobIsTerminal = uploadJobTerminal || error instanceof WorkAssetPublishError;
    const cleanupAssetKey = selectWorkAssetCleanupKey(
      uploadMayHaveStarted ? assetKey : null,
      error instanceof WorkAssetPublishError ? error.result : null,
    );
    if (cleanupAssetKey) {
      try {
        if (reservation) await reservation.abandon();
        await cleanupWorkAssets(cleanupAssetKey, {
          workId: "new",
          spaceId,
          slug,
          publishJobId: publishJobId ?? undefined,
          deferUntilPublishTerminal: !publishJobIsTerminal,
          reason: "create_upload_failed",
        });
      } catch (cleanupError) {
        logger.error("[works] failed to clean up unsuccessful work creation upload", {
          spaceId,
          slug,
          cleanupError,
        });
        return c.json({ message: "work asset cleanup failed", code: "work_asset_cleanup_failed" }, 502);
      }
    }
    return workAssetErrorResponse(c, error, { spaceId, targetType, targetRef });
  }

  let work: typeof works.$inferSelect | null = null;
  try {
    if (reservation) await reservation.assertHealthy();
    work = await db.transaction(async (tx) => {
      const [createdWork] = await tx.insert(works).values({
        spaceId,
        userUuid: user.uuid,
        slug,
        status,
        visibility,
        targetType,
        targetRef,
        assetKey,
        latestVersion: status === "published" ? 1 : 0,
        publishedAt: status === "published" ? now : null,
        workScopes: normalizeScopes(body?.workScopes, ALLOWED_WORK_SCOPES),
        allowedViewerScopes: normalizeScopes(body?.allowedViewerScopes, ALLOWED_VIEWER_SCOPES),
        meta,
      }).returning();
      if (!createdWork) return null;
      if (status !== "published") return createdWork;
      const [version] = await tx.insert(workVersions).values({
        workId: createdWork.id,
        version: 1,
        targetType,
        targetRef,
        assetKey,
        createdAt: now,
      }).returning();
      if (!version) throw new Error("failed to create work version");
      const [updatedWork] = await tx.update(works).set({ currentVersionId: version.id }).where(eq(works.id, createdWork.id)).returning();
      if (publishJobId) {
        const [committedReservation] = await tx
          .update(workAssetReservations)
          .set({ state: "committed", updatedAt: new Date() })
          .where(and(
            eq(workAssetReservations.publishJobId, publishJobId),
            eq(workAssetReservations.state, "pending"),
          ))
          .returning({ publishJobId: workAssetReservations.publishJobId });
        if (!committedReservation) throw new Error("failed to commit work asset reservation");
      }
      return updatedWork ?? createdWork;
    }).catch((error: unknown) => {
      if (isWorkSlugConflict(error)) return null;
      throw error;
    });
  } catch (error) {
    if (reservation) await reservation.abandon();
    await cleanupWorkAssets(assetKey, {
      workId: "new",
      spaceId,
      slug,
      publishJobId: publishJobId ?? undefined,
      reason: "create_failed",
    });
    throw error;
  }
  if (!work) {
    if (reservation) await reservation.abandon();
    await cleanupWorkAssets(assetKey, {
      workId: "new",
      spaceId,
      slug,
      publishJobId: publishJobId ?? undefined,
      reason: "create_slug_conflict",
    });
    return c.json({ message: "slug already exists" }, 409);
  }
  if (reservation) await reservation.stop();
  return c.json({ work: serializeWork(work) }, 201);
});

async function updateWork(
  c: Context,
  current: typeof works.$inferSelect,
  body: Record<string, unknown> | null,
  actorUserId: string,
) {
  const nextSlug = typeof body?.slug === "string" ? body.slug.trim().toLowerCase() : current.slug;
  if (!SLUG_RE.test(nextSlug)) return c.json({ message: "slug must use lowercase letters, numbers, hyphens, or underscores" }, 400);
  if (nextSlug !== current.slug && !(await ensureUniqueWorkSlug({ spaceId: current.spaceId, slug: nextSlug, excludeId: current.id }))) {
    return c.json({ message: "slug already exists" }, 409);
  }

  const nextTargetType = typeof body?.targetType === "string" ? body.targetType : current.targetType;
  let nextTargetRef = typeof body?.targetRef === "string" ? body.targetRef.trim() : current.targetRef;
  if (!TARGET_TYPES.has(nextTargetType) || !nextTargetRef) return c.json({ message: "target is invalid" }, 400);
  if (nextTargetType === "file" && !/\.html?$/i.test(nextTargetRef)) {
    return c.json({ message: "only HTML files can be published as work" }, 400);
  }
  if (nextTargetType === "port") {
    const portRef = normalizePortRef(nextTargetRef);
    if (!portRef) return c.json({ message: "port is invalid" }, 400);
    nextTargetRef = portRef;
  }
  if (body && "status" in body && (typeof body.status !== "string" || !WORK_STATUSES.has(body.status))) {
    return invalidWorkStatusResponse(c);
  }
  if (body && "visibility" in body && (typeof body.visibility !== "string" || !WORK_VISIBILITIES.has(body.visibility))) {
    return invalidWorkVisibilityResponse(c);
  }
  const nextStatus = typeof body?.status === "string" ? body.status : current.status;
  if (nextStatus === "published" && current.status !== "published") {
    return c.json({ message: "publish a version to publish this work" }, 409);
  }
  const identityError = await ensureWorkPublicIdentity(c, current.spaceId);
  if (identityError) return identityError;
  const nextMeta = "meta" in (body ?? {}) ? getWorkMeta(body?.meta) : getWorkMeta(current.meta);
  const presentationError = await ensureWorkPresentationAllowed(c, { userId: actorUserId, meta: nextMeta });
  if (presentationError) return presentationError;

  const now = new Date();
  const work = await db.transaction(async (tx) => {
    const [lockedWork] = await tx
      .select()
      .from(works)
      .where(eq(works.id, current.id))
      .limit(1)
      .for("update");
    if (!lockedWork) return null;

    const lockedNextSlug = typeof body?.slug === "string" ? body.slug.trim().toLowerCase() : lockedWork.slug;
    if (!SLUG_RE.test(lockedNextSlug)) {
      return c.json({ message: "slug must use lowercase letters, numbers, hyphens, or underscores" }, 400);
    }
    const lockedNextTargetType = typeof body?.targetType === "string" ? body.targetType : lockedWork.targetType;
    let lockedNextTargetRef = typeof body?.targetRef === "string" ? body.targetRef.trim() : lockedWork.targetRef;
    if (!TARGET_TYPES.has(lockedNextTargetType) || !lockedNextTargetRef) {
      return c.json({ message: "target is invalid" }, 400);
    }
    if (lockedNextTargetType === "file" && !/\.html?$/i.test(lockedNextTargetRef)) {
      return c.json({ message: "only HTML files can be published as work" }, 400);
    }
    if (lockedNextTargetType === "port") {
      const portRef = normalizePortRef(lockedNextTargetRef);
      if (!portRef) return c.json({ message: "port is invalid" }, 400);
      lockedNextTargetRef = portRef;
    }
    const lockedNextStatus = typeof body?.status === "string" ? body.status : lockedWork.status;
    if (lockedNextStatus === "published" && lockedWork.status !== "published") {
      return c.json({ message: "publish a version to publish this work" }, 409);
    }
    const lockedNextVisibility = typeof body?.visibility === "string"
      ? body.visibility
      : (lockedWork.visibility ?? "public");
    const versionState = getWorkUpdateVersionState(lockedWork, lockedNextStatus, now);

    const [updatedWork] = await tx.update(works).set({
      slug: lockedNextSlug,
      status: lockedNextStatus,
      visibility: lockedNextVisibility,
      targetType: lockedNextTargetType,
      targetRef: lockedNextTargetRef,
      ...versionState,
      workScopes: "workScopes" in (body ?? {}) ? normalizeScopes(body?.workScopes, ALLOWED_WORK_SCOPES) : lockedWork.workScopes,
      allowedViewerScopes: "allowedViewerScopes" in (body ?? {}) ? normalizeScopes(body?.allowedViewerScopes, ALLOWED_VIEWER_SCOPES) : lockedWork.allowedViewerScopes,
      meta: "meta" in (body ?? {}) ? nextMeta : lockedWork.meta,
      updatedAt: now,
    }).where(eq(works.id, lockedWork.id)).returning();
    return updatedWork ?? null;
  }).catch((error: unknown) => {
    if (isWorkSlugConflict(error)) return null;
    throw error;
  });
  if (work instanceof Response) return work;
  if (!work) return c.json({ message: "work not found" }, 404);
  return c.json({ work: serializeWork(work) });
}

async function publishWorkVersion(c: Context, current: typeof works.$inferSelect) {
  const identityError = await ensureWorkPublicIdentity(c, current.spaceId);
  if (identityError) return identityError;
  let assetKey: string | null = null;
  let publishJobId: string | null = null;
  let reservation: Awaited<ReturnType<typeof startWorkAssetReservation>> | null = null;
  let cleanupScope = createWorkAssetCleanupScope(config.env, current);
  let publishTarget = {
    spaceId: current.spaceId,
    slug: current.slug,
    targetType: current.targetType,
    targetRef: current.targetRef,
  };
  let uploadMayHaveStarted = false;
  let uploadJobTerminal = false;
  try {
    const preparedWork = await db.transaction(async (tx) => {
      const [lockedWork] = await tx
        .select()
        .from(works)
        .where(eq(works.id, current.id))
        .limit(1)
        .for("update");
      if (!lockedWork) return null;
      return lockedWork;
    });
    if (!preparedWork) return c.json({ message: "work not found" }, 404);

    publishTarget = {
      spaceId: preparedWork.spaceId,
      slug: preparedWork.slug,
      targetType: preparedWork.targetType,
      targetRef: preparedWork.targetRef,
    };
    cleanupScope = createWorkAssetCleanupScope(config.env, preparedWork);
    assetKey = preparedWork.targetType === "file" || preparedWork.targetType === "directory"
      ? createWorkAssetObjectKey(config.env, preparedWork)
      : null;
    if (assetKey) {
      publishJobId = createWorkAssetPublishJobId(assetKey);
      reservation = await startWorkAssetReservation({
        publishJobId,
        assetKey,
        spaceId: cleanupScope.spaceId,
        slug: cleanupScope.slug,
      });
      await scheduleWorkAssetCleanupWatchdog({
        assetKey,
        scope: cleanupScope,
        publishJobId,
        reason: "publish_upload_watchdog",
      });
      uploadMayHaveStarted = true;
    }
    assetKey = await writeWorkAsset({
      ...publishTarget,
      assetKey,
      publishJobId,
      status: "published",
    });
    uploadJobTerminal = true;
    if (reservation) await reservation.assertHealthy();

    const result = await db.transaction(async (tx) => {
      const [lockedWork] = await tx
        .select()
        .from(works)
        .where(eq(works.id, current.id))
        .limit(1)
        .for("update");
      if (!lockedWork) throw new Error("work was deleted while its asset was publishing");
      if (!hasSameWorkPublishTarget(publishTarget, lockedWork)) {
        throw new Error("work target changed while its asset was publishing");
      }
      const now = new Date();
      const [versionedWork] = await tx.update(works).set({
        latestVersion: sql`${works.latestVersion} + 1`,
        updatedAt: now,
      }).where(eq(works.id, lockedWork.id)).returning({ latestVersion: works.latestVersion });
      if (!versionedWork) throw new Error("failed to reserve work version");
      const [version] = await tx.insert(workVersions).values({
        workId: lockedWork.id,
        version: versionedWork.latestVersion,
        targetType: lockedWork.targetType,
        targetRef: lockedWork.targetRef,
        assetKey,
        createdAt: now,
      }).returning();
      if (!version) throw new Error("failed to create work version");
      const [work] = await tx.update(works).set({
        status: "published",
        assetKey,
        currentVersionId: version.id,
        latestVersion: versionedWork.latestVersion,
        publishedAt: lockedWork.publishedAt ?? now,
        updatedAt: now,
      }).where(eq(works.id, lockedWork.id)).returning();
      if (!work) throw new Error("failed to publish work version");
      if (publishJobId) {
        const [committedReservation] = await tx
          .update(workAssetReservations)
          .set({ state: "committed", updatedAt: new Date() })
          .where(and(
            eq(workAssetReservations.publishJobId, publishJobId),
            eq(workAssetReservations.state, "pending"),
          ))
          .returning({ publishJobId: workAssetReservations.publishJobId });
        if (!committedReservation) throw new Error("failed to commit work asset reservation");
      }
      return { work, version };
    });
    if (reservation) await reservation.stop();
    return c.json({ work: serializeWork(result.work), version: serializeWorkVersion(result.version) });
  } catch (error) {
    if (reservation) {
      try {
        await reservation.abandon();
      } catch (reservationError) {
        logger.error("[works] failed to abandon work version asset reservation", {
          workId: current.id,
          spaceId: cleanupScope.spaceId,
          slug: cleanupScope.slug,
          publishJobId,
          error: reservationError,
        });
        return c.json({ message: "work asset cleanup failed", code: "work_asset_cleanup_failed" }, 502);
      }
    }
    if (assetKey && !uploadMayHaveStarted) {
      logger.error("[works] failed to schedule work publish upload watchdog", {
        workId: current.id,
        spaceId: cleanupScope.spaceId,
        slug: cleanupScope.slug,
        error,
      });
      return c.json({ message: "work asset cleanup queue unavailable" }, 502);
    }
    const publishJobIsTerminal = uploadJobTerminal || error instanceof WorkAssetPublishError;
    const cleanupAssetKey = selectWorkAssetCleanupKey(
      uploadMayHaveStarted ? assetKey : null,
      error instanceof WorkAssetPublishError ? error.result : null,
    );
    if (cleanupAssetKey) {
      try {
        await cleanupWorkAssets(cleanupAssetKey, {
          workId: current.id,
          spaceId: cleanupScope.spaceId,
          slug: cleanupScope.slug,
          publishJobId: publishJobId ?? undefined,
          deferUntilPublishTerminal: !publishJobIsTerminal,
          reason: "publish_failed",
        });
      } catch (cleanupError) {
        if (cleanupError instanceof WorkAssetCleanupError) {
          return c.json({ message: "work asset cleanup failed", code: "work_asset_cleanup_failed" }, 502);
        }
        throw cleanupError;
      }
    }
    if (error instanceof WorkAssetPublishError) {
      return workAssetErrorResponse(c, error, {
        spaceId: cleanupScope.spaceId,
        targetType: publishTarget.targetType,
        targetRef: publishTarget.targetRef,
      });
    }
    throw error;
  }
}

router.patch("/:id", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "work not found" }, 404);
  const current = await getWorkById(id);
  if (!current) return c.json({ message: "work not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId: current.spaceId }))) return authzDenied(c);

  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  return updateWork(c, current, body, user.uuid);
});

router.get("/:id/versions", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "work not found" }, 404);
  const work = await getWorkById(id);
  if (!work) return c.json({ message: "work not found" }, 404);
  if (!(await hasPermission(user, "space.view", { spaceId: work.spaceId }))) return authzDenied(c);
  const rows = await db.select().from(workVersions).where(eq(workVersions.workId, id)).orderBy(desc(workVersions.version));
  return c.json({ versions: rows.map(serializeWorkVersion) });
});

router.post("/:id/versions", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "work not found" }, 404);
  const work = await getWorkById(id);
  if (!work) return c.json({ message: "work not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId: work.spaceId }))) return authzDenied(c);
  return publishWorkVersion(c, work);
});

router.post("/:id/purge-historical-assets", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "work not found" }, 404);
  const current = await getWorkById(id);
  if (!current) return c.json({ message: "work not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId: current.spaceId }))) return authzDenied(c);

  try {
    const result = await db.transaction(async (tx) => {
      const [lockedWork] = await tx
        .select()
        .from(works)
        .where(eq(works.id, current.id))
        .limit(1)
        .for("update");
      if (!lockedWork) return null;

      const versions = await tx
        .select({ id: workVersions.id, assetKey: workVersions.assetKey })
        .from(workVersions)
        .where(eq(workVersions.workId, lockedWork.id));
      const scope = { env: config.env, spaceId: lockedWork.spaceId, slug: lockedWork.slug };
      const historical = collectHistoricalWorkAssetKeys(versions, lockedWork.currentVersionId, scope);
      if (historical.assetKeys.length > 0) {
        const [versionConflict] = await tx
          .select({ assetKey: workVersions.assetKey })
          .from(workVersions)
          .where(and(ne(workVersions.workId, lockedWork.id), inArray(workVersions.assetKey, historical.assetKeys)))
          .limit(1);
        const [workConflict] = await tx
          .select({ assetKey: works.assetKey })
          .from(works)
          .where(and(ne(works.id, lockedWork.id), inArray(works.assetKey, historical.assetKeys)))
          .limit(1);
        const conflictingAssetKey = versionConflict?.assetKey ?? workConflict?.assetKey;
        if (conflictingAssetKey) {
          throw new WorkAssetCleanupError([
            { assetKey: conflictingAssetKey, message: "work asset key is referenced by another work" },
          ]);
        }
      }

      if (historical.assetKeys.length > 0) {
        await enqueueWorkAssetCleanup({
          assetKeys: historical.assetKeys,
          scope,
          reason: "purge_historical_assets",
          deferWhileReferenced: true,
        });
      }
      if (historical.versionIds.length > 0) {
        await tx
          .update(workVersions)
          .set({ assetKey: null })
          .where(inArray(workVersions.id, historical.versionIds));
      }
      return { assetKeys: historical.assetKeys, scope, purgedVersions: historical.versionIds.length };
    });
    if (!result) return c.json({ message: "work not found" }, 404);
    const cleanup = await deleteWorkAssetKeys(
      result.assetKeys,
      result.scope,
      deleteWorkAssetsByObjectKeys,
    );
    return c.json({
      ok: true,
      purgedVersions: result.purgedVersions,
      deletedAssets: cleanup.objects,
    });
  } catch (error) {
    if (!(error instanceof WorkAssetCleanupError)) throw error;
    logger.error("[works] failed to purge historical work assets", {
      workId: current.id,
      spaceId: current.spaceId,
      failures: error.failures,
    });
    return c.json({ message: "work asset cleanup failed", code: "work_asset_cleanup_failed" }, 502);
  }
});

router.delete("/:id", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "work not found" }, 404);
  const work = await getWorkById(id);
  if (!work) return c.json({ message: "work not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId: work.spaceId }))) return authzDenied(c);
  try {
    const result = await db.transaction(async (tx) => {
      const [lockedWork] = await tx
        .select()
        .from(works)
        .where(eq(works.id, work.id))
        .limit(1)
        .for("update");
      if (!lockedWork) return null;

      const versions = await tx
        .select({ assetKey: workVersions.assetKey })
        .from(workVersions)
        .where(eq(workVersions.workId, lockedWork.id));
      const scope = { env: config.env, spaceId: lockedWork.spaceId, slug: lockedWork.slug };
      const assetKeys = collectWorkAssetKeys(
        [lockedWork.assetKey, ...versions.map((version) => version.assetKey)],
        scope,
      );
      if (assetKeys.length > 0) {
        const [versionConflict] = await tx
          .select({ assetKey: workVersions.assetKey })
          .from(workVersions)
          .where(and(ne(workVersions.workId, lockedWork.id), inArray(workVersions.assetKey, assetKeys)))
          .limit(1);
        const [workConflict] = await tx
          .select({ assetKey: works.assetKey })
          .from(works)
          .where(and(ne(works.id, lockedWork.id), inArray(works.assetKey, assetKeys)))
          .limit(1);
        const conflictingAssetKey = versionConflict?.assetKey ?? workConflict?.assetKey;
        if (conflictingAssetKey) {
          throw new WorkAssetCleanupError([
            { assetKey: conflictingAssetKey, message: "work asset key is referenced by another work" },
          ]);
        }
      }
      const detached = await detachWorkWithAssetCleanupScheduled({
        assetKeys,
        scope,
        scheduleCleanup: async (cleanupAssetKeys) => {
          await enqueueWorkAssetCleanup({
            assetKeys: cleanupAssetKeys,
            scope,
            reason: "delete_work",
            deferWhileReferenced: true,
          });
        },
        deleteRecords: async () => {
          await tx.delete(workViewerGrants).where(eq(workViewerGrants.workId, lockedWork.id));
          await tx.delete(workVersions).where(eq(workVersions.workId, lockedWork.id));
          await tx.delete(works).where(eq(works.id, lockedWork.id));
        },
      });
      return { ...detached, scope };
    });
    if (!result) return c.json({ message: "work not found" }, 404);
    await deleteWorkAssetKeys(result.assetKeys, result.scope, deleteWorkAssetsByObjectKeys);
    return c.json({ ok: true });
  } catch (error) {
    if (!(error instanceof WorkAssetCleanupError)) throw error;
    logger.error("[works] failed to delete work assets", {
      workId: work.id,
      spaceId: work.spaceId,
      failures: error.failures,
    });
    return c.json({ message: "work asset cleanup failed", code: "work_asset_cleanup_failed" }, 502);
  }
});

router.post("/:id/session", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "work not found" }, 404);
  const work = await getWorkById(id);
  if (work?.status !== "published") return c.json({ message: "work not found" }, 404);
  if (requiresSpaceWorkAccess(work) && !(await hasPermission(user, "space.view", { spaceId: work.spaceId }))) return authzDenied(c);
  const token = createWorkSessionToken({
    userUuid: user.uuid,
    workId: work.id,
    spaceId: work.spaceId,
    workScopes: work.workScopes as Permission[],
  });
  return c.json({ token, expiresIn: WORK_SESSION_TTL_SECONDS, work: serializeWork(work) });
});

router.post("/:id/authorize", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "work not found" }, 404);
  const work = await getWorkById(id);
  if (work?.status !== "published") return c.json({ message: "work not found" }, 404);
  if (requiresSpaceWorkAccess(work) && !(await hasPermission(user, "space.view", { spaceId: work.spaceId }))) return authzDenied(c);
  const body = await c.req.json().catch(() => null) as { scopes?: unknown } | null;
  const requested = normalizeScopes(body?.scopes, ALLOWED_VIEWER_SCOPES);
  if (requested.length === 0) return c.json({ message: "no valid scopes requested" }, 400);
  if (!isSubset(requested, work.allowedViewerScopes ?? [])) return c.json({ message: "scope not allowed for this work" }, 403);

  const expiresAt = new Date(Date.now() + WORK_SESSION_TTL_SECONDS * 1000);
  const [grant] = await db.insert(workViewerGrants).values({
    workId: work.id,
    spaceId: work.spaceId,
    viewerUserUuid: user.uuid,
    scopes: requested,
    expiresAt,
  }).onConflictDoUpdate({
    target: [workViewerGrants.workId, workViewerGrants.viewerUserUuid],
    set: { scopes: requested, expiresAt, revokedAt: null, updatedAt: new Date() },
  }).returning();
  if (!grant) return c.json({ message: "failed to create grant" }, 500);

  const token = createWorkSessionToken({
    userUuid: user.uuid,
    workId: work.id,
    spaceId: work.spaceId,
    workScopes: work.workScopes as Permission[],
    viewerScopes: requested,
    workViewerGrantId: grant.id,
  });
  return c.json({ token, expiresIn: WORK_SESSION_TTL_SECONDS, grant: { id: grant.id, scopes: requested, expiresAt: expiresAt.toISOString() } });
});

export default router;
