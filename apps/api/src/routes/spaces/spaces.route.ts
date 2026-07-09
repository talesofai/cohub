import { BillingAccessBlockedError, COHUB_BILLING_FEATURES, billingOperations } from "@cohub/billing";
import { DEFAULT_SANDBOX_SPEC_ID, SANDBOX_SPECS, getSandboxSpecRank, isSandboxSpecId, type SandboxSpecId } from "@cohub/sandbox-controller";
import { createLogger } from "@cohub/infra/logging";
import { Hono, type Context } from "hono";
import type { ContentBlock } from "@cohub/protocol/core";
import { getDefaultSpaceModsForEnv } from "@cohub/protocol";
import { normalizeGenerationPolicy } from "@cohub/protocol/generation";
import * as cronParser from "cron-parser";
import { db } from "../../db/index.js";
import {
  userChannels,
  spaceChannels,
  spaceMods,
  spaces,
  taskRuns,
  spaceSessions,
  spaceMembers,
  userProfiles,
  sessionTurns,
} from "@cohub/db";
import { eq, and, inArray, desc, lt, or, sql, count } from "drizzle-orm";
import { useAuth, getOptionalAuth, getWorkSessionPrincipal, requireValidId, buildSpaceListItems, buildStorageRepoName, authzDenied, getSpacePublicProfile, normalizePublicAvatarUrl } from "../../lib/middleware.js";
import { config } from "../../config.js";
import { scheduleSandboxAutoDestroy } from "../../sandbox-idle-scheduler.js";
import { attachSandboxPublicEndpoints } from "../../sandbox-public-network.js";
import { ensureSpaceSandbox, getSpaceSandboxBySpaceId, markSandboxSpecPendingRestart, recoverSpaceSandbox, reconcileSpaceSandbox, resizeSpaceSandboxToSpec } from "../../space-sandboxes.js";
import {
  createInitialSpaceSession,
  getSpaceById,
  getSpaceSessionById,
  hydrateSessionParticipantProfiles,
  listSpaceSessions,
  normalizeSpaceEnv,
  validateSpaceEnv,
  setSpaceEnv,
  SandboxNotReadyError,
  SpaceEnvValidationError,
} from "../../space-sessions.js";
import { syncSpaceChannelConfigCache, getSpaceChannelsBySpaceId, bindSpaceChannelsToGateway, unbindSpaceChannelFromGateway, updateSpaceChannelConfig } from "../../channels.js";
import { createCronJob, enqueueTask } from "../../tasks.js";
import { RUN_COMMAND_TASK_TYPE } from "@cohub/core/commands";
import { sanitizePostgresJsonValue } from "@cohub/core/content/sanitize";
import { assignLabelsToSession, parseLabelRefs, resolveLabelPaths, resolveOrCreateLabelPaths } from "@cohub/core/labels";
import { assignSessionSourceSystemLabel } from "@cohub/core/labels/session-source";
import { hasPermission, getSpaceMemberRole, filterSessionsByPermission, resolvePermissionAccess } from "../../permissions.js";
import { checkpoints } from "@cohub/db";
import { checkpointFsJsonError, listCheckpointDirectory, readCheckpointFile } from "../../checkpoint-fs.js";
import type { AuthUser } from "../../lib/middleware.js";
import { submitSessionPrompt } from "../../session-prompts.js";
import { parsePromptEnv, PromptEnvValidationError } from "@cohub/core/sessions";
import { delegatedPromptAuthFromWorkSession, promptAuthContextFromWorkSession } from "../../prompt-auth-context.js";
import { buildSessionTurnResponse } from "../../session-turn-response.js";
import { getSessionTurnById, hydrateTurnAuthorProfiles } from "../../session-turns.js";
import { dispatchTurnUpdated } from "../../session-output.js";
import { enqueueAgentTurnJob } from "../../agent-turn-queue.js";
import { requestAgentTurnAbort } from "../../agent-turn-abort.js";
import { dispatchLabelAssignmentsUpdated } from "../../realtime-events.js";
import { listSessionForksForSessions } from "../../session-forks.js";
import { fallbackPublicUserProfile, getProfilesByUuids } from "../../user-profiles.js";
import { SYSTEM_ENV_KEY_SET } from "@cohub/protocol/sandbox";
import { prepareSpaceModInserts, spaceModErrorResponse, type CreateSpaceModInput } from "../../space-mods.js";
import { parseChannelConfigPatch, mergeChannelConfig, validateChannelModelConfig } from "../../lib/channel-model-config.js";
import { redisCommandClient } from "../../redis.js";
import { featureGateResponse } from "../../lib/feature-gate.js";
import { billingBlockedResponse } from "../../lib/billing-blocked.js";


const logger = createLogger({ serviceName: "cohub-api" });
const getSpaceSaveCheckpointLockKey = (spaceId: string) => `cohub:space:${spaceId}:save-checkpoint`;

const router = new Hono();
const { CronExpressionParser } = cronParser;

type SpaceRouteSessionRecord = NonNullable<Awaited<ReturnType<typeof getSpaceSessionById>>>;

function getPromptAuthContext(c: Context, spaceId: string) {
  return promptAuthContextFromWorkSession(getWorkSessionPrincipal(c), spaceId);
}

function getScheduledPromptAuthContext(c: Context, spaceId: string, actorUserId: string) {
  return delegatedPromptAuthFromWorkSession(getWorkSessionPrincipal(c), spaceId, actorUserId);
}

async function buildSpacePromptTurnResponse(session: SpaceRouteSessionRecord | null, turnId: string) {
  const response = session ? await buildSessionTurnResponse(session, turnId) : null;
  return response ? { mode: "immediate" as const, ...response } : null;
}

type SpacePromptSchedule =
  | { mode?: "immediate" }
  | { mode: "delay"; delayMs?: number }
  | { mode: "at"; sendAt?: string }
  | { mode: "repeat"; cronExpression?: string; timezone?: string };

type PromptAccessMode = "read_only" | "full_access";

const normalizePromptAccessMode = (value: unknown): PromptAccessMode | null => {
  if (value === undefined || value === null) return "full_access";
  return value === "read_only" || value === "full_access" ? value : null;
};

const MAX_PROMPT_SOURCE_LENGTH = 255;

const normalizePromptSource = (value: unknown): { source: string; error?: string } => {
  if (value === undefined || value === null) return { source: "public_api" };
  if (typeof value !== "string") return { source: "public_api", error: "source must be a string" };
  const source = value.trim() || "public_api";
  if (source.length > MAX_PROMPT_SOURCE_LENGTH) return { source, error: "source must be at most 255 characters" };
  return { source };
};

type SpacePromptIntent = "followup" | "steer";

const normalizeSpacePromptIntent = (value: unknown): SpacePromptIntent | null => {
  if (value === undefined || value === null) return "followup";
  return value === "followup" || value === "steer" ? value : null;
};

const readMetaRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const sanitizeMeta = (value: Record<string, unknown>) =>
  sanitizePostgresJsonValue(value) as Record<string, unknown>;

type SpaceTurnActionResult = {
  turn: NonNullable<Awaited<ReturnType<typeof getSessionTurnById>>>;
  affectedTurns: NonNullable<Awaited<ReturnType<typeof getSessionTurnById>>>[];
};

async function promoteQueuedTurnToSteer(input: {
  spaceId: string;
  sessionId: string;
  turnId: string;
  actorUserId: string;
}): Promise<SpaceTurnActionResult> {
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [session] = await tx.select({ id: spaceSessions.id, spaceId: spaceSessions.spaceId }).from(spaceSessions).where(eq(spaceSessions.id, input.sessionId)).for("update").limit(1);
    if (!session || session.spaceId !== input.spaceId) throw new Error("session not found");

    const [target] = await tx.select().from(sessionTurns).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId))).for("update").limit(1);
    if (target?.status !== "queued") throw new Error("turn is not queued");
    if (target.intent !== "followup") throw new Error("only follow-up turns can be steered");

    const [maxSequenceRow] = await tx.select({ max: sql<number>`coalesce(max(${sessionTurns.sequence}), 0)::int` }).from(sessionTurns).where(eq(sessionTurns.sessionId, input.sessionId));
    const nextSequence = (maxSequenceRow?.max ?? target.sequence) + 1;
    await tx.update(sessionTurns).set({
      sequence: nextSequence,
      intent: "steer",
      meta: sanitizeMeta({
        ...readMetaRecord(target.meta),
        promotedToSteerAt: now.toISOString(),
        promotedByUserId: input.actorUserId,
        promotedFromIntent: target.intent,
        dispatchIntent: "steer",
      }),
      updatedAt: now,
    }).where(eq(sessionTurns.id, target.id));

    const [activeTurn] = await tx.select({ id: sessionTurns.id, status: sessionTurns.status, meta: sessionTurns.meta }).from(sessionTurns).where(and(eq(sessionTurns.sessionId, input.sessionId), inArray(sessionTurns.status, ["running", "abort_requested"]))).orderBy(desc(sessionTurns.sequence)).limit(1);
    if (activeTurn && activeTurn.id !== target.id) {
      await tx.update(sessionTurns).set({
        status: "abort_requested",
        meta: sanitizeMeta({
          ...readMetaRecord(activeTurn.meta),
          abortRequestedAt: now.toISOString(),
          continuedByTurnId: target.id,
          abortActorUserId: input.actorUserId,
        }),
        updatedAt: now,
      }).where(and(eq(sessionTurns.id, activeTurn.id), inArray(sessionTurns.status, ["running", "abort_requested"])));
    }

    return { targetId: target.id, activeTurnId: activeTurn?.id ?? null, activeTurnStatus: activeTurn?.status ?? null, affectedTurnIds: [target.id, ...(activeTurn?.id && activeTurn.id !== target.id ? [activeTurn.id] : [])] };
  });

  try {
    await enqueueAgentTurnJob({ spaceId: input.spaceId, sessionId: input.sessionId, reason: "steer" });
  } catch (error) {
    const failedAt = new Date();
    await db.update(sessionTurns).set({
      status: "failed",
      summary: { finishReason: "failed", reason: "enqueue_failed" },
      errorMessage: error instanceof Error ? error.message : String(error),
      meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify({ enqueueFailedAt: failedAt.toISOString() })}::jsonb`,
      completedAt: failedAt,
      updatedAt: failedAt,
    }).where(and(eq(sessionTurns.id, result.targetId), eq(sessionTurns.sessionId, input.sessionId), eq(sessionTurns.status, "queued")));
    if (result.activeTurnId && result.activeTurnId !== result.targetId && result.activeTurnStatus === "running") {
      await db.update(sessionTurns).set({ status: "running", updatedAt: failedAt }).where(and(eq(sessionTurns.id, result.activeTurnId), eq(sessionTurns.sessionId, input.sessionId), eq(sessionTurns.status, "abort_requested")));
    }
    throw new Error("failed to enqueue steered turn");
  }

  if (result.activeTurnId && result.activeTurnId !== result.targetId) {
    await requestAgentTurnAbort({
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      turnId: result.activeTurnId,
      reason: "interrupt",
      continuedByTurnId: result.targetId,
      actorUserId: input.actorUserId,
    }).catch((error) => {
      logger.warn("[SessionTurn] failed to publish steer abort", error);
    });
  }
  const turns = (await Promise.all(result.affectedTurnIds.map((turnId) => getSessionTurnById(input.sessionId, turnId))))
    .filter(Boolean) as NonNullable<Awaited<ReturnType<typeof getSessionTurnById>>>[];
  const hydrated = await hydrateTurnAuthorProfiles(turns);
  const target = hydrated.find((turn) => turn.id === result.targetId);
  if (!target) throw new Error("turn not found");
  return { turn: target, affectedTurns: hydrated };
}

async function cancelQueuedTurn(input: {
  spaceId: string;
  sessionId: string;
  turnId: string;
  actorUserId: string;
}): Promise<NonNullable<Awaited<ReturnType<typeof getSessionTurnById>>>> {
  const now = new Date();
  const [updated] = await db.transaction(async (tx) => {
    const [session] = await tx.select({ id: spaceSessions.id, spaceId: spaceSessions.spaceId }).from(spaceSessions).where(eq(spaceSessions.id, input.sessionId)).for("update").limit(1);
    if (!session || session.spaceId !== input.spaceId) throw new Error("session not found");
    const [turn] = await tx.select().from(sessionTurns).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId))).for("update").limit(1);
    if (turn?.status !== "queued") throw new Error("turn is not queued");
    if (turn.intent !== "followup") throw new Error("only follow-up turns can be cancelled");
    const [maxSequenceRow] = await tx.select({ max: sql<number>`coalesce(max(${sessionTurns.sequence}), 0)::int` }).from(sessionTurns).where(eq(sessionTurns.sessionId, input.sessionId));
    return tx.update(sessionTurns).set({
      sequence: (maxSequenceRow?.max ?? turn.sequence) + 1,
      status: "cancelled",
      summary: { finishReason: "cancelled", reason: "queued_followup_cancelled" },
      meta: sanitizeMeta({
        ...readMetaRecord(turn.meta),
        cancelledAt: now.toISOString(),
        cancelledByUserId: input.actorUserId,
        cancelledBeforeDispatch: true,
      }),
      completedAt: now,
      updatedAt: now,
    }).where(eq(sessionTurns.id, input.turnId)).returning();
  });
  if (!updated) throw new Error("turn not found");
  const turn = await getSessionTurnById(input.sessionId, input.turnId);
  if (!turn) throw new Error("turn not found");
  const [hydrated = turn] = await hydrateTurnAuthorProfiles([turn]);
  return hydrated;
}

type SpacePromptInput = {
  sessionId?: string | null;
  title?: string | null;
  source?: string | null;
  content?: ContentBlock[];
  model?: string | null;
  provider?: string | null;
  clientMessageId?: string | null;
  generationPolicy?: unknown;
  intent?: SpacePromptIntent | null;
  accessMode?: PromptAccessMode | null;
  schedule?: SpacePromptSchedule | null;
  labelRefs?: unknown;
  env?: unknown;
};

type SpaceSandboxAutoDestroyPolicy =
  | { mode: "idle"; ttlSeconds: number }
  | { mode: "never" };

type SpaceSandboxProvider = "cloud" | "local";

type SpaceConfigInput = {
  sandbox?: {
    provider?: SpaceSandboxProvider;
    autoDestroy?: SpaceSandboxAutoDestroyPolicy;
    spec?: SandboxSpecId;
  };
};

const DEFAULT_SPACE_SANDBOX_AUTO_DESTROY: SpaceSandboxAutoDestroyPolicy = {
  mode: "idle",
  ttlSeconds: config.env === "prod" ? 12 * 60 * 60 : 10 * 60,
};

const MIN_SPACE_SANDBOX_AUTO_DESTROY_TTL_SECONDS = 60;
const MAX_SPACE_SANDBOX_AUTO_DESTROY_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_SPACE_DESCRIPTION_LENGTH = 10_000;
const HOME_SPACE_SLUG = "home";
const SPACE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeSpaceSlug = (value: unknown): { slug: string | null; error?: string } => {
  if (value === undefined || value === null) return { slug: null };
  if (typeof value !== "string") return { slug: null, error: "slug must be a string or null" };
  const slug = value.trim();
  if (!slug) return { slug: null };
  if (!SPACE_SLUG_PATTERN.test(slug)) {
    return {
      slug: null,
      error: "slug must be 1-80 characters, lowercase letters, numbers, hyphens, or underscores, and cannot start or end with a separator",
    };
  }
  return { slug };
};

const uniqueViolationConstraint = (error: unknown): string | null => {
  const record = error as { code?: string; constraint_name?: string; constraint?: string };
  if (record?.code !== "23505") return null;
  return record.constraint_name ?? record.constraint ?? null;
};

type SpaceRow = typeof spaces.$inferSelect;

async function listAccessibleSpaceIds(user: AuthUser): Promise<string[]> {
  const owned = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.userUuid, user.uuid));
  const member = await db
    .select({ id: spaceMembers.spaceId })
    .from(spaceMembers)
    .where(eq(spaceMembers.userId, user.uuid));

  return Array.from(new Set([...owned.map((item) => item.id), ...member.map((item) => item.id)]));
}

function compareSpaceActivityDesc(left: SpaceRow, right: SpaceRow): number {
  const leftActivity = left.lastActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const rightActivity = right.lastActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (leftActivity !== rightActivity) return rightActivity - leftActivity;

  const leftCreated = left.createdAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const rightCreated = right.createdAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return rightCreated - leftCreated;
}

function selectMostRecentSpace(candidates: Array<SpaceRow | null | undefined>): SpaceRow | null {
  return candidates.filter((space): space is SpaceRow => Boolean(space)).sort(compareSpaceActivityDesc)[0] ?? null;
}

const readSpaceConfig = (space: typeof spaces.$inferSelect) => {
  const meta = isRecord(space.meta) ? space.meta : {};
  const config = isRecord(meta.config) ? meta.config : {};
  return { meta, config };
};

const normalizeSpaceSandboxAutoDestroyPolicy = (value: unknown): SpaceSandboxAutoDestroyPolicy => {
  if (!isRecord(value) || typeof value.mode !== "string") {
    throw new Error("sandbox.autoDestroy must be an object with mode");
  }
  if (value.mode === "never") return { mode: "never" };
  if (value.mode !== "idle") {
    throw new Error("sandbox.autoDestroy.mode must be idle or never");
  }
  const ttlSeconds = Number((value as { ttlSeconds?: unknown }).ttlSeconds);
  if (!Number.isInteger(ttlSeconds)) {
    throw new Error("sandbox.autoDestroy.ttlSeconds must be an integer number of seconds");
  }
  if (ttlSeconds < MIN_SPACE_SANDBOX_AUTO_DESTROY_TTL_SECONDS || ttlSeconds > MAX_SPACE_SANDBOX_AUTO_DESTROY_TTL_SECONDS) {
    throw new Error(`sandbox.autoDestroy.ttlSeconds must be between ${MIN_SPACE_SANDBOX_AUTO_DESTROY_TTL_SECONDS} and ${MAX_SPACE_SANDBOX_AUTO_DESTROY_TTL_SECONDS}`);
  }
  return { mode: "idle", ttlSeconds };
};

const getSpaceSandboxAutoDestroyPolicy = (space: typeof spaces.$inferSelect) => {
  const { config } = readSpaceConfig(space);
  const sandbox = isRecord(config.sandbox) ? config.sandbox : {};
  const autoDestroy = sandbox.autoDestroy;
  if (!autoDestroy) return DEFAULT_SPACE_SANDBOX_AUTO_DESTROY;
  try {
    return normalizeSpaceSandboxAutoDestroyPolicy(autoDestroy);
  } catch {
    return DEFAULT_SPACE_SANDBOX_AUTO_DESTROY;
  }
};

const normalizeSpaceSandboxProvider = (value: unknown): SpaceSandboxProvider => {
  if (value === "local") return "local";
  if (value === undefined || value === null || value === "cloud") return "cloud";
  throw new Error("sandbox.provider must be 'cloud' or 'local'");
};

const getSpaceSandboxProvider = (space: typeof spaces.$inferSelect): SpaceSandboxProvider => {
  const { config } = readSpaceConfig(space);
  const sandbox = isRecord(config.sandbox) ? config.sandbox : {};
  return sandbox.provider === "local" ? "local" : "cloud";
};

const normalizeSpaceSandboxSpec = (value: unknown): SandboxSpecId => {
  if (value === undefined || value === null) return DEFAULT_SANDBOX_SPEC_ID;
  if (isSandboxSpecId(value)) return value;
  throw new Error(`sandbox.spec must be one of: ${Object.keys(SANDBOX_SPECS).join(", ")}`);
};

const getSpaceSandboxSpec = (space: typeof spaces.$inferSelect): SandboxSpecId => {
  const { config } = readSpaceConfig(space);
  const sandbox = isRecord(config.sandbox) ? config.sandbox : {};
  return isSandboxSpecId(sandbox.spec) ? sandbox.spec : DEFAULT_SANDBOX_SPEC_ID;
};

async function getAllowedSandboxSpecId(userId: string): Promise<SandboxSpecId> {
  try {
    const state = await billingOperations.getState({ userId });
    const keys = new Set(state.entitlements.filter((entitlement) => entitlement.enabled).map((entitlement) => entitlement.key));
    if (keys.has(COHUB_BILLING_FEATURES.sandboxSpecUltra)) return "ultra";
    if (keys.has(COHUB_BILLING_FEATURES.sandboxSpecBoost)) return "boost";
    return DEFAULT_SANDBOX_SPEC_ID;
  } catch (error) {
    logger.warn("[SandboxSpec] failed to check entitlement", { userId, error });
    return DEFAULT_SANDBOX_SPEC_ID;
  }
}

/** Free plan owned-space cap when `space.owned.unlimited` is not entitled. */
const FREE_OWNED_SPACE_LIMIT = 1;
/** Namespace constant for pg_advisory_xact_lock(key1, key2) owned-space quota locks. */
const OWNED_SPACE_QUOTA_LOCK_NS = 872_314_51;

class SpaceOwnedLimitError extends Error {
  override name = "SpaceOwnedLimitError";
  constructor() {
    super("space owned limit reached");
  }
}

/**
 * Resolves whether the user may own unlimited spaces.
 * Returns `true` when entitled (or billing is disabled), `false` when
 * explicitly not entitled, and `null` when billing could not be reached so
 * callers can surface a temporary error instead of a false upgrade prompt.
 */
async function resolveSpaceOwnedUnlimited(userId: string): Promise<boolean | null> {
  if (!billingOperations.status.configured) return true;
  try {
    const entitlement = await billingOperations.getFeatureEntitlement({
      userId,
      featureKey: COHUB_BILLING_FEATURES.spaceOwnedUnlimited,
    });
    return Boolean(entitlement?.enabled);
  } catch (error) {
    logger.warn("[SpaceLimit] failed to check owned-space entitlement", { userId, error });
    return null;
  }
}

const createSandboxSpecRequiredResponse = (c: Context, specId: SandboxSpecId) =>
  featureGateResponse(c, {
    source: "sandbox_spec",
    message: `${SANDBOX_SPECS[specId].label} sandboxes are available on ${SANDBOX_SPECS[specId].requiredPlan ?? "a higher plan"}.`,
    title: `Upgrade for ${SANDBOX_SPECS[specId].label} sandboxes`,
    conversionMessage: `Choose a higher plan to use ${SANDBOX_SPECS[specId].label} with ${SANDBOX_SPECS[specId].resources.limits.cpu} vCPU and ${SANDBOX_SPECS[specId].resources.limits.memory} memory.`,
  });

const normalizeSpaceConfigInput = (input?: SpaceConfigInput | null): SpaceConfigInput => {
  const provider = normalizeSpaceSandboxProvider(input?.sandbox?.provider);
  const policy = input?.sandbox?.autoDestroy;
  const spec = normalizeSpaceSandboxSpec(input?.sandbox?.spec);
  return {
    sandbox: {
      provider,
      autoDestroy: policy ? normalizeSpaceSandboxAutoDestroyPolicy(policy) : DEFAULT_SPACE_SANDBOX_AUTO_DESTROY,
      spec,
    },
  };
};

const mergeSpaceConfig = (space: typeof spaces.$inferSelect, patch: SpaceConfigInput) => {
  const { meta, config } = readSpaceConfig(space);
  const nextSandbox = {
    ...(isRecord(config.sandbox) ? config.sandbox : {}),
    ...(patch.sandbox?.provider ? { provider: patch.sandbox.provider } : {}),
    ...(patch.sandbox?.autoDestroy ? { autoDestroy: patch.sandbox.autoDestroy } : {}),
    ...(patch.sandbox?.spec ? { spec: patch.sandbox.spec } : {}),
  };
  const nextConfig = {
    ...config,
    sandbox: nextSandbox,
  };
  return {
    ...meta,
    config: nextConfig,
  };
};
const hasExplicitTimezone = (value: string) => /(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim());

function validatePromptContentBlocks(content: unknown): content is ContentBlock[] {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((block) => block && typeof block === "object" && !Array.isArray(block) && typeof (block as { type?: unknown }).type === "string");
}

function promptInputError(error: unknown): string | null {
  if (error instanceof SandboxNotReadyError) return null;
  if (!(error instanceof Error)) return String(error);
  if (
    error.message.includes("content") ||
    error.message.includes("clientMessageId") ||
    error.message.includes("userId") ||
    error.message.includes("Invalid image") ||
    error.message.includes("Invalid content block") ||
    error.message.includes("shell command is empty") ||
    error.message.includes("shell_command is not allowed")
  ) {
    return error.message;
  }
  return null;
}

const isPositiveSafeInteger = (value: number) => Number.isSafeInteger(value) && value > 0;

const validateTimezone = (timezone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const parseScheduledAt = (sendAt: string) => {
  const trimmed = sendAt.trim();
  if (!hasExplicitTimezone(trimmed)) {
    throw new Error("sendAt must include timezone, e.g. 2026-05-09T10:00:00+08:00 or 2026-05-09T02:00:00Z");
  }
  const scheduledAt = new Date(trimmed);
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new Error("sendAt must be a valid ISO 8601 datetime, e.g. 2026-05-09T10:00:00+08:00");
  }
  if (scheduledAt.getTime() <= Date.now()) throw new Error("sendAt must be in the future");
  return scheduledAt;
};

const validateRepeatSchedule = (input: { cronExpression: string; timezone: string }) => {
  const cronExpression = input.cronExpression.trim();
  const timezone = input.timezone.trim();
  if (cronExpression.split(/\s+/).length !== 5) {
    throw new Error("cronExpression must have 5 fields, e.g. 0 9 * * *");
  }
  if (!validateTimezone(timezone)) throw new Error("timezone must be an IANA timezone, e.g. Asia/Shanghai or UTC");
  const interval = CronExpressionParser.parse(cronExpression, { tz: timezone });
  const nextRun = interval.next().toDate();
  const secondRun = interval.next().toDate();
  if (secondRun.getTime() - nextRun.getTime() < 60_000) {
    throw new Error("cron interval must be at least 1 minute");
  }
  return { cronExpression, timezone, nextRun };
};

// ── Provisioning params builder ──────────────────────────────────────────────

function getSpaceProvisionParams(
  user: AuthUser,
  space: typeof spaces.$inferSelect,
) {
  return {
    spaceId: space.id,
    userUuid: user.uuid,
    ownerUserUuid: space.userUuid,
  };
}

router.get("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  if (!(await hasPermission(user, "user.space.list", { spaceId: "" }))) return authzDenied(c);

  const spaceIds = await listAccessibleSpaceIds(user);
  if (spaceIds.length === 0) return c.json([]);

  const spaceList = await db
    .select()
    .from(spaces)
    .where(inArray(spaces.id, spaceIds))
    .orderBy(sql`${spaces.lastActivityAt} desc nulls last`, desc(spaces.createdAt));

  const items = await buildSpaceListItems(spaceList);
  const workSession = getWorkSessionPrincipal(c);
  return c.json(workSession ? items.map(stripSensitiveSpaceFields) : items);
});

router.get("/default", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  if (!(await hasPermission(user, "user.space.list", { spaceId: "" }))) return authzDenied(c);

  const [[ownedHome], [memberHome]] = await Promise.all([
    db
      .select()
      .from(spaces)
      .where(and(eq(spaces.userUuid, user.uuid), eq(spaces.slug, HOME_SPACE_SLUG)))
      .limit(1),
    db
      .select({ space: spaces })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(and(eq(spaceMembers.userId, user.uuid), eq(spaces.slug, HOME_SPACE_SLUG)))
      .orderBy(sql`${spaces.lastActivityAt} desc nulls last`, desc(spaces.createdAt))
      .limit(1),
  ]);
  const homeSpace = selectMostRecentSpace([ownedHome, memberHome?.space]);
  if (homeSpace) return c.json({ space: await buildDefaultSpaceResponse(c, homeSpace, user) });

  const [[ownedRecent], [memberRecent]] = await Promise.all([
    db
      .select()
      .from(spaces)
      .where(eq(spaces.userUuid, user.uuid))
      .orderBy(sql`${spaces.lastActivityAt} desc nulls last`, desc(spaces.createdAt))
      .limit(1),
    db
      .select({ space: spaces })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(eq(spaceMembers.userId, user.uuid))
      .orderBy(sql`${spaces.lastActivityAt} desc nulls last`, desc(spaces.createdAt))
      .limit(1),
  ]);
  const space = selectMostRecentSpace([ownedRecent, memberRecent?.space]);

  return c.json({ space: space ? await buildDefaultSpaceResponse(c, space, user) : null });
});

// ── POST /api/spaces ─────────────────────────────────────────────────────────

router.post("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;

  const body = (await c.req
    .json<{
      name?: string;
      slug?: string | null;
      description?: string | null;
      source?: string;
      cwd?: string;
      protocol?: "pi" | "acp" | "internal";
      meta?: Record<string, unknown>;
      extraEnv?: Array<{ name: string; value: string }>;
      channelBindings?: Array<{ channelId: string; config?: Record<string, unknown> | null }>;
      mods?: CreateSpaceModInput[];
      bootstrapSource?:
        | { type: "blank" }
        | { type: "git_repo"; repoUrl?: string; ref?: string | null }
        | { type: "checkpoint"; checkpointId?: string };
    gitHubToken?: string;
    }>()
    .catch(() => ({}))) as {
    name?: string;
    slug?: string | null;
    description?: string | null;
    source?: string;
    cwd?: string;
    protocol?: "pi" | "acp" | "internal";
    meta?: Record<string, unknown>;
    extraEnv?: Array<{ name: string; value: string }>;
    channelBindings?: Array<{ channelId: string; config?: Record<string, unknown> | null }>;
    mods?: CreateSpaceModInput[];
    bootstrapSource?:
      | { type: "blank" }
      | { type: "git_repo"; repoUrl?: string; ref?: string | null }
      | { type: "checkpoint"; checkpointId?: string };
    gitHubToken?: string;
    config?: SpaceConfigInput;
  };

  const name = body.name?.trim();
  if (!name) return c.json({ message: "name is required" }, 400);

  const { slug, error: slugError } = normalizeSpaceSlug(body.slug);
  if (slugError) return c.json({ message: slugError }, 400);

  const existingSpace = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.userUuid, user.uuid), eq(spaces.name, name)))
    .limit(1);
  if (existingSpace.length > 0) return c.json({ message: "space already exists" }, 409);

  const spaceOwnedUnlimited = await resolveSpaceOwnedUnlimited(user.uuid);
  if (spaceOwnedUnlimited === null) {
    return c.json({
      message: "Could not verify plan eligibility. Please try again.",
      code: "space_owned_limit_unavailable",
    }, 503);
  }

  const normalizedExtraEnv = normalizeSpaceEnv(body.extraEnv);
  const envValidationError = validateSpaceEnvForResponse(normalizedExtraEnv);
  if (envValidationError) return c.json(envValidationError, 400);

  let normalizedConfig: SpaceConfigInput;
  try {
    normalizedConfig = normalizeSpaceConfigInput(body.config ?? null);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid space config" }, 400);
  }
  const requestedSpec = normalizedConfig.sandbox?.spec ?? DEFAULT_SANDBOX_SPEC_ID;
  const allowedSpec = await getAllowedSandboxSpecId(user.uuid);
  if (getSandboxSpecRank(requestedSpec) > getSandboxSpecRank(allowedSpec)) {
    return createSandboxSpecRequiredResponse(c, requestedSpec);
  }

  let normalizedChannelBindings: Array<{ channelId: string; config: ReturnType<typeof parseChannelConfigPatch> }> = [];
  try {
    normalizedChannelBindings = Array.isArray(body.channelBindings)
      ? body.channelBindings
          .filter((binding) => binding?.channelId && requireValidId(binding.channelId))
          .map((binding) => ({ channelId: binding.channelId, config: parseChannelConfigPatch(binding.config ?? null) }))
      : [];
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid channel config" }, 400);
  }

  if (normalizedChannelBindings.length > 0) {
    const ids = normalizedChannelBindings.map((binding) => binding.channelId);
    const channels = await db
      .select({ id: userChannels.id })
      .from(userChannels)
      .where(and(eq(userChannels.userUuid, user.uuid), inArray(userChannels.id, ids)));
    if (channels.length !== ids.length) return c.json({ message: "one or more channels are invalid" }, 400);
  }

  const occupiedChannels = normalizedChannelBindings.length
    ? await db
        .select({ channelId: spaceChannels.channelId })
        .from(spaceChannels)
        .where(inArray(spaceChannels.channelId, normalizedChannelBindings.map((binding) => binding.channelId)))
    : [];
  if (occupiedChannels.length > 0) {
    return c.json({ message: "channel binding already exists for this channel" }, 409);
  }

  let normalizedBootstrapSource:
    | { type: "blank" }
    | { type: "git_repo"; repoUrl: string; ref: string | null }
    | { type: "checkpoint"; checkpointId: string };
  const gitToken = body.gitHubToken?.trim() || c.req.header("X-Git-Token")?.trim() || null;
  try {
    normalizedBootstrapSource = (() => {
      const source = body.bootstrapSource;
      if (!source || source.type === "blank") return { type: "blank" } as const;
      if (source.type === "git_repo") {
        const repoUrl = source.repoUrl?.trim();
        if (!repoUrl) throw new Error("repoUrl is required");
        return { type: "git_repo", repoUrl, ref: source.ref?.trim() || null } as const;
      }
      if (source.type === "checkpoint") {
        const checkpointId = source.checkpointId?.trim();
        if (!checkpointId || !requireValidId(checkpointId)) throw new Error("checkpointId is required");
        return { type: "checkpoint", checkpointId } as const;
      }
      return { type: "blank" } as const;
    })();
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message.toLowerCase().replace(/\.$/, "") : "invalid bootstrap source" }, 400);
  }

  if (normalizedBootstrapSource.type === "checkpoint") {
    const [checkpoint] = await db.select().from(checkpoints).where(eq(checkpoints.id, normalizedBootstrapSource.checkpointId)).limit(1);
    if (!checkpoint) return c.json({ message: "checkpoint not found" }, 404);
    if (!(await hasPermission(user, "checkpoint.view", { spaceId: checkpoint.spaceId }))) return authzDenied(c);
  }

  const spaceId = crypto.randomUUID();
  const storageRepoName = buildStorageRepoName(spaceId);

  const createMods = Array.isArray(body.mods) ? body.mods : getDefaultSpaceModsForEnv(config.env);
  const preparedModValues = await prepareSpaceModInserts({
    actor: user,
    spaceId,
    mods: createMods,
    existing: [],
  }).catch((error) => {
    const response = spaceModErrorResponse(error);
    if (response) return response;
    throw error;
  });
  if (!Array.isArray(preparedModValues)) return c.json({ message: preparedModValues.message }, preparedModValues.status);

  let space: typeof spaces.$inferSelect | undefined;
  let insertedChannels: Array<typeof spaceChannels.$inferSelect> = [];
  try {
    const result = await db.transaction(async (tx) => {
      // Serialize free-plan quota checks per owner so concurrent creates cannot
      // both observe count < limit and both insert.
      if (!spaceOwnedUnlimited) {
        await tx.execute(sql`select pg_advisory_xact_lock(${OWNED_SPACE_QUOTA_LOCK_NS}, hashtext(${user.uuid}))`);
        const [owned] = await tx
          .select({ value: count() })
          .from(spaces)
          .where(eq(spaces.userUuid, user.uuid));
        if ((owned?.value ?? 0) >= FREE_OWNED_SPACE_LIMIT) {
          throw new SpaceOwnedLimitError();
        }
      }

      const [createdSpace] = await tx
        .insert(spaces)
        .values({
          id: spaceId,
          userUuid: user.uuid,
          name,
          slug,
          description: body.description ?? null,
          storageRepoName,
          baseCheckpointId: normalizedBootstrapSource.type === "checkpoint" ? normalizedBootstrapSource.checkpointId : null,
          headCheckpointId: null,
          lastActivityAt: new Date(),
          meta: {
            ...(body.meta ?? {}),
            config: {
              ...(isRecord(body.meta?.config) ? body.meta.config : {}),
              sandbox: {
                provider: normalizedConfig.sandbox?.provider ?? "cloud",
                autoDestroy: normalizedConfig.sandbox?.autoDestroy ?? DEFAULT_SPACE_SANDBOX_AUTO_DESTROY,
                spec: requestedSpec,
              },
            },
            extraEnv: normalizedExtraEnv,
            bootstrap: {
              status: "pending",
              stage: null,
              taskRunId: null,
              errorMessage: null,
              source: normalizedBootstrapSource,
              startedAt: null,
              finishedAt: null,
            },
          },
        })
        .returning();
      if (!createdSpace) throw new Error("failed to create space");

      await tx.insert(spaceMembers).values({
        spaceId: createdSpace.id,
        userId: user.uuid,
        role: "host",
        createdBy: user.uuid,
        updatedBy: user.uuid,
      });

      if (preparedModValues.length > 0) {
        await tx.insert(spaceMods).values(preparedModValues);
      }

      for (const binding of normalizedChannelBindings) {
        if (!(await validateChannelModelConfig(tx as unknown as typeof db, createdSpace.id, binding.config?.model ?? null))) {
          throw new Error("model not found");
        }
      }

      const createdChannels = normalizedChannelBindings.length > 0
        ? await tx
            .insert(spaceChannels)
            .values(
              normalizedChannelBindings.map((binding) => ({
                spaceId: createdSpace.id,
                channelId: binding.channelId,
                config: binding.config,
              })),
            )
            .returning()
        : [];

      return { space: createdSpace, insertedChannels: createdChannels };
    });
    space = result.space;
    insertedChannels = result.insertedChannels;
  } catch (error) {
    if (error instanceof SpaceOwnedLimitError) {
      return featureGateResponse(c, {
        source: "space_owned_limit",
        message: "Free plan includes one space. Upgrade to create more.",
        title: "Upgrade to create more spaces",
        conversionMessage: "Your plan includes one space. Upgrade to create unlimited spaces.",
      });
    }
    const constraint = uniqueViolationConstraint(error);
    if (constraint?.includes("user_slug")) return c.json({ message: "space slug already exists" }, 409);
    const modResponse = spaceModErrorResponse(error);
    if (modResponse) return c.json({ message: modResponse.message }, modResponse.status);
    if (error instanceof Error && error.message === "model not found") return c.json({ message: "model not found" }, 400);
    throw error;
  }

  if (!space) return c.json({ message: "failed to create space" }, 500);

  // Keep the runtime env cache in sync at creation time. The agent reads
  // user-provided space env from Redis (not directly from DB meta), so spaces
  // created with extraEnv must populate Redis before the sandbox/session starts.
  // Later env panel writes already go through persistSpaceEnv(), which does the
  // same cache update.
  await setSpaceEnv(space.id, normalizedExtraEnv);

  if (insertedChannels.length > 0) {
    await Promise.all(
      insertedChannels.map((channel) =>
        syncSpaceChannelConfigCache({
          spaceChannelId: channel.id,
          config: (channel.config as Record<string, unknown> | null) ?? null,
        }),
      ),
    );
    // Push channel config to gateway so it starts long-polling
    void bindSpaceChannelsToGateway(space.id).catch((error) => logger.error("[SpaceChannels] failed to bind channels after space creation", { spaceId: space.id, error }));
  }

  if ((normalizedConfig.sandbox?.provider ?? "cloud") === "local") {
    // Local sandboxes are provided by the user's machine via the gateway relay.
    // Skip cloud pod provisioning and idle auto-destroy; register the row before
    // enqueuing bootstrap so the worker never races ahead of a missing sandbox.
    try {
      await ensureSpaceSandbox({
        spaceId: space.id,
        provider: "local",
        status: "stopped",
        runtimeStatus: "unknown",
        stopReason: "disconnected",
        stoppedAt: new Date(),
      });
    } catch (error) {
      logger.error("[LocalSandbox] failed to register local sandbox after space creation", { spaceId: space.id, error });
      return c.json({ message: "failed to register local sandbox" }, 500);
    }
  } else {
    void scheduleSandboxAutoDestroy({
      spaceId: space.id,
      policy: normalizedConfig.sandbox?.autoDestroy ?? DEFAULT_SPACE_SANDBOX_AUTO_DESTROY,
      baseAt: space.createdAt ? new Date(space.createdAt) : new Date(),
    }).catch((error) => logger.error("[SandboxAutoDestroy] failed to schedule policy after space creation", { spaceId: space.id, error }));
    void reconcileSpaceSandbox(
      {
        ...getSpaceProvisionParams(user, space),
        mode: "ensure",
        reason: "space_created",
      },
    ).catch((error) => logger.error("[SandboxPublicNetwork] failed to reconcile after space creation", { spaceId: space.id, error }));
  }

  const taskData: Record<string, unknown> = { source: normalizedBootstrapSource };
  // TODO: gitToken is stored in taskData (BullMQ Redis + DB task_runs).
  // For long-term security, encrypt it or use a temporary token reference.
  if (gitToken) taskData.gitToken = gitToken;

  const job = await enqueueTask({
    type: "create_space",
    spaceId: space.id,
    userId: user.uuid,
    data: taskData,
  }).catch(async (error) => {
    const nextMeta = {
      ...((space.meta as Record<string, unknown> | null) ?? {}),
      bootstrap: {
        status: "failed",
        stage: null,
        taskRunId: null,
        errorMessage: error instanceof Error ? error.message : String(error),
        source: normalizedBootstrapSource,
        startedAt: null,
        finishedAt: new Date().toISOString(),
      },
    };
    await db
      .update(spaces)
      .set({ meta: nextMeta, updatedAt: new Date(), lastActivityAt: new Date() })
      .where(eq(spaces.id, space.id));
    throw error;
  });
  const taskRunId = job.taskRunId;
  if (!taskRunId) {
    await db
      .update(spaces)
      .set({
        meta: {
          ...((space.meta as Record<string, unknown> | null) ?? {}),
          bootstrap: {
            status: "failed",
            stage: null,
            taskRunId: null,
            errorMessage: "failed to allocate create_space task id",
            source: normalizedBootstrapSource,
            startedAt: null,
            finishedAt: new Date().toISOString(),
          },
        },
        updatedAt: new Date(),
        lastActivityAt: new Date(),
      })
      .where(eq(spaces.id, space.id));
    return c.json({ message: "failed to create bootstrap job" }, 500);
  }

  const [spaceWithJob] = await db
    .update(spaces)
    .set({
      meta: {
        ...((space.meta as Record<string, unknown> | null) ?? {}),
        bootstrap: {
          status: "pending",
          stage: null,
          taskRunId,
          errorMessage: null,
          source: normalizedBootstrapSource,
          startedAt: null,
          finishedAt: null,
        },
      },
      updatedAt: new Date(),
      lastActivityAt: new Date(),
    })
    .where(eq(spaces.id, space.id))
    .returning();

  const createdSpace = spaceWithJob ?? space;
  return c.json({ space: await serializeSpaceForResponse(createdSpace, user), taskRunId });
});

/**
 * Remove fields that are sensitive or irrelevant when a Work runtime session
 * lists the viewer's spaces. All omitted fields are already optional in the
 * SDK type, so the response stays type-compatible.
 */
function stripSensitiveSpaceFields(item: Record<string, unknown>): Record<string, unknown> {
  const { storageRepoName, sandboxStatus, access, meta, ...rest } = item;
  void storageRepoName;
  void sandboxStatus;
  void access;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const { extraEnv, config, ...safeMeta } = meta as Record<string, unknown>;
    void extraEnv;
    void config;
    return { ...rest, meta: safeMeta };
  }
  return rest;
}

async function buildDefaultSpaceResponse(c: Context, space: SpaceRow, user: AuthUser) {
  if (!getWorkSessionPrincipal(c)) return serializeSpaceForResponse(space, user);
  const [item] = await buildSpaceListItems([space]);
  return item ? stripSensitiveSpaceFields(item) : null;
}

// ── GET /api/spaces/:id ──────────────────────────────────────────────────────

async function serializeSpaceForResponse(space: typeof spaces.$inferSelect, user: AuthUser | null) {
  const [sandbox, access] = await Promise.all([
    getSpaceSandboxBySpaceId(space.id),
    resolvePermissionAccess(user, { spaceId: space.id }),
  ]);
  const profileMap = await getProfilesByUuids([space.userUuid]);
  const ownerProfile = profileMap.get(space.userUuid) ?? fallbackPublicUserProfile(space.userUuid);

  return {
    ...space,
    meta: sanitizeSpaceMeta(space.meta),
    publicProfile: getSpacePublicProfile(space),
    sandboxStatus: sandbox?.status ?? null,
    sandbox: attachSandboxPublicEndpoints(sandbox),
    access,
    ownerProfile,
  };
}

function sanitizeRepoUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function sanitizeSpaceMeta(meta: unknown): Record<string, unknown> | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return meta as null;
  }
  const metaObj = meta as Record<string, unknown>;
  const bootstrap = metaObj.bootstrap;
  if (
    !bootstrap ||
    typeof bootstrap !== "object" ||
    Array.isArray(bootstrap)
  ) {
    return metaObj;
  }
  const bootstrapObj = bootstrap as Record<string, unknown>;
  const source = bootstrapObj.source;
  if (
    !source ||
    typeof source !== "object" ||
    Array.isArray(source)
  ) {
    return metaObj;
  }
  const sourceObj = source as Record<string, unknown>;
  if (sourceObj.type === "git_repo" && typeof sourceObj.repoUrl === "string") {
    return {
      ...metaObj,
      bootstrap: {
        ...bootstrapObj,
        source: {
          ...sourceObj,
          repoUrl: sanitizeRepoUrl(sourceObj.repoUrl as string),
        },
      },
    };
  }
  return metaObj;
}

router.get("/:id", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  if (await hasPermission(user, "space.view", { spaceId })) {
    return c.json(await serializeSpaceForResponse(space, user));
  }

  // Fallback: only session-level access — keep the response intentionally tiny.
  // Access is omitted here because effective permissions depend on a concrete session policy.
  return c.json({
    id: space.id,
    name: space.name,
    accessLevel: "minimal" as const,
  });
});

// ── GET /api/spaces/by-slug/:username/:slug ────────────────────────────────

router.get("/by-slug/:username/:slug", async (c) => {
  const user = getOptionalAuth(c);
  const username = c.req.param("username");
  const rawSlug = c.req.param("slug");
  const { slug, error: slugError } = normalizeSpaceSlug(rawSlug);
  if (slugError || !slug) return c.json({ message: "space not found" }, 404);

  const [profile] = await db
    .select({ userUuid: userProfiles.userUuid })
    .from(userProfiles)
    .where(eq(userProfiles.username, username))
    .limit(1);
  if (!profile) return c.json({ message: "space not found" }, 404);

  const [space] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.userUuid, profile.userUuid), eq(spaces.slug, slug)))
    .limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  if (await hasPermission(user, "space.view", { spaceId: space.id })) {
    return c.json(await serializeSpaceForResponse(space, user));
  }

  return c.json({
    id: space.id,
    name: space.name,
    slug: space.slug,
    accessLevel: "minimal" as const,
  });
});

// ── PATCH /api/spaces/:id (rename / slug) ───────────────────────────────────

router.patch("/:id", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<{ name?: string; slug?: string | null }>().catch(() => null);
  if (!body) return c.json({ message: "invalid body" }, 400);

  const updates: Partial<Pick<typeof spaces.$inferSelect, "name" | "slug">> = {};

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return c.json({ message: "name is required" }, 400);
    if (name !== space.name) {
      const duplicate = await db
        .select({ id: spaces.id })
        .from(spaces)
        .where(and(eq(spaces.userUuid, space.userUuid), eq(spaces.name, name)))
        .limit(1);
      if (duplicate.length > 0) return c.json({ message: "space name already exists" }, 409);
      updates.name = name;
    }
  }

  if (body.slug !== undefined) {
    const { slug, error: slugError } = normalizeSpaceSlug(body.slug);
    if (slugError) return c.json({ message: slugError }, 400);
    if (!slug && space.slug) return c.json({ message: "space slug cannot be cleared once set" }, 400);
    if (slug !== space.slug) updates.slug = slug;
  }

  if (updates.name === undefined && updates.slug === undefined) {
    return c.json({ space: await serializeSpaceForResponse(space, user) });
  }

  try {
    const [updated] = await db
      .update(spaces)
      .set({ ...updates, updatedAt: new Date(), lastActivityAt: new Date() })
      .where(eq(spaces.id, spaceId))
      .returning();

    const result = updated ?? space;
    return c.json({ space: await serializeSpaceForResponse(result, user) });
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint?.includes("user_slug")) return c.json({ message: "space slug already exists" }, 409);
    throw error;
  }
});

// ── PATCH /api/spaces/:id/profile ───────────────────────────────────────────

router.patch("/:id/profile", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || !isRecord(body)) return c.json({ message: "invalid body" }, 400);

  let nextDescription = space.description;
  if ("description" in body) {
    if (body.description !== null && typeof body.description !== "string") {
      return c.json({ message: "description must be a string or null" }, 400);
    }
    if (typeof body.description === "string" && body.description.length > MAX_SPACE_DESCRIPTION_LENGTH) {
      return c.json({ message: `description must be at most ${MAX_SPACE_DESCRIPTION_LENGTH} characters` }, 400);
    }
    nextDescription = body.description;
  }

  const existingMeta = (space.meta as Record<string, unknown> | null) ?? {};
  const existingProfile = typeof existingMeta.publicProfile === "object" && existingMeta.publicProfile !== null && !Array.isArray(existingMeta.publicProfile)
    ? existingMeta.publicProfile as Record<string, unknown>
    : {};
  const nextProfile: Record<string, unknown> = { ...existingProfile };
  if ("avatarUrl" in body) {
    if (body.avatarUrl !== null && typeof body.avatarUrl !== "string") {
      return c.json({ message: "avatarUrl must be a URL string or null" }, 400);
    }
    const avatarUrl = body.avatarUrl === null ? null : normalizePublicAvatarUrl(body.avatarUrl);
    if (body.avatarUrl !== null && !avatarUrl) {
      return c.json({ message: "avatarUrl must be a valid http(s) URL under 2048 characters" }, 400);
    }
    nextProfile.avatarUrl = avatarUrl;
    delete nextProfile.pictureUrl;
  }

  const [updated] = await db
    .update(spaces)
    .set({
      description: nextDescription,
      meta: { ...existingMeta, publicProfile: nextProfile },
      updatedAt: new Date(),
      lastActivityAt: new Date(),
    })
    .where(eq(spaces.id, spaceId))
    .returning();

  const result = updated ?? space;
  return c.json({ space: await serializeSpaceForResponse(result, user) });
});

// ── Checkpoints ──────────────────────────────────────────────────────────────

router.post("/:id/checkpoints", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "checkpoint.edit", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<{ description?: string }>().catch(() => null);
  const description = body?.description?.trim() || null;

  if (space.name === "config") {
    const duplicateConfigSpaces = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.userUuid, space.userUuid), eq(spaces.name, "config")))
      .limit(2);
    if (duplicateConfigSpaces.length > 1) {
      return c.json({ message: "multiple config spaces found for this user" }, 409);
    }
  }

  const existingSave = await db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .where(and(eq(taskRuns.spaceId, spaceId), eq(taskRuns.taskType, "save_checkpoint"), inArray(taskRuns.status, ["pending", "running"])))
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);
  if (existingSave[0]) return c.json({ ok: true, taskRunId: existingSave[0].id, existing: true });

  const saveLockBusy = await redisCommandClient.exists(getSpaceSaveCheckpointLockKey(spaceId)).catch((error) => {
    logger.warn(`[Checkpoints] failed to check save lock for space=${spaceId}`, error);
    return 0;
  });
  if (saveLockBusy) {
    return c.json({ message: "Checkpoint save in progress.", reason: "save_checkpoint_lock_busy" }, 409);
  }

  const { taskRunId } = await enqueueTask({
    type: "save_checkpoint",
    spaceId,
    userId: user.uuid,
    data: { spaceId, description },
  });

  return c.json({ ok: true, taskRunId });
});

const DEFAULT_CHECKPOINT_LIST_LIMIT = 20;
const MAX_CHECKPOINT_LIST_LIMIT = 100;

const encodeCheckpointListCursor = (
  checkpoint: { id: string; createdAt: Date | string | null } | null | undefined,
) => {
  if (!checkpoint?.createdAt) return null;
  const createdAt = checkpoint.createdAt instanceof Date
    ? checkpoint.createdAt.toISOString()
    : new Date(checkpoint.createdAt).toISOString();
  return `${createdAt}|${checkpoint.id}`;
};

const decodeCheckpointListCursor = (cursor: string | null | undefined) => {
  if (!cursor) return null;
  const separatorIndex = cursor.lastIndexOf("|");
  const rawDate = separatorIndex > 0 ? cursor.slice(0, separatorIndex) : cursor;
  const id = separatorIndex > 0 ? cursor.slice(separatorIndex + 1) : null;
  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) return null;
  return { date, id };
};

router.get("/:id/checkpoints", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "checkpoint.view", { spaceId }))) return authzDenied(c);

  const limitParam = Number(c.req.query("limit") ?? DEFAULT_CHECKPOINT_LIST_LIMIT);
  const rawLimit = Math.trunc(limitParam);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_CHECKPOINT_LIST_LIMIT)
    : DEFAULT_CHECKPOINT_LIST_LIMIT;
  const cursor = decodeCheckpointListCursor(c.req.query("cursor"));

  const rows = await db
    .select({
      id: checkpoints.id,
      spaceId: checkpoints.spaceId,
      commitHash: checkpoints.commitHash,
      description: checkpoints.description,
      parentCheckpointId: checkpoints.parentCheckpointId,
      rootCheckpointId: checkpoints.rootCheckpointId,
      forkCount: checkpoints.forkCount,
      saveVersion: checkpoints.saveVersion,
      createdAt: checkpoints.createdAt,
    })
    .from(checkpoints)
    .where(
      cursor
        ? and(
            eq(checkpoints.spaceId, spaceId),
            or(
              lt(checkpoints.createdAt, cursor.date),
              cursor.id
                ? and(eq(checkpoints.createdAt, cursor.date), lt(checkpoints.id, cursor.id))
                : undefined,
            ),
          )
        : eq(checkpoints.spaceId, spaceId),
    )
    .orderBy(desc(checkpoints.createdAt), desc(checkpoints.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const listedCheckpoints = hasMore ? rows.slice(0, limit) : rows;

  return c.json({
    checkpoints: listedCheckpoints,
    pageInfo: {
      hasMore,
      nextCursor: hasMore ? encodeCheckpointListCursor(listedCheckpoints.at(-1)) : null,
    },
  });
});

router.get("/:id/checkpoints/:checkpointId", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  const checkpointId = c.req.param("checkpointId");
  if (!requireValidId(spaceId) || !requireValidId(checkpointId)) {
    return c.json({ message: "checkpoint not found" }, 404);
  }
  if (!(await hasPermission(user, "checkpoint.view", { spaceId }))) return authzDenied(c);

  const [checkpoint] = await db
    .select()
    .from(checkpoints)
    .where(and(eq(checkpoints.id, checkpointId), eq(checkpoints.spaceId, spaceId)))
    .limit(1);

  if (!checkpoint) return c.json({ message: "checkpoint not found" }, 404);

  return c.json({ checkpoint });
});

// In production, these checkpoints/fs routes are routed to fs-api by the gateway.
// This remains a local/non-split fallback.
router.get("/:id/checkpoints/:checkpointId/fs/tree", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  const checkpointId = c.req.param("checkpointId");
  if (!requireValidId(spaceId) || (checkpointId !== "latest" && !requireValidId(checkpointId))) return c.json({ code: "checkpoint_not_found", message: "Checkpoint not found." }, 404);
  if (!(await hasPermission(user, "checkpoint.view", { spaceId }))) return authzDenied(c);

  try {
    return c.json(await listCheckpointDirectory({ spaceId, checkpointId, path: c.req.query("path") ?? "" }));
  } catch (error) {
    const { status, body } = checkpointFsJsonError(error);
    return c.json(body, status as never);
  }
});

router.get("/:id/checkpoints/:checkpointId/fs/file", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  const checkpointId = c.req.param("checkpointId");
  if (!requireValidId(spaceId) || (checkpointId !== "latest" && !requireValidId(checkpointId))) return c.json({ code: "checkpoint_not_found", message: "Checkpoint not found." }, 404);
  if (!(await hasPermission(user, "checkpoint.view", { spaceId }))) return authzDenied(c);

  try {
    return c.json(await readCheckpointFile({ spaceId, checkpointId, path: c.req.query("path") ?? "" }));
  } catch (error) {
    const { status, body } = checkpointFsJsonError(error);
    return c.json(body, status as never);
  }
});

// ── Env ──────────────────────────────────────────────────────────────────────

function getExtraEnvFromSpace(space: typeof spaces.$inferSelect) {
  const meta = space.meta as Record<string, unknown> | null;
  return normalizeSpaceEnv(meta?.extraEnv);
}

async function persistSpaceEnv(space: typeof spaces.$inferSelect, envs: Array<{ name: string; value: string }>) {
  const existingMeta = space.meta as Record<string, unknown> | null;
  await db
    .update(spaces)
    .set({
      meta: { ...existingMeta, extraEnv: envs },
      updatedAt: new Date(),
      lastActivityAt: new Date(),
    })
    .where(eq(spaces.id, space.id));
  await setSpaceEnv(space.id, envs);
}

router.get("/:id/env", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  const envs = getExtraEnvFromSpace(space);
  return c.json({ env: envs });
});

const toSpaceEnvValidationResponse = (error: unknown) => {
  if (!(error instanceof SpaceEnvValidationError)) return null;
  return { message: error.message };
};

const validateSpaceEnvForResponse = (envs: Array<{ name: string; value: string }>) => {
  try {
    validateSpaceEnv(envs);
    return null;
  } catch (error) {
    const response = toSpaceEnvValidationResponse(error);
    if (response) return response;
    throw error;
  }
};

router.post("/:id/env", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  const body = await c.req.json<{ name: string; value: string }>().catch(() => null);
  if (!body?.name || body.value === undefined) return c.json({ message: "name and value are required" }, 400);

  const entry = { name: body.name.trim(), value: String(body.value) };
  if (SYSTEM_ENV_KEY_SET.has(entry.name)) {
    return c.json({ message: `env name "${entry.name}" is reserved by the system` }, 400);
  }

  const existing = getExtraEnvFromSpace(space);
  const filtered = existing.filter((e) => e.name !== entry.name);
  const updated = [...filtered, entry];
  const validationError = validateSpaceEnvForResponse(updated);
  if (validationError) return c.json(validationError, 400);
  await persistSpaceEnv(space, updated);

  return c.json({ env: updated }, 201);
});

router.put("/:id/env/:name", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const envName = c.req.param("name");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  if (!envName?.trim()) return c.json({ message: "env name is required" }, 400);
  if (SYSTEM_ENV_KEY_SET.has(envName)) {
    return c.json({ message: `env name "${envName}" is reserved by the system` }, 400);
  }

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  const body = await c.req.json<{ value?: string }>().catch(() => null);
  if (!body || body.value === undefined || body.value === null) return c.json({ message: "value is required" }, 400);

  const existing = getExtraEnvFromSpace(space);
  const target = existing.find((e) => e.name === envName);
  if (!target) return c.json({ message: `env "${envName}" not found` }, 404);

  target.value = String(body.value);
  const validationError = validateSpaceEnvForResponse(existing);
  if (validationError) return c.json(validationError, 400);
  await persistSpaceEnv(space, existing);

  return c.json({ env: existing });
});

router.delete("/:id/env/:name", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const envName = c.req.param("name");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  const existing = getExtraEnvFromSpace(space);
  const filtered = existing.filter((e) => e.name !== envName);
  if (filtered.length === existing.length) return c.json({ message: `env "${envName}" not found` }, 404);

  await persistSpaceEnv(space, filtered);
  return c.json({ env: filtered });
});

// ── Config ───────────────────────────────────────────────────────────────────

router.get("/:id/config", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.view", { spaceId }))) return authzDenied(c);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  const [allowedSpec, sandbox] = await Promise.all([
    user?.uuid ? getAllowedSandboxSpecId(user.uuid) : Promise.resolve(DEFAULT_SANDBOX_SPEC_ID),
    getSpaceSandboxBySpaceId(spaceId),
  ]);
  return c.json({
    config: {
      sandbox: {
        provider: getSpaceSandboxProvider(space),
        autoDestroy: getSpaceSandboxAutoDestroyPolicy(space),
        spec: getSpaceSandboxSpec(space),
        appliedSpec: isRecord(sandbox?.meta) && isSandboxSpecId(sandbox.meta.appliedSpec) ? sandbox.meta.appliedSpec : null,
        specPendingRestart: isRecord(sandbox?.meta) ? sandbox.meta.specPendingRestart === true : false,
        allowedSpec,
        specs: SANDBOX_SPECS,
      },
    },
  });
});

router.patch("/:id/config", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  const body = await c.req.json<{ sandbox?: { autoDestroy?: SpaceSandboxAutoDestroyPolicy; spec?: SandboxSpecId } }>().catch(() => null);
  if (!body) return c.json({ message: "invalid body" }, 400);

  let nextAutoDestroy: SpaceSandboxAutoDestroyPolicy;
  let nextSpec: SandboxSpecId;
  try {
    nextAutoDestroy = body.sandbox?.autoDestroy ? normalizeSpaceSandboxAutoDestroyPolicy(body.sandbox.autoDestroy) : getSpaceSandboxAutoDestroyPolicy(space);
    nextSpec = body.sandbox?.spec ? normalizeSpaceSandboxSpec(body.sandbox.spec) : getSpaceSandboxSpec(space);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid space config" }, 400);
  }

  const allowedSpec = await getAllowedSandboxSpecId(space.userUuid);
  if (getSandboxSpecRank(nextSpec) > getSandboxSpecRank(allowedSpec)) {
    return createSandboxSpecRequiredResponse(c, nextSpec);
  }

  const nextMeta = mergeSpaceConfig(space, { sandbox: { autoDestroy: nextAutoDestroy, spec: nextSpec } });

  const [updated] = await db.update(spaces).set({ meta: nextMeta, updatedAt: new Date(), lastActivityAt: new Date() }).where(eq(spaces.id, spaceId)).returning();
  if (!updated) return c.json({ message: "failed to update space config" }, 500);

  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  const baseAt = sandbox?.lastActivityAt ?? sandbox?.lastHeartbeatAt ?? sandbox?.createdAt ?? updated.createdAt ?? new Date();
  await scheduleSandboxAutoDestroy({ spaceId, policy: nextAutoDestroy, baseAt: baseAt ? new Date(baseAt) : null }).catch((error) => logger.error("[SandboxAutoDestroy] failed to reschedule policy", { spaceId, error }));

  const specResult = body.sandbox?.spec ? await resizeSpaceSandboxToSpec({ spaceId, specId: nextSpec }).catch(async (error) => {
    logger.warn("[SandboxSpec] failed to resize sandbox", { spaceId, specId: nextSpec, error });
    await markSandboxSpecPendingRestart({ spaceId, specId: nextSpec, reason: "resize_failed" }).catch((markError) => {
      logger.warn("[SandboxSpec] failed to mark pending restart", { spaceId, specId: nextSpec, error: markError });
    });
    return { resized: false, pendingRestart: true, message: error instanceof Error ? error.message : String(error) };
  }) : { resized: false, pendingRestart: false };

  return c.json({ space: await serializeSpaceForResponse(updated, user), sandbox: specResult });
});

// ── Sandbox ──────────────────────────────────────────────────────────────────

router.get("/:id/sandbox", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "sandbox.view", { spaceId }))) return authzDenied(c);

  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  return c.json({ sandbox: attachSandboxPublicEndpoints(sandbox) });
});

router.get("/:id/sandbox/ports", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "sandbox.view", { spaceId }))) return authzDenied(c);

  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  return c.json({ endpoints: attachSandboxPublicEndpoints(sandbox)?.publicEndpoints ?? {} });
});

router.post("/:id/sandbox/recreate", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "sandbox.manage", { spaceId }))) return authzDenied(c);

  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  const result = await recoverSpaceSandbox({
    ...getSpaceProvisionParams(user, space),
    reason: "manual_recreate",
    source: "manual",
    verify: true,
  });

  return c.json(result);
});

const MAX_COMMAND_LENGTH = 16 * 1024;

router.post("/:id/commands", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "command.execute", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<{ command?: string }>().catch(() => null);
  const command = body?.command?.trim();
  if (!command) return c.json({ message: "command is required" }, 400);
  if (command.length > MAX_COMMAND_LENGTH) return c.json({ message: `command is too long; max ${MAX_COMMAND_LENGTH} characters` }, 400);
  const cwd = "/workspace";

  const { taskRunId } = await enqueueTask({
    type: RUN_COMMAND_TASK_TYPE,
    spaceId,
    userId: user.uuid,
    data: {
      command,
      cwd,
      source: "command_palette",
    },
  });

  return c.json({ taskRunId });
});

// ── Sessions ─────────────────────────────────────────────────────────────────

router.post("/:id/prompt", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);

  const body = await c.req.json<SpacePromptInput>().catch(() => null);
  if (!validatePromptContentBlocks(body?.content)) {
    return c.json({ message: "content must be a non-empty ContentBlock array" }, 400);
  }
  const accessMode = normalizePromptAccessMode(body.accessMode);
  if (!accessMode) return c.json({ message: "accessMode must be one of: read_only, full_access" }, 400);
  const promptIntent = normalizeSpacePromptIntent(body.intent);
  if (!promptIntent) return c.json({ message: "intent must be one of: followup, steer" }, 400);
  const promptPermission = accessMode === "read_only" ? "session.prompt.readonly" : "session.prompt.fullaccess";
  if (!(await hasPermission(user, promptPermission, { spaceId }))) return authzDenied(c);

  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  if (body.sessionId && !requireValidId(body.sessionId)) return c.json({ message: "invalid sessionId" }, 400);

  let sessionId = body.sessionId?.trim() || null;
  let promptSession: SpaceRouteSessionRecord | null = null;
  let createdPromptSession: SpaceRouteSessionRecord | null = null;
  if (sessionId) {
    const session = await getSpaceSessionById(sessionId);
    if (!session || session.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);
    if (!(await hasPermission(user, promptPermission, { spaceId, sessionId }))) {
      return authzDenied(c);
    }
    promptSession = session;
  }

  const schedule = body.schedule ?? { mode: "immediate" as const };
  const mode = schedule.mode ?? "immediate";
  if (!["immediate", "delay", "at", "repeat"].includes(mode)) {
    return c.json({ message: "schedule.mode must be one of: immediate, delay, at, repeat" }, 400);
  }

  const generationPolicy = body.generationPolicy === undefined || body.generationPolicy === null
    ? null
    : normalizeGenerationPolicy(body.generationPolicy);
  if (body.generationPolicy !== undefined && body.generationPolicy !== null && !generationPolicy) {
    return c.json({ message: "generationPolicy is invalid" }, 400);
  }

  let promptLabelIds: string[] = [];
  try {
    const labelPaths = parseLabelRefs(body.labelRefs);
    if (labelPaths.length > 0) {
      const labelPermissionScope = sessionId ? { spaceId, sessionId } : { spaceId };
      if (!(await hasPermission(user, "space.label.assign", labelPermissionScope))) return authzDenied(c);
      const resolved = await resolveLabelPaths({ db, spaceId, paths: labelPaths });
      if (resolved.missingPaths.length > 0 && !(await hasPermission(user, "space.label.manage", { spaceId }))) return authzDenied(c);
      promptLabelIds = (await resolveOrCreateLabelPaths({ db, spaceId, paths: labelPaths, userId: user.uuid })).labelIds;
    }
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }

  let promptEnv: Record<string, string> | null = null;
  try {
    promptEnv = parsePromptEnv(body.env);
  } catch (error) {
    if (error instanceof PromptEnvValidationError) return c.json({ message: error.message }, 400);
    throw error;
  }

  const content = body.content;
  const clientMessageId = body.clientMessageId?.trim() || crypto.randomUUID();
  const sourceResult = normalizePromptSource(body.source);
  if (sourceResult.error) return c.json({ message: sourceResult.error }, 400);
  const source = sourceResult.source;

  const scheduledAuth = getScheduledPromptAuthContext(c, spaceId, user.uuid);
  const taskData = {
    content,
    clientMessageId,
    ...(generationPolicy ? { generationPolicy } : {}),
    ...(promptIntent !== "followup" ? { intent: promptIntent } : {}),
    ...(accessMode !== "full_access" ? { accessMode } : {}),
    ...(promptEnv ? { env: promptEnv } : {}),
    ...(source !== "scheduled_task" ? { source } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(body.title ? { title: body.title } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(body.provider ? { provider: body.provider } : {}),
    ...(promptLabelIds.length > 0 ? { labelIds: promptLabelIds } : {}),
    ...(scheduledAuth ? { auth: scheduledAuth } : {}),
  };

  if (mode === "immediate") {
    if (!sessionId) {
      promptSession = await createInitialSpaceSession({
        spaceId,
        sessionId: crypto.randomUUID(),
        userUuid: user.uuid,
        title: body.title ?? null,
        source,
        externalSessionId: null,
        meta: { createdBy: "api_space_prompt" },
      });
      createdPromptSession = promptSession;
      sessionId = promptSession.id;
    }

    try {
      if (promptLabelIds.length > 0) {
        await assignLabelsToSession({ db, spaceId, sessionId, labelIds: promptLabelIds, userId: user.uuid });
      }
      if (createdPromptSession) {
        const createdPromptSessionId = createdPromptSession.id;
        await assignSessionSourceSystemLabel({ db, spaceId, sessionId: createdPromptSessionId, source: createdPromptSession.source }).then(() =>
          dispatchLabelAssignmentsUpdated({ spaceId, resourceType: "session", resourceRef: createdPromptSessionId, sessionId: createdPromptSessionId }),
        ).catch((error) => {
          logger.warn("[SessionSourceLabel] failed to assign system source label", error);
        });
      }
      const { turnId } = await submitSessionPrompt({
        spaceId,
        sessionId,
        userId: user.uuid,
        clientMessageId,
        content,
        source,
        model: body.model ?? null,
        provider: body.provider ?? null,
        generationPolicy,
        intent: promptIntent,
        accessMode,
        env: promptEnv,
        context: { kind: "public_api", auth: getPromptAuthContext(c, spaceId) },
      });
      const response = await buildSpacePromptTurnResponse(await getSpaceSessionById(sessionId), turnId);
      if (!response) return c.json({ message: "turn not found" }, 500);
      return c.json(response);
    } catch (error) {
      if (error instanceof BillingAccessBlockedError) return billingBlockedResponse(c, error);
      if (error instanceof SandboxNotReadyError) return c.json({ message: "sandbox is not ready" }, 503);
      const inputError = promptInputError(error);
      if (inputError) return c.json({ message: inputError }, 400);
      throw error;
    }
  }

  if (mode === "delay") {
    const delayMs = Number((schedule as { delayMs?: number }).delayMs);
    if (!isPositiveSafeInteger(delayMs)) {
      return c.json({ message: "delayMs must be a positive integer, e.g. 600000" }, 400);
    }
    const scheduledAt = new Date(Date.now() + delayMs);
    const { taskRunId } = await enqueueTask({
      type: "send_message",
      spaceId,
      sessionId: sessionId ?? undefined,
      userId: user.uuid,
      data: taskData,
    }, { delay: delayMs, scheduledAt });
    return c.json({ mode: "delay", taskRunId, scheduledAt: scheduledAt.toISOString(), sessionId });
  }

  if (mode === "at") {
    const sendAt = (schedule as { sendAt?: string }).sendAt;
    if (!sendAt?.trim()) return c.json({ message: "sendAt is required, e.g. 2026-05-09T10:00:00+08:00" }, 400);
    let scheduledAt: Date;
    try {
      scheduledAt = parseScheduledAt(sendAt);
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message.toLowerCase().replace(/\.$/, "") : "invalid sendAt" }, 400);
    }
    const { taskRunId } = await enqueueTask({
      type: "send_message",
      spaceId,
      sessionId: sessionId ?? undefined,
      userId: user.uuid,
      data: taskData,
    }, { delay: scheduledAt.getTime() - Date.now(), scheduledAt });
    return c.json({ mode: "at", taskRunId, scheduledAt: scheduledAt.toISOString(), sessionId });
  }

  const repeat = schedule as { cronExpression?: string; timezone?: string };
  if (!repeat.cronExpression?.trim()) return c.json({ message: "cronExpression is required, e.g. 0 9 * * *" }, 400);
  if (!repeat.timezone?.trim()) return c.json({ message: "timezone is required, e.g. Asia/Shanghai" }, 400);
  let parsedRepeat: { cronExpression: string; timezone: string; nextRun: Date };
  try {
    parsedRepeat = validateRepeatSchedule({ cronExpression: repeat.cronExpression, timezone: repeat.timezone });
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message.toLowerCase().replace(/\.$/, "") : "invalid repeat schedule" }, 400);
  }

  const cronJob = await createCronJob({
    userId: user.uuid,
    title: body.title?.trim() || "scheduled prompt",
    taskType: "send_message",
    payload: taskData,
    schedule: { pattern: parsedRepeat.cronExpression, timezone: parsedRepeat.timezone },
    spaceId,
    sessionId,
  });

  return c.json({
    mode: "repeat",
    cronJobId: cronJob.id,
    nextRunAt: parsedRepeat.nextRun.toISOString(),
    timezone: parsedRepeat.timezone,
    sessionId,
  });
});

router.post("/:id/sessions/:sessionId/turns/:turnId/steer", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const sessionId = c.req.param("sessionId");
  const turnId = c.req.param("turnId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId) || !requireValidId(turnId)) return c.json({ message: "not found" }, 404);
  if (!(await hasPermission(user, "session.prompt.fullaccess", { spaceId, sessionId }))) return authzDenied(c);

  try {
    const result = await promoteQueuedTurnToSteer({ spaceId, sessionId, turnId, actorUserId: user.uuid });
    await Promise.all(result.affectedTurns.map((turn) => dispatchTurnUpdated({ spaceId, sessionId, turn }).catch((error) => logger.warn("[SessionTurn] failed to dispatch steered turn", error))));
    return c.json({ ok: true, turn: result.turn, affectedTurns: result.affectedTurns });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "session not found") return c.json({ message }, 404);
    if (message === "failed to enqueue steered turn") return c.json({ message }, 503);
    if (message.includes("not queued") || message.includes("only follow-up")) return c.json({ message }, 409);
    throw error;
  }
});

router.post("/:id/sessions/:sessionId/turns/:turnId/cancel", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const sessionId = c.req.param("sessionId");
  const turnId = c.req.param("turnId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId) || !requireValidId(turnId)) return c.json({ message: "not found" }, 404);
  if (!(await hasPermission(user, "session.prompt.fullaccess", { spaceId, sessionId }))) return authzDenied(c);

  try {
    const turn = await cancelQueuedTurn({ spaceId, sessionId, turnId, actorUserId: user.uuid });
    await dispatchTurnUpdated({ spaceId, sessionId, turn }).catch((error) => logger.warn("[SessionTurn] failed to dispatch cancelled turn", error));
    return c.json({ ok: true, turn });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "session not found" || message === "turn not found") return c.json({ message }, 404);
    if (message.includes("not queued") || message.includes("only follow-up")) return c.json({ message }, 409);
    throw error;
  }
});

router.post("/:id/sessions", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "session.prompt.fullaccess", { spaceId }))) return authzDenied(c);

  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  let body: { title?: string | null; source?: string | null; labelRefs?: unknown };
  try {
    body = await c.req.json<{ title?: string | null; source?: string | null; labelRefs?: unknown }>();
  } catch {
    return c.json({ message: "invalid json body" }, 400);
  }

  let userLabelIds: string[] = [];
  try {
    const labelPaths = parseLabelRefs(body.labelRefs);
    if (labelPaths.length > 0) {
      if (!(await hasPermission(user, "space.label.assign", { spaceId }))) return authzDenied(c);
      const resolved = await resolveLabelPaths({ db, spaceId, paths: labelPaths });
      if (resolved.missingPaths.length > 0 && !(await hasPermission(user, "space.label.manage", { spaceId }))) return authzDenied(c);
      userLabelIds = (await resolveOrCreateLabelPaths({ db, spaceId, paths: labelPaths, userId: user.uuid })).labelIds;
    }
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
  }

  const source = body.source?.trim() || "public_api";
  const session = await createInitialSpaceSession({
    spaceId: space.id,
    sessionId: crypto.randomUUID(),
    userUuid: user.uuid,
    title: body.title ?? null,
    source,
    externalSessionId: null,
    meta: { createdBy: "api_space_session_create" },
  });

  if (userLabelIds.length > 0) {
    await assignLabelsToSession({ db, spaceId, sessionId: session.id, labelIds: userLabelIds, userId: user.uuid });
  }
  await assignSessionSourceSystemLabel({ db, spaceId, sessionId: session.id, source }).then(() =>
    dispatchLabelAssignmentsUpdated({ spaceId, resourceType: "session", resourceRef: session.id, sessionId: session.id }),
  ).catch((error) => {
    logger.warn("[SessionSourceLabel] failed to assign system source label", error);
  });

  return c.json({ ok: true, session });
});

router.get("/:id/sessions", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId }))) return authzDenied(c);

  const limitParam = Number(c.req.query("limit") ?? 20);
  const limit = Number.isFinite(limitParam) ? limitParam : 20;
  const cursor = c.req.query("cursor") ?? null;
  const { sessions, pageInfo } = await listSpaceSessions(spaceId, { limit, cursor });

  // Member users have space-level permission that covers all sessions.
  // Only non-members need per-session accessPolicy checks.
  const isMember = user?.uuid
    ? (await getSpaceMemberRole(spaceId, user.uuid)) !== null
    : false;
  const visibleSessions = isMember
    ? sessions
    : await filterSessionsByPermission(user, "session.view", spaceId, sessions);

  const hydratedSessions = await hydrateSessionParticipantProfiles(visibleSessions);

  const includeForks = c.req.query("includeForks") === "1" || c.req.query("includeForks") === "true";
  const forks = includeForks
    ? (await listSessionForksForSessions(visibleSessions.map((session) => session.id))).map((fork) => {
      if (isMember) return fork;
      const visibleSessionIds = new Set(visibleSessions.map((session) => session.id));
      const parentVisible = visibleSessionIds.has(fork.parentSessionId);
      return {
        id: fork.id,
        spaceId: fork.spaceId,
        childSessionId: fork.childSessionId,
        parentSessionId: parentVisible ? fork.parentSessionId : null,
        depth: fork.depth,
        anchorSequence: fork.anchorSequence,
        createdAt: fork.createdAt,
        firstUserTextAfterFork: fork.firstUserTextAfterFork,
        parentTitle: parentVisible ? fork.parentTitle : null,
      };
    })
    : undefined;

  return c.json({ sessions: hydratedSessions, ...(forks ? { forks } : {}), pageInfo });
});

// ── Channels ─────────────────────────────────────────────────────────────────

router.get("/:id/channels", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "channel.view", { spaceId }))) return authzDenied(c);

  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  const channels = await getSpaceChannelsBySpaceId(space.id);
  const channelIds = channels.map((item) => item.channelId);
  const channelList =
    channelIds.length > 0
      ? await db.select().from(userChannels).where(inArray(userChannels.id, channelIds))
      : [];

  const userChannelById = new Map(channelList.map((item) => [item.id, item]));

  return c.json(
    channels.map((channel) => ({
      ...channel,
      channel: userChannelById.get(channel.channelId) ?? null,
    })),
  );
});

// ── POST /api/spaces/:id/channels/:channelId — bind a channel at runtime ─────────────────

router.post("/:id/channels/:channelId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const channelId = c.req.param("channelId");
  if (!requireValidId(spaceId) || !requireValidId(channelId)) {
    return c.json({ message: "space or channel not found" }, 404);
  }
  if (!(await hasPermission(user, "channel.manage", { spaceId }))) return authzDenied(c);

  // Verify ownership: the channel must belong to the same user
  const [userChannel] = await db.select().from(userChannels).where(and(eq(userChannels.id, channelId), eq(userChannels.userUuid, user.uuid))).limit(1);
  if (!userChannel) return c.json({ message: "channel not owned by you" }, 403);

  // Check if already bound to any space
  const [existingBinding] = await db.select({ id: spaceChannels.id }).from(spaceChannels).where(eq(spaceChannels.channelId, channelId)).limit(1);
  if (existingBinding) return c.json({ message: "channel is already bound to another space" }, 409);

  const body = (await c.req.json<{ config?: unknown }>().catch(() => ({}))) as { config?: unknown };
  let channelConfig: ReturnType<typeof parseChannelConfigPatch>;
  try {
    channelConfig = parseChannelConfigPatch(body.config ?? null);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid channel config" }, 400);
  }
  if (!(await validateChannelModelConfig(db, spaceId, channelConfig?.model ?? null))) {
    return c.json({ message: "model not found" }, 400);
  }

  const [spaceChannel] = await db.insert(spaceChannels).values({
    spaceId,
    channelId,
    config: channelConfig,
  }).returning();

  if (!spaceChannel) return c.json({ message: "failed to bind channel" }, 500);

  // Push to gateway so it starts listening (bindSingleChannelToGateway handles config cache internally)
  void bindSpaceChannelsToGateway(spaceId).catch((error) => logger.error("[SpaceChannels] failed to bind channel to gateway", { spaceId, error }));

  return c.json(spaceChannel, 201);
});

// ── PATCH /api/spaces/:id/channels/:channelId — update channel config ───────────────────

router.patch("/:id/channels/:channelId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const channelId = c.req.param("channelId");
  if (!requireValidId(spaceId) || !requireValidId(channelId)) {
    return c.json({ message: "space or channel not found" }, 404);
  }
  if (!(await hasPermission(user, "channel.manage", { spaceId }))) return authzDenied(c);

  const [spaceChannel] = await db.select().from(spaceChannels).where(and(eq(spaceChannels.spaceId, spaceId), eq(spaceChannels.channelId, channelId))).limit(1);
  if (!spaceChannel) return c.json({ message: "channel not bound to this space" }, 404);

  const body = (await c.req.json<{ config?: unknown }>().catch(() => ({}))) as { config?: unknown };
  let configPatch: ReturnType<typeof parseChannelConfigPatch>;
  try {
    configPatch = parseChannelConfigPatch(body.config ?? null);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid channel config" }, 400);
  }

  const nextConfig = mergeChannelConfig(spaceChannel.config, configPatch);
  if (!(await validateChannelModelConfig(db, spaceId, nextConfig?.model ?? null))) {
    return c.json({ message: "model not found" }, 400);
  }

  const updated = await updateSpaceChannelConfig({ spaceChannelId: spaceChannel.id, config: nextConfig });
  if (!updated) return c.json({ message: "failed to update channel config" }, 500);

  return c.json(updated);
});

// ── DELETE /api/spaces/:id/channels/:channelId — unbind a channel at runtime ─────────────

router.delete("/:id/channels/:channelId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const channelId = c.req.param("channelId");
  if (!requireValidId(spaceId) || !requireValidId(channelId)) {
    return c.json({ message: "space or channel not found" }, 404);
  }
  if (!(await hasPermission(user, "channel.manage", { spaceId }))) return authzDenied(c);

  const [spaceChannel] = await db.select().from(spaceChannels).where(and(eq(spaceChannels.spaceId, spaceId), eq(spaceChannels.channelId, channelId))).limit(1);
  if (!spaceChannel) return c.json({ message: "channel not bound to this space" }, 404);

  await db.delete(spaceChannels).where(eq(spaceChannels.id, spaceChannel.id));
  // Remove from gateway routing
  void unbindSpaceChannelFromGateway(spaceChannel.id).catch((error) => logger.error("[SpaceChannels] failed to unbind channel from gateway", { spaceId, spaceChannelId: spaceChannel.id, error }));

  return c.json({ ok: true });
});

export default router;

