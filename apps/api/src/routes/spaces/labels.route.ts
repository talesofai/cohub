import { Hono, type Context } from "hono";
import { and, asc, count, desc, eq, inArray, max, sql } from "drizzle-orm";
import { checkpoints, labelAssignments, labels, spaceSessions } from "@cohub/db";
import { listLabelsByRank, normalizeLabelName, parseLabelRef, parseLabelRefs, resolveLabelPaths, resolveOrCreateLabelPaths, slugifyLabelName } from "@cohub/core/labels";
import { db } from "../../db/index.js";
import { authzDenied, getOptionalAuth, requireValidId, useAuth } from "../../lib/middleware.js";
import { hasPermission } from "../../permissions.js";
import { dispatchLabelAssignmentsUpdated } from "../../realtime-events.js";

const router = new Hono();
const SCOPE_TYPE = "space";
const RESOURCE_TYPES = new Set(["session", "checkpoint", "file"]);
const DEFAULT_ITEMS_LIMIT = 30;
const MAX_ITEMS_LIMIT = 50;

function normalizeName(value: unknown) {
  try {
    return normalizeLabelName(value);
  } catch {
    return null;
  }
}

function isSafeFilePath(path: string) {
  const trimmed = path.trim();
  return trimmed.length > 0 &&
    !trimmed.startsWith("/") &&
    !trimmed.includes("\0") &&
    !trimmed.split("/").some((part) => part === ".." || part === "");
}

function parseItemsLimit(value: string | undefined) {
  const limit = Number(value ?? DEFAULT_ITEMS_LIMIT);
  if (!Number.isSafeInteger(limit) || limit < 1) return DEFAULT_ITEMS_LIMIT;
  return Math.min(limit, MAX_ITEMS_LIMIT);
}

function encodeItemsCursor(row: typeof labelAssignments.$inferSelect) {
  return Buffer.from(JSON.stringify({ rank: row.rank, createdAt: row.createdAt?.toISOString() ?? null, id: row.id })).toString("base64url");
}

function decodeItemsCursor(value: string | undefined) {
  if (!value) return { ok: true as const, cursor: null };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { rank?: unknown; createdAt?: unknown; id?: unknown };
    if (!Number.isSafeInteger(parsed.rank) || typeof parsed.id !== "string" || !requireValidId(parsed.id)) return { ok: false as const };
    if (parsed.createdAt !== null && typeof parsed.createdAt !== "string") return { ok: false as const };
    const createdAt = parsed.createdAt ? new Date(parsed.createdAt) : null;
    if (createdAt && !Number.isFinite(createdAt.getTime())) return { ok: false as const };
    return { ok: true as const, cursor: { rank: parsed.rank, createdAt, id: parsed.id } };
  } catch {
    return { ok: false as const };
  }
}

function buildHref(spaceId: string, resourceType: string, resourceRef: string) {
  if (resourceType === "session") return `/spaces/${spaceId}/sessions/${resourceRef}`;
  if (resourceType === "checkpoint") return `/spaces/${spaceId}/checkpoints/${resourceRef}`;
  if (resourceType === "file") return `/spaces/${spaceId}/files/${resourceRef.split("/").map(encodeURIComponent).join("/")}`;
  return `/spaces/${spaceId}`;
}

function buildLabelTree(rows: Array<typeof labels.$inferSelect>) {
  const sorted = [...rows].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.name.localeCompare(b.name);
  });
  const byId = new Map(sorted.map((label) => [label.id, { ...label, children: [] as Array<typeof label & { children: never[] }> }]));
  const roots: Array<typeof sorted[number] & { children: Array<typeof sorted[number]> }> = [];
  for (const label of byId.values()) {
    if (label.parentId) {
      const parent = byId.get(label.parentId);
      if (parent) {
        parent.children.push(label as never);
        continue;
      }
    }
    roots.push(label as never);
  }
  return roots;
}

async function requireSpacePermission(c: Context, permission: Parameters<typeof hasPermission>[1]) {
  const user = permission === "space.label.view" ? getOptionalAuth(c) : useAuth(c);
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return { error: c.json({ message: "space not found" }, 404) };
  if (!(await hasPermission(user, permission, { spaceId }))) return { error: authzDenied(c) };
  return { user, spaceId };
}

async function getScopeLabels(spaceId: string) {
  return listLabelsByRank(db, spaceId);
}

async function getLabelInSpace(spaceId: string, labelId: string) {
  const [label] = await db
    .select()
    .from(labels)
    .where(and(eq(labels.id, labelId), eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, spaceId)))
    .limit(1);
  return label ?? null;
}

async function getLabelByRef(spaceId: string, labelRef: unknown) {
  const path = parseLabelRef(labelRef);
  const resolved = await resolveLabelPaths({ db, spaceId, paths: [path] });
  const labelId = resolved.labelIds[0];
  if (!labelId) return null;
  return getLabelInSpace(spaceId, labelId);
}

async function resolveOrCreateRefs(spaceId: string, labelRefs: unknown, userId: string | null) {
  const paths = parseLabelRefs(labelRefs);
  return resolveOrCreateLabelPaths({ db, spaceId, paths, userId });
}

async function resolveRefsWithCreatePermission(c: Context, access: { user: ReturnType<typeof getOptionalAuth>; spaceId: string }, labelRefs: unknown) {
  const paths = parseLabelRefs(labelRefs);
  const resolved = await resolveLabelPaths({ db, spaceId: access.spaceId, paths });
  if (resolved.missingPaths.length === 0) return { labelIds: resolved.labelIds };
  if (!(await hasPermission(access.user, "space.label.manage", { spaceId: access.spaceId }))) {
    return { error: authzDenied(c) };
  }
  await resolveOrCreateLabelPaths({ db, spaceId: access.spaceId, paths: resolved.missingPaths, userId: access.user?.uuid ?? null });
  return resolveLabelPaths({ db, spaceId: access.spaceId, paths });
}

async function resolveExistingRefs(spaceId: string, labelRefs: unknown) {
  const paths = parseLabelRefs(labelRefs);
  return resolveLabelPaths({ db, spaceId, paths });
}

function isUniqueLabelNameViolation(error: unknown) {
  const record = error as { code?: string; constraint_name?: string; constraint?: string };
  const constraint = record.constraint_name ?? record.constraint ?? "";
  return record.code === "23505" && constraint.includes("labels_scope_parent_name");
}

async function validateResource(spaceId: string, resourceType: string, resourceRef: string) {
  if (!RESOURCE_TYPES.has(resourceType)) return false;
  if (resourceType === "file") return isSafeFilePath(resourceRef);
  if (!requireValidId(resourceRef)) return false;
  if (resourceType === "session") {
    const [row] = await db.select({ id: spaceSessions.id }).from(spaceSessions).where(and(eq(spaceSessions.spaceId, spaceId), eq(spaceSessions.id, resourceRef))).limit(1);
    return Boolean(row);
  }
  const [row] = await db.select({ id: checkpoints.id }).from(checkpoints).where(and(eq(checkpoints.spaceId, spaceId), eq(checkpoints.id, resourceRef))).limit(1);
  return Boolean(row);
}

async function getUserLabelIds(c: Context, spaceId: string, labelIds: string[]) {
  const uniqueLabelIds = [...new Set(labelIds)].filter(Boolean);
  if (uniqueLabelIds.length === 0) return { labelIds: [] };
  const rows = await db.select().from(labels).where(and(eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, spaceId), inArray(labels.id, uniqueLabelIds)));
  if (rows.length !== uniqueLabelIds.length || rows.some((label) => label.source !== "user")) return { error: authzDenied(c) };
  const userIds = new Set(rows.map((label) => label.id));
  return { labelIds: uniqueLabelIds.filter((labelId) => userIds.has(labelId)) };
}

async function getResourceLabelResponse(spaceId: string, resourceType: string, resourceRef: string) {
  const [allLabels, assignments] = await Promise.all([
    getScopeLabels(spaceId),
    db.select().from(labelAssignments).where(and(eq(labelAssignments.scopeType, SCOPE_TYPE), eq(labelAssignments.scopeId, spaceId), eq(labelAssignments.resourceType, resourceType), eq(labelAssignments.resourceRef, resourceRef))),
  ]);
  return { labels: buildLabelTree(allLabels), assignments };
}

async function hydrateAssignments(spaceId: string, rows: Array<typeof labelAssignments.$inferSelect>) {
  const sessionIds = rows.filter((m) => m.resourceType === "session").map((m) => m.resourceRef).filter(requireValidId);
  const checkpointIds = rows.filter((m) => m.resourceType === "checkpoint").map((m) => m.resourceRef).filter(requireValidId);
  const sessionRows = sessionIds.length > 0
    ? await db.select().from(spaceSessions).where(and(eq(spaceSessions.spaceId, spaceId), inArray(spaceSessions.id, sessionIds)))
    : [];
  const checkpointRows = checkpointIds.length > 0
    ? await db.select().from(checkpoints).where(and(eq(checkpoints.spaceId, spaceId), inArray(checkpoints.id, checkpointIds)))
    : [];
  const sessionsById = new Map(sessionRows.map((s) => [s.id, s]));
  const checkpointsById = new Map(checkpointRows.map((cp) => [cp.id, cp]));

  return rows.flatMap((assignment) => {
    if (assignment.resourceType === "session") {
      const session = sessionsById.get(assignment.resourceRef);
      if (!session) return [];
      return [{
        ...assignment,
        href: buildHref(spaceId, assignment.resourceType, assignment.resourceRef),
        resource: {
          title: session.title ?? session.latestMessageText ?? "New chat",
          subtitle: session.lastMessageAt ? new Date(session.lastMessageAt).toISOString() : null,
          status: session.status ?? null,
        },
      }];
    }
    if (assignment.resourceType === "checkpoint") {
      const checkpoint = checkpointsById.get(assignment.resourceRef);
      if (!checkpoint) return [];
      return [{
        ...assignment,
        href: buildHref(spaceId, assignment.resourceType, assignment.resourceRef),
        resource: {
          title: checkpoint.description || checkpoint.commitHash.slice(0, 12),
          subtitle: checkpoint.createdAt ? new Date(checkpoint.createdAt).toISOString() : null,
          status: null,
        },
      }];
    }
    if (assignment.resourceType === "file") {
      return [{
        ...assignment,
        href: buildHref(spaceId, assignment.resourceType, assignment.resourceRef),
        resource: {
          title: assignment.resourceRef.split("/").pop() ?? assignment.resourceRef,
          subtitle: assignment.resourceRef,
          status: null,
        },
      }];
    }
    return [];
  });
}

router.get("/", async (c) => {
  const access = await requireSpacePermission(c, "space.label.view");
  if (access.error) return access.error;
  const rows = await getScopeLabels(access.spaceId);
  return c.json({ labels: buildLabelTree(rows) });
});

router.post("/", async (c) => {
  const access = await requireSpacePermission(c, "space.label.manage");
  if (access.error) return access.error;
  const body = await c.req.json<{ labelRef?: unknown }>().catch(() => null);
  try {
    const { labelIds } = await resolveOrCreateRefs(access.spaceId, [body?.labelRef], access.user?.uuid ?? null);
    const rows = labelIds.length > 0
      ? await db.select().from(labels).where(and(eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, access.spaceId), inArray(labels.id, labelIds)))
      : [];
    return c.json({ labels: rows }, 201);
  } catch (error) {
    if (isUniqueLabelNameViolation(error)) return c.json({ message: "label already exists" }, 409);
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
});

router.post("/resolve", async (c) => {
  const access = await requireSpacePermission(c, "space.label.manage");
  if (access.error) return access.error;
  const body = await c.req.json<{ labelRefs?: unknown }>().catch(() => null);
  try {
    const { labelIds } = await resolveOrCreateRefs(access.spaceId, body?.labelRefs, access.user?.uuid ?? null);
    const rows = labelIds.length > 0
      ? await db.select().from(labels).where(and(eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, access.spaceId), inArray(labels.id, labelIds)))
      : [];
    return c.json({ labels: rows });
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
});

router.patch("/by-ref", async (c) => {
  const access = await requireSpacePermission(c, "space.label.manage");
  if (access.error) return access.error;
  const body = await c.req.json<{ labelRef?: unknown; name?: string; parentRef?: string | null; rank?: number }>().catch(() => null);
  let label: typeof labels.$inferSelect | null;
  try {
    label = await getLabelByRef(access.spaceId, body?.labelRef);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
  if (!label) return c.json({ message: "label not found" }, 404);
  const patch: Partial<typeof labels.$inferInsert> = { updatedAt: new Date() };
  if (body?.name !== undefined) {
    const name = normalizeName(body.name);
    if (!name) return c.json({ message: "name is required" }, 400);
    patch.name = name;
    patch.slug = slugifyLabelName(name);
  }
  if (body?.rank !== undefined) {
    const rank = Number(body.rank);
    if (!Number.isSafeInteger(rank) || rank < -1_000_000 || rank > 1_000_000) return c.json({ message: "invalid rank" }, 400);
    patch.rank = rank;
  }
  if (body?.parentRef !== undefined) {
    let parentId: string | null = null;
    let depth = 0;
    if (body.parentRef !== null) {
      let parent: typeof labels.$inferSelect | null;
      try {
        parent = await getLabelByRef(access.spaceId, body.parentRef);
      } catch (error) {
        return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
      }
      if (parent?.depth !== 0 || parent.id === label.id) return c.json({ message: "parent label not found" }, 404);
      parentId = parent.id;
      depth = 1;
    }
    const [{ value: childCount } = { value: 0 }] = await db.select({ value: count() }).from(labels).where(eq(labels.parentId, label.id));
    if (depth === 1 && Number(childCount) > 0) return c.json({ message: "label has child labels" }, 400);
    patch.parentId = parentId;
    patch.depth = depth;
  }
  try {
    const [updated] = await db.update(labels).set(patch).where(and(eq(labels.id, label.id), eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, access.spaceId))).returning();
    return c.json({ label: updated });
  } catch (error) {
    if (isUniqueLabelNameViolation(error)) return c.json({ message: "label already exists" }, 409);
    throw error;
  }
});

router.delete("/by-ref", async (c) => {
  const access = await requireSpacePermission(c, "space.label.manage");
  if (access.error) return access.error;
  let label: typeof labels.$inferSelect | null;
  try {
    label = await getLabelByRef(access.spaceId, c.req.query("ref"));
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
  if (!label) return c.json({ message: "label not found" }, 404);
  const [{ value: childCount } = { value: 0 }] = await db.select({ value: count() }).from(labels).where(and(eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, access.spaceId), eq(labels.parentId, label.id)));
  if (Number(childCount) > 0) return c.json({ message: "delete child labels first" }, 400);
  await db.transaction(async (tx) => {
    await tx.delete(labelAssignments).where(and(eq(labelAssignments.scopeType, SCOPE_TYPE), eq(labelAssignments.scopeId, access.spaceId), eq(labelAssignments.labelId, label.id)));
    await tx.delete(labels).where(and(eq(labels.id, label.id), eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, access.spaceId)));
  });
  return c.json({ ok: true });
});

router.post("/reorder", async (c) => {
  const access = await requireSpacePermission(c, "space.label.manage");
  if (access.error) return access.error;
  const body = await c.req.json<{ labelRefs?: unknown }>().catch(() => null);
  let labelIds: string[];
  try {
    const paths = parseLabelRefs(body?.labelRefs);
    const resolved = await resolveLabelPaths({ db, spaceId: access.spaceId, paths });
    if (resolved.missingPaths.length > 0) return c.json({ message: "label not found" }, 404);
    labelIds = resolved.labelIds;
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
  await db.transaction(async (tx) => {
    for (const [index, labelId] of labelIds.entries()) {
      await tx.update(labels).set({ rank: (index + 1) * 10, updatedAt: new Date() }).where(and(eq(labels.id, labelId), eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, access.spaceId)));
    }
  });
  return c.json({ labels: buildLabelTree(await getScopeLabels(access.spaceId)) });
});

router.get("/items", async (c) => {
  const access = await requireSpacePermission(c, "space.label.view");
  if (access.error) return access.error;
  let label: typeof labels.$inferSelect | null;
  try {
    label = await getLabelByRef(access.spaceId, c.req.query("ref"));
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
  if (!label) return c.json({ message: "label not found" }, 404);
  const limit = parseItemsLimit(c.req.query("limit"));
  const decodedCursor = decodeItemsCursor(c.req.query("cursor"));
  if (!decodedCursor.ok) return c.json({ message: "invalid cursor" }, 400);
  const cursor = decodedCursor.cursor;
  const rows = await db
    .select()
    .from(labelAssignments)
    .where(and(
      eq(labelAssignments.scopeType, SCOPE_TYPE),
      eq(labelAssignments.scopeId, access.spaceId),
      eq(labelAssignments.labelId, label.id),
      ...(cursor ? [sql`(${labelAssignments.rank}, ${labelAssignments.createdAt}, ${labelAssignments.id}) < (${cursor.rank}, ${cursor.createdAt ?? new Date(0)}, ${cursor.id})`] : []),
    ))
    .orderBy(desc(labelAssignments.rank), desc(labelAssignments.createdAt), desc(labelAssignments.id))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const lastRow = pageRows.at(-1);
  const nextCursor = rows.length > limit && lastRow ? encodeItemsCursor(lastRow) : null;
  return c.json({ items: await hydrateAssignments(access.spaceId, pageRows), pageInfo: { hasMore: Boolean(nextCursor), nextCursor } });
});

router.post("/attach", async (c) => {
  const access = await requireSpacePermission(c, "space.label.assign");
  if (access.error) return access.error;
  const body = await c.req.json<{ labelRef?: unknown; resourceType?: string; resourceRef?: string }>().catch(() => null);
  const resourceType = body?.resourceType ?? "";
  const resourceRef = body?.resourceRef?.trim() ?? "";
  if (!resourceRef || !(await validateResource(access.spaceId, resourceType, resourceRef))) return c.json({ message: "resource not found" }, 404);
  let labelIds: string[];
  try {
    const resolved = await resolveRefsWithCreatePermission(c, access, [body?.labelRef]);
    if ("error" in resolved) return resolved.error;
    labelIds = resolved.labelIds;
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
  const labelId = labelIds[0];
  if (!labelId) return c.json({ message: "label not found" }, 404);
  const label = await getLabelInSpace(access.spaceId, labelId);
  if (label?.source !== "user") return authzDenied(c);
  const [{ value: maxRank } = { value: 0 }] = await db.select({ value: max(labelAssignments.rank) }).from(labelAssignments).where(eq(labelAssignments.labelId, labelId));
  const [assignment] = await db.insert(labelAssignments).values({
    labelId,
    scopeType: SCOPE_TYPE,
    scopeId: access.spaceId,
    resourceType,
    resourceRef,
    rank: Number(maxRank ?? 0) + 10,
    source: "user",
    createdBy: access.user?.uuid ?? null,
  }).onConflictDoNothing().returning();
  if (assignment) {
    await dispatchLabelAssignmentsUpdated({
      spaceId: access.spaceId,
      resourceType: resourceType as "session" | "checkpoint" | "file",
      resourceRef,
      sessionId: resourceType === "session" ? resourceRef : null,
      affectedLabelIds: [labelId],
    }).catch(() => undefined);
    return c.json({ assignment }, 201);
  }
  const [existing] = await db.select().from(labelAssignments).where(and(eq(labelAssignments.labelId, labelId), eq(labelAssignments.resourceType, resourceType), eq(labelAssignments.resourceRef, resourceRef))).limit(1);
  if (existing) {
    await dispatchLabelAssignmentsUpdated({
      spaceId: access.spaceId,
      resourceType: resourceType as "session" | "checkpoint" | "file",
      resourceRef,
      sessionId: resourceType === "session" ? resourceRef : null,
      affectedLabelIds: [labelId],
    }).catch(() => undefined);
  }
  return c.json({ assignment: existing }, existing ? 200 : 409);
});

router.post("/detach", async (c) => {
  const access = await requireSpacePermission(c, "space.label.assign");
  if (access.error) return access.error;
  const body = await c.req.json<{ labelRef?: unknown; resourceType?: string; resourceRef?: string }>().catch(() => null);
  const resourceType = body?.resourceType ?? "";
  const resourceRef = body?.resourceRef?.trim() ?? "";
  if (!resourceRef || !RESOURCE_TYPES.has(resourceType)) return c.json({ message: "resource not found" }, 404);
  let label: typeof labels.$inferSelect | null;
  try {
    label = await getLabelByRef(access.spaceId, body?.labelRef);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
  if (!label) return c.json({ message: "label not found" }, 404);
  if (label.source !== "user") return authzDenied(c);
  await db.delete(labelAssignments).where(and(eq(labelAssignments.labelId, label.id), eq(labelAssignments.scopeType, SCOPE_TYPE), eq(labelAssignments.scopeId, access.spaceId), eq(labelAssignments.resourceType, resourceType), eq(labelAssignments.resourceRef, resourceRef)));
  await dispatchLabelAssignmentsUpdated({
    spaceId: access.spaceId,
    resourceType: resourceType as "session" | "checkpoint" | "file",
    resourceRef,
    sessionId: resourceType === "session" ? resourceRef : null,
    affectedLabelIds: [label.id],
  }).catch(() => undefined);
  return c.json({ ok: true });
});

export async function getResourceLabels(c: Context) {
  const access = await requireSpacePermission(c, "space.label.view");
  if (access.error) return access.error;
  const resourceType = c.req.param("resourceType") ?? "";
  const resourceRef = c.req.query("resourceRef")?.trim() ?? "";
  if (!resourceRef || !RESOURCE_TYPES.has(resourceType)) return c.json({ message: "resource not found" }, 404);
  if (resourceType === "file" && !isSafeFilePath(resourceRef)) return c.json({ message: "resource not found" }, 404);
  return c.json(await getResourceLabelResponse(access.spaceId, resourceType, resourceRef));
}

export async function patchResourceLabels(c: Context) {
  const access = await requireSpacePermission(c, "space.label.assign");
  if (access.error) return access.error;
  const resourceType = c.req.param("resourceType") ?? "";
  const resourceRef = c.req.query("resourceRef")?.trim() ?? "";
  if (!resourceRef || !(await validateResource(access.spaceId, resourceType, resourceRef))) return c.json({ message: "resource not found" }, 404);
  const body = await c.req.json<{ addLabelRefs?: unknown; removeLabelRefs?: unknown }>().catch(() => undefined);
  if (!body) return c.json({ message: "invalid json body" }, 400);

  let addLabelIds: string[];
  let removeLabelIds: string[];
  try {
    const addResolved = await resolveRefsWithCreatePermission(c, access, body?.addLabelRefs ?? []);
    if ("error" in addResolved) return addResolved.error;
    const removeResolved = await resolveExistingRefs(access.spaceId, body?.removeLabelRefs ?? []);
    const addUserLabels = await getUserLabelIds(c, access.spaceId, addResolved.labelIds);
    if ("error" in addUserLabels) return addUserLabels.error;
    const removeUserLabels = await getUserLabelIds(c, access.spaceId, removeResolved.labelIds);
    if ("error" in removeUserLabels) return removeUserLabels.error;
    addLabelIds = addUserLabels.labelIds;
    removeLabelIds = removeUserLabels.labelIds;
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }

  const existing = await db.select().from(labelAssignments).where(and(eq(labelAssignments.scopeType, SCOPE_TYPE), eq(labelAssignments.scopeId, access.spaceId), eq(labelAssignments.resourceType, resourceType), eq(labelAssignments.resourceRef, resourceRef))).orderBy(asc(labelAssignments.rank), asc(labelAssignments.createdAt), asc(labelAssignments.id));
  const removeSet = new Set(removeLabelIds);
  const nextUserLabelIds = existing
    .filter((assignment) => assignment.source === "user" && !removeSet.has(assignment.labelId))
    .map((assignment) => assignment.labelId);
  for (const labelId of addLabelIds) {
    if (!nextUserLabelIds.includes(labelId)) nextUserLabelIds.push(labelId);
  }
  const nextSet = new Set(nextUserLabelIds);
  const removeAssignmentIds = existing
    .filter((assignment) => assignment.source === "user" && removeSet.has(assignment.labelId) && !nextSet.has(assignment.labelId))
    .map((assignment) => assignment.id);
  const existingByLabelId = new Map(existing.map((assignment) => [assignment.labelId, assignment]));
  const changed = removeAssignmentIds.length > 0 || nextUserLabelIds.some((labelId, index) => {
    const existingAssignment = existingByLabelId.get(labelId);
    return !existingAssignment || existingAssignment.rank !== (index + 1) * 10;
  });

  await db.transaction(async (tx) => {
    if (removeAssignmentIds.length > 0) await tx.delete(labelAssignments).where(inArray(labelAssignments.id, removeAssignmentIds));
    for (const [index, labelId] of nextUserLabelIds.entries()) {
      const rank = (index + 1) * 10;
      const existingAssignment = existingByLabelId.get(labelId);
      if (existingAssignment) {
        if (existingAssignment.rank !== rank) await tx.update(labelAssignments).set({ rank, updatedAt: new Date() }).where(eq(labelAssignments.id, existingAssignment.id));
        continue;
      }
      await tx.insert(labelAssignments).values({
        labelId,
        scopeType: SCOPE_TYPE,
        scopeId: access.spaceId,
        resourceType,
        resourceRef,
        rank,
        source: "user",
        createdBy: access.user?.uuid ?? null,
      }).onConflictDoNothing();
    }
  });

  const affectedLabelIds = Array.from(new Set([...addLabelIds, ...removeLabelIds]));
  const result = await getResourceLabelResponse(access.spaceId, resourceType, resourceRef);
  await dispatchLabelAssignmentsUpdated({
    spaceId: access.spaceId,
    resourceType: resourceType as "session" | "checkpoint" | "file",
    resourceRef,
    sessionId: resourceType === "session" ? resourceRef : null,
    affectedLabelIds,
  }).catch(() => undefined);
  return c.json({ ...result, changed });
}

export async function setResourceLabels(c: Context) {
  const access = await requireSpacePermission(c, "space.label.assign");
  if (access.error) return access.error;
  const resourceType = c.req.param("resourceType") ?? "";
  const resourceRef = c.req.query("resourceRef")?.trim() ?? "";
  if (!resourceRef || !(await validateResource(access.spaceId, resourceType, resourceRef))) return c.json({ message: "resource not found" }, 404);
  const body = await c.req.json<{ labelRefs?: unknown }>().catch(() => undefined);
  if (!body) return c.json({ message: "invalid json body" }, 400);
  let labelIds: string[];
  try {
    const resolved = await resolveRefsWithCreatePermission(c, access, body?.labelRefs ?? []);
    if ("error" in resolved) return resolved.error;
    labelIds = resolved.labelIds;
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
  const resolvedLabels = labelIds.length > 0
    ? await db.select().from(labels).where(and(eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, access.spaceId), inArray(labels.id, labelIds)))
    : [];
  const userLabelIds = resolvedLabels.filter((label) => label.source === "user").map((label) => label.id);
  const existing = await db.select().from(labelAssignments).where(and(eq(labelAssignments.scopeType, SCOPE_TYPE), eq(labelAssignments.scopeId, access.spaceId), eq(labelAssignments.resourceType, resourceType), eq(labelAssignments.resourceRef, resourceRef)));
  const preservedSystemLabelIds = existing.filter((assignment) => assignment.source === "system").map((assignment) => assignment.labelId);
  const wanted = new Set([...userLabelIds, ...preservedSystemLabelIds]);
  const existingIds = new Set(existing.map((assignment) => assignment.labelId));
  const affectedLabelIds = Array.from(new Set([...existingIds, ...userLabelIds]));
  const removeIds = existing.filter((assignment) => assignment.source !== "system" && !wanted.has(assignment.labelId)).map((assignment) => assignment.id);
  const existingByLabelId = new Map(existing.map((assignment) => [assignment.labelId, assignment]));
  const addIds = userLabelIds.filter((labelId) => !existingIds.has(labelId));
  await db.transaction(async (tx) => {
    if (removeIds.length > 0) await tx.delete(labelAssignments).where(inArray(labelAssignments.id, removeIds));
    for (const [index, labelId] of userLabelIds.entries()) {
      const rank = (index + 1) * 10;
      const existingAssignment = existingByLabelId.get(labelId);
      if (existingAssignment) {
        if (existingAssignment.rank !== rank) {
          await tx.update(labelAssignments).set({ rank, updatedAt: new Date() }).where(eq(labelAssignments.id, existingAssignment.id));
        }
        continue;
      }
      if (!addIds.includes(labelId)) continue;
      await tx.insert(labelAssignments).values({
        labelId,
        scopeType: SCOPE_TYPE,
        scopeId: access.spaceId,
        resourceType,
        resourceRef,
        rank,
        source: "user",
        createdBy: access.user?.uuid ?? null,
      }).onConflictDoNothing();
    }
  });
  const result = await getResourceLabelResponse(access.spaceId, resourceType, resourceRef);
  await dispatchLabelAssignmentsUpdated({
    spaceId: access.spaceId,
    resourceType: resourceType as "session" | "checkpoint" | "file",
    resourceRef,
    sessionId: resourceType === "session" ? resourceRef : null,
    affectedLabelIds,
  }).catch(() => undefined);
  return c.json(result);
}

export default router;
