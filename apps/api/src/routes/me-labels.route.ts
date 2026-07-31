import { Hono } from "hono";
import { db } from "../db/index.js";
import { useAccountAuth, requireValidId } from "../lib/middleware.js";
import {
  getUserResourceLabelAssignments,
  patchUserResourceLabels,
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
  const user = useAccountAuth(c);
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
  const user = useAccountAuth(c);
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
