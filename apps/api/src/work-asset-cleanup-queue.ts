import { COHUB_SYSTEM_QUEUE, createBullmqQueue } from "@cohub/infra/bullmq";
import { getCurrentRequestId } from "@cohub/infra/tracing";
import { injectTrace } from "@cohub/infra/tracing/propagator";
import { config } from "./config.js";
import type { WorkAssetKeyScope } from "./routes/work-delete.js";
import { createWorkAssetCleanupJobId } from "./work-asset-cleanup-job.js";

export const WORK_ASSET_CLEANUP_JOB = "work.cleanup_asset";

export type WorkAssetCleanupJobData = {
  assetKeys: string[];
  scope: WorkAssetKeyScope;
  reason: string;
  publishJobId?: string;
  deferWhileReferenced?: boolean;
  requestId?: string | null;
  trace?: Record<string, unknown>;
};

const queue = createBullmqQueue<WorkAssetCleanupJobData>(COHUB_SYSTEM_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-api-work-asset-cleanup",
});

export async function enqueueWorkAssetCleanup(
  input: Omit<WorkAssetCleanupJobData, "requestId" | "trace">,
  options?: { delayMs?: number },
) {
  return queue.add(
    WORK_ASSET_CLEANUP_JOB,
    {
      ...input,
      requestId: getCurrentRequestId() ?? null,
      trace: injectTrace(),
    },
    {
      jobId: createWorkAssetCleanupJobId(input.assetKeys),
      attempts: 12,
      backoff: { type: "exponential", delay: 30_000 },
      ...(options?.delayMs !== undefined ? { delay: options.delayMs } : {}),
      removeOnComplete: { age: 7 * 24 * 3600, count: 1_000 },
      removeOnFail: { age: 30 * 24 * 3600, count: 10_000 },
    },
  );
}
