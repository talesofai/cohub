import { COHUB_TASKS_QUEUE, createBullmqQueue, retryFailedQueueJob } from "@cohub/infra/bullmq";
import { enqueueTaskRun, type TaskEnqueueOptions } from "@cohub/core/tasks";
import type { TaskPayload } from "@cohub/protocol/task";
import { createLogger } from "@cohub/infra/logging";
import { config } from "../config.js";
import { db } from "../db.js";
import { dispatchTaskCreated } from "../realtime-events.js";

const logger = createLogger({ serviceName: "cohub-worker" });

const taskQueue = createBullmqQueue(COHUB_TASKS_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-worker",
});

export const enqueueTask = (payload: TaskPayload, options?: TaskEnqueueOptions) => enqueueTaskRun({
  db,
  payload,
  options,
  enqueue: (name, taskPayload, jobOptions) => taskQueue.add(name, taskPayload, jobOptions),
  recoverFailedQueueJob: (jobId) => retryFailedQueueJob(taskQueue, jobId),
  onTaskCreated: (taskRun) => dispatchTaskCreated(taskRun).catch((error) => {
    logger.warn("[Realtime] failed to dispatch task.created", error);
  }),
});
