import { QueueEvents } from "bullmq";
import { COHUB_AGENT_TURNS_QUEUE, createBullmqConnectionOptions, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import { getCurrentRequestId } from "@cohub/infra/tracing";
import { injectTrace } from "@cohub/infra/tracing/propagator";
import { config } from "./config.js";

export const AGENT_SANDBOX_BASH_JOB_NAME = "sandbox_bash";

export type SandboxBashUploadFile = {
  relativePath: string;
  name: string;
  size: number;
  mimeType: string | null;
  downloadUrl: string;
};

export type SandboxBashUploadJobData = {
  spaceId: string;
  workspaceLease?: {
    holderKind: "cloud_file_api";
    holderId: string;
    epoch: number;
  } | null;
  sessionId: string;
  uploadId: string;
  destinationRoot: string;
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

export const sandboxBashQueue = createBullmqQueue<SandboxBashUploadJobData, SandboxBashUploadJobResult>(COHUB_AGENT_TURNS_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-api-sandbox-bash",
});

const sandboxBashQueueEvents = new QueueEvents(COHUB_AGENT_TURNS_QUEUE, {
  connection: createBullmqConnectionOptions(config.bullmqRedisUrl),
});

export async function enqueueSandboxUploadFilesJob(input: Omit<SandboxBashUploadJobData, "requestId" | "trace">) {
  const job = await sandboxBashQueue.add(AGENT_SANDBOX_BASH_JOB_NAME, {
    ...input,
    requestId: getCurrentRequestId() ?? null,
    trace: injectTrace(),
  }, {
    jobId: `sandbox-bash-${input.uploadId}`,
    attempts: 2,
    backoff: { type: "fixed", delay: 1000 },
    ...defaultJobRetention,
  });

  try {
    return await job.waitUntilFinished(sandboxBashQueueEvents, 60 * 60 * 1000) as SandboxBashUploadJobResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("upload_size_mismatch:")) {
      throw new SandboxUploadSizeMismatchError(message.slice("upload_size_mismatch:".length).trim());
    }
    throw error;
  }
}
