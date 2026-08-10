import { Hono, type Context } from "hono";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { spaces, works, workVersions, workViewerGrants, workViewStatsHourly, userProfiles } from "@cohub/db";
import { createWorkAssetPublicUrl, deleteWorkAssetsByObjectKey, isConfiguredWorkAssetPublicUrl } from "../work-asset-storage.js";
import { publishWorkAssetInWorker, type WorkPublishAssetJobResult } from "../work-publish-asset-queue.js";
import type { Permission } from "@cohub/core/permissions";
import { materializeHtmlPageMeta, mergeWorkPageMeta } from "@cohub/core/works";
import { db } from "../db/index.js";
import {
  authzDenied,
  getOptionalAuth,
  getSpacePublicProfile,
  getWorkSessionPrincipal,
  requireValidId,
  useAuth,
  type AuthUser,
} from "../lib/middleware.js";
import { hasPermission } from "../permissions.js";
import { createWorkSessionToken, WORK_SESSION_TTL_SECONDS } from "../work-sessions.js";
import { getSandboxPublicEndpoints } from "../sandbox-public-network.js";
import type { WorkArtifactDescriptor, WorkContentKind } from "@cohub/protocol";
import { SANDBOX_PUBLIC_PORTS } from "@cohub/protocol/ports";
import type { RealtimeWorkRecord, RealtimeWorkVersionRecord } from "@cohub/protocol/realtime";
import { createLogger } from "@cohub/infra/logging";
import { billingOperations, COHUB_BILLING_FEATURES } from "@cohub/billing";
import { featureGateResponse } from "../lib/feature-gate.js";
import { createWorkPublicUrl } from "../lib/work-public-url.js";
import { applyRequestSourceToMeta, getRequestSource } from "../lib/request-source.js";
import { dispatchWorkVersionPublished } from "../work-events.js";
import { ensureUserProfileByUuid } from "../user-profiles.js";
import {
  getWorkViewStats,
  recordWorkViewStatsHourly,
  resolveWorkViewSource,
  type WorkViewSource,
} from "../work-view-stats.js";
import {
  createWorkRoom,
  createWorkRoomAdmission,
  getWorkRoomByCode,
  WorkRoomError,
} from "../work-realtime-rooms.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

const WORK_STATUSES = new Set(["published", "disabled"]);
const WORK_VISIBILITIES = new Set(["public", "space"]);
const TARGET_TYPES = new Set(["file", "directory", "port"]);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/;
/** Public work payloads are safe to edge/browser cache briefly. */
const PUBLIC_WORK_HTTP_CACHE = "public, max-age=60, stale-while-revalidate=300";
const PRIVATE_WORK_HTTP_CACHE = "private, no-store";
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
async function getWorkPublicIdentity(spaceId: string) {
  const [row] = await db
    .select({
      ownerUserUuid: spaces.userUuid,
      spaceSlug: spaces.slug,
      ownerUsername: userProfiles.username,
    })
    .from(spaces)
    .leftJoin(userProfiles, eq(userProfiles.userUuid, spaces.userUuid))
    .where(eq(spaces.id, spaceId))
    .limit(1);
  return {
    ownerUserUuid: row?.ownerUserUuid ?? null,
    ownerUsername: row?.ownerUsername?.trim() || null,
    spaceSlug: row?.spaceSlug?.trim() || null,
  };
}

async function ensureWorkPublicIdentity(c: Context, spaceId: string, actor: AuthUser) {
  let identity = await getWorkPublicIdentity(spaceId);
  if (!identity.ownerUsername && identity.ownerUserUuid) {
    await ensureUserProfileByUuid(identity.ownerUserUuid, actor);
    identity = await getWorkPublicIdentity(spaceId);
  }
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

const serializeWork = (work: typeof works.$inferSelect): RealtimeWorkRecord => ({
  id: work.id,
  spaceId: work.spaceId,
  userUuid: work.userUuid,
  slug: work.slug,
  status: work.status as RealtimeWorkRecord["status"],
  visibility: (work.visibility ?? "public") as RealtimeWorkRecord["visibility"],
  targetType: work.targetType as RealtimeWorkRecord["targetType"],
  targetRef: work.targetRef,
  assetKey: work.assetKey,
  currentVersionId: work.currentVersionId,
  latestVersion: work.latestVersion ?? 0,
  publishedAt: work.publishedAt?.toISOString() ?? null,
  workScopes: work.workScopes ?? [],
  allowedViewerScopes: work.allowedViewerScopes ?? [],
  meta: getWorkMeta(work.meta),
  createdAt: work.createdAt?.toISOString() ?? null,
  updatedAt: work.updatedAt?.toISOString() ?? null,
});

const serializeWorkVersion = (version: typeof workVersions.$inferSelect): RealtimeWorkVersionRecord => ({
  id: version.id,
  workId: version.workId,
  version: version.version,
  targetType: version.targetType as RealtimeWorkVersionRecord["targetType"],
  targetRef: version.targetRef,
  assetKey: version.assetKey,
  contentKind: version.contentKind as WorkContentKind,
  artifact: isRecord(version.artifact) ? version.artifact as WorkArtifactDescriptor : null,
  meta: getWorkMeta(version.meta),
  createdAt: version.createdAt?.toISOString() ?? null,
});

async function getWorkById(id: string) {
  const [work] = await db.select().from(works).where(eq(works.id, id)).limit(1);
  return work ?? null;
}

let lastWorkViewRecordWarningAt = 0;

function recordResolvedWorkView(
  c: Context,
  work: typeof works.$inferSelect,
  fallbackSource: WorkViewSource,
) {
  if (work.status !== "published" || !work.currentVersionId) return;
  void recordWorkViewStatsHourly({
    workId: work.id,
    workVersionId: work.currentVersionId,
    source: resolveWorkViewSource(getRequestSource(c), fallbackSource),
  }).catch((error) => {
    const now = Date.now();
    if (now - lastWorkViewRecordWarningAt < 60_000) return;
    lastWorkViewRecordWarningAt = now;
    logger.warn("[works] failed to buffer view", { workId: work.id, error });
  });
}

class WorkAssetPublishError extends Error {
  constructor(public result: Extract<WorkPublishAssetJobResult, { ok: false }>) {
    super(result.message);
  }
}

type WrittenWorkAsset = {
  assetKey: string;
  artifact: WorkArtifactDescriptor;
  extracted: ReturnType<typeof materializeHtmlPageMeta> | null;
};

async function writeWorkAsset(input: {
  spaceId: string;
  slug: string;
  targetType: string;
  targetRef: string;
  status: string;
}): Promise<WrittenWorkAsset | null> {
  const { spaceId, slug, targetType, targetRef, status } = input;
  if (status !== "published" || (targetType !== "file" && targetType !== "directory")) return null;
  const result = await publishWorkAssetInWorker({ spaceId, slug, targetType, targetRef });
  if (!result.ok) throw new WorkAssetPublishError(result);
  const extracted = result.extracted
    ? materializeHtmlPageMeta(
        {
          title: result.extracted.title,
          description: result.extracted.description,
          icon: result.extracted.icon,
          image: result.extracted.image,
          lang: result.extracted.lang ?? null,
          themeColor: result.extracted.themeColor ?? null,
          sourcePath: result.extracted.sourcePath,
        },
        result.assetKey,
        createWorkAssetPublicUrl,
      )
    : null;
  return {
    assetKey: result.assetKey,
    // An older worker returns no descriptor; every publish it can perform is an
    // HTML page or site, so `web` reconstructs it faithfully.
    artifact: result.artifact ?? {
      kind: "web",
      mimeType: "text/html",
      sizeBytes: result.sizeBytes,
      fileCount: result.fileCount ?? 1,
    },
    extracted,
  };
}

function withPublishedPageMeta(input: {
  baseMeta: WorkMeta | null | undefined;
  extracted: WrittenWorkAsset["extracted"];
}) {
  return mergeWorkPageMeta(input.baseMeta, input.extracted ?? undefined);
}

function workAssetErrorResponse(c: Context, error: unknown, context: { spaceId: string; targetType: string; targetRef: string }) {
  if (error instanceof WorkAssetPublishError) {
    return c.json({ message: error.result.message.toLowerCase().replace(/\.$/, ""), code: error.result.code }, error.result.status as never);
  }
  logger.warn("[works] failed to write work asset", { ...context, error });
  return c.json({ message: "work asset storage failed" }, 502);
}

async function cleanupWorkAssets(assetKey: string | null | undefined, context: { workId: string; spaceId: string; reason: string }) {
  if (!assetKey) return;
  try {
    await deleteWorkAssetsByObjectKey(assetKey);
  } catch (error) {
    logger.warn("[works] failed to delete stale work asset", { ...context, assetKey, error });
  }
}

const getWorkContent = (input: {
  spaceId: string;
  targetType: string;
  targetRef: string;
  assetKey: string | null;
  contentKind: string;
  artifact: Record<string, unknown> | null;
}) => {
  if (input.targetType === "port") {
    const portRef = normalizePortRef(input.targetRef);
    if (!portRef) return null;
    const url = getSandboxPublicEndpoints(input.spaceId)[portRef]?.url;
    if (!url || !isAllowedWorkContentUrl(url, "port")) return null;
    return { kind: "port" as const, url, targetType: "port" as const, port: portRef };
  }
  if (!input.assetKey) return null;
  const url = createWorkAssetPublicUrl(input.assetKey);
  if (!isAllowedWorkContentUrl(url, "asset")) return null;
  if (input.contentKind === "board" && input.artifact?.kind === "board") {
    return {
      kind: "board" as const,
      url,
      targetType: "file" as const,
      path: input.targetRef,
      boardId: String(input.artifact.boardId),
      boardVersion: Number(input.artifact.boardVersion),
    };
  }
  const rawDownload = isRecord(input.artifact?.download) ? input.artifact.download : null;
  const manifestKey = typeof rawDownload?.manifestKey === "string" ? rawDownload.manifestKey : null;
  const manifestSha256 = typeof rawDownload?.manifestSha256 === "string" ? rawDownload.manifestSha256 : null;
  const manifestUrl = manifestKey ? createWorkAssetPublicUrl(manifestKey) : null;
  const download = manifestUrl && manifestSha256 && isAllowedWorkContentUrl(manifestUrl, "asset")
    ? { manifestUrl, manifestSha256 }
    : null;
  if (input.contentKind === "file" && input.artifact?.kind === "file") {
    return {
      kind: "file" as const,
      url,
      targetType: "file" as const,
      path: input.targetRef,
      name: String(input.artifact.name),
      mimeType: typeof input.artifact.mimeType === "string" ? input.artifact.mimeType : null,
      sizeBytes: Number(input.artifact.sizeBytes),
      sha256: String(input.artifact.sha256),
      ...(download ? { download } : {}),
    };
  }
  return {
    kind: "web" as const,
    url,
    targetType: input.targetType as "file" | "directory",
    path: input.targetRef,
    ...(download ? { download } : {}),
  };
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
    contentKind: version.contentKind,
    artifact: version.artifact,
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

  recordResolvedWorkView(c, row.work, "web");
  const content = await getPublishedWorkContent(row.work);

  // Public works are anonymous-readable; space works depend on the caller.
  c.header(
    "Cache-Control",
    requiresSpaceWorkAccess(row.work) ? PRIVATE_WORK_HTTP_CACHE : PUBLIC_WORK_HTTP_CACHE,
  );
  return c.json({
    work: serializeWork(row.work),
    space: { id: row.space.id, slug: row.space.slug, name: row.space.name, userUuid: row.space.userUuid, publicProfile: getSpacePublicProfile(row.space) },
    owner: { ...row.owner, username: row.owner.username },
    publicUrl: createWorkPublicUrl({ ownerUsername: row.owner.username, spaceSlug: row.space.slug, workSlug: row.work.slug, status: row.work.status }),
    content,
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
  // Content matches what the by-slug page already serves for the same access
  // model, so an in-workspace preview can render a Work reached by public url.
  const content = await getPublishedWorkContent(work);
  return c.json({
    work: serializeWork(work),
    space,
    owner: { ...row.owner, username: row.owner.username },
    content,
  });
});

router.get("/:id/stats", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "work not found" }, 404);
  const work = await getWorkById(id);
  if (!work) return c.json({ message: "work not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId: work.spaceId }))) return authzDenied(c);
  return c.json(await getWorkViewStats(work.id));
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
  const shouldRecordCliView = getRequestSource(c)?.via === "cli";
  if (shouldRecordCliView) recordResolvedWorkView(c, work, "cli");
  const content = await getPublishedWorkContent(work);
  return c.json({
    work: serializeWork(work),
    space,
    owner: { ...row.owner, username: row.owner.username },
    publicUrl: createWorkPublicUrl({ ownerUsername: row.owner.username, spaceSlug: row.space.slug, workSlug: work.slug, status: work.status }),
    content,
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
  const identityError = await ensureWorkPublicIdentity(c, spaceId, user);
  if (identityError) return identityError;
  const meta = getWorkMeta(body?.meta);
  const presentationError = await ensureWorkPresentationAllowed(c, { userId: user.uuid, meta });
  if (presentationError) return presentationError;
  const now = new Date();

  const [existingWork] = await db.select().from(works).where(and(eq(works.spaceId, spaceId), eq(works.slug, slug))).limit(1);
  if (existingWork) return c.json({ message: "slug already exists" }, 409);

  let written: WrittenWorkAsset | null = null;
  try {
    written = await writeWorkAsset({ spaceId, slug, targetType, targetRef, status });
  } catch (error) {
    return workAssetErrorResponse(c, error, { spaceId, targetType, targetRef });
  }
  const assetKey = written?.assetKey ?? null;
  const pageMeta = withPublishedPageMeta({ baseMeta: meta, extracted: written?.extracted ?? null });
  const versionMeta = withPublishedPageMeta({
    baseMeta: applyRequestSourceToMeta(c, null),
    extracted: written?.extracted ?? null,
  });

  try {
    const result = await db.transaction(async (tx) => {
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
        meta: pageMeta,
      }).returning();
      if (!createdWork) return null;
      if (status !== "published") return { work: createdWork, version: null };
      const [version] = await tx.insert(workVersions).values({
        workId: createdWork.id,
        version: 1,
        targetType,
        targetRef,
        assetKey,
        contentKind: written?.artifact.kind ?? "web",
        artifact: written?.artifact ?? null,
        meta: versionMeta,
        createdAt: now,
      }).returning();
      if (!version) throw new Error("failed to create work version");
      const [updatedWork] = await tx.update(works).set({ currentVersionId: version.id }).where(eq(works.id, createdWork.id)).returning();
      return { work: updatedWork ?? createdWork, version };
    }).catch((error: unknown) => {
      if (isWorkSlugConflict(error)) return null;
      throw error;
    });
    if (!result) {
      await cleanupWorkAssets(assetKey, { workId: "new", spaceId, reason: "create_slug_conflict" });
      return c.json({ message: "slug already exists" }, 409);
    }
    const serializedWork = serializeWork(result.work);
    if (result.version) {
      const serializedVersion = serializeWorkVersion(result.version);
      await dispatchWorkVersionPublished({
        work: serializedWork,
        version: serializedVersion,
        previousVersionId: null,
        actorUserId: user.uuid,
        source: getRequestSource(c),
      }).catch((error) => {
        logger.warn("[works] failed to dispatch work.version.published", {
          workId: result.work.id,
          version: result.version?.version,
          error,
        });
      });
    }
    return c.json({ work: serializedWork }, 201);
  } catch (error) {
    await cleanupWorkAssets(assetKey, { workId: "new", spaceId, reason: "create_failed" });
    throw error;
  }
});

async function updateWork(
  c: Context,
  current: typeof works.$inferSelect,
  body: Record<string, unknown> | null,
  actor: AuthUser,
) {
  const nextSlug = typeof body?.slug === "string" ? body.slug.trim().toLowerCase() : current.slug;
  if (!SLUG_RE.test(nextSlug)) return c.json({ message: "slug must use lowercase letters, numbers, hyphens, or underscores" }, 400);
  if (nextSlug !== current.slug && !(await ensureUniqueWorkSlug({ spaceId: current.spaceId, slug: nextSlug, excludeId: current.id }))) {
    return c.json({ message: "slug already exists" }, 409);
  }

  const nextTargetType = typeof body?.targetType === "string" ? body.targetType : current.targetType;
  let nextTargetRef = typeof body?.targetRef === "string" ? body.targetRef.trim() : current.targetRef;
  if (!TARGET_TYPES.has(nextTargetType) || !nextTargetRef) return c.json({ message: "target is invalid" }, 400);
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
  const nextVisibility = typeof body?.visibility === "string" ? body.visibility : (current.visibility ?? "public");
  const identityError = await ensureWorkPublicIdentity(c, current.spaceId, actor);
  if (identityError) return identityError;
  const nextMeta = "meta" in (body ?? {}) ? getWorkMeta(body?.meta) : getWorkMeta(current.meta);
  const presentationError = await ensureWorkPresentationAllowed(c, { userId: actor.uuid, meta: nextMeta });
  if (presentationError) return presentationError;

  const assetKey = nextStatus === "published" ? current.assetKey : null;

  const now = new Date();
  const work = await db.transaction(async (tx) => {
    const [updatedWork] = await tx.update(works).set({
      slug: nextSlug,
      status: nextStatus,
      visibility: nextVisibility,
      targetType: nextTargetType,
      targetRef: nextTargetRef,
      assetKey,
      currentVersionId: current.currentVersionId,
      latestVersion: current.latestVersion,
      publishedAt: nextStatus === "published" ? (current.publishedAt ?? now) : null,
      workScopes: "workScopes" in (body ?? {}) ? normalizeScopes(body?.workScopes, ALLOWED_WORK_SCOPES) : current.workScopes,
      allowedViewerScopes: "allowedViewerScopes" in (body ?? {}) ? normalizeScopes(body?.allowedViewerScopes, ALLOWED_VIEWER_SCOPES) : current.allowedViewerScopes,
      meta: nextMeta,
      updatedAt: now,
    }).where(eq(works.id, current.id)).returning();
    return updatedWork ?? null;
  }).catch((error: unknown) => {
    if (isWorkSlugConflict(error)) return null;
    throw error;
  });
  if (!work) return c.json({ message: "slug already exists" }, 409);
  return c.json({ work: serializeWork(work) });
}

async function publishWorkVersion(
  c: Context,
  current: typeof works.$inferSelect,
  options: { actor: AuthUser; meta?: WorkMeta | null },
) {
  const identityError = await ensureWorkPublicIdentity(c, current.spaceId, options.actor);
  if (identityError) return identityError;
  let written: WrittenWorkAsset | null = null;
  try {
    written = await writeWorkAsset({
      spaceId: current.spaceId,
      slug: current.slug,
      targetType: current.targetType,
      targetRef: current.targetRef,
      status: "published",
    });
  } catch (error) {
    return workAssetErrorResponse(c, error, { spaceId: current.spaceId, targetType: current.targetType, targetRef: current.targetRef });
  }
  const assetKey = written?.assetKey ?? null;
  const versionMeta = withPublishedPageMeta({
    baseMeta: options?.meta ?? null,
    extracted: written?.extracted ?? null,
  });
  const workMeta = withPublishedPageMeta({
    baseMeta: getWorkMeta(current.meta),
    extracted: written?.extracted ?? null,
  });

  try {
    const result = await db.transaction(async (tx) => {
      const now = new Date();
      const [versionedWork] = await tx.update(works).set({
        latestVersion: sql`${works.latestVersion} + 1`,
        updatedAt: now,
      }).where(eq(works.id, current.id)).returning({
        latestVersion: works.latestVersion,
        previousVersionId: works.currentVersionId,
      });
      if (!versionedWork) throw new Error("failed to reserve work version");
      const [version] = await tx.insert(workVersions).values({
        workId: current.id,
        version: versionedWork.latestVersion,
        targetType: current.targetType,
        targetRef: current.targetRef,
        assetKey,
        contentKind: written?.artifact.kind ?? "web",
        artifact: written?.artifact ?? null,
        meta: versionMeta,
        createdAt: now,
      }).returning();
      if (!version) throw new Error("failed to create work version");
      const [work] = await tx.update(works).set({
        status: "published",
        assetKey,
        currentVersionId: version.id,
        latestVersion: versionedWork.latestVersion,
        publishedAt: current.publishedAt ?? now,
        meta: workMeta,
        updatedAt: now,
      }).where(eq(works.id, current.id)).returning();
      if (!work) throw new Error("failed to publish work version");
      return { work, version, previousVersionId: versionedWork.previousVersionId };
    });
    const serializedWork = serializeWork(result.work);
    const serializedVersion = serializeWorkVersion(result.version);
    await dispatchWorkVersionPublished({
      work: serializedWork,
      version: serializedVersion,
      previousVersionId: result.previousVersionId,
      actorUserId: options.actor.uuid,
      source: getRequestSource(c),
    }).catch((error) => {
      logger.warn("[works] failed to dispatch work.version.published", {
        workId: result.work.id,
        version: result.version.version,
        error,
      });
    });
    return c.json({ work: serializedWork, version: serializedVersion });
  } catch (error) {
    try {
      await cleanupWorkAssets(assetKey, { workId: current.id, spaceId: current.spaceId, reason: "publish_failed" });
    } catch (cleanupError) {
      logger.warn("[works] failed to run publish cleanup", { workId: current.id, spaceId: current.spaceId, cleanupError });
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
  return updateWork(c, current, body, user);
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
  const meta = applyRequestSourceToMeta(c, null);
  return publishWorkVersion(c, work, { actor: user, meta });
});

router.delete("/:id", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "work not found" }, 404);
  const work = await getWorkById(id);
  if (!work) return c.json({ message: "work not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId: work.spaceId }))) return authzDenied(c);
  await db.transaction(async (tx) => {
    await tx.delete(workViewerGrants).where(eq(workViewerGrants.workId, work.id));
    await tx.delete(workViewStatsHourly).where(eq(workViewStatsHourly.workId, work.id));
    await tx.delete(workVersions).where(eq(workVersions.workId, work.id));
    await tx.delete(works).where(eq(works.id, work.id));
  });
  return c.json({ ok: true });
});

const workRoomErrorResponse = (c: Context, error: unknown) => {
  if (!(error instanceof WorkRoomError)) return c.json({ message: "failed to create realtime room" }, 503);
  if (error.code === "ROOM_QUOTA_EXCEEDED") return c.json({ code: error.code, message: error.message }, 429);
  const status = error.code === "ROOM_CODE_TAKEN" ? 409 : 400;
  return c.json({ code: error.code, message: error.message }, status);
};

const getPublishedWorkForRoom = async (c: Context, workId: string) => {
  const principal = getWorkSessionPrincipal(c);
  if (!principal || principal.workId !== workId) return null;
  const work = await getWorkById(workId);
  if (work?.status !== "published" || work.spaceId !== principal.spaceId) return null;
  return { principal, work };
};

router.post("/:id/realtime/rooms", async (c) => {
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "work not found" }, 404);
  const context = await getPublishedWorkForRoom(c, id);
  if (!context) return authzDenied(c);
  const body = await c.req.json().catch(() => null) as {
    code?: unknown;
    expiresInSeconds?: unknown;
    maxParticipants?: unknown;
    seatPerUser?: unknown;
  } | null;
  try {
    const room = await createWorkRoom({
      workId: id,
      code: body?.code,
      expiresInSeconds: body?.expiresInSeconds,
      maxParticipants: body?.maxParticipants,
      seatPerUser: body?.seatPerUser,
    });
    return c.json(createWorkRoomAdmission({
      workId: id,
      userUuid: context.principal.userUuid,
      room,
    }));
  } catch (error) {
    return workRoomErrorResponse(c, error);
  }
});

router.post("/:id/realtime/rooms/join", async (c) => {
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "work not found" }, 404);
  const context = await getPublishedWorkForRoom(c, id);
  if (!context) return authzDenied(c);
  const body = await c.req.json().catch(() => null) as { code?: unknown } | null;
  const room = await getWorkRoomByCode(id, body?.code);
  if (!room || room.workId !== id) return c.json({ code: "ROOM_NOT_FOUND", message: "room not found" }, 404);
  try {
    return c.json(createWorkRoomAdmission({
      workId: id,
      userUuid: context.principal.userUuid,
      room,
    }));
  } catch (error) {
    return workRoomErrorResponse(c, error);
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
