import type { Job } from "bullmq";
import { COHUB_SYSTEM_QUEUE, createBullmqQueue } from "@cohub/infra/bullmq";
import { config } from "../../../config.js";
import { registerSystemJob } from "../../registry.js";
import { isWorkAssetPublishJobTerminal } from "./job-state.js";
import { WORK_ASSET_CLEANUP_JOB, type WorkAssetCleanupJobData } from "./types.js";

const systemQueue = createBullmqQueue(COHUB_SYSTEM_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-worker-work-asset-cleanup-state",
});

async function ensurePublishJobTerminal(publishJobId: string | undefined) {
  if (!publishJobId) return;
  const publishJob = await systemQueue.getJob(publishJobId);
  if (!publishJob) return;
  if (publishJob.name !== "work.publish_asset") {
    throw new Error(`work asset cleanup referenced unexpected job ${publishJobId}`);
  }
  const state = await publishJob.getState();
  if (!isWorkAssetPublishJobTerminal(state)) {
    throw new Error(`work asset publish job ${publishJobId} is not terminal: ${state}`);
  }
}

async function processWorkAssetCleanup(job: Job<WorkAssetCleanupJobData>) {
  await ensurePublishJobTerminal(job.data.publishJobId);
  if (job.data.publishJobId && !job.id) throw new Error("work asset cleanup job id is missing");
  const response = await fetch(`${config.internalApiBaseUrl}/internal/works/cleanup-assets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Worker-Secret": config.workerSecret,
    },
    body: JSON.stringify({
      assetKeys: job.data.assetKeys,
      scope: job.data.scope,
      publishJobId: job.data.publishJobId,
      deferWhileReferenced: job.data.deferWhileReferenced,
      claimant: job.id,
      reason: job.data.reason,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`work asset cleanup API failed with status ${response.status}: ${text}`);
  }
  const result: unknown = JSON.parse(text);
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) {
    throw new Error("work asset cleanup API returned an invalid response");
  }
  return result as Record<string, unknown>;
}

registerSystemJob(WORK_ASSET_CLEANUP_JOB, processWorkAssetCleanup);
