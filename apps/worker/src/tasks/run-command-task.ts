import { QueueEvents } from "bullmq";
import { COHUB_AGENT_TURNS_QUEUE, createBullmqConnectionOptions } from "@cohub/infra/bullmq";
import {
  createAgentTurnsQueue,
  enqueueAgentRunCommandJob,
  type AgentRunCommandJobData,
  type AgentRunCommandJobResult,
} from "@cohub/infra/agent-queue";
import { RUN_COMMAND_TASK_TYPE, RUN_COMMAND_TIMEOUT_SECONDS, MAX_RUN_COMMAND_TIMEOUT_SECONDS, buildRunCommandQueuedProgress } from "@cohub/core/commands";
import type { Job } from "bullmq";
import type { TaskPayload } from "@cohub/protocol/task";
import type { GenerationPolicy } from "@cohub/protocol/generation";
import { normalizePermissionScopes } from "@cohub/core/permissions";
import { createDelegatedPromptAuth, parsePromptEnv } from "@cohub/core/sessions";
import { config } from "../config.js";
import { getPromptTemplateService } from "../prompt-templates.js";
import { getSkillService } from "../skills.js";
import { getSessionDomainServices } from "../session-services.js";
import {
  appActionFailureMessage,
  parseRunCommandExecutionContext,
} from "./run-command-context.js";
import { registerTask } from "./registry.js";

const agentQueue = createAgentTurnsQueue<AgentRunCommandJobData, AgentRunCommandJobResult>(config.bullmqRedisUrl, "cohub-worker-run-command");
const BACKGROUND_BASH_TASK_SOURCE = "background_bash_task";

const sessionPromptService = getSessionDomainServices({
  promptTemplateService: getPromptTemplateService(),
  skillService: getSkillService(),
});

function getJobId(job: Job) {
  if (!job.id) throw new Error("Task job has no id");
  return job.id;
}

type RunCommandOrigin = {
  kind: "bash_tool_call";
  sessionId: string;
  turnId: string;
  toolCallId: string;
  requestId?: string | null;
};

type RunCommandNotify = {
  kind: "session_prompt";
  sessionId: string;
  source?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseOrigin(value: unknown): RunCommandOrigin | null {
  const record = asRecord(value);
  if (record?.kind !== "bash_tool_call") return null;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  const turnId = typeof record.turnId === "string" ? record.turnId.trim() : "";
  const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId.trim() : "";
  if (!sessionId || !turnId || !toolCallId) return null;
  const requestId = typeof record.requestId === "string" && record.requestId.trim() ? record.requestId.trim() : null;
  return { kind: "bash_tool_call", sessionId, turnId, toolCallId, ...(requestId ? { requestId } : {}) };
}

function parseNotify(value: unknown): RunCommandNotify | null {
  const record = asRecord(value);
  if (record?.kind !== "session_prompt") return null;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  if (!sessionId) return null;
  const source = typeof record.source === "string" && record.source.trim() ? record.source.trim() : BACKGROUND_BASH_TASK_SOURCE;
  return { kind: "session_prompt", sessionId, source };
}

function parseGenerationPolicy(value: unknown): GenerationPolicy | null {
  return asRecord(value) as GenerationPolicy | null;
}

function clampTimeout(timeout: unknown) {
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return undefined;
  return Math.min(Math.floor(timeout), MAX_RUN_COMMAND_TIMEOUT_SECONDS);
}

function backgroundTaskAuthExp(timeout: number | undefined) {
  return Math.floor((Date.now() + ((timeout ?? RUN_COMMAND_TIMEOUT_SECONDS) + 60) * 1000) / 1000);
}

function formatBackgroundBashTaskMessage(input: {
  command: string;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  termination?: AgentRunCommandJobResult["termination"];
}) {
  const reason = input.termination?.reason;
  const title = reason === "timed_out"
    ? "Background bash command timed out."
    : reason === "aborted"
      ? "Background bash command was aborted."
      : input.exitCode === 0
        ? "Background bash command finished."
        : "Background bash command failed.";
  const output = input.output.trimEnd();
  return [
    title,
    "",
    `Command: ${input.command}`,
    `Exit code: ${input.exitCode ?? "unknown"}`,
    "",
    "Output:",
    output || "(no output)",
    input.truncated ? "\n[Output truncated]" : "",
  ].filter(Boolean).join("\n");
}

async function notifyRunCommandCompletion(input: {
  payload: TaskPayload;
  taskRunId: string;
  command: string;
  result: AgentRunCommandJobResult;
  notify: RunCommandNotify | null;
  origin: RunCommandOrigin | null;
  sourceClientId: string | null;
}) {
  if (!input.notify) return;
  const spaceId = input.payload.spaceId;
  const userId = input.payload.userId?.trim();
  if (!spaceId || !userId) return;

  await sessionPromptService.submitPrompt({
    spaceId,
    sessionId: input.notify.sessionId,
    userId,
    clientMessageId: `background-bash-task:${input.taskRunId}:completion`,
    content: [{
      type: "text",
      text: formatBackgroundBashTaskMessage({
        command: input.command,
        exitCode: input.result.exitCode,
        output: input.result.output,
        truncated: input.result.truncated,
        termination: input.result.termination,
      }),
    }],
    source: input.notify.source ?? BACKGROUND_BASH_TASK_SOURCE,
    sourceClientId: input.sourceClientId,
    intent: "steer",
    context: {
      kind: "background_bash_task",
      taskRunId: input.taskRunId,
      auth: (() => {
        const scopes = normalizePermissionScopes(Array.isArray(input.payload.data?.executionScopes) ? input.payload.data.executionScopes : []);
        return input.payload.spaceId && input.payload.userId
          ? createDelegatedPromptAuth({
              source: "background_bash_task",
              actorUserId: input.payload.userId,
              spaceId: input.payload.spaceId,
              scopes,
              appScopes: scopes,
              exp: backgroundTaskAuthExp(typeof input.payload.data?.timeout === "number" ? input.payload.data.timeout : undefined),
            })
          : null;
      })(),
      origin: input.origin,
    },
    accessMode: "full_access",
  });
}

async function mirrorAgentProgress(job: Job, agentJobId: string) {
  const agentJob = await agentQueue.getJob(agentJobId).catch(() => null);
  if (!agentJob) return;
  const progress = agentJob.progress;
  if (!progress) return;
  await job.updateProgress(progress).catch(() => undefined);
}

registerTask(RUN_COMMAND_TASK_TYPE, async (job) => {
  const payload = job.data as TaskPayload;
  const spaceId = payload.spaceId;
  const data = payload.data ?? {};
  const command = typeof data.command === "string" ? data.command.trim() : "";
  const cwd = typeof data.cwd === "string" && data.cwd.trim() ? data.cwd.trim() : "/workspace";
  const timeout = clampTimeout(data.timeout);
  const generationPolicy = parseGenerationPolicy(data.generationPolicy);
  const { sourceClientId, model } = parseRunCommandExecutionContext(data);
  const promptEnv = parsePromptEnv(data.env);
  const executionScopes = normalizePermissionScopes(Array.isArray(data.executionScopes) ? data.executionScopes : []);
  const origin = parseOrigin(data.origin);
  const notify = parseNotify(data.notify);
  if (!spaceId) throw new Error("spaceId is required for run_command task");
  if (!command) throw new Error("command is required for run_command task");

  const taskRunId = getJobId(job);
  const userId = typeof data.actorUserId === "string" && data.actorUserId.trim()
    ? data.actorUserId.trim()
    : payload.userId?.trim() || null;
  const agentJob = await enqueueAgentRunCommandJob(agentQueue, {
    spaceId,
    sessionId: payload.sessionId ?? null,
    taskRunId,
    command,
    cwd,
    ...(typeof data.source === "string" ? { source: data.source } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(userId ? { userId } : {}),
    ...(typeof data.viewerUserId === "string" ? { viewerUserId: data.viewerUserId } : {}),
    ...(typeof data.appId === "string" ? { appId: data.appId } : {}),
    ...(typeof data.appVersionId === "string" ? { appVersionId: data.appVersionId } : {}),
    ...(typeof data.action === "string" ? { action: data.action } : {}),
    ...(sourceClientId ? { sourceClientId } : {}),
    ...(model ? { model } : {}),
    ...(generationPolicy ? { generationPolicy } : {}),
    ...(promptEnv ? { env: promptEnv } : {}),
    ...(executionScopes.length > 0 ? { executionScopes } : {}),
    requestId: origin?.requestId ?? null,
    origin,
  });

  await job.updateProgress(buildRunCommandQueuedProgress({
    toolCallId: `run-command-${taskRunId}`,
    command,
    cwd,
    output: "",
  })).catch(() => undefined);

  const queueEvents = new QueueEvents(COHUB_AGENT_TURNS_QUEUE, {
    connection: createBullmqConnectionOptions(config.bullmqRedisUrl),
  });
  await queueEvents.waitUntilReady();
  const mirrorTimer = setInterval(() => {
    void mirrorAgentProgress(job, agentJob.id ?? `run-command-${taskRunId}`);
  }, 600);

  try {
    const result = await agentJob.waitUntilFinished(queueEvents, ((timeout ?? RUN_COMMAND_TIMEOUT_SECONDS) + 60) * 1000) as AgentRunCommandJobResult;
    await mirrorAgentProgress(job, agentJob.id ?? `run-command-${taskRunId}`);
    const failureMessage = appActionFailureMessage(data.source, result);
    if (failureMessage) throw new Error(failureMessage);
    await notifyRunCommandCompletion({ payload, taskRunId, command, result, notify, origin, sourceClientId });
    return result;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearInterval(mirrorTimer);
    await queueEvents.close().catch(() => undefined);
  }
});
