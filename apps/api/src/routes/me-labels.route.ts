import { Hono, type Context } from "hono";
import { db } from "../db/index.js";
import { useAuth, requireValidId } from "../lib/middleware.js";
import {
  createUserLabel,
  deleteUserLabel,
  getUserResourceLabelAssignments,
  listUserLabels,
  listUserSpaceGroups,
  patchUserResourceLabels,
  UserLabelError,
} from "@cohub/core/labels";
import type { LabelResourceType } from "@cohub/core/labels";
import { hasPermission } from "../permissions.js";
import { getRealtimeUserRoom } from "@cohub/protocol/realtime";
import { dispatchRealtimeEvent } from "../channels.js";

const router = new Hono();

const RESOURCE_TYPES = new Set<LabelResourceType>(["session", "checkpoint", "file", "space"]);
const MAX_LABEL_REFS = 20;

function parseResourceType(value: string): LabelResourceType | null {
  return RESOURCE_TYPES.has(value as LabelResourceType) ? value as LabelResourceType : null;
}

function userLabelHttpError(c: Context, error: unknown) {
  if (error instanceof UserLabelError) {
    if (error.kind === "not_found") return c.json({ message: error.message }, 404);
    return c.json({ message: error.message }, 409);
  }
  return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
}

function parseLabelRefs(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_LABEL_REFS) return null;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

/**
 * GET /api/me/resources/:resourceType/labels?resourceRef=...
 * Get user-scope label assignments for a resource.
 *
 * Like other /api/me endpoints, access is gated by authentication only —
 * user-scope labels are private viewer data. The resource itself is not
 * re-authorized here; a stale assignment to a space the viewer lost access
 * to is harmless (it just won't appear in the space list).
 */
router.get("/resources/:resourceType/labels", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const resourceType = parseResourceType(c.req.param("resourceType") ?? "");
  const resourceRef = c.req.query("resourceRef")?.trim() ?? "";
  if (!resourceType || !resourceRef) return c.json({ message: "resource not found" }, 404);
  const assignments = await getUserResourceLabelAssignments(db, user.uuid, resourceType, resourceRef);
  return c.json({ assignments });
});

/**
 * PATCH /api/me/resources/:resourceType/labels?resourceRef=...
 * Add/remove user-scope labels for a resource.
 * Body: { addLabelRefs?: string[], removeLabelRefs?: string[] }
 *
 * Write operations require the viewer to have access to the target resource
 * (space.view for spaces), preventing pins on private spaces the viewer
 * cannot see.
 */
router.patch("/resources/:resourceType/labels", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const resourceType = parseResourceType(c.req.param("resourceType") ?? "");
  const resourceRef = c.req.query("resourceRef")?.trim() ?? "";
  if (!resourceType || !resourceRef) return c.json({ message: "resource not found" }, 404);
  if (resourceType === "space") {
    if (!requireValidId(resourceRef) || !(await hasPermission(user, "space.view", { spaceId: resourceRef }))) {
      return c.json({ message: "forbidden" }, 403);
    }
  }
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ message: "invalid json body" }, 400);
  const addLabelRefs = parseLabelRefs((body as { addLabelRefs?: unknown }).addLabelRefs);
  const removeLabelRefs = parseLabelRefs((body as { removeLabelRefs?: unknown }).removeLabelRefs);
  if (addLabelRefs === null || removeLabelRefs === null) return c.json({ message: "addLabelRefs and removeLabelRefs must be arrays of strings" }, 400);
  if (addLabelRefs.length === 0 && removeLabelRefs.length === 0) return c.json({ message: "addLabelRefs or removeLabelRefs is required" }, 400);
  const assignments = await db.transaction((tx) =>
    patchUserResourceLabels(tx, user.uuid, resourceType, resourceRef, {
      addLabelRefs,
      removeLabelRefs,
    }),
  );
  await dispatchUserLabelAssignmentsUpdated(user.uuid, resourceType, resourceRef, assignments.map((a) => a.labelId));
  return c.json({ assignments });
});

/**
 * GET /api/me/labels
 * List the viewer's private user-scope labels, including the built-in Pinned label when present.
 * Auth-only: this is private viewer data, never another user's labels.
 */
router.get("/labels", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const labels = await listUserLabels(db, user.uuid);
  return c.json({ labels });
});

/**
 * POST /api/me/labels
 * Create a custom user-scope label (empty group). Body: { name }
 * Refuses reserved Pinned; idempotent if the name already exists.
 */
router.post("/labels", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ message: "invalid json body" }, 400);
  const name = (body as { name?: unknown }).name;
  if (typeof name !== "string") return c.json({ message: "name is required" }, 400);
  try {
    const label = await db.transaction((tx) => createUserLabel(tx, user.uuid, name));
    await dispatchUserLabelAssignmentsUpdated(user.uuid, "space", "", [label.id]);
    return c.json({ label }, 201);
  } catch (error) {
    return userLabelHttpError(c, error);
  }
});

/**
 * DELETE /api/me/labels?name=
 * Delete a custom user-scope label and its assignments. Refuses Pinned.
 */
router.delete("/labels", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const name = c.req.query("name")?.trim() ?? "";
  if (!name) return c.json({ message: "name is required" }, 400);
  try {
    const label = await db.transaction((tx) => deleteUserLabel(tx, user.uuid, name));
    await dispatchUserLabelAssignmentsUpdated(user.uuid, "space", "", [label.id]);
    return c.json({ ok: true });
  } catch (error) {
    return userLabelHttpError(c, error);
  }
});

/**
 * GET /api/me/space-groups
 * Snapshot of the viewer's user labels with ordered space assignment ids.
 * Includes Pinned when it exists; Mine UI hides systemKey === 'user:pinned'.
 */
router.get("/space-groups", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const groups = await listUserSpaceGroups(db, user.uuid);
  return c.json({ groups });
});

/**
 * Dispatch `label.assignments.updated` to the user's realtime room.
 * Reuses the existing event type so the web client can handle it uniformly.
 */
async function dispatchUserLabelAssignmentsUpdated(
  userUuid: string,
  resourceType: LabelResourceType,
  resourceRef: string,
  affectedLabelIds: string[],
) {
  const assignments = await getUserResourceLabelAssignments(db, userUuid, resourceType, resourceRef);
  await dispatchRealtimeEvent({
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    domain: "label",
    type: "label.assignments.updated",
    spaceId: null,
    sessionId: null,
    rooms: [getRealtimeUserRoom(userUuid)],
    payload: {
      resourceType,
      resourceRef,
      labels: [],
      assignments,
      items: [],
      affectedLabelIds,
    },
  }).catch(() => undefined);
}

export default router;
