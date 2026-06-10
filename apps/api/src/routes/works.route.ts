import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { spaces, works, workViewerGrants, userProfiles } from "@cohub/db";
import { readSpaceDirectoryFiles, readSpaceFile, SpaceFsError, spaceFsJsonError } from "../space-fs.js";
import { createWorkAssetPublicUrl, isConfiguredWorkAssetPublicUrl, writeWorkHtmlAsset, writeWorkSiteAssets } from "../work-asset-storage.js";
import type { Permission } from "@cohub/core/permissions";
import { db } from "../db/index.js";
import { authzDenied, requireValidId, useAuth } from "../lib/middleware.js";
import { hasPermission } from "../permissions.js";
import { createWorkSessionToken, WORK_SESSION_TTL_SECONDS } from "../work-sessions.js";
import { getSandboxPublicEndpoints } from "../sandbox-public-network.js";
import { SANDBOX_PUBLIC_PORTS } from "@cohub/protocol/ports";
import { createLogger } from "@cohub/infra/logging";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

const WORK_STATUSES = new Set(["draft", "published"]);
const TARGET_TYPES = new Set(["file", "directory", "port"]);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/;
const SANDBOX_PUBLIC_PORT_SET = new Set<number>(SANDBOX_PUBLIC_PORTS as readonly number[]);
const ALLOWED_WORK_SCOPES = new Set<Permission>(["space.view", "session.view", "file.view"]);
const ALLOWED_VIEWER_SCOPES = new Set<Permission>([
  "session.prompt.readonly",
  "session.prompt.fullaccess",
]);


const normalizeScopes = (value: unknown, allowed: Set<Permission>): Permission[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((item): item is Permission => typeof item === "string" && allowed.has(item as Permission))));
};

const isSubset = (requested: Permission[], allowed: string[]) => requested.every((scope) => allowed.includes(scope));

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
  targetType: work.targetType,
  targetRef: work.targetRef,
  assetKey: work.assetKey,
  publishedAt: work.publishedAt?.toISOString() ?? null,
  workScopes: work.workScopes ?? [],
  allowedViewerScopes: work.allowedViewerScopes ?? [],
  meta: work.meta ?? null,
  createdAt: work.createdAt?.toISOString() ?? null,
  updatedAt: work.updatedAt?.toISOString() ?? null,
});

async function getWorkById(id: string) {
  const [work] = await db.select().from(works).where(eq(works.id, id)).limit(1);
  return work ?? null;
}

router.get("/by-slug/:username/:spaceSlug/:workSlug", async (c) => {
  const username = c.req.param("username");
  const spaceSlug = c.req.param("spaceSlug");
  const workSlug = c.req.param("workSlug");
  if (!username || !SLUG_RE.test(spaceSlug) || !SLUG_RE.test(workSlug)) return c.json({ message: "work not found" }, 404);

  const [row] = await db
    .select({
      owner: { userUuid: userProfiles.userUuid, username: userProfiles.username, displayName: userProfiles.displayName },
      space: spaces,
      work: works,
    })
    .from(userProfiles)
    .innerJoin(spaces, and(eq(spaces.userUuid, userProfiles.userUuid), eq(spaces.slug, spaceSlug)))
    .innerJoin(works, and(eq(works.spaceId, spaces.id), eq(works.slug, workSlug), eq(works.status, "published")))
    .where(eq(userProfiles.username, username))
    .limit(1);
  if (!row) return c.json({ message: "work not found" }, 404);

  return c.json({
    work: serializeWork(row.work),
    space: { id: row.space.id, slug: row.space.slug, name: row.space.name, userUuid: row.space.userUuid },
    owner: row.owner,
  });
});

router.get("/space/:spaceId", async (c) => {
  const user = useAuth(c);
  const spaceId = c.req.param("spaceId");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.view", { spaceId }))) return authzDenied(c);
  const rows = await db.select().from(works).where(eq(works.spaceId, spaceId));
  return c.json({ works: rows.map(serializeWork) });
});

router.post("/", async (c) => {
  const user = useAuth(c);
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
  const status = typeof body?.status === "string" && WORK_STATUSES.has(body.status) ? body.status : "published";

  const [existingWork] = await db
    .select({ id: works.id })
    .from(works)
    .where(and(eq(works.spaceId, spaceId), eq(works.slug, slug)))
    .limit(1);
  if (existingWork) return c.json({ message: "slug already exists" }, 409);

  let assetKey: string | null = null;
  if (status === "published" && (targetType === "file" || targetType === "directory")) {
    try {
      if (targetType === "directory") {
        const result = await readSpaceDirectoryFiles(spaceId, targetRef, { visibility: "full" });
        const written = await writeWorkSiteAssets({ spaceId, workSlug: slug, files: result.files });
        assetKey = written.objectKey;
      } else {
        const result = await readSpaceFile(spaceId, targetRef, { visibility: "full" });
        if (!("content" in result)) return c.json({ message: "file is still preparing" }, 409);
        const written = await writeWorkHtmlAsset({ spaceId, workSlug: slug, html: result.content });
        assetKey = written.objectKey;
      }
    } catch (error) {
      if (error instanceof Error && (
        error.message === "work asset must be 1 byte to 5MB" ||
        error.message === "work site must contain index.html" ||
        error.message === "work site must be 1 byte to 100MB" ||
        error.message.startsWith("work site must contain 1 to ")
      )) {
        return c.json({ message: error.message }, 400);
      }
      if (error instanceof Error && error.message === "work asset storage is not configured") {
        return c.json({ message: error.message }, 500);
      }
      if (!(error instanceof SpaceFsError)) {
        logger.warn("[works] failed to write work asset", { spaceId, targetType, targetRef, error });
        return c.json({ message: "work asset storage failed" }, 502);
      }
      const { status: errorStatus, body: errorBody } = spaceFsJsonError(error);
      return c.json(errorBody, errorStatus as never);
    }
  }

  const [work] = await db.insert(works).values({
    spaceId,
    userUuid: user.uuid,
    slug,
    status,
    targetType,
    targetRef,
    assetKey,
    publishedAt: status === "published" ? new Date() : null,
    workScopes: normalizeScopes(body?.workScopes, ALLOWED_WORK_SCOPES),
    allowedViewerScopes: normalizeScopes(body?.allowedViewerScopes, ALLOWED_VIEWER_SCOPES),
    meta: body?.meta && typeof body.meta === "object" ? body.meta as Record<string, unknown> : null,
  }).returning().catch((error: unknown) => {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : null;
    if (code === "23505") return [];
    throw error;
  });
  if (!work) return c.json({ message: "slug already exists" }, 409);
  return c.json({ work: serializeWork(work) }, 201);
});

router.get("/:id/content", async (c) => {
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "work not found" }, 404);
  const work = await getWorkById(id);
  if (work?.status !== "published") return c.json({ message: "work not found" }, 404);
  if (work.targetType === "port") {
    const portRef = normalizePortRef(work.targetRef);
    if (!portRef) return c.json({ message: "work port is unavailable" }, 409);
    const url = getSandboxPublicEndpoints(work.spaceId)[portRef]?.url;
    if (!url || !isAllowedWorkContentUrl(url, "port")) return c.json({ message: "work port is unavailable" }, 409);
    return c.json({ url, targetType: "port", port: portRef });
  }
  if (work.assetKey) {
    const url = createWorkAssetPublicUrl(work.assetKey);
    if (!isAllowedWorkContentUrl(url, "asset")) return c.json({ message: "work asset is unavailable" }, 409);
    return c.json({ url, targetType: work.targetType, path: work.targetRef });
  }
  return c.json({ message: "work asset is unavailable" }, 409);
});

router.post("/:id/session", async (c) => {
  const user = useAuth(c);
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "work not found" }, 404);
  const work = await getWorkById(id);
  if (work?.status !== "published") return c.json({ message: "work not found" }, 404);
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
  const id = c.req.param("id");
  if (!requireValidId(id)) return c.json({ message: "work not found" }, 404);
  const work = await getWorkById(id);
  if (work?.status !== "published") return c.json({ message: "work not found" }, 404);
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
