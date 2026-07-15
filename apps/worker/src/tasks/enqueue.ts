import { COHUB_TASKS_QUEUE, createBullmqQueue } from "@cohub/infra/bullmq";
import { and, eq } from "drizzle-orm";
import { taskRuns } from "@cohub/db";
import { enqueueTaskRun, type TaskEnqueueOptions } from "@cohub/core/tasks";
import type { TaskPayload } from "@cohub/protocol/task";
import { config } from "../config.js";
import { db } from "../db.js";

const taskQueue = createBullmqQueue(COHUB_TASKS_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-worker",
});

export const enqueueTask = (payload: TaskPayload, options?: TaskEnqueueOptions) => enqueueTaskRun({
  db,
  payload,
  options,
  enqueue: (name, taskPayload, jobOptions) => taskQueue.add(name, taskPayload, jobOptions),
});

export async function retryFailedTask(taskRunId: string) {
  const job = await taskQueue.getJob(taskRunId);
  if (!job) throw new Error(`failed TaskRun ${taskRunId} has no BullMQ job`);
  if (await job.getState() !== "failed") throw new Error(`TaskRun ${taskRunId} BullMQ job is not failed`);
  await job.retry("failed");
  await db.update(taskRuns).set({
    status: "pending",
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date(),
  }).where(and(eq(taskRuns.id, taskRunId), eq(taskRuns.status, "failed")));
}
