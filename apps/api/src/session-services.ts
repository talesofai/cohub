import { billingOperations, createBillingUsageGate } from "@cohub/billing";
import { getCurrentRequestId, getOrCreateRequestId } from "@cohub/infra/tracing";
import { injectTrace } from "@cohub/infra/tracing/propagator";
import { createSessionServices } from "@cohub/core/sessions";
import { assignSessionParticipantSystemLabels } from "@cohub/core/labels/session-user";
import { createSandboxLifecycleController, getSandboxPromptRecoveryReason } from "@cohub/sandbox-controller";
import { db } from "./db/index.js";
import { redisCommandClient } from "./redis.js";
import { expandPromptTemplate, type LoadPromptTemplatesOptions, type ExpandedPromptTemplate } from "./prompt-templates.js";
import { expandSkillCommand, type ExpandedSkill } from "./skills.js";
import { ensureSpaceSandbox, recoverSpaceSandbox } from "./space-sandboxes.js";
import { getSpaceSessionById, getSpaceById } from "./space-sessions.js";
import { touchSpaceActivity } from "./space-activity.js";
import { dispatchLabelAssignmentsUpdated, dispatchSessionUpdated } from "./realtime-events.js";
import { createLogger } from "@cohub/infra/logging";
import { enqueueAgentTurnJob } from "./agent-turn-queue.js";


const logger = createLogger({ serviceName: "cohub-api" });
export type PromptTemplateService = {
  expand(text: string, options?: LoadPromptTemplatesOptions): Promise<ExpandedPromptTemplate | null>;
};

export type SkillService = {
  expand(text: string, options?: LoadPromptTemplatesOptions): Promise<ExpandedSkill | null>;
};

const defaultPromptTemplateService: PromptTemplateService = {
  expand: expandPromptTemplate,
};

const defaultSkillService: SkillService = {
  expand: expandSkillCommand,
};

const sandboxLifecycle = createSandboxLifecycleController({ db, infra: null });
const billingUsageGate = createBillingUsageGate({
  operations: billingOperations,
  onEvaluationError: (error, gateInput) => {
    logger.warn("[BillingGate] fail-open after billing evaluation error", { error, gateInput });
  },
});

let defaultSessionDomainServices: ReturnType<typeof createSessionServices> | null = null;

export function getSessionDomainServices(input?: {
  promptTemplateService?: PromptTemplateService;
  skillService?: SkillService;
}) {
  if (!input?.promptTemplateService && !input?.skillService && defaultSessionDomainServices) {
    return defaultSessionDomainServices;
  }

  const services = createSessionServices({
    db,
    redis: redisCommandClient,
    promptTemplateService: input?.promptTemplateService ?? defaultPromptTemplateService,
    skillService: input?.skillService ?? defaultSkillService,
    billingUsageGate,
    sandboxRecovery: {
      maybeRecoverForPrompt: async ({ spaceId, userId, source }) => {
        const sandbox = await sandboxLifecycle.getSandbox(spaceId);
        const reason = getSandboxPromptRecoveryReason(sandbox);
        if (!reason) return;

        const space = await getSpaceById(spaceId);
        if (!space) return;
        if (reason === "missing") {
          await ensureSpaceSandbox({ spaceId, status: "pending", runtimeStatus: "unknown" });
        }

        void recoverSpaceSandbox({
          spaceId,
          userUuid: userId,
          ownerUserUuid: space.userUuid,
          reason,
          source,
          verify: false,
        }).catch((error) => {
          logger.warn(`[SandboxResume] failed to resume sandbox for prompt spaceId=${spaceId} reason=${reason}:`, error);
        });
      },
    },
    injectTrace,
    getRequestId: getCurrentRequestId,
    onSessionActivityUpdated: async ({ sessionId, changed }) => {
      const session = await getSpaceSessionById(sessionId);
      if (!session) return;
      await touchSpaceActivity(session.spaceId, session.lastMessageAt ?? new Date()).catch((error) => {
        logger.warn("[SpaceActivity] failed to touch after session activity update", error);
      });
      await dispatchSessionUpdated({ session, changed });
    },
    onSessionParticipantsUpdated: async ({ spaceId, sessionId, userUuids }) => {
      const affectedLabelIds = await assignSessionParticipantSystemLabels({ db, spaceId, sessionId, userUuids });
      await dispatchLabelAssignmentsUpdated({
        spaceId,
        resourceType: "session",
        resourceRef: sessionId,
        sessionId,
        affectedLabelIds,
      });
    },
    agentTurnQueue: {
      enqueue: (job) => enqueueAgentTurnJob({
        ...job,
        requestId: getOrCreateRequestId(job.requestId),
      }, job.jobId ? { jobId: job.jobId } : {}),
    },
    logger: console,
  });

  if (!input?.promptTemplateService) {
    defaultSessionDomainServices = services;
  }
  return services;
}
