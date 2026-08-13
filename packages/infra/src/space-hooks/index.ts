import { createHash, randomUUID } from "node:crypto";
import {
  getSpaceHooksRedisKey,
  isSpaceHookableEvent,
  SPACE_HOOK_DISPATCH_JOB,
  SPACE_HOOK_TASK_TYPE,
  SPACE_HOOKS_DIR,
  type SpaceHookEventEnvelope,
} from "@cohub/protocol";
import { buildAgentRunCommandJobId } from "../agent-queue/index.js";

export type { SpaceHookEventEnvelope };

type DispatchPayload = {
  event: SpaceHookEventEnvelope;
  eventActorUserId: string | null;
};

type TaskPayloadLike = {
  type: string;
  spaceId?: string;
  sessionId?: string;
  userId?: string;
  data?: Record<string, unknown>;
};

type EnqueueOptions = {
  [key: string]: unknown;
  jobId?: string;
  delay?: number;
  scheduledAt?: Date | null;
};

type RedisLike = {
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveEventActorUserId(payload: Record<string, unknown>) {
  const actor = isRecord(payload.actor) ? payload.actor : null;
  return asString(actor?.userId)
    ?? asString(actor?.userUuid)
    ?? asString(payload.userId)
    ?? asString(payload.userUuid)
    ?? null;
}

function collectChangedPaths(payload: Record<string, unknown>) {
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const paths: string[] = [];
  for (const change of changes) {
    if (!isRecord(change)) continue;
    if (typeof change.path === "string" && change.path.trim()) paths.push(change.path);
    if (typeof change.oldPath === "string" && change.oldPath.trim()) paths.push(change.oldPath);
  }
  return paths;
}

function touchesSpaceHooksDir(paths: string[]): boolean {
  return paths.some((path) => {
    const normalized = path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
    return normalized === SPACE_HOOKS_DIR || normalized.startsWith(`${SPACE_HOOKS_DIR}/`);
  });
}

/**
 * Lightweight cache gate for publishers (no core dependency).
 * - `empty`: cached and definitions.length === 0 → skip dispatch
 * - `present` | `unknown`: proceed to enqueue dispatch
 */
async function resolveHooksCacheGate(
  redis: RedisLike,
  spaceId: string,
): Promise<"empty" | "present" | "unknown"> {
  const raw = await redis.get(getSpaceHooksRedisKey(spaceId)).catch(() => null);
  if (!raw) return "unknown";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.definitions)) {
      return "unknown";
    }
    return parsed.definitions.length === 0 ? "empty" : "present";
  } catch {
    return "unknown";
  }
}

async function invalidateSpaceHooksCache(redis: RedisLike, spaceId: string) {
  return redis
    .del(getSpaceHooksRedisKey(spaceId))
    .then(() => true)
    .catch(() => false);
}

/** Stable id for the internal dispatch job (system queue, no task_runs). */
export function buildSpaceHookDispatchJobId(input: {
  spaceId: string;
  eventId: string;
  eventType: string;
}) {
  const digest = createHash("sha1")
    .update(`${input.spaceId}:${input.eventType}:${input.eventId}`)
    .digest("hex")
    .slice(0, 24);
  return `space-hook-dispatch-${digest}`;
}

/** Stable id for the user-visible execution task (task_runs / cohub-tasks). */
export function buildSpaceHookTaskId(input: {
  spaceId: string;
  eventId: string;
  eventType: string;
}) {
  const digest = createHash("sha1")
    .update(`${input.spaceId}:${input.eventType}:${input.eventId}`)
    .digest("hex")
    .slice(0, 24);
  return `space-hook-${digest}`;
}

/**
 * Skip re-entrant hook triggers from hook-generated session activity.
 * A prompt hook that listens to session.turn.finalized would otherwise loop forever.
 */
export function isReentrantSpaceHookEvent(input: {
  type: string;
  payload?: Record<string, unknown> | null;
}): boolean {
  if (input.type === "session.turn.finalized") {
    const payload = isRecord(input.payload) ? input.payload : null;
    const turn = isRecord(payload?.turn) ? payload.turn : null;
    const meta = isRecord(turn?.meta) ? turn.meta : null;
    if (!meta) return false;
    if (asString(meta.source) === "space_hook") return true;
    const context = isRecord(meta.context) ? meta.context : null;
    return asString(context?.kind) === "space_hook";
  }
  if (input.type === "task.updated") {
    const payload = isRecord(input.payload) ? input.payload : null;
    const task = isRecord(payload?.task) ? payload.task : null;
    if (!task) return false;
    // Hook execution tasks and the run_command children they spawn must not
    // re-trigger task hooks, or every hook run would loop forever.
    if (asString(task.type) === SPACE_HOOK_TASK_TYPE) return true;
    // Hook-spawned run_command children use jobId `run-command-` + the space_hook
    // execute task id (space-hook-*), see buildSpaceHookTaskId / runCommandHook.
    const jobId = asString(task.jobId) ?? "";
    return asString(task.type) === "run_command"
      && jobId.startsWith(buildAgentRunCommandJobId("space-hook-"));
  }
  return false;
}

function isDuplicateJobError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|duplicat|JobId/i.test(message);
}

/**
 * Fan-out helper for event publishers.
 *
 * - Filters non-hookable / re-entrant events
 * - Invalidates definition cache when `.cohub/hooks/**` changes
 * - Skips enqueue when Redis cache confirms the space has zero hooks
 * - Enqueues an internal `space_hook.dispatch` system job (never writes task_runs)
 */
export async function maybeEnqueueSpaceHookTask(input: {
  event: {
    id?: string | null;
    type: string;
    timestamp?: number;
    spaceId?: string | null;
    sessionId?: string | null;
    payload?: Record<string, unknown> | null;
  };
  /** Enqueue onto the system queue (`space_hook.dispatch`). */
  enqueue: (name: string, payload: DispatchPayload, options: EnqueueOptions) => Promise<unknown>;
  /** App Redis — optional; without it the empty-cache gate is skipped. */
  redis?: RedisLike | null;
}) {
  const spaceId = asString(input.event.spaceId);
  const type = asString(input.event.type);
  if (!spaceId || !type || !isSpaceHookableEvent(type)) return null;

  const payload = isRecord(input.event.payload) ? input.event.payload : {};
  if (isReentrantSpaceHookEvent({ type, payload })) return null;

  const event: SpaceHookEventEnvelope = {
    id: asString(input.event.id) ?? randomUUID(),
    type,
    timestamp: typeof input.event.timestamp === "number" ? input.event.timestamp : Date.now(),
    spaceId,
    sessionId: asString(input.event.sessionId),
    payload,
  };

  const hooksConfigChanged = type === "space.fs.changed"
    && touchesSpaceHooksDir(collectChangedPaths(payload));
  if (input.redis && hooksConfigChanged) {
    await invalidateSpaceHooksCache(input.redis, spaceId);
  }

  if (input.redis && !hooksConfigChanged) {
    const gate = await resolveHooksCacheGate(input.redis, spaceId);
    if (gate === "empty") return null;
  }

  const dispatchPayload: DispatchPayload = {
    event,
    eventActorUserId: resolveEventActorUserId(payload),
  };

  try {
    const job = await input.enqueue(SPACE_HOOK_DISPATCH_JOB, dispatchPayload, {
      jobId: buildSpaceHookDispatchJobId({
        spaceId,
        eventId: event.id,
        eventType: event.type,
      }),
    });
    return { job, event };
  } catch (error) {
    // Duplicate jobId is expected for retries/replays of the same event.
    if (isDuplicateJobError(error)) return null;
    throw error;
  }
}

/** Build the user-visible execution task payload after dispatch match. */
export function buildSpaceHookExecutePayload(input: {
  event: SpaceHookEventEnvelope;
  eventActorUserId: string | null;
  ownerUserId: string;
  matchedHooks: Array<{ path: string; fingerprint: string }>;
}): TaskPayloadLike {
  return {
    type: SPACE_HOOK_TASK_TYPE,
    spaceId: input.event.spaceId,
    sessionId: input.event.sessionId ?? undefined,
    userId: input.ownerUserId,
    data: {
      event: input.event,
      eventActorUserId: input.eventActorUserId,
      matchedHooks: input.matchedHooks,
    },
  };
}
