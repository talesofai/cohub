import type { ContentBlock } from "@cohub/protocol/core";
import type { GenerationPolicy } from "@cohub/protocol/generation";
import type { TaskPayload } from "@cohub/protocol/task";
import { registerTask } from "./registry.js";
import { parseLabelRefs } from "@cohub/core/labels";
import { assignSessionSourceSystemLabel } from "@cohub/core/labels/session-source";
import type {
  PromptAccessMode,
  PromptAuthContext,
  PromptEnv,
  SubmitSessionPromptContext,
} from "@cohub/core/sessions";
import type { SessionTurnIntent } from "@cohub/protocol/model";
import { getPromptTemplateService } from "../prompt-templates.js";
import { getSkillService } from "../skills.js";
import { getSessionDomainServices } from "../session-services.js";
import { createLogger } from "@cohub/infra/logging";
import { db } from "../db.js";
import { dispatchLabelAssignmentsUpdated } from "../label-events.js";
import {
  buildScheduledSendMessagePromptInput,
  parseScheduledSendMessagePromptOptions,
  requireScheduledPromptAuth,
  scheduledPromptSessionId,
} from "./send-message-prompt.js";

const MAX_TASK_SOURCE_LENGTH = 255;

const normalizeTaskSource = (value: unknown) => {
  if (typeof value !== "string") return "scheduled_task";
  const source = value.trim();
  if (!source) return "scheduled_task";
  return source.length > MAX_TASK_SOURCE_LENGTH ? source.slice(0, MAX_TASK_SOURCE_LENGTH) : source;
};

const logger = createLogger({ serviceName: "cohub-worker" });

const sessionPromptService = getSessionDomainServices({
  promptTemplateService: getPromptTemplateService(),
  skillService: getSkillService(),
});

const sendMessageHandler = async (job: import("bullmq").Job, context?: { taskRunId: string }) => {
  const payload = job.data as TaskPayload;
  const spaceId = payload.spaceId;
  const { content, sessionId, title, source: payloadSource, model, provider, thinkingLevel, clientMessageId, generationPolicy, accessMode, intent, labelRefs, auth, env, systemInstructions } = (payload.data ?? {}) as {
    content?: ContentBlock[];
    sessionId?: string;
    title?: string;
    source?: unknown;
    model?: string;
    provider?: string;
    thinkingLevel?: string | null;
    clientMessageId?: string;
    generationPolicy?: GenerationPolicy | null;
    accessMode?: PromptAccessMode | null;
    intent?: SessionTurnIntent | null;
    labelRefs?: string[];
    auth?: PromptAuthContext | null;
    env?: PromptEnv | null;
    systemInstructions?: string | null;
  };

  if (!spaceId) throw new Error("spaceId is required for send_message task");
  if (!content || content.length === 0) throw new Error("content (ContentBlock[]) is required for send_message task");

  const userId = payload.userId?.trim();
  if (!userId) throw new Error("userId is required for send_message task");

  const taskRunId = (context?.taskRunId ?? String(job.id ?? "")).trim();
  if (!taskRunId) throw new Error("taskRunId is required for send_message task");
  const promptAuth = requireScheduledPromptAuth(auth ?? null, { spaceId, userId });
  const scheduledLabelPaths = parseLabelRefs(labelRefs);

  const {
    env: promptEnv,
    systemInstructions: promptSystemInstructions,
  } = parseScheduledSendMessagePromptOptions({ env, systemInstructions });
  const source = normalizeTaskSource(payloadSource);
  const promptClientMessageId = payload.cronJobId?.trim()
    ? `cron:${payload.cronJobId.trim()}:run:${taskRunId}`
    : clientMessageId?.trim() || `taskrun:${taskRunId}`;
  const targetSessionId = sessionId?.trim() || null;
  const createdSession = targetSessionId ? null : await sessionPromptService.registerCronjobSession(spaceId, {
    sessionId: scheduledPromptSessionId({ spaceId, userId, taskRunId }),
    source,
    title: title ?? null,
    userUuid: userId,
  });
  const promptSessionId = targetSessionId ?? createdSession?.id;
  if (!promptSessionId) throw new Error("sessionId is required for send_message task");

  if (createdSession) {
    await assignSessionSourceSystemLabel({ db, spaceId, sessionId: promptSessionId, source }).then(() =>
      dispatchLabelAssignmentsUpdated({ spaceId, resourceType: "session", resourceRef: promptSessionId, sessionId: promptSessionId }),
    ).catch((error) => {
      logger.warn("[SessionSourceLabel] failed to assign scheduled task source label", error);
    });
  }

  const result = await sessionPromptService.submitPrompt(buildScheduledSendMessagePromptInput({
    spaceId,
    sessionId: promptSessionId,
    userId,
    clientMessageId: promptClientMessageId,
    content,
    source,
    model: model ?? null,
    provider: provider ?? null,
    thinkingLevel: thinkingLevel ?? null,
    generationPolicy: generationPolicy ?? null,
    accessMode: accessMode ?? "full_access",
    env: promptEnv,
    systemInstructions: promptSystemInstructions,
    intent: intent ?? null,
    sessionLabelPaths: scheduledLabelPaths,
    context: {
      kind: "scheduled_task",
      taskRunId,
      cronJobId: payload.cronJobId ?? null,
      auth: promptAuth,
    } satisfies SubmitSessionPromptContext,
  }));

  return {
    sessionId: promptSessionId,
    spaceId,
    turnId: result.turnId,
    userMessageId: result.userMessageId,
    messageSent: true,
  };
};

registerTask("send_message", sendMessageHandler);
