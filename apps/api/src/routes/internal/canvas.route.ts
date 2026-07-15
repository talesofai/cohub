import { Hono } from "hono";
import { applyCanvasTransaction, type CanvasSemanticOp } from "../../canvas-service.js";
import { ensureInternalRequest, requireValidId, type AuthUser } from "../../lib/middleware.js";
import { hasPermission } from "../../permissions.js";

const router = new Hono();

router.post("/:spaceId/:documentId/tx", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;
  const spaceId = c.req.param("spaceId");
  const documentId = c.req.param("documentId");
  if (!requireValidId(spaceId) || !requireValidId(documentId)) return c.json({ message: "canvas not found" }, 404);
  const body = await c.req.json<{
    actorId?: string;
    txId?: string;
    baseVersion?: number;
    clientId?: string | null;
    undoGroupId?: string | null;
    ops?: CanvasSemanticOp[];
  }>().catch(() => null);
  if (!body?.actorId || !body.txId || typeof body.baseVersion !== "number" || !Number.isInteger(body.baseVersion) || !Array.isArray(body.ops)) return c.json({ message: "invalid canvas transaction" }, 400);
  try {
    const actor = { uuid: body.actorId } as AuthUser;
    if (!(await hasPermission(actor, "file.edit", { spaceId }))) return c.json({ message: "forbidden" }, 403);
    const result = await applyCanvasTransaction({
      spaceId,
      documentId,
      actorId: body.actorId,
      txId: body.txId,
      baseVersion: body.baseVersion,
      clientId: body.clientId ?? null,
      undoGroupId: body.undoGroupId ?? null,
      ops: body.ops,
    });
    return c.json(result);
  } catch (error) {
    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
    const message = error instanceof Error ? error.message : "Canvas operation failed";
    const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "canvas_error";
    const currentVersion = typeof (error as { currentVersion?: unknown })?.currentVersion === "number"
      ? (error as { currentVersion: number }).currentVersion
      : undefined;
    return c.json({ message, code, currentVersion }, status as never);
  }
});

export default router;
