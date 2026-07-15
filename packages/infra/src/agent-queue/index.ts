import type { GenerationPolicy } from "@cohub/protocol/generation";
import type { Queue, JobsOptions, QueueOptions } from "bullmq";
import { COHUB_AGENT_TURNS_QUEUE, createBullmqConnectionOptions, createBullmqQueue, defaultJobRetention } from "../bullmq/index.js";

export const AGENT_SANDBOX_BASH_JOB_NAME = "sandbox_bash" as const;
export const AGENT_RUN_COMMAND_JOB_NAME = "run_command" as const;

export type AgentSandboxBashUploadJobData = {
  spaceId: string;
  sessionId: string;
  uploadId: string;
  destinationRoot: string;
  downloadHost: string;
  files: Array<{
    relativePath: string;
    name: string;
    size: number;
    mimeType: string | null;
    downloadUrl: string;
  }>;
  requestId?: string | null;
  trace?: Record<string, unknown>;
};

export type AgentRunCommandOrigin = {
  kind: "bash_tool_call";
  sessionId: string;
  turnId: string;
  toolCallId: string;
  requestId?: string | null;
};

export type AgentRunCommandJobData = {
  spaceId: string;
  sessionId?: string | null;
  taskRunId: string;
  command: string;
  cwd: string;
  timeout?: number;
  userId?: string | null;
  generationPolicy?: GenerationPolicy | null;
  env?: Record<string, string> | null;
  executionScopes?: string[] | null;
  accessMode?: "read_only" | "full_access" | "isolated_worker" | null;
  requestId?: string | null;
  trace?: Record<string, unknown>;
  origin?: AgentRunCommandOrigin | null;
};

export type AgentRunCommandJobResult = {
  ok: true;
  exitCode: number | null;
  termination?: {
    reason: "exited" | "timed_out" | "aborted";
    exitCode: number | null;
    timeoutSecs?: number;
    message?: string;
  };
  durationMs: number;
  output: string;
  truncated: boolean;
  content: Array<Record<string, unknown>>;
};

export type AgentBashJobData = AgentSandboxBashUploadJobData | AgentRunCommandJobData;

export function createAgentTurnsQueue<DataType = AgentBashJobData, ResultType = unknown>(redisUrl: string, telemetryServiceName: string) {
  return createBullmqQueue<DataType, ResultType>(COHUB_AGENT_TURNS_QUEUE, {
    redisUrl,
    telemetryServiceName,
  });
}

export function createAgentTurnsQueueConnection(redisUrl: string) {
  return createBullmqConnectionOptions(redisUrl);
}

export function createAgentTurnsQueueWithOptions<DataType = AgentBashJobData, ResultType = unknown>(
  options: Omit<QueueOptions, "connection" | "telemetry"> & {
    redisUrl: string;
    telemetryServiceName: string;
  },
) {
  return createBullmqQueue<DataType, ResultType>(COHUB_AGENT_TURNS_QUEUE, options);
}

export const buildAgentSandboxBashJobId = (uploadId: string) => `sandbox-bash-${uploadId}`;
export const buildAgentRunCommandJobId = (taskRunId: string) => `run-command-${taskRunId}`;

export function enqueueAgentRunCommandJob(queue: Queue, input: AgentRunCommandJobData, options: JobsOptions = {}) {
  return queue.add(AGENT_RUN_COMMAND_JOB_NAME, input, {
    jobId: buildAgentRunCommandJobId(input.taskRunId),
    attempts: 1,
    ...defaultJobRetention,
    ...options,
  });
}
