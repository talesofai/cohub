import { COHUB_WORKSPACE_SYNC_QUEUE, createBullmqQueue, defaultCriticalJobOptions } from "@cohub/infra/bullmq";
import type { JobsOptions } from "bullmq";
import type { WorkspaceSyncJobData } from "@cohub/protocol";
import { config } from "./config.js";

export const WORKSPACE_SYNC_JOB_NAME = "workspace_sync" as const;

export const workspaceSyncQueue = createBullmqQueue<WorkspaceSyncJobData>(COHUB_WORKSPACE_SYNC_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-api-workspace-sync",
});

export function enqueueWorkspaceSyncJob(data: WorkspaceSyncJobData, options: JobsOptions = {}) {
  return workspaceSyncQueue.add(WORKSPACE_SYNC_JOB_NAME, data, {
    jobId: `workspace-sync-${data.cycleId}`,
    ...defaultCriticalJobOptions,
    ...options,
  });
}
