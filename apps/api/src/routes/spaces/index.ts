import { Hono } from "hono";
import spacesRouter from "./spaces.route.js";
import fsRouter from "./fs.route.js";
import membersRouter from "./members.route.js";
import accessRouter from "./access.route.js";
import usageRouter from "./usage.route.js";
import invitationsRouter from "./invitations.route.js";
import labelsRouter, { getResourceLabels, patchResourceLabels, setResourceLabels } from "./labels.route.js";
import modsRouter from "./mods.route.js";
import canvasRouter from "./canvas.route.js";
import presenceRouter from "./presence.route.js";
import previewSessionRouter from "./preview-session.route.js";
import commerceRouter from "./commerce.route.js";
import completionsRouter from "./completions.route.js";
import isolatedWorkersRouter from "./isolated-workers.route.js";
import { getOptionalAuth, requireValidId } from "../../lib/middleware.js";
import { hasPermission } from "../../permissions.js";
import {
  rejectIsolatedWorkerDisposableRouteMutation,
  type IsolatedWorkerDisposableOperation,
} from "../../isolated-worker-disposable-guard.js";

const router = new Hono();

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

router.use("*", async (c, next) => {
  if (READ_METHODS.has(c.req.method)) return next();
  const match = c.req.path.match(/\/api\/spaces\/([^/]+)(\/.*)?$/);
  const spaceId = match?.[1] ?? "";
  if (!requireValidId(spaceId)) return next();

  // Preserve each route's own authentication and authorization response. The
  // disposable classification must not become a space-existence oracle.
  const user = getOptionalAuth(c);
  if (!user || !(await hasPermission(user, "space.view", { spaceId }))) return next();

  const suffix = match?.[2] ?? "";
  let operation: IsolatedWorkerDisposableOperation = "generic_mutation";
  if (suffix === "/isolated-workers/dispatch") operation = "isolated_worker_dispatch";
  else if (suffix === "/isolated-workers/reuse-probe") operation = "isolated_worker_reuse_probe";
  else if (/\/sessions\/[^/]+\/turns\/[^/]+\/cancel$/.test(suffix)) operation = "isolated_worker_revoke";

  const rejected = await rejectIsolatedWorkerDisposableRouteMutation(c, { spaceId, operation });
  if (rejected) return rejected;
  return next();
});

router.route("/", spacesRouter);
// In production, /:id/fs/* is routed to fs-api by the gateway.
// This remains a local/non-split fallback.
router.route("/:id/fs", fsRouter);
router.route("/:id/completions", completionsRouter);
router.route("/:id/isolated-workers", isolatedWorkersRouter);
router.route("/:id/members", membersRouter);
router.route("/:id/access", accessRouter);
router.route("/:id/usage", usageRouter);
router.route("/:id/invitations", invitationsRouter);
router.route("/:id/labels", labelsRouter);
router.get("/:id/resources/:resourceType/labels", getResourceLabels);
router.patch("/:id/resources/:resourceType/labels", patchResourceLabels);
router.put("/:id/resources/:resourceType/labels", setResourceLabels);
router.route("/:id/mods", modsRouter);
router.route("/:id/canvas", canvasRouter);
router.route("/:id/presence", presenceRouter);
router.route("/", previewSessionRouter);
router.route("/", commerceRouter);

export default router;
