import { QueueEvents } from "bullmq";
import { COHUB_AGENT_TURNS_QUEUE, createBullmqConnectionOptions, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import { getCurrentRequestId } from "@cohub/infra/tracing";
import { injectTrace } from "@cohub/infra/tracing/propagator";
import type { SpaceFsUploadTargetVersion } from "@cohub/protocol/fs";
import { config } from "./config.js";

export const AGENT_SANDBOX_BASH_JOB_NAME = "sandbox_bash";
export const AGENT_SANDBOX_BASH_ATOMIC_JOB_NAME = "sandbox_bash_atomic";

export type SandboxBashUploadFile = {
  relativePath: string;
  name: string;
  size: number;
  mimeType: string | null;
  downloadUrl: string;
  targetVersion?: SpaceFsUploadTargetVersion;
};

export type SandboxBashUploadJobData = {
  spaceId: string;
  sessionId: string;
  uploadId: string;
  destinationRoot: string;
  materialize?: "atomic";
  files: SandboxBashUploadFile[];
  requestId?: string | null;
  trace?: Record<string, unknown>;
};

export type SandboxBashUploadJobResult = {
  ok: true;
  uploaded: Array<{
    path: string;
    name: string;
    size: number;
    mimeType: string | null;
    mtimeMs: number;
  }>;
  output?: string;
};

export class SandboxUploadSizeMismatchError extends Error {
  override name = "SandboxUploadSizeMismatchError";
}

export class SandboxUploadConflictError extends Error {
  override name = "SandboxUploadConflictError";
}

export const sandboxBashQueue = createBullmqQueue<SandboxBashUploadJobData, SandboxBashUploadJobResult>(COHUB_AGENT_TURNS_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-api-sandbox-bash",
});

const sandboxBashQueueEvents = new QueueEvents(COHUB_AGENT_TURNS_QUEUE, {
  connection: createBullmqConnectionOptions(config.bullmqRedisUrl),
});

export async function enqueueSandboxUploadFilesJob(input: Omit<SandboxBashUploadJobData, "requestId" | "trace">) {
  // Keep atomic uploads on a distinct job name: an older agent must reject the
  // job rather than execute the legacy unconditional mv path during rollout.
  const jobName = input.materialize === "atomic" ? AGENT_SANDBOX_BASH_ATOMIC_JOB_NAME : AGENT_SANDBOX_BASH_JOB_NAME;
  const job = await sandboxBashQueue.add(jobName, {
    ...input,
    requestId: getCurrentRequestId() ?? null,
    trace: injectTrace(),
  }, {
    jobId: input.materialize === "atomic"
      ? `${jobName}-${input.uploadId}`
      : `sandbox-bash-${input.uploadId}`,
    attempts: input.materialize === "atomic" ? 12 : 2,
    backoff: { type: "fixed", delay: input.materialize === "atomic" ? 5000 : 1000 },
    ...defaultJobRetention,
  });

  try {
    return await job.waitUntilFinished(sandboxBashQueueEvents, 60 * 60 * 1000) as SandboxBashUploadJobResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("upload_size_mismatch:")) {
      throw new SandboxUploadSizeMismatchError(message.slice("upload_size_mismatch:".length).trim());
    }
    if (message.startsWith("upload_conflict:")) {
      throw new SandboxUploadConflictError(message.slice("upload_conflict:".length).trim());
    }
    throw error;
  }
}
