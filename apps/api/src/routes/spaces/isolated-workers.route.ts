import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import {
  checkpoints,
  spaceSandboxes,
  spaceSessions,
  spaces,
  taskRuns,
} from "@cohub/db";
import type {
  IsolatedWorkerDispatchInput,
  IsolatedWorkerReuseProbeInput,
} from "@cohub/protocol/isolated-worker";
import { db } from "../../db/index.js";
import { authzDenied, requireValidId, useAuth } from "../../lib/middleware.js";
import { hasPermission } from "../../permissions.js";
import { taskQueue } from "../../tasks.js";
import {
  createIsolatedWorkerDispatch,
  createIsolatedWorkerReuseProbe,
  parseIsolatedWorkerDispatchInput,
  type IsolatedWorkerDispatchStore,
} from "../../isolated-worker-dispatch.js";

const router = new Hono();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const store: IsolatedWorkerDispatchStore = {
  async validateInputManifest(input) {
    const [checkpoint] = await db.select().from(checkpoints).where(and(
      eq(checkpoints.id, input.inputBundle.authorityCheckpointId),
      eq(checkpoints.spaceId, input.authoritySpaceId),
    )).limit(1);
    if (!checkpoint || checkpoint.commitHash !== input.inputBundle.authorityCheckpointCommit) {
      throw new Error("input manifest authority checkpoint binding mismatch");
    }
    const meta = isRecord(checkpoint.meta) ? checkpoint.meta : null;
    const gitTree = meta && isRecord(meta.gitTree) ? meta.gitTree : null;
    if (
      gitTree?.sha256 !== input.inputBundle.authorityTreeSha256
    ) {
      throw new Error("input manifest authority checkpoint tree binding mismatch");
    }
  },
  async reserveTask(input) {
    await db.insert(taskRuns).values({
      id: input.taskRunId,
      jobId: input.taskRunId,
      taskType: input.payload.type,
      spaceId: input.payload.spaceId ?? null,
      sessionId: input.payload.sessionId ?? null,
      userUuid: input.payload.userId ?? null,
      status: "pending",
      payload: input.payload,
    });
  },

  async enqueue(input) {
    await taskQueue.add(input.payload.type, input.payload, { jobId: input.taskRunId, attempts: 1 });
  },

  async markEnqueueFailed(input) {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    await db.update(taskRuns).set({
        status: "failed",
        result: { disposableSpaceId: input.disposableSpaceId, rejected: true, reason: "dispatch_enqueue_failed", podCreated: false, disposableSpaceCreated: false, authorityExecutionTokenIssued: false },
        errorMessage: message,
        finishedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(taskRuns.id, input.taskRunId));
  },

  async assertReusableProbeTarget(input) {
    const [row] = await db
      .select({ space: spaces, sandbox: spaceSandboxes })
      .from(spaces)
      .leftJoin(spaceSandboxes, eq(spaceSandboxes.spaceId, spaces.id))
      .where(and(eq(spaces.id, input.disposableSpaceId), eq(spaces.userUuid, input.userId)))
      .limit(1);
    const disposable = isRecord(row?.space.meta) && isRecord(row.space.meta.isolatedWorkerDisposable)
      ? row.space.meta.isolatedWorkerDisposable
      : null;
    if (!row?.sandbox || !disposable || disposable.authoritySpaceId !== input.authoritySpaceId) {
      throw new Error("disposable worker space not found for authority");
    }
    return { status: row.sandbox.status, authoritySpaceId: String(disposable.authoritySpaceId) };
  },

  async reserveReuseProbe(input) {
    await db.insert(taskRuns).values({
      id: input.taskRunId,
      jobId: input.taskRunId,
      taskType: input.payload.type,
      spaceId: input.payload.spaceId ?? null,
      sessionId: input.payload.sessionId ?? null,
      userUuid: input.payload.userId ?? null,
      status: "pending",
      payload: input.payload,
    });
  },
};

router.post("/dispatch", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const authoritySpaceId = c.req.param("id") ?? "";
  if (!requireValidId(authoritySpaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "session.prompt.fullaccess", { spaceId: authoritySpaceId }))) return authzDenied(c);
  const [authority] = await db.select({ id: spaces.id }).from(spaces)
    .where(and(eq(spaces.id, authoritySpaceId), eq(spaces.userUuid, user.uuid))).limit(1);
  if (!authority) return c.json({ message: "space not found" }, 404);
  const rawBody = await c.req.json<unknown>().catch(() => null);
  let body: IsolatedWorkerDispatchInput;
  try {
    body = parseIsolatedWorkerDispatchInput(rawBody);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }
  if (body.repairOfDisposableSpaceId && !requireValidId(body.repairOfDisposableSpaceId)) {
    return c.json({ message: "invalid repairOfDisposableSpaceId" }, 400);
  }
  try {
    const result = await createIsolatedWorkerDispatch({ authoritySpaceId, userId: user.uuid, input: body, store });
    return c.json(result, 202);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("repair target") || message.includes("disposable worker space not found")) {
      return c.json({ message }, 409);
    }
    throw error;
  }
});

router.post("/reuse-probe", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const authoritySpaceId = c.req.param("id") ?? "";
  if (!requireValidId(authoritySpaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "session.prompt.fullaccess", { spaceId: authoritySpaceId }))) return authzDenied(c);
  const body = await c.req.json<IsolatedWorkerReuseProbeInput>().catch(() => null);
  if (!body || !requireValidId(body.disposableSpaceId) || !requireValidId(body.sessionId)) {
    return c.json({ message: "valid disposableSpaceId and sessionId are required" }, 400);
  }
  const [session] = await db.select({ id: spaceSessions.id }).from(spaceSessions)
    .where(and(eq(spaceSessions.id, body.sessionId), eq(spaceSessions.spaceId, authoritySpaceId))).limit(1);
  if (!session) return c.json({ message: "session not found" }, 404);
  try {
    const result = await createIsolatedWorkerReuseProbe({
      authoritySpaceId,
      disposableSpaceId: body.disposableSpaceId,
      sessionId: body.sessionId,
      userId: user.uuid,
      store,
    });
    return c.json(result, 202);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 409);
  }
});

export default router;
