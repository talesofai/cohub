import type { ContentBlock } from "@cohub/protocol/core";
import type { GenerationPolicy } from "@cohub/protocol/generation";
import type { TaskPayload } from "@cohub/protocol/task";
import { registerTask } from "./registry.js";
import { assignLabelsToSession } from "@cohub/core/labels";
import { assignSessionSourceSystemLabel } from "@cohub/core/labels/session-source";
import { parsePromptEnv, type PromptAccessMode, type PromptAuthContext, type PromptEnv, type SubmitSessionPromptContext } from "@cohub/core/sessions";
import type { SessionTurnIntent } from "@cohub/protocol/model";
import { getPromptTemplateService } from "../prompt-templates.js";
import { getSkillService } from "../skills.js";
import { getSessionDomainServices } from "../session-services.js";
import { createLogger } from "@cohub/infra/logging";
import { db } from "../db.js";
import { dispatchLabelAssignmentsUpdated } from "../label-events.js";
import { works, workViewerGrants } from "@cohub/db";
import { and, eq } from "drizzle-orm";
import { requireDelegatedTaskAuth, resolveScheduledPromptAuth } from "../work-viewer-prompt-auth.js";

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

async function loadWorkViewerGrant(input: {
  grantId: string;
  workId: string;
  spaceId: string;
  viewerUserUuid: string;
}) {
  const [grant] = await db
    .select({
      scopes: workViewerGrants.scopes,
      expiresAt: workViewerGrants.expiresAt,
      revokedAt: workViewerGrants.revokedAt,
      workStatus: works.status,
      workSpaceId: works.spaceId,
      workScopes: works.workScopes,
      allowedViewerScopes: works.allowedViewerScopes,
    })
    .from(workViewerGrants)
    .innerJoin(works, eq(works.id, workViewerGrants.workId))
    .where(and(
      eq(workViewerGrants.id, input.grantId),
      eq(workViewerGrants.workId, input.workId),
      eq(workViewerGrants.spaceId, input.spaceId),
      eq(workViewerGrants.viewerUserUuid, input.viewerUserUuid),
    ))
    .limit(1);
  return grant ?? null;
}

const sendMessageHandler = async (job: import("bullmq").Job, context?: { taskRunId: string }) => {
  const payload = job.data as TaskPayload;
  const spaceId = payload.spaceId;
  const { content, sessionId, title, source: payloadSource, model, provider, thinkingLevel, clientMessageId, generationPolicy, accessMode, intent, labelIds, auth, delegatedAuthRequired, env } = (payload.data ?? {}) as {
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
    labelIds?: string[];
    auth?: PromptAuthContext | null;
    delegatedAuthRequired?: boolean;
    env?: PromptEnv | null;
  };

  if (!spaceId) throw new Error("spaceId is required for send_message task");
  if (!content || content.length === 0) throw new Error("content (ContentBlock[]) is required for send_message task");

  const userId = payload.userId?.trim();
  if (!userId) throw new Error("userId is required for send_message task");

  const taskRunId = (context?.taskRunId ?? String(job.id ?? "")).trim();
  if (!taskRunId) throw new Error("taskRunId is required for send_message task");

  const promptAccessMode = accessMode ?? "full_access";
  const promptPermission = promptAccessMode === "read_only"
    ? "session.prompt.readonly"
    : "session.prompt.fullaccess";
  const taskAuth = requireDelegatedTaskAuth(delegatedAuthRequired === true, auth);
  const promptAuth = await resolveScheduledPromptAuth(
    taskAuth,
    { spaceId, userId, requiredPermission: promptPermission },
    loadWorkViewerGrant,
  );

  const promptEnv = parsePromptEnv(env);
  const source = normalizeTaskSource(payloadSource);
  const targetSessionId = sessionId?.trim() || null;
  const createdSession = targetSessionId ? null : await sessionPromptService.registerCronjobSession(spaceId, { source, title: title ?? null, userUuid: userId });
  const promptSessionId = targetSessionId ?? createdSession?.id;
  if (!promptSessionId) throw new Error("sessionId is required for send_message task");
  const promptClientMessageId = payload.cronJobId?.trim()
    ? `cron:${payload.cronJobId.trim()}:run:${taskRunId}`
    : clientMessageId?.trim() || `taskrun:${taskRunId}`;

  if (labelIds && labelIds.length > 0) {
    await assignLabelsToSession({ db, spaceId, sessionId: promptSessionId, labelIds, userId });
  }
  if (createdSession) {
    await assignSessionSourceSystemLabel({ db, spaceId, sessionId: promptSessionId, source }).then(() =>
      dispatchLabelAssignmentsUpdated({ spaceId, resourceType: "session", resourceRef: promptSessionId, sessionId: promptSessionId }),
    ).catch((error) => {
      logger.warn("[SessionSourceLabel] failed to assign scheduled task source label", error);
    });
  }

  const result = await sessionPromptService.submitPrompt({
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
    accessMode: promptAccessMode,
    env: promptEnv,
    intent: intent ?? null,
    context: {
      kind: "scheduled_task",
      taskRunId,
      cronJobId: payload.cronJobId ?? null,
      auth: promptAuth,
    } satisfies SubmitSessionPromptContext,
  });

  return {
    sessionId: promptSessionId,
    spaceId,
    turnId: result.turnId,
    userMessageId: result.userMessageId,
    messageSent: true,
  };
};

registerTask("send_message", sendMessageHandler);
