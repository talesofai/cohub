import { QueueEvents } from "bullmq";
import { COHUB_SYSTEM_QUEUE, createBullmqConnectionOptions, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import { getCurrentRequestId } from "@cohub/infra/tracing";
import { injectTrace } from "@cohub/infra/tracing/propagator";
import { config } from "./config.js";

export const WORK_PUBLISH_ASSET_JOB = "work.publish_asset";

export type WorkPublishAssetJobData = {
  spaceId: string;
  slug: string;
  assetKey: string;
  targetType: "file" | "directory";
  targetRef: string;
  requestId?: string | null;
  trace?: Record<string, unknown>;
};

export type WorkPublishAssetJobResult = {
  ok: true;
  assetKey: string;
  sizeBytes: number;
  fileCount?: number;
} | {
  ok: false;
  status: number;
  message: string;
  code?: string;
  cleanupAssetKey?: string;
};

const workPublishAssetQueue = createBullmqQueue<WorkPublishAssetJobData, WorkPublishAssetJobResult>(COHUB_SYSTEM_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-api-work-publish-asset",
});

const workPublishAssetQueueEvents = new QueueEvents(COHUB_SYSTEM_QUEUE, {
  connection: createBullmqConnectionOptions(config.bullmqRedisUrl),
});

export async function publishWorkAssetInWorker(
  input: Omit<WorkPublishAssetJobData, "requestId" | "trace">,
  options: { jobId: string },
) {
  const job = await workPublishAssetQueue.add(WORK_PUBLISH_ASSET_JOB, {
    ...input,
    requestId: getCurrentRequestId() ?? null,
    trace: injectTrace(),
  }, {
    jobId: options.jobId,
    attempts: 1,
    ...defaultJobRetention,
  });

  return job.waitUntilFinished(workPublishAssetQueueEvents, 15 * 60 * 1000) as Promise<WorkPublishAssetJobResult>;
}
