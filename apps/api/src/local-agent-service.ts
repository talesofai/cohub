import { and, asc, count, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  localAgentDevices,
  localAgentRuntimes,
  localAgentRuntimeCommands,
  localAgentRuntimeSessions,
  sessionTurns,
  spaceLocalAgentPolicies,
  spaceWorkspacePolicies,
  spaceSandboxes,
  spaces,
  workspaceBlobs,
  workspaceExecutionAttempts,
  workspaceReplicas,
  workspaceSnapshots,
  workspaceSnapshotBlobs,
  workspaceState,
  workspaceSyncConflicts,
  workspaceSyncCycles,
  workspaceWriterLeases,
} from "@cohub/db";
import {
  LocalAgentPolicySchema,
  WorkspaceManifestSchema,
  canonicalizeJsonBytes,
  canonicalJsonSha256,
  validateManifest,
  type LocalAgentPolicyV1,
  type WorkspaceManifestV1,
} from "@cohub/protocol";
import { LocalAgentObjectStorageError } from "./local-agent-object-storage.js";
import { createLocalAgentObjectGetUrl, createLocalAgentObjectPutUrl, headLocalAgentObject, buildLocalAgentObjectKey, verifyLocalAgentObject } from "./local-agent-object-storage.js";
import { createLocalAgentRefreshToken, createLocalAgentToken, hashLocalAgentRefreshToken, refreshTokenMatches } from "./local-agent-auth.js";
import { dispatchWorkspaceStateUpdated } from "./workspace-realtime.js";
import { enqueueWorkspaceSyncJob } from "./workspace-sync-queue.js";
import { db } from "./db/index.js";
import { requestAgentTurnAbort } from "./agent-turn-abort.js";

export const LOCAL_AGENT_MAX_MANIFEST_INLINE_BYTES = 1024 * 1024;
export const LOCAL_AGENT_MAX_SNAPSHOT_ENTRIES = 2_000_000;
export const LOCAL_AGENT_ONLINE_LEASE_SECONDS = 30;

export class LocalAgentServiceError extends Error {
  override name = "LocalAgentServiceError";
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export type LocalAgentActor = {
  userUuid: string;
  deviceId: string | null;
  credentialVersion?: number;
  principal: "user" | "device";
};

export type EnrollDeviceInput = {
  displayName: string;
  platform: string;
  daemonVersion?: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;
const isUuid = (value: string) => UUID_RE.test(value);
const isSha256 = (value: string) => SHA256_RE.test(value);
const assertUuid = (value: string, field: string) => {
  if (!isUuid(value)) throw new LocalAgentServiceError(`${field} must be a UUID`, "invalid_id", 400);
  return value;
};
const assertSha256 = (value: string, field: string) => {
  if (!isSha256(value)) throw new LocalAgentServiceError(`${field} must be a lowercase SHA-256 hash`, "invalid_hash", 400);
  return value;
};
const normalizeBounded = (value: unknown, field: string, max: number) => {
  if (typeof value !== "string") throw new LocalAgentServiceError(`${field} is required`, "invalid_input", 400);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new LocalAgentServiceError(`${field} is invalid`, "invalid_input", 400);
  return trimmed;
};
const now = () => new Date();
const WORKSPACE_CONFLICT_RESOLUTIONS = new Set(["local", "cloud", "merged", "deleted", "keep_managed", "unmanage"]);

const serializeDevice = (row: typeof localAgentDevices.$inferSelect) => ({
  id: row.id,
  userUuid: row.userUuid,
  displayName: row.displayName,
  platform: row.platform,
  daemonVersion: row.daemonVersion,
  credentialVersion: row.credentialVersion,
  status: row.status,
  lastSeenAt: iso(row.lastSeenAt),
  revokedAt: iso(row.revokedAt),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export async function enrollLocalAgentDevice(userUuid: string, input: EnrollDeviceInput) {
  const displayName = normalizeBounded(input.displayName, "displayName", 255);
  const platform = normalizeBounded(input.platform, "platform", 80);
  const daemonVersion = input.daemonVersion == null ? null : normalizeBounded(input.daemonVersion, "daemonVersion", 120);
  const refreshToken = createLocalAgentRefreshToken();
  const [device] = await db.insert(localAgentDevices).values({
    userUuid,
    displayName,
    platform,
    daemonVersion,
    refreshTokenHash: hashLocalAgentRefreshToken(refreshToken),
  }).returning();
  if (!device) throw new LocalAgentServiceError("failed to enroll device", "device_enrollment_failed", 500);
  const accessToken = createLocalAgentToken({
    deviceId: device.id,
    userUuid,
    credentialVersion: device.credentialVersion,
  });
  return { device: serializeDevice(device), accessToken, refreshToken };
}

export async function listLocalAgentDevices(userUuid: string) {
  const rows = await db.select().from(localAgentDevices).where(eq(localAgentDevices.userUuid, userUuid)).orderBy(asc(localAgentDevices.createdAt));
  return rows.map(serializeDevice);
}

export async function issueLocalAgentToken(input: { deviceId: string; userUuid?: string; refreshToken: string }) {
  assertUuid(input.deviceId, "deviceId");
  const refreshToken = normalizeBounded(input.refreshToken, "refreshToken", 512);
  const conditions = [eq(localAgentDevices.id, input.deviceId)];
  if (input.userUuid) conditions.push(eq(localAgentDevices.userUuid, input.userUuid));
  const [device] = await db.select().from(localAgentDevices).where(and(...conditions)).limit(1);
  if (device?.status !== "active" || device.revokedAt || !refreshTokenMatches({ token: refreshToken, storedHash: device.refreshTokenHash })) {
    throw new LocalAgentServiceError("device credential is invalid or revoked", "device_credential_invalid", 401);
  }
  const updatedAt = now();
  await db.update(localAgentDevices).set({ lastSeenAt: updatedAt, updatedAt }).where(eq(localAgentDevices.id, device.id));
  return {
    deviceId: device.id,
    accessToken: createLocalAgentToken({
      deviceId: device.id,
      userUuid: device.userUuid,
      credentialVersion: device.credentialVersion,
    }),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
}

export async function revokeLocalAgentDevice(input: { userUuid: string; deviceId: string }) {
  assertUuid(input.deviceId, "deviceId");
  let abortRequests: Array<{ spaceId: string; sessionId: string; turnId: string }> = [];
  const result = await db.transaction(async (tx) => {
    const revokedAt = now();
    const [device] = await tx.update(localAgentDevices).set({
      status: "revoked",
      revokedAt,
      credentialVersion: sql`${localAgentDevices.credentialVersion} + 1`,
      updatedAt: revokedAt,
    }).where(and(eq(localAgentDevices.id, input.deviceId), eq(localAgentDevices.userUuid, input.userUuid), eq(localAgentDevices.status, "active"))).returning();
    if (!device) throw new LocalAgentServiceError("device not found", "device_not_found", 404);
    const revokedRuntimes = await tx.update(localAgentRuntimes).set({
      status: "revoked",
      connectionEpoch: sql`${localAgentRuntimes.connectionEpoch} + 1`,
      disconnectedAt: revokedAt,
      lastError: "device revoked",
      updatedAt: revokedAt,
    }).where(and(eq(localAgentRuntimes.deviceId, input.deviceId), ne(localAgentRuntimes.status, "revoked"))).returning({ id: localAgentRuntimes.id });
    const runtimeIds = revokedRuntimes.map((runtime) => runtime.id);
    if (runtimeIds.length > 0) {
      await tx.update(localAgentRuntimeSessions).set({ status: "revoked", updatedAt: revokedAt }).where(inArray(localAgentRuntimeSessions.runtimeId, runtimeIds));
      await tx.update(localAgentRuntimeCommands).set({ status: "failed", errorCode: -32004, errorMessage: "local device was revoked", updatedAt: revokedAt }).where(and(
        inArray(localAgentRuntimeCommands.runtimeId, runtimeIds),
        inArray(localAgentRuntimeCommands.status, ["prepared", "sent"]),
      ));
    }
    const replicas = await tx.select({ id: workspaceReplicas.id, spaceId: workspaceReplicas.spaceId }).from(workspaceReplicas).where(eq(workspaceReplicas.deviceId, input.deviceId));
    const replicaIds = replicas.map((replica) => replica.id);
    const activeAttempts = replicaIds.length > 0
      ? await tx.select({ id: workspaceExecutionAttempts.id, spaceId: workspaceExecutionAttempts.spaceId, sessionId: workspaceExecutionAttempts.sessionId, turnId: workspaceExecutionAttempts.turnId, status: workspaceExecutionAttempts.status }).from(workspaceExecutionAttempts).where(and(
          inArray(workspaceExecutionAttempts.replicaId, replicaIds),
          eq(workspaceExecutionAttempts.executorKind, "local_acp"),
          inArray(workspaceExecutionAttempts.status, ["prepared", "running", "workspace_sealed", "transcript_sealed", "awaiting_recovery"]),
        ))
      : [];
    const attemptIds = activeAttempts.map((attempt) => attempt.id);
    abortRequests = activeAttempts
      .filter((attempt) => ["running", "workspace_sealed", "transcript_sealed", "awaiting_recovery"].includes(attempt.status) && typeof attempt.spaceId === "string" && typeof attempt.sessionId === "string" && typeof attempt.turnId === "string")
      .map((attempt) => ({ spaceId: attempt.spaceId, sessionId: attempt.sessionId as string, turnId: attempt.turnId as string }));
    if (attemptIds.length > 0) {
      await tx.update(workspaceExecutionAttempts).set({ status: "aborted", errorCode: "device_revoked", errorMessage: "local device was revoked", completedAt: revokedAt, updatedAt: revokedAt }).where(inArray(workspaceExecutionAttempts.id, attemptIds));
      await tx.update(workspaceState).set({ activeExecutionAttemptId: null, updatedAt: revokedAt }).where(inArray(workspaceState.activeExecutionAttemptId, attemptIds));
      const turnIds = activeAttempts.map((attempt) => attempt.turnId).filter((turnId): turnId is string => typeof turnId === "string");
      if (turnIds.length > 0) {
        await tx.update(sessionTurns).set({ status: "failed", errorMessage: "local device was revoked", summary: { finishReason: "failed", reason: "device_revoked" }, completedAt: revokedAt, updatedAt: revokedAt }).where(and(
          inArray(sessionTurns.id, turnIds),
          inArray(sessionTurns.status, ["queued", "running", "abort_requested"]),
        ));
      }
    }
    if (replicaIds.length > 0) {
      await tx.update(workspaceReplicas).set({ status: "offline", activeExecutionAttemptId: null, updatedAt: revokedAt }).where(inArray(workspaceReplicas.id, replicaIds));
    }
    if (attemptIds.length > 0) {
      await tx.update(workspaceWriterLeases).set({ expiresAt: revokedAt, lastHeartbeatAt: revokedAt, updatedAt: revokedAt }).where(and(
        eq(workspaceWriterLeases.holderKind, "local_agent"),
        inArray(workspaceWriterLeases.holderId, attemptIds),
      ));
    }
    return { device, spaceIds: [...new Set(replicas.map((replica) => replica.spaceId))] };
  });
  for (const request of abortRequests) {
    void requestAgentTurnAbort({
      spaceId: request.spaceId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      reason: "abort",
      actorUserId: input.userUuid,
    }).catch(() => undefined);
  }
  for (const spaceId of result.spaceIds) {
    void notifyWorkspaceState({ spaceId, reason: "device_revoked" }).catch(() => undefined);
  }
  return serializeDevice(result.device);
}

async function getActiveDevice(deviceId: string, userUuid?: string) {
  const conditions = [eq(localAgentDevices.id, deviceId), eq(localAgentDevices.status, "active"), isNull(localAgentDevices.revokedAt)];
  if (userUuid) conditions.push(eq(localAgentDevices.userUuid, userUuid));
  const [device] = await db.select().from(localAgentDevices).where(and(...conditions)).limit(1);
  if (!device) throw new LocalAgentServiceError("device is not enrolled or has been revoked", "device_not_found", 404);
  return device;
}

async function assertDeviceActor(actor: LocalAgentActor, deviceId: string) {
  assertUuid(deviceId, "deviceId");
  if (actor.deviceId !== deviceId) {
    await getActiveDevice(deviceId, actor.userUuid);
    if (actor.principal === "device") throw new LocalAgentServiceError("device does not own this credential", "device_mismatch", 403);
  } else {
    const device = await getActiveDevice(deviceId, actor.userUuid);
    if (actor.principal === "device" && actor.credentialVersion !== undefined && device.credentialVersion !== actor.credentialVersion) {
      throw new LocalAgentServiceError("device credential has been rotated", "device_credential_stale", 401);
    }
  }
}

const defaultWorkspacePolicy = (updatedBy: string) => ({
  policyVersion: 1,
  defaultExcludes: [],
  customExcludes: [],
  sensitiveContentMode: "exclude_with_warning",
  limits: {
    maxEntries: LOCAL_AGENT_MAX_SNAPSHOT_ENTRIES,
    maxFileBytes: 5 * 1024 * 1024 * 1024,
    maxSnapshotBytes: 100 * 1024 * 1024 * 1024,
    maxManifestBytes: 64 * 1024 * 1024,
  },
  updatedBy,
});

const defaultIntegrationPolicy = (spaceId: string, deviceId: string, userUuid: string) => ({
  spaceId,
  deviceId,
  userUuid,
  integrationPolicyVersion: 1,
  workspaceMode: "handoff" as const,
  updatedBy: userUuid,
});

export async function ensureWorkspaceReplica(input: {
  actor: LocalAgentActor;
  spaceId: string;
  rootFingerprint: string;
  displayName: string;
  capabilities?: Record<string, unknown>;
  protocolVersion?: number;
}) {
  assertUuid(input.spaceId, "spaceId");
  const rootFingerprint = normalizeBounded(input.rootFingerprint, "rootFingerprint", 255);
  const displayName = normalizeBounded(input.displayName, "displayName", 255);
  const capabilities = input.capabilities && typeof input.capabilities === "object" && !Array.isArray(input.capabilities)
    ? input.capabilities
    : {};
  const initialChoice = capabilities.initialChoice;
  if (initialChoice !== "use-cloud" && initialChoice !== "use-local" && initialChoice !== "merge") {
    throw new LocalAgentServiceError("capabilities.initialChoice must be use-cloud, use-local, or merge", "initial_strategy_required", 400);
  }
  if (input.actor.deviceId) await assertDeviceActor(input.actor, input.actor.deviceId);
  const [space] = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.id, input.spaceId)).limit(1);
  if (!space) throw new LocalAgentServiceError("space not found", "space_not_found", 404);
  const [sandbox] = await db.select({ provider: spaceSandboxes.provider }).from(spaceSandboxes).where(eq(spaceSandboxes.spaceId, input.spaceId)).limit(1);
  if (sandbox?.provider === "local") {
    throw new LocalAgentServiceError("legacy local sandbox Spaces cannot attach a cloud workspace replica", "legacy_local_sandbox", 409);
  }
  if (!input.actor.deviceId) throw new LocalAgentServiceError("a device credential is required for replica attach", "device_required", 401);
  const device = await getActiveDevice(input.actor.deviceId, input.actor.userUuid);
  const result = await db.transaction(async (tx) => {
    let [policy] = await tx.select().from(spaceWorkspacePolicies).where(eq(spaceWorkspacePolicies.spaceId, input.spaceId)).for("update").limit(1);
    if (!policy) {
      [policy] = await tx.insert(spaceWorkspacePolicies).values({ spaceId: input.spaceId, ...defaultWorkspacePolicy(input.actor.userUuid) }).returning();
    }
    if (!policy) throw new LocalAgentServiceError("workspace policy unavailable", "policy_unavailable", 500);

    let [integrationPolicy] = await tx.select().from(spaceLocalAgentPolicies).where(and(eq(spaceLocalAgentPolicies.spaceId, input.spaceId), eq(spaceLocalAgentPolicies.deviceId, device.id))).for("update").limit(1);
    if (!integrationPolicy) {
      [integrationPolicy] = await tx.insert(spaceLocalAgentPolicies).values(defaultIntegrationPolicy(input.spaceId, device.id, input.actor.userUuid)).returning();
    }
    if (!integrationPolicy) throw new LocalAgentServiceError("local agent policy unavailable", "policy_unavailable", 500);

    let [cloudReplica] = await tx.select().from(workspaceReplicas).where(and(eq(workspaceReplicas.spaceId, input.spaceId), eq(workspaceReplicas.kind, "cloud"))).for("update").limit(1);
    if (!cloudReplica) {
      [cloudReplica] = await tx.insert(workspaceReplicas).values({
        spaceId: input.spaceId,
        kind: "cloud",
        status: "attaching",
        displayName: "Cloud /workspace",
        protocolVersion: input.protocolVersion ?? 1,
        capabilities: { source: "cloud" },
      }).returning();
    }
    if (!cloudReplica) throw new LocalAgentServiceError("cloud replica unavailable", "replica_unavailable", 500);

    let [localReplica] = await tx.select().from(workspaceReplicas).where(and(
      eq(workspaceReplicas.spaceId, input.spaceId),
      eq(workspaceReplicas.deviceId, device.id),
      eq(workspaceReplicas.rootFingerprint, rootFingerprint),
      eq(workspaceReplicas.kind, "local"),
      ne(workspaceReplicas.status, "detached"),
    )).for("update").limit(1);
    if (!localReplica) {
      [localReplica] = await tx.insert(workspaceReplicas).values({
        spaceId: input.spaceId,
        deviceId: device.id,
        userUuid: input.actor.userUuid,
        kind: "local",
        status: "attaching",
        displayName,
        rootFingerprint,
        protocolVersion: input.protocolVersion ?? 1,
        capabilities,
      }).returning();
    } else {
      const storedCapabilities = localReplica.capabilities && typeof localReplica.capabilities === "object" && !Array.isArray(localReplica.capabilities)
        ? localReplica.capabilities as Record<string, unknown>
        : {};
      if (storedCapabilities.initialChoice && storedCapabilities.initialChoice !== initialChoice) {
        throw new LocalAgentServiceError("the replica initial strategy is immutable", "initial_strategy_immutable", 409);
      }
      [localReplica] = await tx.update(workspaceReplicas).set({
        displayName,
        protocolVersion: input.protocolVersion ?? localReplica.protocolVersion,
        capabilities: { ...storedCapabilities, ...capabilities, initialChoice },
        updatedAt: now(),
      }).where(eq(workspaceReplicas.id, localReplica.id)).returning();
    }
    if (!localReplica) throw new LocalAgentServiceError("local replica unavailable", "replica_unavailable", 500);

    let [state] = await tx.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).for("update").limit(1);
    if (!state) {
      [state] = await tx.insert(workspaceState).values({ spaceId: input.spaceId }).returning();
    }
    if (!state) throw new LocalAgentServiceError("workspace state unavailable", "workspace_state_unavailable", 500);
    let [bootstrapCycle] = await tx.select().from(workspaceSyncCycles).where(and(
      eq(workspaceSyncCycles.spaceId, input.spaceId),
      inArray(workspaceSyncCycles.status, ["planned", "transferring", "applying_cloud", "applying_local", "verifying"]),
    )).orderBy(asc(workspaceSyncCycles.createdAt)).limit(1).for("update");
    if (!bootstrapCycle && !state.canonicalSnapshotId && initialChoice === "use-cloud") {
      [bootstrapCycle] = await tx.insert(workspaceSyncCycles).values({
        spaceId: input.spaceId,
        replicaId: cloudReplica.id,
        direction: "initial_attach",
        canonicalGenerationAtStart: state.generation,
        status: "planned",
      }).returning();
    }
    return { policy, integrationPolicy, cloudReplica, localReplica, state, bootstrapCycle: bootstrapCycle ?? null };
  });

  const response = {
    replica: serializeReplica(result.localReplica),
    cloudReplica: serializeReplica(result.cloudReplica),
    workspace: serializeWorkspaceState(result.state),
    workspacePolicy: serializeWorkspacePolicy(result.policy),
    integrationPolicy: serializeIntegrationPolicy(result.integrationPolicy),
    bootstrapCycleId: result.bootstrapCycle?.id ?? null,
  };
  void dispatchWorkspaceStateUpdated({
    spaceId: input.spaceId,
    workspace: response.workspace,
    replica: response.replica,
    reason: "replica_attached",
  }).catch(() => undefined);
  return response;
}

const serializeReplica = (row: typeof workspaceReplicas.$inferSelect) => ({
  id: row.id,
  spaceId: row.spaceId,
  deviceId: row.deviceId,
  userUuid: row.userUuid,
  kind: row.kind,
  status: row.status,
  displayName: row.displayName,
  rootFingerprint: row.rootFingerprint,
  boundaryMode: row.boundaryMode,
  protocolVersion: row.protocolVersion,
  capabilities: row.capabilities,
  currentSnapshotId: row.currentSnapshotId,
  appliedSnapshotId: row.appliedSnapshotId,
  lastCommonSnapshotId: row.lastCommonSnapshotId,
  activeExecutionAttemptId: row.activeExecutionAttemptId,
  lastSeenAt: iso(row.lastSeenAt),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const serializeReplicaOverview = (row: typeof workspaceReplicas.$inferSelect) => ({
  id: row.id,
  spaceId: row.spaceId,
  kind: row.kind,
  status: row.status,
  displayName: row.displayName,
  boundaryMode: row.boundaryMode,
  protocolVersion: row.protocolVersion,
  currentSnapshotId: row.currentSnapshotId,
  appliedSnapshotId: row.appliedSnapshotId,
  lastCommonSnapshotId: row.lastCommonSnapshotId,
  lastSeenAt: iso(row.lastSeenAt),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const serializeWorkspaceState = (row: typeof workspaceState.$inferSelect) => ({
  spaceId: row.spaceId,
  canonicalSnapshotId: row.canonicalSnapshotId,
  cloudAppliedSnapshotId: row.cloudAppliedSnapshotId,
  generation: row.generation,
  status: row.status,
  activeCycleId: row.activeCycleId,
  lastWriterKind: row.lastWriterKind,
  updatedAt: row.updatedAt.toISOString(),
});

const serializeWorkspacePolicy = (row: typeof spaceWorkspacePolicies.$inferSelect) => ({
  id: row.id,
  spaceId: row.spaceId,
  policyVersion: row.policyVersion,
  defaultExcludes: row.defaultExcludes,
  customExcludes: row.customExcludes,
  sensitiveContentMode: row.sensitiveContentMode,
  limits: row.limits,
  updatedBy: row.updatedBy,
  updatedAt: row.updatedAt.toISOString(),
});

export const notifyWorkspaceState = async (input: { spaceId: string; replica?: typeof workspaceReplicas.$inferSelect | null; reason?: string | null }) => {
  const [state] = await db.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).limit(1);
  if (!state) return;
  const [conflictCount] = await db.select({ count: count() }).from(workspaceSyncConflicts).where(and(eq(workspaceSyncConflicts.spaceId, input.spaceId), eq(workspaceSyncConflicts.status, "open")));
  const [lease] = await db.select().from(workspaceWriterLeases).where(eq(workspaceWriterLeases.spaceId, input.spaceId)).limit(1);
  await dispatchWorkspaceStateUpdated({
    spaceId: input.spaceId,
    workspace: serializeWorkspaceState(state),
    replica: input.replica ? serializeReplica(input.replica) : null,
    openConflictCount: Number(conflictCount?.count ?? 0),
    lease: lease ? serializeLease(lease) : null,
    reason: input.reason ?? null,
  });
};

const serializeIntegrationPolicy = (row: typeof spaceLocalAgentPolicies.$inferSelect): LocalAgentPolicyV1 & { spaceId: string; deviceId: string; integrationPolicyVersion: number } => ({
  ...LocalAgentPolicySchema.parse({
    version: 1,
    workspaceMode: row.workspaceMode,
  }),
  spaceId: row.spaceId,
  deviceId: row.deviceId,
  integrationPolicyVersion: row.integrationPolicyVersion,
});

export async function listWorkspaceReplicaStates(input: { actor: LocalAgentActor; spaceId: string }) {
  assertUuid(input.spaceId, "spaceId");
  const visibility = input.actor.deviceId
    ? or(eq(workspaceReplicas.kind, "cloud"), eq(workspaceReplicas.deviceId, input.actor.deviceId))
    : or(eq(workspaceReplicas.kind, "cloud"), eq(workspaceReplicas.userUuid, input.actor.userUuid));
  const replicas = await db.select().from(workspaceReplicas).where(and(eq(workspaceReplicas.spaceId, input.spaceId), visibility)).orderBy(asc(workspaceReplicas.kind), asc(workspaceReplicas.createdAt));
  const [state] = await db.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).limit(1);
  const [policy] = await db.select().from(spaceWorkspacePolicies).where(eq(spaceWorkspacePolicies.spaceId, input.spaceId)).limit(1);
  const [lease] = await db.select().from(workspaceWriterLeases).where(eq(workspaceWriterLeases.spaceId, input.spaceId)).limit(1);
  const [conflictCount] = await db.select({ count: count() }).from(workspaceSyncConflicts).where(and(eq(workspaceSyncConflicts.spaceId, input.spaceId), eq(workspaceSyncConflicts.status, "open")));
  return {
    replicas: replicas.map(serializeReplicaOverview),
    workspace: state ? serializeWorkspaceState(state) : null,
    workspacePolicy: policy ? serializeWorkspacePolicy(policy) : null,
    lease: lease ? serializeLease(lease) : null,
    openConflictCount: Number(conflictCount?.count ?? 0),
  };
}

export async function getWorkspaceReplicaState(input: { actor: LocalAgentActor; spaceId: string; replicaId: string }) {
  assertUuid(input.spaceId, "spaceId");
  assertUuid(input.replicaId, "replicaId");
  const conditions = [eq(workspaceReplicas.id, input.replicaId), eq(workspaceReplicas.spaceId, input.spaceId)];
  if (input.actor.deviceId) conditions.push(eq(workspaceReplicas.deviceId, input.actor.deviceId));
  else conditions.push(sql`(${workspaceReplicas.kind} = 'cloud' or ${workspaceReplicas.userUuid} = ${input.actor.userUuid})`);
  const [replica] = await db.select().from(workspaceReplicas).where(and(...conditions)).limit(1);
  if (!replica) throw new LocalAgentServiceError("replica not found", "replica_not_found", 404);
  const [state] = await db.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).limit(1);
  const [policy] = await db.select().from(spaceWorkspacePolicies).where(eq(spaceWorkspacePolicies.spaceId, input.spaceId)).limit(1);
  const [integrationPolicy] = input.actor.deviceId
    ? await db.select().from(spaceLocalAgentPolicies).where(and(eq(spaceLocalAgentPolicies.spaceId, input.spaceId), eq(spaceLocalAgentPolicies.deviceId, input.actor.deviceId))).limit(1)
    : [];
  const [lease] = await db.select().from(workspaceWriterLeases).where(eq(workspaceWriterLeases.spaceId, input.spaceId)).limit(1);
  const [conflictCount] = await db.select({ count: count() }).from(workspaceSyncConflicts).where(and(eq(workspaceSyncConflicts.spaceId, input.spaceId), eq(workspaceSyncConflicts.status, "open")));
  return {
    replica: serializeReplica(replica),
    workspace: state ? serializeWorkspaceState(state) : null,
    workspacePolicy: policy ? serializeWorkspacePolicy(policy) : null,
    integrationPolicy: integrationPolicy ? serializeIntegrationPolicy(integrationPolicy) : null,
    lease: lease ? serializeLease(lease) : null,
    openConflictCount: Number(conflictCount?.count ?? 0),
  };
}

const serializeLease = (row: typeof workspaceWriterLeases.$inferSelect) => ({
  spaceId: row.spaceId,
  holderKind: row.holderKind,
  epoch: row.epoch,
  baseSnapshotId: row.baseSnapshotId,
  expiresAt: row.expiresAt.toISOString(),
  lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const WORKSPACE_LEASE_HOLDER_KINDS = new Set([
  "local_agent",
  "cloud_agent",
  "cloud_file_api",
  "cloud_command",
  "sync_apply",
]);

const normalizeLeaseHolderKind = (value: string) => {
  const holderKind = normalizeBounded(value, "holderKind", 40);
  if (!WORKSPACE_LEASE_HOLDER_KINDS.has(holderKind)) {
    throw new LocalAgentServiceError("holderKind is unsupported", "invalid_holder_kind", 400);
  }
  return holderKind;
};

async function assertLeaseActor(input: {
  actor: LocalAgentActor;
  spaceId: string;
  holderKind: string;
  holderId: string;
  epoch?: number;
}) {
  const holderKind = normalizeLeaseHolderKind(input.holderKind);
  const conditions = [
    eq(workspaceWriterLeases.spaceId, input.spaceId),
    eq(workspaceWriterLeases.holderKind, holderKind),
    eq(workspaceWriterLeases.holderId, input.holderId),
  ];
  if (input.epoch !== undefined) conditions.push(eq(workspaceWriterLeases.epoch, input.epoch));
  const [lease] = await db.select().from(workspaceWriterLeases).where(and(...conditions)).limit(1);
  if (!lease) throw new LocalAgentServiceError("workspace lease not found", "workspace_lease_not_found", 404);
  if (holderKind === "local_agent") {
    if (input.actor.principal === "user") {
      if (lease.holderUserUuid !== input.actor.userUuid) {
        throw new LocalAgentServiceError("workspace lease does not belong to this user", "lease_owner_mismatch", 403);
      }
      return lease;
    }
    if (!input.actor.deviceId) {
      throw new LocalAgentServiceError("a device credential is required for this workspace lease", "device_required", 401);
    }
    const [attempt] = await db.select({ deviceId: workspaceReplicas.deviceId }).from(workspaceExecutionAttempts)
      .innerJoin(workspaceReplicas, eq(workspaceReplicas.id, workspaceExecutionAttempts.replicaId))
      .where(and(eq(workspaceExecutionAttempts.id, input.holderId), eq(workspaceExecutionAttempts.spaceId, input.spaceId)))
      .limit(1);
    if (attempt?.deviceId !== input.actor.deviceId) {
      throw new LocalAgentServiceError("workspace lease does not belong to this device", "lease_owner_mismatch", 403);
    }
  } else {
    if (input.actor.principal !== "user" || lease.holderUserUuid !== input.actor.userUuid) {
      throw new LocalAgentServiceError("workspace lease does not belong to this user", "lease_owner_mismatch", 403);
    }
  }
  return lease;
}

async function resolveReplicaForActor(input: { actor: LocalAgentActor; spaceId: string; replicaId: string }) {
  assertUuid(input.spaceId, "spaceId");
  assertUuid(input.replicaId, "replicaId");
  const conditions = [eq(workspaceReplicas.id, input.replicaId), eq(workspaceReplicas.spaceId, input.spaceId)];
  if (input.actor.deviceId) conditions.push(eq(workspaceReplicas.deviceId, input.actor.deviceId));
  else conditions.push(sql`(${workspaceReplicas.kind} = 'cloud' or ${workspaceReplicas.userUuid} = ${input.actor.userUuid})`);
  const [replica] = await db.select().from(workspaceReplicas).where(and(...conditions)).limit(1);
  if (!replica) throw new LocalAgentServiceError("replica not found", "replica_not_found", 404);
  return replica;
}

export type SnapshotBlobInput = { path: string; sha256: string; size: number; contentType?: string | null };
export type PrepareSnapshotInput = {
  snapshotId: string;
  replicaGeneration: number;
  parentSnapshotId?: string | null;
  baseCanonicalSnapshotId?: string | null;
  executionAttemptId?: string | null;
  leaseEpoch?: number | null;
  source?: string;
  manifest: unknown;
  manifestSha256?: string;
  manifestTransportSha256?: string | null;
  manifestTransportBytes?: number | null;
  blobs?: SnapshotBlobInput[];
};

const validateSnapshotNumbers = (input: PrepareSnapshotInput, manifest: WorkspaceManifestV1) => {
  if (!Number.isSafeInteger(input.replicaGeneration) || input.replicaGeneration < 0) throw new LocalAgentServiceError("replicaGeneration must be a non-negative safe integer", "invalid_generation", 400);
  if (manifest.entries.length > LOCAL_AGENT_MAX_SNAPSHOT_ENTRIES) throw new LocalAgentServiceError("snapshot contains too many entries", "snapshot_limit", 413);
  const totalBytes = manifest.entries.reduce((sum, entry) => sum + (entry.type === "file" ? entry.size : 0), 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > 100 * 1024 * 1024 * 1024) throw new LocalAgentServiceError("snapshot exceeds the configured size limit", "snapshot_limit", 413);
  return totalBytes;
};

export async function prepareWorkspaceSnapshot(input: { actor: LocalAgentActor; spaceId: string; replicaId: string; value: PrepareSnapshotInput }) {
  const replica = await resolveReplicaForActor({ actor: input.actor, spaceId: input.spaceId, replicaId: input.replicaId });
  if (replica.kind !== "local") throw new LocalAgentServiceError("snapshot upload requires a local replica", "invalid_replica_kind", 400);
  assertUuid(input.value.snapshotId, "snapshotId");
  if (input.value.parentSnapshotId) assertUuid(input.value.parentSnapshotId, "parentSnapshotId");
  if (input.value.baseCanonicalSnapshotId) assertUuid(input.value.baseCanonicalSnapshotId, "baseCanonicalSnapshotId");
  if (input.value.executionAttemptId) assertUuid(input.value.executionAttemptId, "executionAttemptId");
  if (input.value.leaseEpoch != null && (!Number.isSafeInteger(input.value.leaseEpoch) || input.value.leaseEpoch < 1)) {
    throw new LocalAgentServiceError("leaseEpoch must be a positive safe integer", "invalid_epoch", 400);
  }
  const source = input.value.source ?? "watcher";
  if (source !== "watcher" && source !== "initial_merge" && source !== "initial_use_local") {
    throw new LocalAgentServiceError("snapshot source is unsupported", "snapshot_source_invalid", 400);
  }
  const capabilities = replica.capabilities && typeof replica.capabilities === "object" && !Array.isArray(replica.capabilities)
    ? replica.capabilities as Record<string, unknown>
    : {};
  const initialChoice = typeof capabilities.initialChoice === "string" ? capabilities.initialChoice : null;
  if (source === "initial_merge" && initialChoice !== "merge") {
    throw new LocalAgentServiceError("replica was not attached with merge as its initial strategy", "initial_strategy_mismatch", 409);
  }
  if (source === "initial_use_local" && initialChoice !== "use-local") {
    throw new LocalAgentServiceError("replica was not attached with use-local as its initial strategy", "initial_strategy_mismatch", 409);
  }
  if (source.startsWith("initial_") && replica.appliedSnapshotId) {
    throw new LocalAgentServiceError("initial reconciliation is already complete", "initial_reconciliation_complete", 409);
  }
  const parsed = validateManifest(WorkspaceManifestSchema.parse(input.value.manifest));
  const totalBytes = validateSnapshotNumbers(input.value, parsed);
  const canonicalBytes = canonicalizeJsonBytes(parsed);
  const manifestSha256 = await canonicalJsonSha256(parsed);
  if (input.value.manifestSha256) assertSha256(input.value.manifestSha256, "manifestSha256");
  if (input.value.manifestSha256 && input.value.manifestSha256 !== manifestSha256) throw new LocalAgentServiceError("manifestSha256 does not match canonical manifest", "manifest_hash_mismatch", 422);
  if (input.value.manifestTransportSha256) assertSha256(input.value.manifestTransportSha256, "manifestTransportSha256");
  if (input.value.manifestTransportSha256 && input.value.manifestTransportSha256 !== manifestSha256) throw new LocalAgentServiceError("manifest transport hash must match canonical manifest bytes", "manifest_transport_mismatch", 422);
  if (input.value.manifestTransportBytes != null && input.value.manifestTransportBytes !== canonicalBytes.byteLength) throw new LocalAgentServiceError("manifest transport size must match canonical manifest bytes", "manifest_transport_mismatch", 422);
  const manifestObjectKey = buildLocalAgentObjectKey({ spaceId: input.spaceId, kind: "manifest", identity: `${input.value.snapshotId}.json` });
  const inline = canonicalBytes.byteLength <= LOCAL_AGENT_MAX_MANIFEST_INLINE_BYTES;
  const declaredBlobsByPath = new Map<string, SnapshotBlobInput>();
  for (const blob of input.value.blobs ?? []) {
    if (!blob || typeof blob.path !== "string" || declaredBlobsByPath.has(blob.path)) {
      throw new LocalAgentServiceError("blob descriptors must have unique paths", "blob_descriptor_invalid", 400);
    }
    declaredBlobsByPath.set(blob.path, blob);
  }
  const blobInputs: SnapshotBlobInput[] = [];
  const uniqueBlobInputs = new Map<string, SnapshotBlobInput>();
  for (const entry of parsed.entries) {
    if (entry.type !== "file") continue;
    const declared = declaredBlobsByPath.get(entry.path);
    const blob = declared ?? { path: entry.path, sha256: entry.sha256, size: entry.size, contentType: null };
    if (blob.sha256 !== entry.sha256 || blob.size !== entry.size) throw new LocalAgentServiceError(`blob descriptor does not match ${entry.path}`, "blob_descriptor_mismatch", 422);
    assertSha256(blob.sha256, `blob sha256 for ${entry.path}`);
    if (!Number.isSafeInteger(blob.size) || blob.size < 0) throw new LocalAgentServiceError(`blob size is invalid for ${entry.path}`, "invalid_blob_size", 400);
    blobInputs.push(blob);
    const existing = uniqueBlobInputs.get(blob.sha256);
    if (existing && (existing.size !== blob.size || (existing.contentType ?? null) !== (blob.contentType ?? null))) {
      throw new LocalAgentServiceError(`blob metadata conflicts for ${blob.sha256}`, "blob_metadata_conflict", 409);
    }
    uniqueBlobInputs.set(blob.sha256, blob);
    declaredBlobsByPath.delete(entry.path);
  }
  if (declaredBlobsByPath.size > 0) {
    throw new LocalAgentServiceError(`blob descriptor path is not in the manifest: ${declaredBlobsByPath.keys().next().value ?? "unknown"}`, "blob_descriptor_unknown_path", 422);
  }

  const result = await db.transaction(async (tx) => {
    const loadSnapshotBlobs = async (snapshotId: string) => tx.select({
      sha256: workspaceBlobs.sha256,
      size: workspaceBlobs.size,
      objectKey: workspaceBlobs.objectKey,
      status: workspaceBlobs.status,
    }).from(workspaceSnapshotBlobs)
      .innerJoin(workspaceBlobs, eq(workspaceBlobs.id, workspaceSnapshotBlobs.blobId))
      .where(eq(workspaceSnapshotBlobs.snapshotId, snapshotId));
    const [existing] = await tx.select().from(workspaceSnapshots).where(and(eq(workspaceSnapshots.id, input.value.snapshotId), eq(workspaceSnapshots.replicaId, replica.id))).for("update").limit(1);
    if (existing) {
      if (
        existing.manifestSha256 !== manifestSha256
        || existing.replicaGeneration !== input.value.replicaGeneration
        || existing.parentSnapshotId !== (input.value.parentSnapshotId ?? null)
        || existing.baseCanonicalSnapshotId !== (input.value.baseCanonicalSnapshotId ?? null)
        || existing.sourceExecutionAttemptId !== (input.value.executionAttemptId ?? null)
        || existing.leaseEpoch !== (input.value.leaseEpoch ?? null)
        || existing.source !== source
      ) throw new LocalAgentServiceError("snapshot id was already used with different content or provenance", "idempotency_conflict", 409);
      const existingBlobs = await loadSnapshotBlobs(existing.id);
      if (new Set(existingBlobs.map((blob) => blob.sha256)).size !== uniqueBlobInputs.size) {
        throw new LocalAgentServiceError("existing snapshot blob mapping is incomplete", "snapshot_mapping_incomplete", 409);
      }
      return { snapshot: existing, existing: true, blobs: existingBlobs };
    }
    const [lockedReplica] = await tx.select().from(workspaceReplicas).where(and(eq(workspaceReplicas.id, replica.id), eq(workspaceReplicas.spaceId, input.spaceId))).for("update").limit(1);
    if (!lockedReplica) throw new LocalAgentServiceError("replica not found", "replica_not_found", 404);
    const [integrationPolicy] = lockedReplica.deviceId
      ? await tx.select({ workspaceMode: spaceLocalAgentPolicies.workspaceMode }).from(spaceLocalAgentPolicies).where(and(
          eq(spaceLocalAgentPolicies.spaceId, input.spaceId),
          eq(spaceLocalAgentPolicies.deviceId, lockedReplica.deviceId),
        )).limit(1)
      : [];
    if (integrationPolicy?.workspaceMode === "one_way_to_local") {
      throw new LocalAgentServiceError("local snapshot upload is disabled by workspace policy", "workspace_write_disabled", 403);
    }
    const [policy] = await tx.select().from(spaceWorkspacePolicies).where(eq(spaceWorkspacePolicies.spaceId, input.spaceId)).for("update").limit(1);
    if (!policy) throw new LocalAgentServiceError("workspace policy is not initialized", "policy_unavailable", 409);
    if (parsed.policyVersion !== policy.policyVersion) throw new LocalAgentServiceError("snapshot uses an outdated workspace policy", "policy_version_stale", 409);
    const [currentState] = await tx.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).for("update").limit(1);
    if (!currentState) throw new LocalAgentServiceError("workspace state is unavailable", "workspace_state_unavailable", 409);
    if ((input.value.parentSnapshotId ?? null) !== (lockedReplica.appliedSnapshotId ?? null)) {
      throw new LocalAgentServiceError("parentSnapshotId must match the snapshot applied to this replica", "snapshot_parent_stale", 409);
    }
    if (source === "initial_merge" && input.value.baseCanonicalSnapshotId) {
      throw new LocalAgentServiceError("initial merge must not declare a common base", "initial_merge_base_invalid", 409);
    }
    const expectedBase = source === "initial_use_local" ? currentState.canonicalSnapshotId : source === "watcher" ? lockedReplica.appliedSnapshotId : null;
    if ((input.value.baseCanonicalSnapshotId ?? null) !== (expectedBase ?? null)) {
      throw new LocalAgentServiceError("baseCanonicalSnapshotId does not match the replica strategy", "snapshot_base_stale", 409);
    }
    for (const referencedSnapshotId of [input.value.parentSnapshotId, input.value.baseCanonicalSnapshotId].filter((value): value is string => Boolean(value))) {
      const [referenced] = await tx.select({ id: workspaceSnapshots.id }).from(workspaceSnapshots).where(and(
        eq(workspaceSnapshots.id, referencedSnapshotId),
        eq(workspaceSnapshots.spaceId, input.spaceId),
        eq(workspaceSnapshots.status, "ready"),
      )).limit(1);
      if (!referenced) throw new LocalAgentServiceError("snapshot provenance references an unavailable snapshot", "snapshot_reference_invalid", 409);
    }
    if (input.value.executionAttemptId) {
      const [attempt] = await tx.select({ id: workspaceExecutionAttempts.id, workspaceLeaseEpoch: workspaceExecutionAttempts.workspaceLeaseEpoch }).from(workspaceExecutionAttempts).where(and(
        eq(workspaceExecutionAttempts.id, input.value.executionAttemptId),
        eq(workspaceExecutionAttempts.spaceId, input.spaceId),
        eq(workspaceExecutionAttempts.replicaId, replica.id),
      )).limit(1);
      if (!attempt) throw new LocalAgentServiceError("executionAttemptId does not belong to this replica", "attempt_identity_mismatch", 409);
      if ((attempt.workspaceLeaseEpoch ?? null) !== (input.value.leaseEpoch ?? null)) {
        throw new LocalAgentServiceError("snapshot lease epoch does not match its execution attempt", "snapshot_epoch_stale", 409);
      }
    } else if (input.value.leaseEpoch != null) {
      throw new LocalAgentServiceError("leaseEpoch requires an executionAttemptId", "snapshot_epoch_invalid", 400);
    }
    const [snapshot] = await tx.insert(workspaceSnapshots).values({
      id: input.value.snapshotId,
      spaceId: input.spaceId,
      replicaId: replica.id,
      replicaGeneration: input.value.replicaGeneration,
      parentSnapshotId: input.value.parentSnapshotId ?? null,
      baseCanonicalSnapshotId: input.value.baseCanonicalSnapshotId ?? null,
      workspacePolicyVersion: policy.policyVersion,
      manifestVersion: parsed.version,
      manifestObjectKey,
      manifestInline: inline ? parsed as unknown as Record<string, unknown> : null,
      manifestSha256,
      manifestTransportSha256: input.value.manifestTransportSha256 ?? null,
      manifestTransportBytes: input.value.manifestTransportBytes ?? null,
      treeHash: await canonicalJsonSha256({ scanPolicyHash: parsed.scanPolicyHash, entries: parsed.entries, boundaries: parsed.boundaries, portableGitState: parsed.portableGitState }),
      fileCount: parsed.entries.filter((entry) => entry.type === "file").length,
      totalBytes,
      source,
      sourceExecutionAttemptId: input.value.executionAttemptId ?? null,
      leaseEpoch: input.value.leaseEpoch ?? null,
      status: "uploading",
    }).returning();
    if (!snapshot) throw new LocalAgentServiceError("failed to create snapshot", "snapshot_create_failed", 500);
    const blobRowsByHash = new Map<string, typeof workspaceBlobs.$inferSelect>();
    for (const blob of uniqueBlobInputs.values()) {
      let [row] = await tx.select().from(workspaceBlobs).where(and(eq(workspaceBlobs.spaceId, input.spaceId), eq(workspaceBlobs.sha256, blob.sha256))).for("update").limit(1);
      if (row && row.size !== blob.size) throw new LocalAgentServiceError("blob hash is already registered with a different size", "blob_size_conflict", 409);
      if (!row) {
        const objectKey = buildLocalAgentObjectKey({ spaceId: input.spaceId, kind: "blob", identity: blob.sha256 });
        [row] = await tx.insert(workspaceBlobs).values({
          spaceId: input.spaceId,
          sha256: blob.sha256,
          size: blob.size,
          objectKey,
          contentType: blob.contentType ?? null,
          status: "uploading",
        }).returning();
      }
      if (!row) throw new LocalAgentServiceError("failed to create blob record", "blob_create_failed", 500);
      blobRowsByHash.set(blob.sha256, row);
    }
    for (const blob of blobInputs) {
      const row = blobRowsByHash.get(blob.sha256);
      if (!row) throw new LocalAgentServiceError("blob record is missing during snapshot mapping", "blob_mapping_failed", 500);
      await tx.insert(workspaceSnapshotBlobs).values({ snapshotId: snapshot.id, blobId: row.id, path: blob.path }).onConflictDoNothing();
    }
    return {
      snapshot,
      existing: false,
      blobs: [...blobRowsByHash.values()].map((row) => ({
        sha256: row.sha256,
        size: row.size,
        objectKey: row.objectKey,
        status: row.status,
      })),
    };
  });

  const blobUploads = await Promise.all(result.blobs.map(async (blob) => {
    const record = blob as { sha256: string; size: number; objectKey: string; status: string };
    if (record.status === "ready") return { ...record, uploadUrl: null, headers: null, ready: true };
    const signed = createLocalAgentObjectPutUrl({ objectKey: record.objectKey, contentType: "application/octet-stream", contentLength: record.size, sha256: record.sha256 });
    return { ...record, uploadUrl: signed.uploadUrl, headers: signed.headers ?? null, expiresAt: signed.expiresAt, ready: false };
  }));
  const manifestUpload = inline
    ? null
    : (() => {
        const signed = createLocalAgentObjectPutUrl({ objectKey: manifestObjectKey, contentType: "application/json", contentLength: canonicalBytes.byteLength, sha256: manifestSha256 });
        return { objectKey: manifestObjectKey, uploadUrl: signed.uploadUrl, headers: signed.headers ?? null, expiresAt: signed.expiresAt };
      })();
  return {
    snapshotId: result.snapshot.id,
    status: result.snapshot.status,
    manifestSha256,
    manifestBytes: canonicalBytes.byteLength,
    manifestInline: inline,
    manifestUpload,
    blobs: blobUploads,
    existing: result.existing,
  };
}

export async function getWorkspaceSnapshot(input: { actor: LocalAgentActor; spaceId: string; replicaId: string; snapshotId: string }) {
  const replica = await resolveReplicaForActor({ actor: input.actor, spaceId: input.spaceId, replicaId: input.replicaId });
  assertUuid(input.snapshotId, "snapshotId");
  const [snapshot] = await db.select().from(workspaceSnapshots).where(and(eq(workspaceSnapshots.id, input.snapshotId), eq(workspaceSnapshots.spaceId, input.spaceId), inArray(workspaceSnapshots.status, ["ready", "gc_pending"]))).limit(1);
  if (!snapshot) throw new LocalAgentServiceError("snapshot not found", "snapshot_not_found", 404);
  const [state] = await db.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).limit(1);
  const replicaOwnsSnapshot = snapshot.replicaId === replica.id;
  const isCanonicalSnapshot = state?.canonicalSnapshotId === snapshot.id;
  if (!replicaOwnsSnapshot && !isCanonicalSnapshot) {
    throw new LocalAgentServiceError("snapshot is outside this replica's recovery scope", "snapshot_scope_mismatch", 403);
  }
  const blobRows = await db.select({ path: workspaceSnapshotBlobs.path, blob: workspaceBlobs }).from(workspaceSnapshotBlobs).innerJoin(workspaceBlobs, eq(workspaceBlobs.id, workspaceSnapshotBlobs.blobId)).where(eq(workspaceSnapshotBlobs.snapshotId, snapshot.id)).orderBy(asc(workspaceSnapshotBlobs.path));
  return {
    snapshot: {
      id: snapshot.id,
      spaceId: snapshot.spaceId,
      replicaId: snapshot.replicaId,
      replicaGeneration: snapshot.replicaGeneration,
      parentSnapshotId: snapshot.parentSnapshotId,
      baseCanonicalSnapshotId: snapshot.baseCanonicalSnapshotId,
      policyVersion: snapshot.workspacePolicyVersion,
      manifestSha256: snapshot.manifestSha256,
      treeHash: snapshot.treeHash,
      fileCount: snapshot.fileCount,
      totalBytes: snapshot.totalBytes,
      status: snapshot.status,
    },
    manifest: snapshot.manifestInline,
    manifestDownload: snapshot.manifestInline ? null : createLocalAgentObjectGetUrl(snapshot.manifestObjectKey),
    blobs: blobRows.map(({ path, blob }) => ({
      path,
      sha256: blob.sha256,
      size: blob.size,
      contentType: blob.contentType,
      download: createLocalAgentObjectGetUrl(blob.objectKey),
    })),
  };
}

export async function ackWorkspaceReplicaApplied(input: { actor: LocalAgentActor; spaceId: string; replicaId: string; snapshotId: string; generation: number }) {
  const replica = await resolveReplicaForActor({ actor: input.actor, spaceId: input.spaceId, replicaId: input.replicaId });
  assertUuid(input.snapshotId, "snapshotId");
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new LocalAgentServiceError("generation is invalid", "invalid_generation", 400);
  const [snapshot] = await db.select({ id: workspaceSnapshots.id, replicaId: workspaceSnapshots.replicaId, status: workspaceSnapshots.status }).from(workspaceSnapshots).where(and(eq(workspaceSnapshots.id, input.snapshotId), eq(workspaceSnapshots.spaceId, input.spaceId))).limit(1);
  if (snapshot?.status !== "ready") throw new LocalAgentServiceError("snapshot is not ready", "snapshot_not_ready", 409);
  const [snapshotReplica] = await db.select({ kind: workspaceReplicas.kind }).from(workspaceReplicas).where(eq(workspaceReplicas.id, snapshot.replicaId)).limit(1);
  if (snapshotReplica?.kind !== "cloud") throw new LocalAgentServiceError("only a cloud canonical snapshot can be applied to a local replica", "snapshot_kind_invalid", 409);
  const [state] = await db.select({ canonicalSnapshotId: workspaceState.canonicalSnapshotId, generation: workspaceState.generation }).from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).limit(1);
  if (!state || state.canonicalSnapshotId !== snapshot.id) {
    throw new LocalAgentServiceError("snapshot is no longer the workspace canonical version", "snapshot_not_canonical", 409);
  }
  if (state.generation !== input.generation) {
    throw new LocalAgentServiceError("workspace generation changed while applying the snapshot", "generation_stale", 409);
  }
  const [updated] = await db.update(workspaceReplicas).set({
    currentSnapshotId: snapshot.id,
    appliedSnapshotId: snapshot.id,
    lastCommonSnapshotId: snapshot.id,
    status: "ready",
    lastSeenAt: now(),
    updatedAt: now(),
  }).where(and(eq(workspaceReplicas.id, replica.id), or(isNull(workspaceReplicas.currentSnapshotId), eq(workspaceReplicas.currentSnapshotId, snapshot.id)))).returning();
  if (!updated) throw new LocalAgentServiceError("replica has moved since the snapshot was downloaded", "replica_state_stale", 409);
  void notifyWorkspaceState({ spaceId: input.spaceId, replica: updated, reason: "replica_applied" }).catch(() => undefined);
  return serializeReplica(updated);
}

export async function commitWorkspaceSnapshot(input: { actor: LocalAgentActor; spaceId: string; replicaId: string; snapshotId: string }) {
  const replica = await resolveReplicaForActor({ actor: input.actor, spaceId: input.spaceId, replicaId: input.replicaId });
  assertUuid(input.snapshotId, "snapshotId");
  const [snapshot] = await db.select().from(workspaceSnapshots).where(and(eq(workspaceSnapshots.id, input.snapshotId), eq(workspaceSnapshots.replicaId, replica.id), eq(workspaceSnapshots.spaceId, input.spaceId))).limit(1);
  if (!snapshot) throw new LocalAgentServiceError("snapshot not found", "snapshot_not_found", 404);
  if (snapshot.status === "ready") {
    const [cycle] = await db.select({ id: workspaceSyncCycles.id }).from(workspaceSyncCycles).where(eq(workspaceSyncCycles.localSnapshotId, snapshot.id)).orderBy(asc(workspaceSyncCycles.createdAt)).limit(1);
    return serializeSnapshotCommit(snapshot, cycle?.id ?? null);
  }
  if (snapshot.manifestInline == null) {
    try {
      if (snapshot.manifestTransportBytes != null && snapshot.manifestTransportSha256) {
        await verifyLocalAgentObject({ objectKey: snapshot.manifestObjectKey, expectedSize: snapshot.manifestTransportBytes, expectedSha256: snapshot.manifestTransportSha256 });
      } else {
        const head = await headLocalAgentObject(snapshot.manifestObjectKey);
        if (snapshot.manifestTransportBytes != null && head.size !== snapshot.manifestTransportBytes) throw new LocalAgentServiceError("manifest transport size mismatch", "manifest_transport_mismatch", 422);
      }
    } catch (error) {
      if (error instanceof LocalAgentServiceError) throw error;
      if (error instanceof LocalAgentObjectStorageError && !/not available|no body/.test(error.message)) {
        throw new LocalAgentServiceError(`manifest object verification failed: ${error.message}`, "manifest_transport_mismatch", 422);
      }
      throw new LocalAgentServiceError("manifest object is not available", "manifest_object_missing", 409);
    }
  }
  const blobRows = await db.select({ blob: workspaceBlobs }).from(workspaceSnapshotBlobs).innerJoin(workspaceBlobs, eq(workspaceBlobs.id, workspaceSnapshotBlobs.blobId)).where(eq(workspaceSnapshotBlobs.snapshotId, snapshot.id));
  // Every blob that is not already verified must match its declared bytes
  // before it becomes `ready`; a ready blob is reused by later snapshots
  // without another upload, so this is the only point that guards it.
  for (const { blob } of blobRows) {
    if (blob.status === "ready") continue;
    try {
      await verifyLocalAgentObject({ objectKey: blob.objectKey, expectedSize: blob.size, expectedSha256: blob.sha256 });
    } catch (error) {
      if (error instanceof LocalAgentObjectStorageError && /does not match|exceeds/.test(error.message)) {
        throw new LocalAgentServiceError(`blob content mismatch for ${blob.sha256}: ${error.message}`, "blob_hash_mismatch", 422);
      }
      throw new LocalAgentServiceError(`blob object is not available for ${blob.sha256}`, "blob_object_missing", 409);
    }
  }
  const committed = await db.transaction(async (tx) => {
    const verifiedAt = now();
    const [currentState] = await tx.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).for("update").limit(1);
    if (!currentState) throw new LocalAgentServiceError("workspace state is unavailable", "workspace_state_unavailable", 409);
    for (const { blob } of blobRows) {
      await tx.update(workspaceBlobs).set({ status: "ready", verifiedAt, updatedAt: verifiedAt }).where(and(eq(workspaceBlobs.id, blob.id), ne(workspaceBlobs.status, "ready")));
    }
    const [updated] = await tx.update(workspaceSnapshots).set({ status: "ready", updatedAt: verifiedAt }).where(and(eq(workspaceSnapshots.id, snapshot.id), eq(workspaceSnapshots.status, "uploading"))).returning();
    const [cycle] = await tx.insert(workspaceSyncCycles).values({
      spaceId: input.spaceId,
      replicaId: replica.id,
      baseSnapshotId: updated?.baseCanonicalSnapshotId ?? snapshot.baseCanonicalSnapshotId,
      localSnapshotId: updated?.id ?? snapshot.id,
      direction: "reconcile",
      status: "planned",
      canonicalGenerationAtStart: currentState.generation,
      executionAttemptId: updated?.sourceExecutionAttemptId ?? snapshot.sourceExecutionAttemptId,
      leaseEpoch: updated?.leaseEpoch ?? snapshot.leaseEpoch,
    }).onConflictDoNothing().returning();
    await tx.update(workspaceReplicas).set({ currentSnapshotId: updated?.id ?? snapshot.id, status: "syncing", updatedAt: verifiedAt }).where(eq(workspaceReplicas.id, replica.id));
    if (cycle) {
      await tx.update(workspaceState).set({ status: "syncing", activeCycleId: cycle.id, updatedAt: verifiedAt }).where(eq(workspaceState.spaceId, input.spaceId));
    }
    return { snapshot: updated ?? snapshot, cycleId: cycle?.id ?? null };
  });
  if (committed.cycleId) {
    void notifyWorkspaceState({ spaceId: input.spaceId, replica, reason: "snapshot_committed" }).catch(() => undefined);
    return serializeSnapshotCommit(committed.snapshot, committed.cycleId);
  }
  const [existingCycle] = await db.select({ id: workspaceSyncCycles.id }).from(workspaceSyncCycles).where(eq(workspaceSyncCycles.localSnapshotId, committed.snapshot.id)).orderBy(asc(workspaceSyncCycles.createdAt)).limit(1);
  void notifyWorkspaceState({ spaceId: input.spaceId, replica, reason: "snapshot_commit_recovered" }).catch(() => undefined);
  return serializeSnapshotCommit(committed.snapshot, existingCycle?.id ?? null);
}

const serializeSnapshotCommit = (snapshot: typeof workspaceSnapshots.$inferSelect, cycleId: string | null) => ({
  snapshotId: snapshot.id,
  status: snapshot.status,
  manifestSha256: snapshot.manifestSha256,
  treeHash: snapshot.treeHash,
  cycleId,
});

export async function acquireWorkspaceWriterLease(input: {
  actor: LocalAgentActor;
  spaceId: string;
  holderKind: string;
  holderId: string;
  replicaId?: string | null;
  baseSnapshotId?: string | null;
  durationSeconds?: number;
}) {
  assertUuid(input.spaceId, "spaceId");
  const holderKind = normalizeLeaseHolderKind(input.holderKind);
  const holderId = normalizeBounded(input.holderId, "holderId", 255);
  let localReplicaIdentity: { id: string; deviceId: string } | null = null;
  if (holderKind === "local_agent") {
    if (input.replicaId) assertUuid(input.replicaId, "replicaId");
    const conditions = [
      eq(workspaceReplicas.spaceId, input.spaceId),
      eq(workspaceReplicas.kind, "local"),
      ne(workspaceReplicas.status, "detached"),
    ];
    if (input.replicaId) conditions.push(eq(workspaceReplicas.id, input.replicaId));
    if (input.actor.principal === "device" && input.actor.deviceId) conditions.push(eq(workspaceReplicas.deviceId, input.actor.deviceId));
    else conditions.push(eq(workspaceReplicas.userUuid, input.actor.userUuid));
    const [ownedReplica] = await db.select({ id: workspaceReplicas.id, deviceId: workspaceReplicas.deviceId }).from(workspaceReplicas).where(and(...conditions)).orderBy(desc(workspaceReplicas.updatedAt)).limit(1);
    if (!ownedReplica?.deviceId) throw new LocalAgentServiceError("local replica is unavailable", "replica_not_found", 404);
    localReplicaIdentity = { id: ownedReplica.id, deviceId: ownedReplica.deviceId };
  } else if (input.actor.principal !== "user") {
    throw new LocalAgentServiceError("a user credential is required for a cloud workspace lease", "user_required", 401);
  }
  const requestedDuration = Math.min(input.durationSeconds ?? LOCAL_AGENT_ONLINE_LEASE_SECONDS, LOCAL_AGENT_ONLINE_LEASE_SECONDS);
  if (!Number.isSafeInteger(requestedDuration) || requestedDuration <= 0) throw new LocalAgentServiceError("durationSeconds is invalid", "invalid_duration", 400);
  if (input.baseSnapshotId) assertUuid(input.baseSnapshotId, "baseSnapshotId");
  const result = await db.transaction(async (tx) => {
    const current = now();
    const [workspace] = await tx.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).for("update").limit(1);
    if (workspace?.status !== "ready" || !workspace.canonicalSnapshotId) {
      throw new LocalAgentServiceError("workspace is not ready for a writer lease", "workspace_not_ready", 409);
    }
    if (input.baseSnapshotId && input.baseSnapshotId !== workspace.canonicalSnapshotId) {
      throw new LocalAgentServiceError("lease base snapshot is not canonical", "lease_base_stale", 409);
    }
    if (holderKind === "local_agent" && localReplicaIdentity) {
      const [integrationPolicy] = await tx.select().from(spaceLocalAgentPolicies).where(and(
        eq(spaceLocalAgentPolicies.spaceId, input.spaceId),
        eq(spaceLocalAgentPolicies.deviceId, localReplicaIdentity.deviceId),
      )).limit(1);
      if (!integrationPolicy) throw new LocalAgentServiceError("local agent policy is unavailable", "policy_unavailable", 409);
      if (integrationPolicy.workspaceMode === "one_way_to_local") {
        throw new LocalAgentServiceError("local workspace is read-only under the current policy", "workspace_write_disabled", 403);
      }
    }
    const [existing] = await tx.select().from(workspaceWriterLeases).where(eq(workspaceWriterLeases.spaceId, input.spaceId)).for("update").limit(1);
    const sameHolder = existing?.holderId === holderId && existing.holderKind === holderKind;
    if (existing && existing.expiresAt.getTime() > current.getTime() && !sameHolder) {
      throw new LocalAgentServiceError("workspace is held by another writer", "workspace_lease_busy", 409);
    }
    if (holderKind === "local_agent") {
      assertUuid(holderId, "holderId");
      // A local writer lease is only ever held by a registered ACP execution
      // attempt. Refusing unknown holders keeps the lease table and the attempt
      // ledger consistent; there is no hook-driven attempt creation path.
      const [attempt] = await tx.select({ deviceId: workspaceReplicas.deviceId }).from(workspaceExecutionAttempts)
        .innerJoin(workspaceReplicas, eq(workspaceReplicas.id, workspaceExecutionAttempts.replicaId))
        .where(and(eq(workspaceExecutionAttempts.id, holderId), eq(workspaceExecutionAttempts.spaceId, input.spaceId), eq(workspaceExecutionAttempts.executorKind, "local_acp")))
        .limit(1);
      if (!attempt) throw new LocalAgentServiceError("execution attempt is not registered for this workspace", "attempt_not_found", 404);
      if (attempt.deviceId !== localReplicaIdentity?.deviceId) {
        throw new LocalAgentServiceError("execution attempt does not belong to this device", "attempt_identity_mismatch", 403);
      }
    }
    const sameActiveHolder = sameHolder && Boolean(existing && existing.expiresAt > current);
    const epoch = (existing?.epoch ?? 0) + (sameActiveHolder ? 0 : 1);
    const expiresAt = new Date(current.getTime() + requestedDuration * 1000);
    const [lease] = await tx.insert(workspaceWriterLeases).values({
      spaceId: input.spaceId,
      holderKind,
      holderId,
      holderUserUuid: input.actor.userUuid,
      epoch,
      baseSnapshotId: input.baseSnapshotId ?? existing?.baseSnapshotId ?? workspace.canonicalSnapshotId,
      expiresAt,
      lastHeartbeatAt: current,
      updatedAt: current,
    }).onConflictDoUpdate({
      target: workspaceWriterLeases.spaceId,
      set: {
        holderKind,
        holderId,
        holderUserUuid: input.actor.userUuid,
        epoch,
        baseSnapshotId: input.baseSnapshotId ?? existing?.baseSnapshotId ?? workspace.canonicalSnapshotId,
        expiresAt,
        lastHeartbeatAt: current,
        updatedAt: current,
      },
    }).returning();
    if (!lease) throw new LocalAgentServiceError("failed to acquire workspace lease", "workspace_lease_failed", 500);
    if (holderKind === "local_agent") {
      await tx.update(workspaceExecutionAttempts).set({ workspaceLeaseEpoch: lease.epoch, updatedAt: current }).where(and(
        eq(workspaceExecutionAttempts.id, holderId),
        eq(workspaceExecutionAttempts.spaceId, input.spaceId),
      ));
    }
    if (holderKind === "local_agent" || holderKind === "cloud_agent") {
      await tx.update(workspaceState).set({ activeExecutionAttemptId: holderId, updatedAt: current }).where(eq(workspaceState.spaceId, input.spaceId));
      await tx.update(workspaceReplicas).set({ activeExecutionAttemptId: holderId, updatedAt: current }).where(and(
        eq(workspaceReplicas.spaceId, input.spaceId),
        eq(workspaceReplicas.kind, holderKind === "cloud_agent" ? "cloud" : "local"),
        ...(holderKind === "local_agent" && localReplicaIdentity ? [eq(workspaceReplicas.id, localReplicaIdentity.id)] : []),
      ));
    }
    return lease;
  });
  void notifyWorkspaceState({ spaceId: input.spaceId, reason: "lease_acquired" }).catch(() => undefined);
  return serializeLease(result);
}

export async function heartbeatWorkspaceWriterLease(input: { actor: LocalAgentActor; spaceId: string; holderKind: string; holderId: string; epoch: number; durationSeconds?: number }) {
  assertUuid(input.spaceId, "spaceId");
  const holderKind = normalizeLeaseHolderKind(input.holderKind);
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) throw new LocalAgentServiceError("epoch is invalid", "invalid_epoch", 400);
  await assertLeaseActor({ actor: input.actor, spaceId: input.spaceId, holderKind, holderId: input.holderId, epoch: input.epoch });
  const seconds = Math.min(input.durationSeconds ?? LOCAL_AGENT_ONLINE_LEASE_SECONDS, LOCAL_AGENT_ONLINE_LEASE_SECONDS);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new LocalAgentServiceError("durationSeconds is invalid", "invalid_duration", 400);
  const current = now();
  const [lease] = await db.update(workspaceWriterLeases).set({
    expiresAt: new Date(current.getTime() + seconds * 1000),
    lastHeartbeatAt: current,
    updatedAt: current,
  }).where(and(eq(workspaceWriterLeases.spaceId, input.spaceId), eq(workspaceWriterLeases.holderKind, holderKind), eq(workspaceWriterLeases.holderId, input.holderId), eq(workspaceWriterLeases.epoch, input.epoch), gt(workspaceWriterLeases.expiresAt, current))).returning();
  if (!lease) throw new LocalAgentServiceError("workspace lease is no longer active", "workspace_lease_lost", 409);
  void notifyWorkspaceState({ spaceId: input.spaceId, reason: "lease_heartbeat" }).catch(() => undefined);
  return serializeLease(lease);
}

export async function releaseWorkspaceWriterLease(input: { actor: LocalAgentActor; spaceId: string; holderKind: string; holderId: string; epoch: number }) {
  assertUuid(input.spaceId, "spaceId");
  const holderKind = normalizeLeaseHolderKind(input.holderKind);
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) throw new LocalAgentServiceError("epoch is invalid", "invalid_epoch", 400);
  try {
    await assertLeaseActor({ actor: input.actor, spaceId: input.spaceId, holderKind, holderId: input.holderId, epoch: input.epoch });
  } catch (error) {
    if (!(error instanceof LocalAgentServiceError) || error.code !== "workspace_lease_not_found" || holderKind !== "local_agent" || !input.actor.deviceId) throw error;
    const [attempt] = await db.select({ id: workspaceExecutionAttempts.id, status: workspaceExecutionAttempts.status }).from(workspaceExecutionAttempts)
      .innerJoin(workspaceReplicas, eq(workspaceReplicas.id, workspaceExecutionAttempts.replicaId))
      .where(and(
        eq(workspaceExecutionAttempts.id, input.holderId),
        eq(workspaceExecutionAttempts.spaceId, input.spaceId),
        eq(workspaceReplicas.deviceId, input.actor.deviceId),
        eq(workspaceReplicas.kind, "local"),
      )).limit(1);
    if (!attempt || !["completed", "failed", "aborted", "blocked"].includes(attempt.status)) throw error;
    await db.update(workspaceState).set({ activeExecutionAttemptId: null, updatedAt: new Date() }).where(and(eq(workspaceState.spaceId, input.spaceId), eq(workspaceState.activeExecutionAttemptId, input.holderId)));
    await db.update(workspaceReplicas).set({ activeExecutionAttemptId: null, updatedAt: new Date() }).where(and(eq(workspaceReplicas.spaceId, input.spaceId), eq(workspaceReplicas.activeExecutionAttemptId, input.holderId)));
    void notifyWorkspaceState({ spaceId: input.spaceId, reason: "lease_release_recovered" }).catch(() => undefined);
    return { released: true, epoch: input.epoch };
  }
  const [lease] = await db.update(workspaceWriterLeases).set({
    expiresAt: new Date(),
    lastHeartbeatAt: new Date(),
    updatedAt: new Date(),
  }).where(and(eq(workspaceWriterLeases.spaceId, input.spaceId), eq(workspaceWriterLeases.holderKind, holderKind), eq(workspaceWriterLeases.holderId, input.holderId), eq(workspaceWriterLeases.epoch, input.epoch))).returning();
  if (!lease) throw new LocalAgentServiceError("workspace lease not found", "workspace_lease_not_found", 404);
  if (holderKind === "local_agent" || holderKind === "cloud_agent") {
    await db.update(workspaceState).set({ activeExecutionAttemptId: null, updatedAt: new Date() }).where(and(eq(workspaceState.spaceId, input.spaceId), eq(workspaceState.activeExecutionAttemptId, input.holderId)));
    await db.update(workspaceReplicas).set({ activeExecutionAttemptId: null, updatedAt: new Date() }).where(and(
      eq(workspaceReplicas.spaceId, input.spaceId),
      eq(workspaceReplicas.activeExecutionAttemptId, input.holderId),
    ));
  }
  void notifyWorkspaceState({ spaceId: input.spaceId, reason: "lease_released" }).catch(() => undefined);
  return { released: true, epoch: lease.epoch };
}

/**
 * Seal a local ACP execution attempt from locald once the provider turn is
 * terminal. The workspace worker completes the attempt after the candidate
 * snapshot is reconciled; this only records that the transcript side is done.
 */
export async function registerLocalWorkspaceAttempt(input: {
  actor: LocalAgentActor;
  spaceId: string;
  replicaId: string;
  attemptId: string;
  leaseEpoch: number;
  baseSnapshotId: string | null;
  workspacePolicyVersion: number;
  integrationPolicyVersion: number;
}) {
  const replica = await resolveReplicaForActor({ actor: input.actor, spaceId: input.spaceId, replicaId: input.replicaId });
  if (replica.kind !== "local" || !input.actor.deviceId) throw new LocalAgentServiceError("local execution attempts require a device replica", "invalid_replica", 400);
  assertUuid(input.attemptId, "attemptId");
  if (!Number.isSafeInteger(input.leaseEpoch) || input.leaseEpoch < 1) throw new LocalAgentServiceError("leaseEpoch is invalid", "invalid_epoch", 400);
  const [policy] = await db.select().from(spaceLocalAgentPolicies).where(and(
    eq(spaceLocalAgentPolicies.spaceId, input.spaceId),
    eq(spaceLocalAgentPolicies.deviceId, input.actor.deviceId),
  )).limit(1);
  if (!policy || policy.integrationPolicyVersion !== input.integrationPolicyVersion) {
    throw new LocalAgentServiceError("local execution attempt uses an outdated integration policy", "policy_version_stale", 409);
  }
  const attempt = await db.transaction(async (tx) => {
    let [current] = await tx.select().from(workspaceExecutionAttempts).where(and(
      eq(workspaceExecutionAttempts.id, input.attemptId),
      eq(workspaceExecutionAttempts.spaceId, input.spaceId),
      eq(workspaceExecutionAttempts.replicaId, replica.id),
      eq(workspaceExecutionAttempts.executorKind, "local_acp"),
    )).for("update").limit(1);
    if (!current) throw new LocalAgentServiceError("execution attempt is not registered for this replica", "attempt_identity_mismatch", 409);
    if ((current.baseCanonicalSnapshotId ?? null) !== (input.baseSnapshotId ?? null)) {
      throw new LocalAgentServiceError("execution attempt base snapshot does not match the workspace lease", "attempt_base_stale", 409);
    }
    if (current.workspaceLeaseEpoch !== input.leaseEpoch) {
      throw new LocalAgentServiceError("execution attempt lease epoch does not match", "workspace_lease_lost", 409);
    }
    if (current.turnId) {
      const [turn] = await tx.select({ status: sessionTurns.status }).from(sessionTurns).where(eq(sessionTurns.id, current.turnId)).limit(1);
      if (!turn || !["completed", "failed", "interrupted", "cancelled", "merged"].includes(turn.status)) {
        throw new LocalAgentServiceError("local ACP transcript is not terminal yet", "transcript_pending", 409);
      }
    }
    if (["queued", "prepared", "running"].includes(current.status)) {
      const [updated] = await tx.update(workspaceExecutionAttempts).set({ status: "transcript_sealed", updatedAt: now() }).where(and(
        eq(workspaceExecutionAttempts.id, current.id),
        inArray(workspaceExecutionAttempts.status, ["queued", "prepared", "running"]),
      )).returning();
      current = updated ?? current;
    }
    return current;
  });
  return {
    attemptId: attempt.id,
    status: attempt.status,
    transcriptRequired: attempt.transcriptRequired,
    workspaceLeaseEpoch: attempt.workspaceLeaseEpoch,
  };
}

export async function resolveWorkspaceConflict(input: {
  actor: LocalAgentActor;
  spaceId: string;
  conflictId: string;
  resolution: string;
}) {
  assertUuid(input.spaceId, "spaceId");
  assertUuid(input.conflictId, "conflictId");
  if (!WORKSPACE_CONFLICT_RESOLUTIONS.has(input.resolution)) {
    throw new LocalAgentServiceError("unsupported workspace conflict resolution", "resolution_invalid", 400);
  }
  if (input.resolution === "merged") {
    throw new LocalAgentServiceError("merged resolution requires a validated merge object", "merged_resolution_requires_object", 400);
  }
  if (input.resolution === "unmanage") {
    throw new LocalAgentServiceError("unmanage resolution requires a confirmed workspace policy update", "unmanage_requires_policy_update", 400);
  }
  const result = await db.transaction(async (tx) => {
    const [conflict] = await tx.select().from(workspaceSyncConflicts).where(and(
      eq(workspaceSyncConflicts.id, input.conflictId),
      eq(workspaceSyncConflicts.spaceId, input.spaceId),
    )).for("update").limit(1);
    if (!conflict) throw new LocalAgentServiceError("workspace conflict not found", "conflict_not_found", 404);
    if (conflict.status !== "open") {
      if (conflict.resolution === input.resolution) return { conflict, cycleId: conflict.cycleId, queued: false };
      throw new LocalAgentServiceError("workspace conflict has already been resolved", "conflict_already_resolved", 409);
    }
    const [cycle] = await tx.select().from(workspaceSyncCycles).where(and(
      eq(workspaceSyncCycles.id, conflict.cycleId),
      eq(workspaceSyncCycles.spaceId, input.spaceId),
    )).for("update").limit(1);
    if (!cycle) throw new LocalAgentServiceError("workspace conflict cycle not found", "cycle_not_found", 409);
    const [updatedConflict] = await tx.update(workspaceSyncConflicts).set({
      status: "resolved",
      resolution: input.resolution as typeof workspaceSyncConflicts.$inferInsert.resolution,
      resolvedBy: input.actor.userUuid,
      resolvedAt: now(),
      updatedAt: now(),
    }).where(and(eq(workspaceSyncConflicts.id, conflict.id), eq(workspaceSyncConflicts.status, "open"))).returning();
    if (!updatedConflict) throw new LocalAgentServiceError("workspace conflict changed while resolving", "conflict_state_stale", 409);
    const [openConflict] = await tx.select({ id: workspaceSyncConflicts.id }).from(workspaceSyncConflicts).where(and(
      eq(workspaceSyncConflicts.cycleId, cycle.id),
      eq(workspaceSyncConflicts.status, "open"),
    )).limit(1);
    if (openConflict) return { conflict: updatedConflict, cycleId: cycle.id, queued: false };
    const [state] = await tx.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).for("update").limit(1);
    await tx.update(workspaceSyncCycles).set({
      status: "planned",
      errorCode: null,
      errorMessage: null,
      updatedAt: now(),
    }).where(and(eq(workspaceSyncCycles.id, cycle.id), eq(workspaceSyncCycles.status, "conflicted")));
    if (state) {
      await tx.update(workspaceState).set({ status: "syncing", activeCycleId: cycle.id, updatedAt: now() }).where(eq(workspaceState.spaceId, input.spaceId));
    }
    await tx.update(workspaceReplicas).set({ status: "syncing", updatedAt: now() }).where(eq(workspaceReplicas.id, cycle.replicaId));
    // The attempt was parked as `blocked` when the conflict was recorded. Move
    // it back into the worker's completion window so the resumed cycle can
    // finish it; otherwise the attempt would stay blocked forever.
    if (cycle.executionAttemptId) {
      await tx.update(workspaceExecutionAttempts).set({ status: "transcript_sealed", errorCode: null, errorMessage: null, updatedAt: now() }).where(and(
        eq(workspaceExecutionAttempts.id, cycle.executionAttemptId),
        eq(workspaceExecutionAttempts.status, "blocked"),
      ));
    }
    return { conflict: updatedConflict, cycleId: cycle.id, queued: true };
  });
  if (result.queued) {
    const [cycle] = await db.select({ replicaId: workspaceSyncCycles.replicaId }).from(workspaceSyncCycles).where(eq(workspaceSyncCycles.id, result.cycleId)).limit(1);
    if (cycle) await enqueueWorkspaceSyncJob({ cycleId: result.cycleId, spaceId: input.spaceId, replicaId: cycle.replicaId }).catch(() => undefined);
  }
  await notifyWorkspaceState({ spaceId: input.spaceId, reason: result.queued ? "conflict_resolved" : "conflict_resolution_recorded" }).catch(() => undefined);
  return {
    conflict: {
      id: result.conflict.id,
      cycleId: result.conflict.cycleId,
      path: result.conflict.path,
      kind: result.conflict.kind,
      status: result.conflict.status,
      resolution: result.conflict.resolution,
      resolvedAt: iso(result.conflict.resolvedAt),
    },
    cycleId: result.cycleId,
    queued: result.queued,
  };
}

export async function listWorkspaceConflicts(input: { actor: LocalAgentActor; spaceId: string; replicaId?: string | null }) {
  assertUuid(input.spaceId, "spaceId");
  const conditions = [eq(workspaceSyncConflicts.spaceId, input.spaceId), eq(workspaceSyncConflicts.status, "open")];
  if (input.replicaId) {
    assertUuid(input.replicaId, "replicaId");
    const cycles = await db.select({ id: workspaceSyncCycles.id }).from(workspaceSyncCycles).where(and(eq(workspaceSyncCycles.spaceId, input.spaceId), eq(workspaceSyncCycles.replicaId, input.replicaId)));
    if (cycles.length === 0) return [];
    conditions.push(inArray(workspaceSyncConflicts.cycleId, cycles.map((cycle) => cycle.id)));
  }
  const rows = await db.select().from(workspaceSyncConflicts).where(and(...conditions)).orderBy(asc(workspaceSyncConflicts.path), asc(workspaceSyncConflicts.createdAt));
  return rows.map((row) => ({
    id: row.id,
    cycleId: row.cycleId,
    spaceId: row.spaceId,
    path: row.path,
    kind: row.kind,
    baseEntry: row.baseEntry,
    localEntry: row.localEntry,
    cloudEntry: row.cloudEntry,
    status: row.status,
    resolution: row.resolution,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}
