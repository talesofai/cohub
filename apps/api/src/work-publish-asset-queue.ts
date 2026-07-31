import { QueueEvents } from "bullmq";
import { COHUB_SYSTEM_QUEUE, createBullmqConnectionOptions, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import { getCurrentRequestId } from "@cohub/infra/tracing";
import { injectTrace } from "@cohub/infra/tracing/propagator";
import { config } from "./config.js";

import type { WorkPublishExtractedPageMeta } from "@cohub/core/works";
import type { WorkArtifactDescriptor } from "@cohub/protocol";

export const WORK_PUBLISH_ASSET_JOB = "work.publish_asset";

export type WorkPublishAssetJobData = {
  spaceId: string;
  slug: string;
  targetType: "file" | "directory";
  targetRef: string;
  requestId?: string | null;
  trace?: Record<string, unknown>;
};

export type { WorkPublishExtractedPageMeta };

export type WorkPublishAssetJobResult = {
  ok: true;
  assetKey: string;
  sizeBytes: number;
  fileCount?: number;
  extracted?: WorkPublishExtractedPageMeta | null;
  /**
   * Absent from workers predating content-kind publishing. The API derives a
   * `web` descriptor in that case, so a rolling deploy in either order keeps
   * publishing rather than failing on a missing field.
   */
  artifact?: WorkArtifactDescriptor;
} | {
  ok: false;
  status: number;
  message: string;
  code?: string;
};

const workPublishAssetQueue = createBullmqQueue<WorkPublishAssetJobData, WorkPublishAssetJobResult>(COHUB_SYSTEM_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-api-work-publish-asset",
});

const workPublishAssetQueueEvents = new QueueEvents(COHUB_SYSTEM_QUEUE, {
  connection: createBullmqConnectionOptions(config.bullmqRedisUrl),
});

export async function publishWorkAssetInWorker(input: Omit<WorkPublishAssetJobData, "requestId" | "trace">) {
  const job = await workPublishAssetQueue.add(WORK_PUBLISH_ASSET_JOB, {
    ...input,
    requestId: getCurrentRequestId() ?? null,
    trace: injectTrace(),
  }, {
    jobId: `work-publish-asset-${input.spaceId}-${input.slug}-${Date.now()}`,
    attempts: 1,
    ...defaultJobRetention,
  });

  return job.waitUntilFinished(workPublishAssetQueueEvents, 30 * 60 * 1000) as Promise<WorkPublishAssetJobResult>;
}
