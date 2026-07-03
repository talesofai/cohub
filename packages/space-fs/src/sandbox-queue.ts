import { QueueEvents } from "bullmq";
import { COHUB_AGENT_TURNS_QUEUE, createBullmqConnectionOptions, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import { getCurrentRequestId } from "@cohub/infra/tracing";
import { injectTrace } from "@cohub/infra/tracing/propagator";
import type { SpaceFsDeps } from "./types.js";

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

export function createSandboxBashQueue(deps: SpaceFsDeps) {
  const { config, serviceName } = deps;

  const sandboxBashQueue = createBullmqQueue<SandboxBashUploadJobData, SandboxBashUploadJobResult>(COHUB_AGENT_TURNS_QUEUE, {
    redisUrl: config.bullmqRedisUrl,
    telemetryServiceName: `${serviceName}-sandbox-bash`,
  });

  const sandboxBashQueueEvents = new QueueEvents(COHUB_AGENT_TURNS_QUEUE, {
    connection: createBullmqConnectionOptions(config.bullmqRedisUrl),
  });

  async function enqueueSandboxUploadFilesJob(input: Omit<SandboxBashUploadJobData, "requestId" | "trace">) {
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

    return job.waitUntilFinished(sandboxBashQueueEvents, 60 * 60 * 1000) as Promise<SandboxBashUploadJobResult>;
  }

  return { enqueueSandboxUploadFilesJob, sandboxBashQueue };
}

export type SandboxBashQueue = ReturnType<typeof createSandboxBashQueue>;
