import { COHUB_TASKS_QUEUE, createBullmqQueue } from "@cohub/infra/bullmq";
import { enqueueTaskRun, type TaskEnqueueOptions } from "@cohub/core/tasks";
import type { TaskPayload } from "@cohub/protocol/task";
import { createLogger } from "@cohub/infra/logging";
import { config } from "../config.js";
import { db } from "../db.js";
import { dispatchTaskCreated } from "../realtime-events.js";
import { resolveStoredPrincipalIdentityForWorker } from "../identity-bridge.js";

const logger = createLogger({ serviceName: "cohub-worker" });

const taskQueue = createBullmqQueue(COHUB_TASKS_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-worker",
});

export const enqueueTask = async (payload: TaskPayload, options?: TaskEnqueueOptions) => {
  const identity = payload.userId
    ? await resolveStoredPrincipalIdentityForWorker(payload.userId)
    : null;
  const canonicalPayload = identity ? { ...payload, userId: identity.uuid } : payload;
  return enqueueTaskRun({
    db,
    payload: canonicalPayload,
    options,
    enqueue: (name, taskPayload, jobOptions) => taskQueue.add(name, taskPayload, jobOptions),
    onTaskCreated: (taskRun) => dispatchTaskCreated(taskRun).catch((error) => {
      logger.warn("[Realtime] failed to dispatch task.created", error);
    }),
  });
};
