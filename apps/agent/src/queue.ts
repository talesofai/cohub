import { COHUB_AGENT_TURNS_QUEUE, defaultJobRetention } from "@cohub/infra/bullmq";
import type { JobsOptions } from "bullmq";
import { getCurrentRequestId } from "@cohub/infra/tracing";
import { injectTrace } from "@cohub/infra/tracing/propagator";
import {
  createAgentTurnsQueue,
  AGENT_SANDBOX_BASH_JOB_NAME,
  AGENT_RUN_COMMAND_JOB_NAME,
  buildAgentSandboxBashJobId,
  buildAgentRunCommandJobId,
  type AgentSandboxBashUploadJobData,
  type AgentRunCommandJobData,
  type AgentRunCommandJobResult,
} from "@cohub/infra/agent-queue";
import { env } from "./env.js";

export const AGENT_TURN_QUEUE_NAME = COHUB_AGENT_TURNS_QUEUE;
export const AGENT_TURN_JOB_NAME = "agent_turns";
export const AGENT_SESSION_FORK_JOB_NAME = "agent_session_fork";
export { AGENT_SANDBOX_BASH_JOB_NAME, AGENT_RUN_COMMAND_JOB_NAME };
export type { AgentSandboxBashUploadJobData, AgentRunCommandJobData, AgentRunCommandJobResult };

export type AgentTurnJobData = {
  spaceId: string;
  sessionId: string;
  reason?: "prompt" | "steer" | "drain" | "retry" | "recovery";
  requestId?: string | null;
  trace?: Record<string, unknown>;
};

export type AgentSessionForkJobData = {
  spaceId: string;
  sessionId: string;
  parentSessionId: string;
  anchorTurnId: string;
  anchorSequence: number;
  anchorEntryId: string;
  requestId?: string | null;
  trace?: Record<string, unknown>;
};

export type AgentJobData = AgentTurnJobData | AgentSessionForkJobData | AgentSandboxBashUploadJobData | AgentRunCommandJobData;

export const agentTurnQueue = createAgentTurnsQueue<AgentJobData, unknown>(env.BULLMQ_REDIS_URL, "cohub-agent");
export const buildSandboxBashJobId = buildAgentSandboxBashJobId;
export const buildRunCommandJobId = buildAgentRunCommandJobId;

export async function enqueueAgentTurnJob(data: AgentTurnJobData, options: JobsOptions = {}) {
  const trace = injectTrace();
  const { jobId: requestedJobId, removeOnFail, ...jobOptions } = options;
  const jobId = requestedJobId ?? (data.reason === "drain" ? null : `agent-session-wakeup-${data.sessionId}`);
  return agentTurnQueue.add(AGENT_TURN_JOB_NAME, {
    ...data,
    requestId: getCurrentRequestId() ?? data.requestId ?? null,
    trace: Object.keys(trace).length > 0 ? trace : data.trace,
  }, {
    // Covers queue/DB failures before claim; claimed LLM turns retry in session-runtime.
    attempts: 2,
    backoff: { type: "fixed", delay: 1000 },
    removeOnComplete: true,
    ...jobOptions,
    ...(jobId ? { jobId } : {}),
    removeOnFail: jobId ? true : removeOnFail ?? defaultJobRetention.removeOnFail,
  });
}

export async function enqueueAgentSessionForkJob(data: AgentSessionForkJobData, options: JobsOptions = {}) {
  return agentTurnQueue.add(AGENT_SESSION_FORK_JOB_NAME, {
    ...data,
    requestId: getCurrentRequestId() ?? null,
    trace: injectTrace(),
  }, {
    jobId: `agent-session-fork-${data.sessionId}-${data.anchorEntryId}`,
    attempts: 3,
    backoff: { type: "fixed", delay: 1000 },
    ...defaultJobRetention,
    ...options,
  });
}
