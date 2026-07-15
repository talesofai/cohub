import { eq } from "drizzle-orm";
import { taskRuns } from "@cohub/db";
import type { TaskPayload } from "@cohub/protocol/task";
import {
  ISOLATED_WORKER_RECEIPT_SCAN_TASK_TYPE,
  ISOLATED_WORKER_REVOKE_TASK_TYPE,
} from "@cohub/protocol/isolated-worker";
import { config } from "../config.js";
import { db } from "../db.js";
import { enqueueTask, retryFailedTask } from "./enqueue.js";
import {
  createIsolatedWorkerReceiptScanHandler,
  createIsolatedWorkerRevokeCompletionHook,
  createIsolatedWorkerRevokeHandler,
} from "./isolated-worker-termination-handler.js";
import { registerTask } from "./registry.js";

const revokeHandler = createIsolatedWorkerRevokeHandler({
  async revokeInternal(input) {
    const baseUrl = config.internalApiBaseUrl.replace(/\/+$/, "");
    const response = await fetch(
      `${baseUrl}/internal/spaces/${input.disposableSpaceId}/sessions/${input.sessionId}/turns/${input.turnId}/isolated-worker/revoke`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-worker-secret": config.workerSecret,
        },
        body: JSON.stringify(input.body),
      },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`isolated worker internal revoke failed ${response.status}: ${JSON.stringify(body)}`);
    }
    return body;
  },
});

const receiptScanHandler = createIsolatedWorkerReceiptScanHandler({
  async readRevokeTaskRun(revokeTaskRunId) {
    const [row] = await db.select({
      id: taskRuns.id,
      jobId: taskRuns.jobId,
      taskType: taskRuns.taskType,
      status: taskRuns.status,
      spaceId: taskRuns.spaceId,
      sessionId: taskRuns.sessionId,
      turnId: taskRuns.turnId,
      userUuid: taskRuns.userUuid,
      startedAt: taskRuns.startedAt,
      finishedAt: taskRuns.finishedAt,
      payload: taskRuns.payload,
      result: taskRuns.result,
    }).from(taskRuns).where(eq(taskRuns.id, revokeTaskRunId)).limit(1);
    return row ?? null;
  },
});

const afterRevokeCompleted = createIsolatedWorkerRevokeCompletionHook({
  async enqueueReceiptScan(input) {
    const [existing] = await db.select({ status: taskRuns.status }).from(taskRuns)
      .where(eq(taskRuns.id, input.taskRunId)).limit(1);
    if (existing?.status === "failed") {
      await retryFailedTask(input.taskRunId);
      return;
    }
    if (existing && ["pending", "running", "completed"].includes(existing.status)) return;
    await enqueueTask(input.payload, { taskRunId: input.taskRunId });
  },
});

registerTask(
  ISOLATED_WORKER_REVOKE_TASK_TYPE,
  async (job, context) => {
    if (!context?.taskRunId) throw new Error("isolated worker revoke TaskRun id is required");
    return revokeHandler({ taskRunId: context.taskRunId, payload: job.data as TaskPayload });
  },
  { afterCompleted: afterRevokeCompleted },
);

registerTask(ISOLATED_WORKER_RECEIPT_SCAN_TASK_TYPE, async (job, context) => {
  if (!context?.taskRunId || !context.startedAt) {
    throw new Error("isolated worker receipt scan TaskRun context is required");
  }
  return receiptScanHandler({
    taskRunId: context.taskRunId,
    startedAt: context.startedAt,
    payload: job.data as TaskPayload,
  });
});
