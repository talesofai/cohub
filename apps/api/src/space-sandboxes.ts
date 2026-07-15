import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { billingOperations, COHUB_BILLING_FEATURES } from "@cohub/billing";
import {
  DEFAULT_SANDBOX_SPEC_ID,
  SANDBOX_SPECS,
  assertSandboxCanAutoRecover,
  assertSandboxCanResumeOrRecreate,
  buildInvalidatedSandboxEndpointMeta,
  getSandboxSpecRank,
  isSandboxAwaitingEndpointReport,
  isSandboxDialable,
  isTerminatedIsolatedWorkerSandbox,
  normalizeSandboxSpecId,
  resolveSpaceSandboxAutoDestroyPolicy,
  type SandboxSpecId,
} from "@cohub/sandbox-controller";
import { db } from "./db/index.js";
import { listEnabledSpaceMods, getSpaceModMountSignature } from "@cohub/core/space-mods";
import { spaceSandboxes, spaces } from "@cohub/db";
import { sessionsNamespace, config } from "./config.js";
import { k8sCoreApi } from "./k8s.js";
import { renderSandboxPodTemplate } from "./sandbox-template.js";
import { deleteSandboxPublicNetwork, getSandboxPublicEndpoints, reconcileSandboxPublicNetwork } from "./sandbox-public-network.js";
import { createSandboxReportToken, hashSandboxReportToken } from "./crypto.js";
import { redisCommandClient } from "./redis.js";
import { publishSandboxLifecycleEvent } from "./sandbox-events.js";
import { scheduleSandboxAutoDestroy } from "./sandbox-idle-scheduler.js";
import type { SpaceSandboxRuntimeStatus, SpaceSandboxStatus, SpaceSandboxStopReason } from "./lib/sandbox/types.js";
import { smokeVerifySandboxPod } from "./lib/sandbox/recovery.js";
import type { V1Pod } from "@kubernetes/client-node";
import { createLogger } from "@cohub/infra/logging";
import { assertIsolatedWorkerDisposableOperationAllowed } from "./isolated-worker-disposable-guard.js";


const logger = createLogger({ serviceName: "cohub-api" });
export const toSandboxImageVersion = (image: string) => {
  const normalized = image.trim();
  if (!normalized) return "cohub-sandbox:unknown";
  return normalized.split("/").pop() ?? normalized;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RECOVERY_LOCK_TTL_MS = 180_000;
const RECOVERY_COOLDOWN_MS = 60_000;

const asMetaObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

const getK8sStatusCode = (error: unknown) => {
  return (error as { statusCode?: number; code?: number }).statusCode
    ?? (error as { statusCode?: number; code?: number }).code
    ?? null;
};

const getSpaceSandboxSpec = async (spaceId: string): Promise<SandboxSpecId> => {
  const [space] = await db.select({ meta: spaces.meta }).from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  const meta = asMetaObject(space?.meta);
  const config = asMetaObject(meta.config);
  const sandbox = asMetaObject(config.sandbox);
  return normalizeSandboxSpecId(sandbox.spec);
};

const getAllowedSandboxSpecId = async (userId: string): Promise<SandboxSpecId> => {
  try {
    const state = await billingOperations.getState({ userId });
    const keys = new Set(state.entitlements.filter((entitlement) => entitlement.enabled).map((entitlement) => entitlement.key));
    if (keys.has(COHUB_BILLING_FEATURES.sandboxSpecUltra)) return "ultra";
    if (keys.has(COHUB_BILLING_FEATURES.sandboxSpecBoost)) return "boost";
    return DEFAULT_SANDBOX_SPEC_ID;
  } catch (error) {
    logger.warn("[SandboxSpec] failed to check entitlement during reconcile", { userId, error });
    return DEFAULT_SANDBOX_SPEC_ID;
  }
};

const getK8sErrorMessage = (error: unknown) => {
  const body = (error as { body?: unknown }).body;
  if (typeof body === "string" && body.trim()) return body;
  if (body && typeof body === "object") {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error);
};

export const waitForSandboxPodDeleted = async (podName: string, timeoutMs = 120_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await k8sCoreApi.readNamespacedPod({
        name: podName,
        namespace: sessionsNamespace,
      });
      await sleep(1000);
    } catch (error: unknown) {
      const statusCode = getK8sStatusCode(error);
      if (statusCode === 404) return true;
      throw error;
    }
  }
  return false;
};

const resourcesMatch = (actual: unknown, expected: { limits: Record<string, string>; requests: Record<string, string> }) => {
  const value = asMetaObject(actual);
  const limits = asMetaObject(value.limits);
  const requests = asMetaObject(value.requests);
  return limits.cpu === expected.limits.cpu
    && limits.memory === expected.limits.memory
    && requests.cpu === expected.requests.cpu
    && requests.memory === expected.requests.memory;
};

type SandboxPodResizeOutcome = { status: "applied" } | { status: "pending" } | { status: "timeout" };

const waitForSandboxPodResizeApplied = async (input: { podName: string; resources: { limits: Record<string, string>; requests: Record<string, string> }; timeoutMs?: number }): Promise<SandboxPodResizeOutcome> => {
  const timeoutMs = input.timeoutMs ?? 15_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pod = await k8sCoreApi.readNamespacedPod({ name: input.podName, namespace: sessionsNamespace });
    const sandboxStatus = pod.status?.containerStatuses?.find((container) => container.name === "sandbox");
    if (resourcesMatch((sandboxStatus as { resources?: unknown } | undefined)?.resources, input.resources)) return { status: "applied" };
    // kubelet defers or rejects the in-place resize when the node lacks capacity; a restart reschedules the pod.
    const resizePending = pod.status?.conditions?.some((condition) => condition.type === "PodResizePending" && condition.status === "True") === true;
    if (resizePending) return { status: "pending" };
    await sleep(1000);
  }
  return { status: "timeout" };
};

export const markSandboxSpecPendingRestart = async (input: { spaceId: string; specId: SandboxSpecId; reason: string }) => {
  const spec = SANDBOX_SPECS[input.specId] ?? SANDBOX_SPECS[DEFAULT_SANDBOX_SPEC_ID];
  await mergeSpaceSandboxMeta(input.spaceId, {
    desiredSpec: input.specId,
    desiredSpecResources: spec.resources,
    specApplying: false,
    specPendingRestart: true,
    specPendingRestartReason: input.reason,
    specPendingRestartAt: new Date().toISOString(),
  });
};

export const resizeSpaceSandboxToSpec = async (input: { spaceId: string; specId: SandboxSpecId }) => {
  await assertIsolatedWorkerDisposableOperationAllowed(input.spaceId, "sandbox_lifecycle");
  const sandbox = await getSpaceSandboxBySpaceId(input.spaceId);
  if (!sandbox || sandbox.provider === "local") return { resized: false, pendingRestart: false, skipped: true };
  if (sandbox.status !== "running" && sandbox.status !== "ready") {
    await markSandboxSpecPendingRestart({ spaceId: input.spaceId, specId: input.specId, reason: "sandbox_not_running" });
    return { resized: false, pendingRestart: true, skipped: true };
  }
  const podName = sandbox.podName ?? `sandbox-${input.spaceId}`;
  const spec = SANDBOX_SPECS[input.specId] ?? SANDBOX_SPECS[DEFAULT_SANDBOX_SPEC_ID];
  const k8sObjectApi = k8sCoreApi as typeof k8sCoreApi & {
    patchNamespacedPodResize?: (input: { name: string; namespace: string; body: unknown }) => Promise<unknown>;
  };
  if (!k8sObjectApi.patchNamespacedPodResize) {
    await markSandboxSpecPendingRestart({ spaceId: input.spaceId, specId: input.specId, reason: "pod_resize_api_unavailable" });
    return { resized: false, pendingRestart: true, message: "pod resize API is unavailable; restart required" };
  }

  const startedAt = new Date();
  await k8sObjectApi.patchNamespacedPodResize({
    name: podName,
    namespace: sessionsNamespace,
    body: [
      {
        op: "replace",
        path: "/spec/containers/0/resources",
        value: spec.resources,
      },
    ],
  });

  await mergeSpaceSandboxMeta(input.spaceId, {
    desiredSpec: input.specId,
    desiredSpecResources: spec.resources,
    specApplying: true,
    specApplyingStartedAt: startedAt.toISOString(),
    specPendingRestart: false,
  });

  const outcome = await waitForSandboxPodResizeApplied({ podName, resources: spec.resources });
  if (outcome.status === "pending") {
    await markSandboxSpecPendingRestart({ spaceId: input.spaceId, specId: input.specId, reason: "resize_deferred" });
    return { resized: false, pendingRestart: true, message: "restart the sandbox to apply the new spec" };
  }
  if (outcome.status === "timeout") return { resized: true, applying: true, pendingRestart: false, message: "pod resize is still applying" };

  await mergeSpaceSandboxMeta(input.spaceId, {
    appliedSpec: input.specId,
    appliedSpecResources: spec.resources,
    appliedSpecUpdatedAt: new Date().toISOString(),
    specApplying: false,
    specPendingRestart: false,
  });
  return { resized: true, applying: false, pendingRestart: false, appliedSpec: input.specId };
};

export const waitForSandboxPodReady = async (podName: string, timeoutMs = 120_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const pod = await k8sCoreApi.readNamespacedPod({ name: podName, namespace: sessionsNamespace });
      const ready = pod.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True") === true;
      if (ready) return true;
    } catch (error: unknown) {
      const statusCode = getK8sStatusCode(error);
      if (statusCode !== 404) throw error;
    }
    await sleep(1000);
  }
  return false;
};

export const getSpaceSandboxBySpaceId = async (spaceId: string) => {
  const [sandbox] = await db
    .select()
    .from(spaceSandboxes)
    .where(eq(spaceSandboxes.spaceId, spaceId))
    .limit(1);

  return sandbox ?? null;
};

export const ensureSpaceSandbox = async (input: {
  spaceId: string;
  provider?: "cloud" | "local";
  status?: SpaceSandboxStatus;
  runtimeStatus?: SpaceSandboxRuntimeStatus;
  podName?: string | null;
  desiredImage?: string | null;
  reportedImageVersion?: string | null;
  reportedAt?: Date | null;
  lastActivityAt?: Date | null;
  stoppedAt?: Date | null;
  stopReason?: SpaceSandboxStopReason | null;
  meta?: Record<string, unknown> | null;
}) => {
  await assertIsolatedWorkerDisposableOperationAllowed(input.spaceId, "sandbox_lifecycle");
  const existing = await getSpaceSandboxBySpaceId(input.spaceId);
  assertSandboxCanResumeOrRecreate(existing);
  const [sandbox] = await db
    .insert(spaceSandboxes)
    .values({
      spaceId: input.spaceId,
      provider: input.provider ?? "cloud",
      status: input.status ?? "pending",
      runtimeStatus: input.runtimeStatus ?? "unknown",
      podName: input.podName ?? null,
      desiredImage: input.desiredImage ?? null,
      reportedImageVersion: input.reportedImageVersion ?? null,
      reportedAt: input.reportedAt ?? null,
      lastActivityAt: input.lastActivityAt ?? null,
      stoppedAt: input.stoppedAt ?? null,
      stopReason: input.stopReason ?? null,
      meta: input.meta ?? null,
    })
    .onConflictDoUpdate({
      target: spaceSandboxes.spaceId,
      setWhere: sql`not (
        coalesce(jsonb_typeof(${spaceSandboxes.meta}->'isolatedWorkerPolicy') = 'object', false)
        or coalesce(jsonb_typeof(${spaceSandboxes.meta}->'isolatedWorker') = 'object', false)
      )`,
      set: {
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        status: input.status ?? "pending",
        runtimeStatus: input.runtimeStatus ?? "unknown",
        podName: input.podName ?? null,
        ...(input.desiredImage !== undefined ? { desiredImage: input.desiredImage } : {}),
        ...(input.reportedImageVersion !== undefined ? { reportedImageVersion: input.reportedImageVersion } : {}),
        ...(input.reportedAt !== undefined ? { reportedAt: input.reportedAt } : {}),
        ...(input.lastActivityAt !== undefined ? { lastActivityAt: input.lastActivityAt } : {}),
        ...(input.stoppedAt !== undefined ? { stoppedAt: input.stoppedAt } : {}),
        ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
        meta: input.meta ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!sandbox) {
    const latest = await getSpaceSandboxBySpaceId(input.spaceId);
    assertSandboxCanResumeOrRecreate(latest);
    throw new Error("Failed to ensure space sandbox");
  }
  return sandbox;
};

export const deleteSpaceSandbox = async (spaceId: string) => {
  await deleteSandboxPublicNetwork(spaceId);

  const [sandbox] = await db
    .delete(spaceSandboxes)
    .where(eq(spaceSandboxes.spaceId, spaceId))
    .returning();

  return sandbox ?? null;
};

export const updateSpaceSandbox = async (input: {
  spaceId: string;
  status?: SpaceSandboxStatus;
  runtimeStatus?: SpaceSandboxRuntimeStatus;
  podName?: string | null;
  desiredImage?: string | null;
  reportedImageVersion?: string | null;
  reportedAt?: Date | null;
  lastHeartbeatAt?: Date | null;
  lastActivityAt?: Date | null;
  stoppedAt?: Date | null;
  stopReason?: SpaceSandboxStopReason | null;
  meta?: Record<string, unknown> | null;
}) => {
  const existing = await getSpaceSandboxBySpaceId(input.spaceId);
  if (isTerminatedIsolatedWorkerSandbox(existing) && input.status !== "stopping" && input.status !== "terminated") {
    throw new Error("terminated isolated worker sandbox state cannot be updated");
  }
  const [sandbox] = await db
    .update(spaceSandboxes)
    .set({
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.runtimeStatus !== undefined ? { runtimeStatus: input.runtimeStatus } : {}),
      ...(input.podName !== undefined ? { podName: input.podName } : {}),
      ...(input.desiredImage !== undefined ? { desiredImage: input.desiredImage } : {}),
      ...(input.reportedImageVersion !== undefined ? { reportedImageVersion: input.reportedImageVersion } : {}),
      ...(input.reportedAt !== undefined ? { reportedAt: input.reportedAt } : {}),
      ...(input.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: input.lastHeartbeatAt } : {}),
      ...(input.lastActivityAt !== undefined ? { lastActivityAt: input.lastActivityAt } : {}),
      ...(input.stoppedAt !== undefined ? { stoppedAt: input.stoppedAt } : {}),
      ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
      ...(input.meta !== undefined ? { meta: input.meta } : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(spaceSandboxes.spaceId, input.spaceId),
      input.status === "stopping" || input.status === "terminated"
        ? sql`true`
        : sql`not (
          coalesce(jsonb_typeof(${spaceSandboxes.meta}->'isolatedWorkerPolicy') = 'object', false)
          and (
            ${spaceSandboxes.status} in ('stopping', 'terminated')
            or coalesce(${spaceSandboxes.meta}->'termination'->>'sandboxTerminated', 'false') = 'true'
            or coalesce(${spaceSandboxes.meta}->>'terminationClaimId', '') <> ''
          )
        )`,
    ))
    .returning();

  return sandbox ?? null;
};

export const mergeSpaceSandboxMeta = async (spaceId: string, metaPatch: Record<string, unknown>) => {
  const [sandbox] = await db
    .update(spaceSandboxes)
    .set({
      meta: sql`(
        CASE
          WHEN jsonb_typeof(${spaceSandboxes.meta}) = 'object' THEN ${spaceSandboxes.meta}
          ELSE '{}'::jsonb
        END
      ) || ${JSON.stringify(metaPatch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(spaceSandboxes.spaceId, spaceId))
    .returning();

  return sandbox ?? null;
};

export const claimIsolatedWorkerSandboxAllocation = async (input: {
  authoritySpaceId: string;
  disposableSpaceId: string;
  sessionId: string;
  turnId: string;
  policySha256: string;
  podName: string;
}) => {
  const isolatedWorker = {
    state: "starting",
    authoritySpaceId: input.authoritySpaceId,
    disposableSpaceId: input.disposableSpaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    policySha256: input.policySha256,
    resumable: false,
  };
  const [sandbox] = await db.update(spaceSandboxes).set({
    status: "provisioning",
    runtimeStatus: "starting",
    podName: input.podName,
    meta: sql`(
      CASE
        WHEN jsonb_typeof(${spaceSandboxes.meta}) = 'object' THEN ${spaceSandboxes.meta}
        ELSE '{}'::jsonb
      END
    ) || ${JSON.stringify({ isolatedWorker, resumable: false })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(
    eq(spaceSandboxes.spaceId, input.disposableSpaceId),
    sql`${spaceSandboxes.status} = 'allocated'`,
    isNull(spaceSandboxes.podName),
    sql`${spaceSandboxes.meta}->'isolatedWorker'->>'state' = 'allocated'`,
    sql`${spaceSandboxes.meta}->'isolatedWorker'->>'authoritySpaceId' = ${input.authoritySpaceId}`,
    sql`${spaceSandboxes.meta}->'isolatedWorker'->>'disposableSpaceId' = ${input.disposableSpaceId}`,
    sql`coalesce(${spaceSandboxes.meta}->'isolatedWorker'->>'resumable', 'true') = 'false'`,
    sql`coalesce(${spaceSandboxes.meta}->>'terminationClaimId', '') = ''`,
    sql`coalesce(${spaceSandboxes.meta}->'termination'->>'sandboxTerminated', 'false') <> 'true'`,
  )).returning({ spaceId: spaceSandboxes.spaceId });
  return Boolean(sandbox);
};

export const completeIsolatedWorkerSandboxAllocation = async (input: {
  registration: {
    spaceId: string;
    status: "ready";
    runtimeStatus: "healthy";
    podName: string;
    meta: Record<string, unknown>;
  };
  authoritySpaceId: string;
  sessionId: string;
  turnId: string;
  policySha256: string;
  podUid: string;
}) => {
  const isolatedWorker = {
    state: "ready",
    authoritySpaceId: input.authoritySpaceId,
    disposableSpaceId: input.registration.spaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    policySha256: input.policySha256,
    podUid: input.podUid,
    resumable: false,
  };
  const [sandbox] = await db.update(spaceSandboxes).set({
    status: input.registration.status,
    runtimeStatus: input.registration.runtimeStatus,
    podName: input.registration.podName,
    meta: sql`(
      CASE
        WHEN jsonb_typeof(${spaceSandboxes.meta}) = 'object' THEN ${spaceSandboxes.meta}
        ELSE '{}'::jsonb
      END
    ) || ${JSON.stringify({ ...input.registration.meta, isolatedWorker, resumable: false })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(
    eq(spaceSandboxes.spaceId, input.registration.spaceId),
    eq(spaceSandboxes.status, "provisioning"),
    eq(spaceSandboxes.podName, input.registration.podName),
    sql`${spaceSandboxes.meta}->'isolatedWorker'->>'state' = 'starting'`,
    sql`${spaceSandboxes.meta}->'isolatedWorker'->>'authoritySpaceId' = ${input.authoritySpaceId}`,
    sql`${spaceSandboxes.meta}->'isolatedWorker'->>'sessionId' = ${input.sessionId}`,
    sql`${spaceSandboxes.meta}->'isolatedWorker'->>'turnId' = ${input.turnId}`,
    sql`${spaceSandboxes.meta}->'isolatedWorker'->>'policySha256' = ${input.policySha256}`,
    sql`coalesce(${spaceSandboxes.meta}->>'terminationClaimId', '') = ''`,
  )).returning({ spaceId: spaceSandboxes.spaceId });
  return Boolean(sandbox);
};

export const markIsolatedWorkerSandboxCreateFailed = async (input: {
  authoritySpaceId: string;
  disposableSpaceId: string;
  sessionId: string;
  turnId: string;
  policySha256: string;
  podName: string;
  reason: string;
}) => {
  const isolatedWorker = {
    state: "create_failed",
    authoritySpaceId: input.authoritySpaceId,
    disposableSpaceId: input.disposableSpaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    policySha256: input.policySha256,
    resumable: false,
    createFailedAt: new Date().toISOString(),
    createFailure: input.reason,
  };
  const [sandbox] = await db.update(spaceSandboxes).set({
    status: "error",
    runtimeStatus: "unhealthy",
    podName: null,
    meta: sql`coalesce(${spaceSandboxes.meta}, '{}'::jsonb) || ${JSON.stringify({
      isolatedWorker,
      podIp: null,
      wsEndpoint: null,
      resumable: false,
    })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(
    eq(spaceSandboxes.spaceId, input.disposableSpaceId),
    eq(spaceSandboxes.status, "provisioning"),
    eq(spaceSandboxes.podName, input.podName),
    sql`${spaceSandboxes.meta}->'isolatedWorker'->>'state' = 'starting'`,
    sql`${spaceSandboxes.meta}->'isolatedWorker'->>'authoritySpaceId' = ${input.authoritySpaceId}`,
    sql`${spaceSandboxes.meta}->'isolatedWorker'->>'sessionId' = ${input.sessionId}`,
    sql`${spaceSandboxes.meta}->'isolatedWorker'->>'turnId' = ${input.turnId}`,
    sql`${spaceSandboxes.meta}->'isolatedWorker'->>'policySha256' = ${input.policySha256}`,
    sql`coalesce(${spaceSandboxes.meta}->>'terminationClaimId', '') = ''`,
  )).returning({ spaceId: spaceSandboxes.spaceId });
  return Boolean(sandbox);
};

export const claimIsolatedWorkerTermination = async (input: {
  spaceId: string;
  podUid: string;
  claimId: string;
  startedAt: string;
}) => {
  const [sandbox] = await db
    .update(spaceSandboxes)
    .set({
      status: "stopping",
      runtimeStatus: "unknown",
      meta: sql`jsonb_set((
        CASE
          WHEN jsonb_typeof(${spaceSandboxes.meta}) = 'object' THEN ${spaceSandboxes.meta}
          ELSE '{}'::jsonb
        END
      ) || ${JSON.stringify({
        terminationStartedAt: input.startedAt,
        terminationClaimId: input.claimId,
        terminationStage: "deleting",
        terminationRequired: true,
        resumable: false,
      })}::jsonb, '{isolatedWorker,state}', '"stopping"'::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(spaceSandboxes.spaceId, input.spaceId),
      sql`${spaceSandboxes.status} <> 'terminated'`,
      sql`${spaceSandboxes.meta}->'isolatedWorkerPolicy'->>'podUid' = ${input.podUid}`,
      sql`${spaceSandboxes.meta}->>'terminationClaimId' is null`,
      sql`coalesce(${spaceSandboxes.meta}->'termination'->>'sandboxTerminated', 'false') <> 'true'`,
    ))
    .returning({ spaceId: spaceSandboxes.spaceId });
  if (sandbox) return true;
  const latest = await getSpaceSandboxBySpaceId(input.spaceId);
  const meta = asMetaObject(latest?.meta);
  const policy = asMetaObject(meta.isolatedWorkerPolicy);
  return latest?.status === "stopping"
    && policy.podUid === input.podUid
    && meta.terminationClaimId === input.claimId;
};

export const markIsolatedWorkerPodDeleted = async (input: {
  spaceId: string;
  podUid: string;
  claimId: string;
  podDeletedAt: string;
}) => {
  const [sandbox] = await db.update(spaceSandboxes).set({
    meta: sql`coalesce(${spaceSandboxes.meta}, '{}'::jsonb) || ${JSON.stringify({
      terminationStage: "pod_deleted",
      podDeletedAt: input.podDeletedAt,
    })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(
    eq(spaceSandboxes.spaceId, input.spaceId),
    eq(spaceSandboxes.status, "stopping"),
    sql`${spaceSandboxes.meta}->'isolatedWorkerPolicy'->>'podUid' = ${input.podUid}`,
    sql`${spaceSandboxes.meta}->>'terminationClaimId' = ${input.claimId}`,
    sql`${spaceSandboxes.meta}->>'terminationStage' = 'deleting'`,
  )).returning({ spaceId: spaceSandboxes.spaceId });
  if (sandbox) return input.podDeletedAt;
  const latest = await getSpaceSandboxBySpaceId(input.spaceId);
  const meta = asMetaObject(latest?.meta);
  const persistedPodDeletedAt = typeof meta.podDeletedAt === "string" ? meta.podDeletedAt : null;
  return latest?.status === "stopping"
    && meta.terminationClaimId === input.claimId
    && (meta.terminationStage === "pod_deleted" || meta.terminationStage === "checkpointing")
    && persistedPodDeletedAt
    ? persistedPodDeletedAt
    : null;
};

export const claimIsolatedWorkerCheckpoint = async (input: {
  spaceId: string;
  podUid: string;
  claimId: string;
  checkpointAttemptId: string;
  checkpointTaskRunId: string;
}) => {
  const [sandbox] = await db.update(spaceSandboxes).set({
    meta: sql`coalesce(${spaceSandboxes.meta}, '{}'::jsonb) || ${JSON.stringify({
      terminationStage: "checkpointing",
      checkpointAttemptId: input.checkpointAttemptId,
      checkpointTaskRunId: input.checkpointTaskRunId,
    })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(
    eq(spaceSandboxes.spaceId, input.spaceId),
    eq(spaceSandboxes.status, "stopping"),
    sql`${spaceSandboxes.meta}->'isolatedWorkerPolicy'->>'podUid' = ${input.podUid}`,
    sql`${spaceSandboxes.meta}->>'terminationClaimId' = ${input.claimId}`,
    sql`${spaceSandboxes.meta}->>'terminationStage' = 'pod_deleted'`,
    sql`${spaceSandboxes.meta}->>'podDeletedAt' is not null`,
  )).returning({ spaceId: spaceSandboxes.spaceId });
  if (sandbox) return {
    checkpointAttemptId: input.checkpointAttemptId,
    checkpointTaskRunId: input.checkpointTaskRunId,
  };
  const latest = await getSpaceSandboxBySpaceId(input.spaceId);
  const meta = asMetaObject(latest?.meta);
  const policy = asMetaObject(meta.isolatedWorkerPolicy);
  return latest?.status === "stopping"
    && policy.podUid === input.podUid
    && meta.terminationClaimId === input.claimId
    && (meta.terminationStage === "checkpointing" || meta.terminationStage === "checkpointed")
    && typeof meta.checkpointAttemptId === "string"
    && typeof meta.checkpointTaskRunId === "string"
    ? {
        checkpointAttemptId: meta.checkpointAttemptId,
        checkpointTaskRunId: meta.checkpointTaskRunId,
      }
    : null;
};

export const rotateIsolatedWorkerCheckpointAttempt = async (input: {
  spaceId: string;
  podUid: string;
  claimId: string;
  checkpointAttemptId: string;
  checkpointTaskRunId: string;
  nextCheckpointAttemptId: string;
  nextCheckpointTaskRunId: string;
}) => {
  const [sandbox] = await db.update(spaceSandboxes).set({
    meta: sql`coalesce(${spaceSandboxes.meta}, '{}'::jsonb) || ${JSON.stringify({
      checkpointAttemptId: input.nextCheckpointAttemptId,
      checkpointTaskRunId: input.nextCheckpointTaskRunId,
    })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(
    eq(spaceSandboxes.spaceId, input.spaceId),
    eq(spaceSandboxes.status, "stopping"),
    sql`${spaceSandboxes.meta}->'isolatedWorkerPolicy'->>'podUid' = ${input.podUid}`,
    sql`${spaceSandboxes.meta}->>'terminationClaimId' = ${input.claimId}`,
    sql`${spaceSandboxes.meta}->>'terminationStage' = 'checkpointing'`,
    sql`${spaceSandboxes.meta}->>'checkpointAttemptId' = ${input.checkpointAttemptId}`,
    sql`${spaceSandboxes.meta}->>'checkpointTaskRunId' = ${input.checkpointTaskRunId}`,
    sql`${spaceSandboxes.meta}->'terminationCheckpoint' is null`,
  )).returning({ spaceId: spaceSandboxes.spaceId });
  if (sandbox) return {
    checkpointAttemptId: input.nextCheckpointAttemptId,
    checkpointTaskRunId: input.nextCheckpointTaskRunId,
  };
  const latest = await getSpaceSandboxBySpaceId(input.spaceId);
  const meta = asMetaObject(latest?.meta);
  const policy = asMetaObject(meta.isolatedWorkerPolicy);
  return latest?.status === "stopping"
    && policy.podUid === input.podUid
    && meta.terminationClaimId === input.claimId
    && (meta.terminationStage === "checkpointing" || meta.terminationStage === "checkpointed")
    && typeof meta.checkpointAttemptId === "string"
    && typeof meta.checkpointTaskRunId === "string"
    ? {
        checkpointAttemptId: meta.checkpointAttemptId,
        checkpointTaskRunId: meta.checkpointTaskRunId,
      }
    : null;
};

export const readIsolatedWorkerTerminationCheckpoint = async (input: {
  spaceId: string;
  podUid: string;
  claimId: string;
  checkpointAttemptId: string;
}) => {
  const sandbox = await getSpaceSandboxBySpaceId(input.spaceId);
  const meta = asMetaObject(sandbox?.meta);
  const policy = asMetaObject(meta.isolatedWorkerPolicy);
  if (
    sandbox?.status !== "stopping"
    || policy.podUid !== input.podUid
    || meta.terminationClaimId !== input.claimId
    || meta.checkpointAttemptId !== input.checkpointAttemptId
    || meta.terminationStage !== "checkpointed"
  ) return null;
  const checkpoint = meta.terminationCheckpoint;
  return checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint)
    ? checkpoint as Record<string, unknown>
    : null;
};

export const persistIsolatedWorkerTerminationCheckpoint = async (input: {
  spaceId: string;
  podUid: string;
  claimId: string;
  checkpointAttemptId: string;
  checkpoint: {
    disposableSpaceId: string;
    checkpointId: string;
    commit: string;
    tree: string;
    treeSha256: string;
    currentHead: string;
    checkpointCreatedAt: string;
  };
}) => {
  const [sandbox] = await db.update(spaceSandboxes).set({
    meta: sql`coalesce(${spaceSandboxes.meta}, '{}'::jsonb) || ${JSON.stringify({
      terminationStage: "checkpointed",
      terminationCheckpoint: input.checkpoint,
    })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(
    eq(spaceSandboxes.spaceId, input.spaceId),
    eq(spaceSandboxes.status, "stopping"),
    sql`${spaceSandboxes.meta}->'isolatedWorkerPolicy'->>'podUid' = ${input.podUid}`,
    sql`${spaceSandboxes.meta}->>'terminationClaimId' = ${input.claimId}`,
    sql`${spaceSandboxes.meta}->>'terminationStage' = 'checkpointing'`,
    sql`${spaceSandboxes.meta}->>'checkpointAttemptId' = ${input.checkpointAttemptId}`,
  )).returning({ spaceId: spaceSandboxes.spaceId });
  if (sandbox) return true;
  return Boolean(await readIsolatedWorkerTerminationCheckpoint(input));
};

export const completeIsolatedWorkerTermination = async (input: {
  spaceId: string;
  podUid: string;
  claimId: string;
  checkpointAttemptId: string;
  receipt: {
    revokeTaskRunId: string;
    automaticTrigger: "turn_terminal_event";
    manualEndpointInvoked: false;
    podUid: string;
    podDeleted: true;
    podDeletedAt: string;
    credentialRevoked: true;
    sandboxTerminated: true;
    checkpointCreatedAfterPodDeletion: true;
    checkpointAdapter: "trusted_production";
    terminatedAt: string;
    checkpointId: string;
    checkpointCommit: string;
    checkpointTreeSha256: string;
  };
}) => {
  if (input.receipt.podUid !== input.podUid) throw new Error("isolated worker termination receipt pod UID mismatch");
  if (
    input.receipt.automaticTrigger !== "turn_terminal_event"
    || input.receipt.manualEndpointInvoked !== false
    || !input.receipt.revokeTaskRunId
  ) throw new Error("isolated worker termination receipt automatic TaskRun binding mismatch");
  return db.transaction(async (tx) => {
    const [sandbox] = await tx
      .update(spaceSandboxes)
    .set({
      status: "terminated",
      runtimeStatus: "unknown",
      podName: null,
      stoppedAt: new Date(input.receipt.terminatedAt),
      meta: sql`jsonb_set((
        CASE
          WHEN jsonb_typeof(${spaceSandboxes.meta}) = 'object' THEN ${spaceSandboxes.meta}
          ELSE '{}'::jsonb
        END
      ) || ${JSON.stringify({
        termination: input.receipt,
        isolatedWorkerDisposable: {
          frozenHead: {
            checkpointId: input.receipt.checkpointId,
            commitHash: input.receipt.checkpointCommit,
            treeSha256: input.receipt.checkpointTreeSha256,
          },
        },
        terminationClaimId: null,
        terminationStage: "terminated",
        checkpointAttemptId: null,
        wsEndpoint: null,
        podIp: null,
        resumable: false,
      })}::jsonb, '{isolatedWorker,state}', '"terminated"'::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(spaceSandboxes.spaceId, input.spaceId),
      sql`${spaceSandboxes.meta}->'isolatedWorkerPolicy'->>'podUid' = ${input.podUid}`,
      sql`${spaceSandboxes.meta}->>'terminationClaimId' = ${input.claimId}`,
      sql`${spaceSandboxes.meta}->>'terminationStage' = 'checkpointed'`,
      sql`${spaceSandboxes.meta}->>'checkpointAttemptId' = ${input.checkpointAttemptId}`,
      sql`${spaceSandboxes.meta}->'terminationCheckpoint'->>'disposableSpaceId' = ${input.spaceId}`,
      sql`${spaceSandboxes.meta}->'terminationCheckpoint'->>'checkpointId' = ${input.receipt.checkpointId}`,
      sql`${spaceSandboxes.meta}->'terminationCheckpoint'->>'commit' = ${input.receipt.checkpointCommit}`,
      sql`${spaceSandboxes.meta}->'terminationCheckpoint'->>'currentHead' = ${input.receipt.checkpointCommit}`,
      sql`${spaceSandboxes.meta}->'terminationCheckpoint'->>'treeSha256' = ${input.receipt.checkpointTreeSha256}`,
      sql`coalesce(${spaceSandboxes.meta}->'termination'->>'sandboxTerminated', 'false') <> 'true'`,
    ))
      .returning({ spaceId: spaceSandboxes.spaceId });
    if (!sandbox) return false;
    const frozenHead = {
      checkpointId: input.receipt.checkpointId,
      commitHash: input.receipt.checkpointCommit,
      treeSha256: input.receipt.checkpointTreeSha256,
    };
    const [updatedSpace] = await tx.update(spaces).set({
      meta: sql`coalesce(${spaces.meta}, '{}'::jsonb) || jsonb_build_object(
        'isolatedWorkerDisposable',
        coalesce(${spaces.meta}->'isolatedWorkerDisposable', '{}'::jsonb)
          || ${JSON.stringify({ frozenHead })}::jsonb
      )`,
      updatedAt: new Date(),
    }).where(eq(spaces.id, input.spaceId)).returning({ id: spaces.id });
    if (!updatedSpace) throw new Error("isolated worker disposable space is missing during termination");
    return true;
  });
};

export const listSandboxRolloutTargets = async (input?: {
  targetImageVersion?: string;
  limit?: number;
}) => {
  const baseQuery = db
    .select({
      spaceId: spaceSandboxes.spaceId,
      userUuid: spaces.userUuid,
      podName: spaceSandboxes.podName,
      status: spaceSandboxes.status,
      desiredImage: spaceSandboxes.desiredImage,
      reportedImageVersion: spaceSandboxes.reportedImageVersion,
      updatedAt: spaceSandboxes.updatedAt,
      createdAt: spaceSandboxes.createdAt,
    })
    .from(spaceSandboxes)
    .innerJoin(spaces, eq(spaceSandboxes.spaceId, spaces.id))
    .orderBy(asc(spaceSandboxes.updatedAt), asc(spaceSandboxes.createdAt));

  if (input?.targetImageVersion) {
    return baseQuery
      .where(or(
        isNull(spaceSandboxes.desiredImage),
        ne(spaceSandboxes.desiredImage, input.targetImageVersion),
        isNull(spaceSandboxes.reportedImageVersion),
        ne(spaceSandboxes.reportedImageVersion, input.targetImageVersion),
      ))
      .limit(input.limit ?? 10_000);
  }

  return baseQuery.limit(input?.limit ?? 10_000);
};

const triggerSandboxPublicNetworkReconcile = (spaceId: string) => {
  void reconcileSandboxPublicNetwork(spaceId)
    .then(async () => {
      await mergeSpaceSandboxMeta(spaceId, {
        publicNetworkStatus: "ready",
        publicNetworkLastError: null,
        publicNetworkReconciledAt: new Date().toISOString(),
        publicEndpoints: getSandboxPublicEndpoints(spaceId),
      });
    })
    .catch(async (error) => {
      await mergeSpaceSandboxMeta(spaceId, {
        publicNetworkStatus: "error",
        publicNetworkLastError: error instanceof Error ? error.message : String(error),
        publicEndpoints: getSandboxPublicEndpoints(spaceId),
      }).catch(() => undefined);
      logger.error(`[SandboxPublicNetwork] reconcile failed spaceId=${spaceId}`, error);
    });
};

const tryCreatePod = async (spaceId: string, pod: V1Pod, retry = 0): Promise<{ podName: string; created: boolean }> => {
  try {
    await k8sCoreApi.createNamespacedPod({
      namespace: sessionsNamespace,
      body: pod,
    });
    return { podName: `sandbox-${spaceId}`, created: true };
  } catch (error: unknown) {
    const statusCode = getK8sStatusCode(error);
    const message = getK8sErrorMessage(error).toLowerCase();
    const podName = `sandbox-${spaceId}`;

    if (statusCode === 409 && message.includes("object is being deleted")) {
      const deleted = await waitForSandboxPodDeleted(podName);
      if (!deleted) throw new Error(`timed out waiting for deleted sandbox pod: ${podName}`);
      return tryCreatePod(spaceId, pod, retry + 1);
    }

    if (statusCode === 409 && retry < 10) {
      const backoffMs = Math.min(250 * 2 ** retry, 4000);
      await sleep(backoffMs);
      return tryCreatePod(spaceId, pod, retry + 1);
    }
    if (statusCode === 409) {
      throw new Error(`sandbox pod already exists after retries: sandbox-${spaceId}`);
    }
    throw error;
  }
};

export const reconcileSpaceSandbox = async (input: {
  spaceId: string;
  userUuid: string;
  ownerUserUuid?: string;
  mode: "ensure" | "replace";
  reason: "space_created" | "manual_recreate" | "auto_recover" | "auto_resume" | "space_mods_changed";
}) => {
  await assertIsolatedWorkerDisposableOperationAllowed(input.spaceId, "sandbox_lifecycle");
  const podName = `sandbox-${input.spaceId}`;
  const existingSandbox = await getSpaceSandboxBySpaceId(input.spaceId);
  assertSandboxCanResumeOrRecreate(existingSandbox);
  const existingMeta = asMetaObject(existingSandbox?.meta);

  if (input.mode === "replace") {
    const generation = new Date().toISOString();
    await publishSandboxLifecycleEvent({
      type: "sandbox.replacing",
      spaceId: input.spaceId,
      reason: input.reason,
      source: "api",
      generation,
      podName: existingSandbox?.podName ?? podName,
      podIp: typeof existingMeta.podIp === "string" ? existingMeta.podIp : null,
    }).catch((error) => {
      logger.warn(`[SandboxEvents] failed to publish replacing event spaceId=${input.spaceId}:`, error);
    });

    // Invalidate endpoint + report token immediately so agents stop dialing the
    // dying pod and it cannot re-publish the dead coordinates.
    await updateSpaceSandbox({
      spaceId: input.spaceId,
      status: "provisioning",
      runtimeStatus: "starting",
      meta: buildInvalidatedSandboxEndpointMeta(existingMeta, input.reason, generation),
    }).catch((error) => {
      logger.warn(`[SandboxRecover] failed to invalidate endpoint before replace spaceId=${input.spaceId}:`, error);
    });

    const podToReplace = existingSandbox?.podName ?? podName;
    try {
      await k8sCoreApi.deleteNamespacedPod({
        name: podToReplace,
        namespace: sessionsNamespace,
      });
    } catch (error: unknown) {
      const statusCode = getK8sStatusCode(error);
      if (statusCode !== 404) throw error;
    }

    const deleted = await waitForSandboxPodDeleted(podToReplace);
    if (!deleted) {
      throw new Error(`Timed out waiting for sandbox pod deletion: ${podToReplace}`);
    }
  }

  const configuredSpec = await getSpaceSandboxSpec(input.spaceId);
  const allowedSpec = await getAllowedSandboxSpecId(input.ownerUserUuid ?? input.userUuid);
  const desiredSpec = getSandboxSpecRank(configuredSpec) > getSandboxSpecRank(allowedSpec) ? allowedSpec : configuredSpec;
  const specEntitlementDowngraded = desiredSpec !== configuredSpec;
  const desiredSpecConfig = SANDBOX_SPECS[desiredSpec] ?? SANDBOX_SPECS[DEFAULT_SANDBOX_SPEC_ID];
  const reportToken = createSandboxReportToken();
  const reportTokenHash = hashSandboxReportToken(reportToken);
  const reportTokenIssuedAt = new Date().toISOString();
  const nowIso = new Date().toISOString();
  const baseMeta = input.mode === "replace"
    ? buildInvalidatedSandboxEndpointMeta(existingMeta, input.reason, nowIso)
    : existingMeta;
  const provisioningMeta = {
    ...baseMeta,
    ...(input.mode === "replace" ? { recreatedAt: nowIso } : {}),
    reconcileReason: input.reason,
    provisioningStartedAt: nowIso,
    reportTokenHash,
    reportTokenIssuedAt,
    publicNetworkStatus: "provisioning",
    publicNetworkLastError: null,
    publicEndpoints: getSandboxPublicEndpoints(input.spaceId),
  };

  await ensureSpaceSandbox({
    spaceId: input.spaceId,
    status: "provisioning",
    runtimeStatus: "starting",
    podName,
    desiredImage: toSandboxImageVersion(config.sandboxImage),
    meta: {
      ...provisioningMeta,
      desiredSpec,
      configuredSpec,
      ...(specEntitlementDowngraded ? { specEntitlementDowngraded: true, specEntitlementAllowedSpec: allowedSpec, specEntitlementCheckedAt: nowIso } : { specEntitlementDowngraded: false }),
      desiredSpecResources: desiredSpecConfig.resources,
    },
  });

  const pod = renderSandboxPodTemplate({
    SPACE_ID: input.spaceId,
    USER_ID: input.userUuid,
    OWNER_USER_ID: input.ownerUserUuid ?? input.userUuid,
    ENV: config.env,
    SPACE_STORAGE_PVC: config.spaceStoragePvc,
    SPACE_STORAGE_SUBPATH: config.spaceStorageSubpath,
    CONFIGS_SUBPATH: config.configsSubpath,
    SANDBOX_SPEC_ID: desiredSpec,
  }) as V1Pod;

  const enabledMods = await listEnabledSpaceMods(db, input.spaceId);
  const modMountSignature = getSpaceModMountSignature(enabledMods);

  if (pod.spec?.containers?.[0]) {
    const container = pod.spec.containers[0];
    container.volumeMounts = [
      ...(container.volumeMounts ?? []),
      ...enabledMods.map((mod) => ({
        name: "checkpoint-cache",
        mountPath: mod.mountPath,
        subPath: `${config.checkpointCacheSubpath}/${mod.modSpaceId}/latest`,
        readOnly: true,
      })),
    ];
    if (!pod.spec.volumes?.some((volume) => volume.name === "checkpoint-cache")) {
      pod.spec.volumes = [
        ...(pod.spec.volumes ?? []),
        {
          name: "checkpoint-cache",
          persistentVolumeClaim: { claimName: config.checkpointCachePvc },
        },
      ];
    }
    container.env = [
      { name: "COHUB_SPACE_ID", value: input.spaceId },
      ...(config.env === "dev" ? [{ name: "ENV", value: "dev" }] : []),
      { name: "WORKSPACE_DIR", value: "/workspace" },
      { name: "PLATFORM_AGENTS_DIR", value: "/configs/platform/.agents" },
      { name: "USER_AGENTS_DIR", value: "/configs/user/.agents" },
      { name: "IMAGE_VERSION", value: toSandboxImageVersion(config.sandboxImage) },
      { name: "POD_IP", valueFrom: { fieldRef: { fieldPath: "status.podIP" } } },
      {
        name: "INTERNAL_API_BASE_URL",
        value:
          config.env === "prod"
            ? "http://cohub-api.cohub.svc.cluster.local:8787"
            : "http://cohub-api-dev.cohub-dev.svc.cluster.local:8787",
      },
      {
        name: "PUBLIC_URL_PREFIX",
        value:
          config.env === "prod"
            ? `https://public.cohub.run/s/${input.spaceId}`
            : `https://public.cohub.run/dev/s/${input.spaceId}`,
      },
      { name: "SANDBOX_REPORT_TOKEN", value: reportToken },
    ];
  }

  await tryCreatePod(input.spaceId, pod);

  const provisionedAt = new Date().toISOString();
  await updateSpaceSandbox({
    spaceId: input.spaceId,
    status: "provisioning",
    runtimeStatus: "starting",
    podName,
    desiredImage: toSandboxImageVersion(config.sandboxImage),
    meta: {
      ...provisioningMeta,
      modMountSignature,
      modMounts: enabledMods.map((mod) => ({
        modSpaceId: mod.modSpaceId,
        mountSlug: mod.mountSlug,
        mountPath: mod.mountPath,
        name: mod.name ?? mod.modSpaceName,
      })),
      appliedSpec: desiredSpec,
      appliedSpecResources: desiredSpecConfig.resources,
      specApplying: false,
      specPendingRestart: false,
      lastProvisionedAt: provisionedAt,
    },
  });

  triggerSandboxPublicNetworkReconcile(input.spaceId);
};

export const provisionSpaceSandbox = async (input: {
  spaceId: string;
  userUuid: string;
  ownerUserUuid?: string;
}) => {
  return reconcileSpaceSandbox({
    spaceId: input.spaceId,
    userUuid: input.userUuid,
    ownerUserUuid: input.ownerUserUuid,
    mode: "ensure",
    reason: "space_created",
  }).catch(async (error) => {
    const existingSandbox = await getSpaceSandboxBySpaceId(input.spaceId);
    const existingMeta = asMetaObject(existingSandbox?.meta);
    await updateSpaceSandbox({
      spaceId: input.spaceId,
      status: "error",
      runtimeStatus: "unhealthy",
      podName: `sandbox-${input.spaceId}`,
      desiredImage: toSandboxImageVersion(config.sandboxImage),
      meta: {
        ...existingMeta,
        lastError: error instanceof Error ? error.message : String(error),
      },
    }).catch(() => undefined);
    throw error;
  });
};

export const recoverSpaceSandbox = async (input: {
  spaceId: string;
  userUuid: string;
  ownerUserUuid?: string;
  reason?: string;
  source?: string;
  verify?: boolean;
}) => {
  await assertIsolatedWorkerDisposableOperationAllowed(input.spaceId, "sandbox_lifecycle");
  const existing = await getSpaceSandboxBySpaceId(input.spaceId);
  if (input.source === "manual") assertSandboxCanResumeOrRecreate(existing);
  else assertSandboxCanAutoRecover(existing);
  if (existing?.provider === "local") {
    // Local sandboxes live on the user's machine; there is nothing to recover
    // server-side. Report current status without attempting a cloud recreate.
    return {
      ok: existing.status === "ready" || existing.status === "running",
      status: existing.status,
      verified: false,
      local: true,
    };
  }
  const lockKey = `sandbox:recover:${input.spaceId}`;
  const cooldownKey = `sandbox:recover:cooldown:${input.spaceId}`;
  const locked = await redisCommandClient.set(lockKey, `${process.pid}:${Date.now()}`, "PX", RECOVERY_LOCK_TTL_MS, "NX");
  if (locked !== "OK") {
    const sandbox = await getSpaceSandboxBySpaceId(input.spaceId);
    // Another recover is in flight — ok only if already dialable.
    return {
      ok: isSandboxDialable(sandbox),
      status: sandbox?.status ?? "provisioning",
      verified: false,
      recovering: true,
    };
  }

  try {
    const cooldown = await redisCommandClient.get(cooldownKey).catch(() => null);
    if (cooldown && input.source !== "manual") {
      const sandbox = await getSpaceSandboxBySpaceId(input.spaceId);
      const dialable = isSandboxDialable(sandbox);
      const awaitingReport = sandbox?.status === "provisioning"
        || isSandboxAwaitingEndpointReport(sandbox?.meta);
      // Dialable → ok. Still provisioning/report-pending → recovering (wait).
      // Otherwise hard throttle without a usable endpoint.
      return {
        ok: dialable,
        status: sandbox?.status ?? "provisioning",
        verified: false,
        throttled: true,
        recovering: !dialable && awaitingReport,
      };
    }
    await redisCommandClient.set(cooldownKey, "1", "PX", RECOVERY_COOLDOWN_MS).catch(() => undefined);

    const startedAt = new Date().toISOString();
    const existingSandbox = await getSpaceSandboxBySpaceId(input.spaceId);
    const existingMeta = asMetaObject(existingSandbox?.meta);
    const recoveryReason = input.reason ?? "recover";
    await updateSpaceSandbox({
      spaceId: input.spaceId,
      status: "provisioning",
      runtimeStatus: "starting",
      meta: {
        ...buildInvalidatedSandboxEndpointMeta(existingMeta, recoveryReason, startedAt),
        recoveryStatus: "recreating",
        recoveryLevel: "L2",
        recoverySource: input.source ?? "auto",
        lastRecoveryReason: recoveryReason,
        lastRecoveryStartedAt: startedAt,
        lastRecoveryError: null,
      },
    });

    await reconcileSpaceSandbox({
      spaceId: input.spaceId,
      userUuid: input.userUuid,
      ownerUserUuid: input.ownerUserUuid,
      mode: "replace",
      reason: input.source === "manual" ? "manual_recreate" : "auto_recover",
    });

    const podName = `sandbox-${input.spaceId}`;
    const ready = await waitForSandboxPodReady(podName);
    if (!ready) throw new Error(`Timed out waiting for sandbox pod ready: ${podName}`);

    const checks = input.verify === false
      ? null
      : await smokeVerifySandboxPod(podName, sessionsNamespace);
    const latest = await getSpaceSandboxBySpaceId(input.spaceId);
    // Product choice: recover/resume resets the idle clock (full TTL from now),
    // rather than continuing prior idle progress. Keeps just-recovered sandboxes
    // from being immediately reaped off a stale lastActivityAt.
    const recoveredAt = new Date();
    await updateSpaceSandbox({
      spaceId: input.spaceId,
      status: "running",
      runtimeStatus: "healthy",
      lastActivityAt: recoveredAt,
      meta: {
        ...asMetaObject(latest?.meta),
        recoveryStatus: "ready",
        lastRecoveredAt: recoveredAt.toISOString(),
        lastRecoveryReason: input.reason ?? "recover",
        lastRecoveryChecks: checks,
        lastRecoveryError: null,
      },
    });

    // Resume/recover is the common path that used to drop idle_check jobs.
    // Re-arm from now so a recovered sandbox always has a next check.
    const [space] = await db.select({ meta: spaces.meta }).from(spaces).where(eq(spaces.id, input.spaceId)).limit(1);
    void scheduleSandboxAutoDestroy({
      spaceId: input.spaceId,
      policy: resolveSpaceSandboxAutoDestroyPolicy(space?.meta),
      baseAt: recoveredAt,
    }).then((result) => {
      logger.info("[SandboxAutoDestroy] scheduled after recover", {
        spaceId: input.spaceId,
        ...result,
        dueAt: "dueAt" in result && result.dueAt instanceof Date ? result.dueAt.toISOString() : null,
      });
    }).catch((error) => {
      logger.error("[SandboxAutoDestroy] failed to schedule policy after recover", {
        spaceId: input.spaceId,
        error,
      });
    });

    return { ok: true as const, status: "running" as const, verified: input.verify !== false, checks };
  } catch (error) {
    const latest = await getSpaceSandboxBySpaceId(input.spaceId);
    await updateSpaceSandbox({
      spaceId: input.spaceId,
      status: "error",
      runtimeStatus: "unhealthy",
      meta: {
        ...asMetaObject(latest?.meta),
        recoveryStatus: "failed",
        lastRecoveryFailedAt: new Date().toISOString(),
        lastRecoveryReason: input.reason ?? "recover",
        lastRecoveryError: error instanceof Error ? error.message : String(error),
      },
    }).catch(() => undefined);
    throw error;
  } finally {
    await redisCommandClient.del(lockKey).catch(() => undefined);
  }
};
