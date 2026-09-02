import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  localAgentDevices,
  localAgentRuntimes,
  localAgentRuntimeCommands,
  localAgentRuntimeSessions,
  nativeAgentEventReceipts,
  nativeAgentIngests,
  nativeAgentSessions,
  nativeAgentTurns,
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
  MirrorCompletenessSchema,
  MirrorFidelitySchema,
  NativeIngestInlineRequestSchema,
  NativeIngestPrepareRequestSchema,
  validateLocalAgentHookEnvelope,
  validateNativeTurnBundleInlineSize,
  validateNativeTurnBundleSize,
  type LocalAgentHookEnvelopeV1,
  type MirrorCompleteness,
  type MirrorFidelity,
  type NativeProvider,
  NativeTurnBundleSchema,
  WorkspaceManifestSchema,
  canonicalizeJsonBytes,
  canonicalJsonSha256,
  validateManifest,
  type LocalAgentPolicyV1,
  type NativeIngestCommitResponseV1,
  type NativeTurnBundleV1,
  type WorkspaceManifestV1,
} from "@cohub/protocol";
import { createLocalAgentObjectGetUrl, createLocalAgentObjectPutUrl, headLocalAgentObject, buildLocalAgentObjectKey } from "./local-agent-object-storage.js";
import { createLocalAgentRefreshToken, createLocalAgentToken, hashLocalAgentRefreshToken, refreshTokenMatches } from "./local-agent-auth.js";
import { dispatchWorkspaceStateUpdated } from "./workspace-realtime.js";
import { enqueueWorkspaceSyncJob } from "./workspace-sync-queue.js";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { requestAgentTurnAbort } from "./agent-turn-abort.js";

export const LOCAL_AGENT_MAX_MANIFEST_INLINE_BYTES = 1024 * 1024;
export const LOCAL_AGENT_MAX_SNAPSHOT_ENTRIES = 2_000_000;
export const LOCAL_AGENT_ONLINE_LEASE_SECONDS = 30;
export const LOCAL_AGENT_OFFLINE_MAX_SECONDS = 24 * 60 * 60;

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
type LocalAgentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
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
const hashCanonical = (value: unknown) => createHash("sha256").update(Buffer.from(canonicalizeJsonBytes(value))).digest("hex");
const now = () => new Date();
const WORKSPACE_CONFLICT_RESOLUTIONS = new Set(["local", "cloud", "merged", "deleted", "keep_managed", "unmanage"]);

const assertNativeProviderEnabled = (provider: NativeProvider) => {
  const enabled = provider === "pi"
    ? config.nativeAgentPiEnabled
    : provider === "claude_code"
      ? config.nativeAgentClaudeEnabled
      : config.nativeAgentCodexEnabled;
  if (!enabled) throw new LocalAgentServiceError(`${provider} native mirroring is not enabled`, "provider_not_enabled", 403);
};

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
          inArray(workspaceExecutionAttempts.executorKind, ["local_native", "local_acp"]),
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
    await tx.update(workspaceWriterLeases).set({ expiresAt: revokedAt, lastHeartbeatAt: revokedAt, updatedAt: revokedAt }).where(and(
      or(eq(workspaceWriterLeases.holderKind, "local_agent"), eq(workspaceWriterLeases.holderKind, "local_offline_reservation")),
      or(
        eq(workspaceWriterLeases.holderId, `device:${input.deviceId}`),
        attemptIds.length > 0 ? inArray(workspaceWriterLeases.holderId, attemptIds) : undefined,
      ),
    ));
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
  sessionMirrorMode: "disabled" as const,
  workspaceMode: "handoff" as const,
  offlineEnabled: false,
  attachmentMode: "workspace_only",
  maxBundleBytes: 256 * 1024 * 1024,
  maxArtifactBytes: 5 * 1024 * 1024 * 1024,
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

type NativeMirrorOverview = {
  status: string;
  provider: string | null;
  fidelity: string | null;
  completeness: string | null;
  lastSeenAt: string | null;
  lastMirroredTurnId: string | null;
};

const serializeReplicaOverview = (row: typeof workspaceReplicas.$inferSelect, mirror: NativeMirrorOverview | null) => ({
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
  nativeMirror: mirror,
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
    sessionMirrorMode: row.sessionMirrorMode,
    workspaceMode: row.workspaceMode,
    offlineEnabled: row.offlineEnabled,
    attachmentMode: row.attachmentMode,
    maxBundleBytes: row.maxBundleBytes,
    maxArtifactBytes: row.maxArtifactBytes,
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
  const localReplicas = replicas.filter((replica) => replica.kind === "local");
  const localReplicaIds = localReplicas.map((replica) => replica.id);
  const nativeRows = localReplicaIds.length > 0
    ? await db.select().from(nativeAgentSessions).where(inArray(nativeAgentSessions.replicaId, localReplicaIds)).orderBy(desc(nativeAgentSessions.updatedAt))
    : [];
  const localDeviceIds = localReplicas.map((replica) => replica.deviceId).filter((deviceId): deviceId is string => Boolean(deviceId));
  const integrationRows = localDeviceIds.length > 0
    ? await db.select().from(spaceLocalAgentPolicies).where(and(eq(spaceLocalAgentPolicies.spaceId, input.spaceId), inArray(spaceLocalAgentPolicies.deviceId, localDeviceIds)))
    : [];
  const policyByDevice = new Map(integrationRows.map((row) => [row.deviceId, row]));
  const mirrorByReplica = new Map<string, NativeMirrorOverview>();
  for (const native of nativeRows) {
    if (mirrorByReplica.has(native.replicaId)) continue;
    mirrorByReplica.set(native.replicaId, {
      status: native.status,
      provider: native.provider,
      fidelity: native.mirrorFidelity,
      completeness: native.mirrorCompleteness,
      lastSeenAt: iso(native.lastSeenAt),
      lastMirroredTurnId: native.lastMirroredTurnId,
    });
  }
  for (const replica of localReplicas) {
    if (mirrorByReplica.has(replica.id)) continue;
    const policy = replica.deviceId ? policyByDevice.get(replica.deviceId) : undefined;
    if (!policy) continue;
    mirrorByReplica.set(replica.id, {
      status: "not_started",
      provider: null,
      fidelity: null,
      completeness: policy.sessionMirrorMode,
      lastSeenAt: null,
      lastMirroredTurnId: null,
    });
  }
  const [state] = await db.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).limit(1);
  const [policy] = await db.select().from(spaceWorkspacePolicies).where(eq(spaceWorkspacePolicies.spaceId, input.spaceId)).limit(1);
  const [lease] = await db.select().from(workspaceWriterLeases).where(eq(workspaceWriterLeases.spaceId, input.spaceId)).limit(1);
  const [conflictCount] = await db.select({ count: count() }).from(workspaceSyncConflicts).where(and(eq(workspaceSyncConflicts.spaceId, input.spaceId), eq(workspaceSyncConflicts.status, "open")));
  return {
    replicas: replicas.map((replica) => serializeReplicaOverview(replica, mirrorByReplica.get(replica.id) ?? null)),
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
  maximumDurationAt: iso(row.maximumDurationAt),
  takeoverRequiresConfirmation: row.takeoverRequiresConfirmation,
  updatedAt: row.updatedAt.toISOString(),
});

const WORKSPACE_LEASE_HOLDER_KINDS = new Set([
  "local_agent",
  "local_offline_reservation",
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
  if (holderKind === "local_agent" || holderKind === "local_offline_reservation") {
    if (input.actor.principal === "user") {
      if (lease.holderUserUuid !== input.actor.userUuid) {
        throw new LocalAgentServiceError("workspace lease does not belong to this user", "lease_owner_mismatch", 403);
      }
      return lease;
    }
    if (!input.actor.deviceId) {
      throw new LocalAgentServiceError("a device credential is required for this workspace lease", "device_required", 401);
    }
    if (holderKind === "local_offline_reservation" && input.holderId !== `device:${input.actor.deviceId}`) {
      throw new LocalAgentServiceError("workspace lease does not belong to this device", "lease_owner_mismatch", 403);
    }
    if (holderKind === "local_agent") {
      const [attempt] = await db.select({ deviceId: workspaceReplicas.deviceId }).from(workspaceExecutionAttempts)
        .innerJoin(workspaceReplicas, eq(workspaceReplicas.id, workspaceExecutionAttempts.replicaId))
        .where(and(eq(workspaceExecutionAttempts.id, input.holderId), eq(workspaceExecutionAttempts.spaceId, input.spaceId)))
        .limit(1);
      if (attempt?.deviceId !== input.actor.deviceId) {
        throw new LocalAgentServiceError("workspace lease does not belong to this device", "lease_owner_mismatch", 403);
      }
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
      const head = await headLocalAgentObject(snapshot.manifestObjectKey);
      if (head.size !== snapshot.manifestTransportBytes && snapshot.manifestTransportBytes != null) throw new LocalAgentServiceError("manifest transport size mismatch", "manifest_transport_mismatch", 422);
    } catch (error) {
      if (error instanceof LocalAgentServiceError) throw error;
      throw new LocalAgentServiceError("manifest object is not available", "manifest_object_missing", 409);
    }
  }
  const blobRows = await db.select({ blob: workspaceBlobs }).from(workspaceSnapshotBlobs).innerJoin(workspaceBlobs, eq(workspaceBlobs.id, workspaceSnapshotBlobs.blobId)).where(eq(workspaceSnapshotBlobs.snapshotId, snapshot.id));
  for (const { blob } of blobRows) {
    if (blob.status === "ready") continue;
    try {
      const head = await headLocalAgentObject(blob.objectKey);
      if (head.size !== blob.size) throw new LocalAgentServiceError(`blob size mismatch for ${blob.sha256}`, "blob_size_mismatch", 422);
    } catch (error) {
      if (error instanceof LocalAgentServiceError) throw error;
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
  offline?: boolean;
  confirmTakeover?: boolean;
}) {
  assertUuid(input.spaceId, "spaceId");
  const holderKind = normalizeLeaseHolderKind(input.holderKind);
  if (input.offline !== (holderKind === "local_offline_reservation")) {
    throw new LocalAgentServiceError("offline must match the lease holder kind", "invalid_lease_mode", 400);
  }
  const holderId = normalizeBounded(input.holderId, "holderId", 255);
  let localReplicaIdentity: { id: string; deviceId: string } | null = null;
  if (holderKind === "local_agent" || holderKind === "local_offline_reservation") {
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
    if (holderKind === "local_offline_reservation" && holderId !== `device:${ownedReplica.deviceId}`) {
      throw new LocalAgentServiceError("workspace lease does not belong to this device", "lease_owner_mismatch", 403);
    }
  } else if (input.actor.principal !== "user") {
    throw new LocalAgentServiceError("a user credential is required for a cloud workspace lease", "user_required", 401);
  }
  const requestedDuration = input.offline ? Math.min(input.durationSeconds ?? LOCAL_AGENT_OFFLINE_MAX_SECONDS, LOCAL_AGENT_OFFLINE_MAX_SECONDS) : Math.min(input.durationSeconds ?? LOCAL_AGENT_ONLINE_LEASE_SECONDS, LOCAL_AGENT_ONLINE_LEASE_SECONDS);
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
    if ((holderKind === "local_agent" || holderKind === "local_offline_reservation") && localReplicaIdentity) {
      const [integrationPolicy] = await tx.select().from(spaceLocalAgentPolicies).where(and(
        eq(spaceLocalAgentPolicies.spaceId, input.spaceId),
        eq(spaceLocalAgentPolicies.deviceId, localReplicaIdentity.deviceId),
      )).limit(1);
      if (!integrationPolicy) throw new LocalAgentServiceError("local agent policy is unavailable", "policy_unavailable", 409);
      if (integrationPolicy.workspaceMode === "one_way_to_local") {
        throw new LocalAgentServiceError("local workspace is read-only under the current policy", "workspace_write_disabled", 403);
      }
      if (holderKind === "local_offline_reservation" && !integrationPolicy.offlineEnabled) {
        throw new LocalAgentServiceError("offline workspace execution is not enabled", "offline_not_enabled", 403);
      }
    }
    const [existing] = await tx.select().from(workspaceWriterLeases).where(eq(workspaceWriterLeases.spaceId, input.spaceId)).for("update").limit(1);
    const sameHolder = existing?.holderId === holderId && existing.holderKind === holderKind;
    if (existing && existing.expiresAt.getTime() > current.getTime() && !sameHolder) {
      throw new LocalAgentServiceError("workspace is held by another writer", "workspace_lease_busy", 409);
    }
    let takeoverRequiresConfirmation = existing?.takeoverRequiresConfirmation ?? false;
    if (existing && existing.expiresAt <= current && !sameHolder && (existing.holderKind === "local_agent" || existing.holderKind === "local_offline_reservation")) {
      const [unresolvedAttempt] = await tx.select({ id: workspaceExecutionAttempts.id }).from(workspaceExecutionAttempts).where(and(
        eq(workspaceExecutionAttempts.spaceId, input.spaceId),
        inArray(workspaceExecutionAttempts.status, ["running", "workspace_sealed", "transcript_sealed", "awaiting_recovery"]),
        existing.holderKind === "local_agent" ? eq(workspaceExecutionAttempts.id, existing.holderId) : undefined,
      )).limit(1);
      takeoverRequiresConfirmation = takeoverRequiresConfirmation || Boolean(unresolvedAttempt);
      if (unresolvedAttempt && input.confirmTakeover) {
        await tx.update(workspaceExecutionAttempts).set({
          status: "blocked",
          errorCode: "explicit_workspace_takeover",
          errorMessage: `Writer lease epoch ${existing.epoch} was explicitly taken over`,
          updatedAt: current,
        }).where(eq(workspaceExecutionAttempts.id, unresolvedAttempt.id));
      }
    }
    if (existing && existing.expiresAt.getTime() <= current.getTime() && takeoverRequiresConfirmation && !input.confirmTakeover && !sameHolder) {
      throw new LocalAgentServiceError("workspace lease expired; explicit takeover confirmation is required", "workspace_takeover_confirmation_required", 409);
    }
    if (holderKind === "local_agent") {
      assertUuid(holderId, "holderId");
      const [attempt] = await tx.select({ deviceId: workspaceReplicas.deviceId }).from(workspaceExecutionAttempts)
        .innerJoin(workspaceReplicas, eq(workspaceReplicas.id, workspaceExecutionAttempts.replicaId))
        .where(and(eq(workspaceExecutionAttempts.id, holderId), eq(workspaceExecutionAttempts.spaceId, input.spaceId)))
        .limit(1);
      if (attempt && attempt.deviceId !== localReplicaIdentity?.deviceId) {
        throw new LocalAgentServiceError("execution attempt does not belong to this device", "attempt_identity_mismatch", 403);
      }
      if (!attempt) {
        const [localReplica] = await tx.select({ id: workspaceReplicas.id }).from(workspaceReplicas).where(and(
          eq(workspaceReplicas.id, localReplicaIdentity?.id as string),
          eq(workspaceReplicas.spaceId, input.spaceId),
          eq(workspaceReplicas.kind, "local"),
          eq(workspaceReplicas.deviceId, localReplicaIdentity?.deviceId as string),
          ne(workspaceReplicas.status, "detached"),
        )).for("update").limit(1);
        if (!localReplica) throw new LocalAgentServiceError("local replica is unavailable", "replica_not_found", 404);
        const [integrationPolicy] = await tx.select({ sessionMirrorMode: spaceLocalAgentPolicies.sessionMirrorMode }).from(spaceLocalAgentPolicies).where(and(
          eq(spaceLocalAgentPolicies.spaceId, input.spaceId),
          eq(spaceLocalAgentPolicies.deviceId, localReplicaIdentity?.deviceId as string),
        )).limit(1);
        if (!integrationPolicy) throw new LocalAgentServiceError("local agent policy is unavailable", "policy_unavailable", 409);
        const [createdAttempt] = await tx.insert(workspaceExecutionAttempts).values({
          id: holderId,
          spaceId: input.spaceId,
          replicaId: localReplica.id,
          idempotencyKey: `local:${holderId}`,
          executorKind: "local_native",
          sessionMirrorMode: integrationPolicy.sessionMirrorMode,
          workspaceRequired: true,
          transcriptRequired: integrationPolicy.sessionMirrorMode === "full",
          baseCanonicalSnapshotId: workspace.canonicalSnapshotId,
          workspacePolicyVersion: null,
          status: "prepared",
        }).onConflictDoNothing().returning({ id: workspaceExecutionAttempts.id });
        if (!createdAttempt) {
          throw new LocalAgentServiceError("another execution attempt is still active for this workspace", "workspace_attempt_active", 409);
        }
      }
    }
    const sameActiveHolder = sameHolder && Boolean(existing && existing.expiresAt > current);
    const epoch = (existing?.epoch ?? 0) + (sameActiveHolder ? 0 : 1);
    const maximumDurationAt = input.offline
      ? sameHolder && existing?.maximumDurationAt
        ? existing.maximumDurationAt
        : new Date(current.getTime() + LOCAL_AGENT_OFFLINE_MAX_SECONDS * 1000)
      : null;
    const requestedExpiresAt = new Date(current.getTime() + requestedDuration * 1000);
    const expiresAt = maximumDurationAt && requestedExpiresAt > maximumDurationAt ? maximumDurationAt : requestedExpiresAt;
    if (expiresAt <= current) throw new LocalAgentServiceError("workspace offline reservation has reached its maximum duration", "workspace_lease_expired", 409);
    const [lease] = await tx.insert(workspaceWriterLeases).values({
      spaceId: input.spaceId,
      holderKind,
      holderId,
      holderUserUuid: input.actor.userUuid,
      epoch,
      baseSnapshotId: input.baseSnapshotId ?? existing?.baseSnapshotId ?? workspace.canonicalSnapshotId,
      expiresAt,
      lastHeartbeatAt: current,
      maximumDurationAt,
      takeoverRequiresConfirmation: false,
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
        maximumDurationAt,
        takeoverRequiresConfirmation: false,
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
  void notifyWorkspaceState({ spaceId: input.spaceId, reason: input.offline ? "offline_lease_acquired" : "lease_acquired" }).catch(() => undefined);
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
  const [existingLease] = await db.select({ maximumDurationAt: workspaceWriterLeases.maximumDurationAt }).from(workspaceWriterLeases).where(and(
    eq(workspaceWriterLeases.spaceId, input.spaceId),
    eq(workspaceWriterLeases.holderKind, holderKind),
    eq(workspaceWriterLeases.holderId, input.holderId),
    eq(workspaceWriterLeases.epoch, input.epoch),
  )).limit(1);
  if (!existingLease) throw new LocalAgentServiceError("workspace lease not found", "workspace_lease_not_found", 404);
  const requestedExpiry = new Date(current.getTime() + seconds * 1000);
  const expiresAt = existingLease.maximumDurationAt && existingLease.maximumDurationAt < requestedExpiry
    ? existingLease.maximumDurationAt
    : requestedExpiry;
  if (expiresAt <= current) throw new LocalAgentServiceError("workspace offline reservation has reached its maximum duration", "workspace_lease_expired", 409);
  const [lease] = await db.update(workspaceWriterLeases).set({
    expiresAt,
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
  await assertLeaseActor({ actor: input.actor, spaceId: input.spaceId, holderKind, holderId: input.holderId, epoch: input.epoch });
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

const nativeKind = (bundle: NativeTurnBundleV1): string => bundle.historyDelta.length > 0 ? "turn_final" : bundle.events.some((event) => event.type === "turn_stopped" || event.type === "turn_failed") ? "turn_final" : "lifecycle";
const nativeSemanticStatus = (status: string): NativeIngestCommitResponseV1["semanticStatus"] => {
  if (status === "applied") return "applied";
  if (status === "quarantined") return "quarantined";
  if (status === "committed" || status === "translating" || status === "forking" || status === "appending_jsonl" || status === "projecting" || status === "publishing_marker") return "ready";
  return "pending_verification";
};
const serializeIngestResponse = (row: typeof nativeAgentIngests.$inferSelect): NativeIngestCommitResponseV1 => ({
  version: 1,
  ingestId: row.id,
  uploadStatus: row.status === "prepared" || row.status === "uploaded" ? "uploaded" : "committed",
  semanticStatus: nativeSemanticStatus(row.status),
  executionAttemptId: row.executionAttemptId,
  cohubSessionId: row.cohubSessionId,
  cohubTurnId: row.cohubTurnId,
  nextPollAt: nativeSemanticStatus(row.status) === "applied" || nativeSemanticStatus(row.status) === "quarantined" ? null : new Date(Date.now() + 1000).toISOString(),
});

async function assertLocalNativeAttemptLease(tx: LocalAgentTransaction, input: {
  spaceId: string;
  replicaId: string;
  deviceId: string;
  attemptId: string;
  leaseEpoch: number | null;
  baseSnapshotId?: string | null;
  terminalEvent: boolean;
  provider?: NativeProvider;
  sessionMirrorMode?: "full" | "metadata_only" | "disabled";
  integrationPolicyVersion?: number;
  workspacePolicyVersion?: number;
}) {
  let [attempt] = await tx.select().from(workspaceExecutionAttempts).where(and(
    eq(workspaceExecutionAttempts.id, input.attemptId),
    eq(workspaceExecutionAttempts.spaceId, input.spaceId),
    eq(workspaceExecutionAttempts.replicaId, input.replicaId),
  )).for("update").limit(1);
  if (!attempt) {
    const epoch = input.leaseEpoch;
    if (!Number.isSafeInteger(epoch) || Number(epoch) < 1) throw new LocalAgentServiceError("execution attempt is not registered for this replica", "attempt_identity_mismatch", 409);
    const [reservation] = await tx.select().from(workspaceWriterLeases).where(and(
      eq(workspaceWriterLeases.spaceId, input.spaceId),
      eq(workspaceWriterLeases.holderKind, "local_offline_reservation"),
      eq(workspaceWriterLeases.holderId, `device:${input.deviceId}`),
      eq(workspaceWriterLeases.epoch, Number(epoch)),
    )).for("update").limit(1);
    if (!reservation) throw new LocalAgentServiceError("execution attempt is not registered for this replica", "attempt_identity_mismatch", 409);
    [attempt] = await tx.insert(workspaceExecutionAttempts).values({
      id: input.attemptId,
      spaceId: input.spaceId,
      replicaId: input.replicaId,
      idempotencyKey: `offline:${input.attemptId}`,
      executorKind: "local_native",
      provider: input.provider ?? null,
      sessionMirrorMode: input.sessionMirrorMode ?? null,
      integrationPolicyVersion: input.integrationPolicyVersion ?? null,
      workspaceRequired: true,
      transcriptRequired: input.sessionMirrorMode === "full",
      baseCanonicalSnapshotId: reservation.baseSnapshotId,
      workspaceLeaseEpoch: reservation.epoch,
      workspacePolicyVersion: input.workspacePolicyVersion ?? null,
      status: reservation.expiresAt > now() ? "prepared" : "awaiting_recovery",
    }).onConflictDoNothing().returning();
    if (!attempt) throw new LocalAgentServiceError("another execution attempt is still active for this workspace", "workspace_attempt_active", 409);
  }
  if (attempt.executorKind !== "local_native" && attempt.executorKind !== "local_acp") throw new LocalAgentServiceError("execution attempt is not a supported local attempt", "attempt_identity_mismatch", 409);
  if (input.baseSnapshotId !== undefined && (attempt.baseCanonicalSnapshotId ?? null) !== (input.baseSnapshotId ?? null)) {
    throw new LocalAgentServiceError("execution attempt base snapshot does not match the workspace lease", "attempt_base_stale", 409);
  }
  if (attempt.status === "awaiting_recovery") return attempt;
  const terminal = ["completed", "failed", "aborted", "transcript_sealed", "workspace_sealed", "awaiting_recovery"].includes(attempt.status);
  if (terminal && input.terminalEvent) return attempt;
  if (input.terminalEvent) {
    const [committedCandidate] = await tx.select({ id: workspaceSnapshots.id }).from(workspaceSnapshots).where(and(
      eq(workspaceSnapshots.sourceExecutionAttemptId, attempt.id),
      eq(workspaceSnapshots.spaceId, input.spaceId),
      eq(workspaceSnapshots.status, "ready"),
    )).limit(1);
    if (committedCandidate) return attempt;
  }
  const epoch = input.leaseEpoch ?? attempt.workspaceLeaseEpoch;
  if (!Number.isSafeInteger(epoch) || Number(epoch) < 1) throw new LocalAgentServiceError("a valid workspace lease epoch is required", "workspace_lease_required", 409);
  const [lease] = await tx.select({ epoch: workspaceWriterLeases.epoch }).from(workspaceWriterLeases).where(and(
    eq(workspaceWriterLeases.spaceId, input.spaceId),
    eq(workspaceWriterLeases.epoch, Number(epoch)),
    gt(workspaceWriterLeases.expiresAt, now()),
    or(
      and(eq(workspaceWriterLeases.holderKind, "local_agent"), eq(workspaceWriterLeases.holderId, input.attemptId)),
      and(eq(workspaceWriterLeases.holderKind, "local_offline_reservation"), eq(workspaceWriterLeases.holderId, `device:${input.deviceId}`)),
    ),
  )).limit(1);
  if (!lease) throw new LocalAgentServiceError("workspace writer lease is missing or expired", "workspace_lease_lost", 409);
  if (attempt.workspaceLeaseEpoch !== Number(epoch)) {
    await tx.update(workspaceExecutionAttempts).set({ workspaceLeaseEpoch: Number(epoch), updatedAt: now() }).where(eq(workspaceExecutionAttempts.id, attempt.id));
  }
  return attempt;
}

async function ensureNativeBinding(tx: LocalAgentTransaction, input: { spaceId: string; replicaId: string; deviceId: string; userUuid: string; provider: NativeProvider; nativeSessionKey: string; providerVersion: string; adapterVersion: string; fidelity: MirrorFidelity; completeness: MirrorCompleteness }) {
  let [binding] = await tx.select().from(nativeAgentSessions).where(and(eq(nativeAgentSessions.spaceId, input.spaceId), eq(nativeAgentSessions.deviceId, input.deviceId), eq(nativeAgentSessions.provider, input.provider), eq(nativeAgentSessions.nativeSessionKey, input.nativeSessionKey))).for("update").limit(1);
  if (!binding) {
    [binding] = await tx.insert(nativeAgentSessions).values({
      spaceId: input.spaceId,
      replicaId: input.replicaId,
      deviceId: input.deviceId,
      userUuid: input.userUuid,
      provider: input.provider,
      nativeSessionKey: input.nativeSessionKey,
      providerVersion: input.providerVersion,
      adapterVersion: input.adapterVersion,
      mirrorFidelity: MirrorFidelitySchema.parse(input.fidelity),
      mirrorCompleteness: MirrorCompletenessSchema.parse(input.completeness),
    }).returning();
  }
  if (!binding) throw new LocalAgentServiceError("failed to create native session binding", "binding_create_failed", 500);
  return binding;
}

export async function registerLocalWorkspaceAttempt(input: {
  actor: LocalAgentActor;
  spaceId: string;
  replicaId: string;
  attemptId: string;
  leaseEpoch: number;
  baseSnapshotId: string | null;
  workspacePolicyVersion: number;
  integrationPolicyVersion: number;
  sessionMirrorMode: "full" | "metadata_only" | "disabled";
}) {
  const replica = await resolveReplicaForActor({ actor: input.actor, spaceId: input.spaceId, replicaId: input.replicaId });
  if (replica.kind !== "local" || !input.actor.deviceId) throw new LocalAgentServiceError("local execution attempts require a device replica", "invalid_replica", 400);
  assertUuid(input.attemptId, "attemptId");
  if (!Number.isSafeInteger(input.leaseEpoch) || input.leaseEpoch < 1) throw new LocalAgentServiceError("leaseEpoch is invalid", "invalid_epoch", 400);
  const [policy] = await db.select().from(spaceLocalAgentPolicies).where(and(
    eq(spaceLocalAgentPolicies.spaceId, input.spaceId),
    eq(spaceLocalAgentPolicies.deviceId, input.actor.deviceId),
  )).limit(1);
  if (!policy || policy.integrationPolicyVersion !== input.integrationPolicyVersion || policy.sessionMirrorMode !== input.sessionMirrorMode) {
    throw new LocalAgentServiceError("local execution attempt uses an outdated integration policy", "policy_version_stale", 409);
  }
  const attempt = await db.transaction(async (tx) => {
    let current = await assertLocalNativeAttemptLease(tx, {
      spaceId: input.spaceId,
      replicaId: replica.id,
      deviceId: input.actor.deviceId as string,
      attemptId: input.attemptId,
      leaseEpoch: input.leaseEpoch,
      baseSnapshotId: input.baseSnapshotId,
      terminalEvent: true,
      sessionMirrorMode: input.sessionMirrorMode,
      integrationPolicyVersion: input.integrationPolicyVersion,
      workspacePolicyVersion: input.workspacePolicyVersion,
    });
    if (current.executorKind === "local_acp" && current.turnId) {
      const [turn] = await tx.select({ status: sessionTurns.status }).from(sessionTurns).where(eq(sessionTurns.id, current.turnId)).limit(1);
      if (!turn || !["completed", "failed", "interrupted", "cancelled", "merged"].includes(turn.status)) {
        throw new LocalAgentServiceError("local ACP transcript is not terminal yet", "transcript_pending", 409);
      }
      if (["queued", "prepared", "running"].includes(current.status)) {
        const [updated] = await tx.update(workspaceExecutionAttempts).set({ status: "transcript_sealed", updatedAt: now() }).where(and(
          eq(workspaceExecutionAttempts.id, current.id),
          inArray(workspaceExecutionAttempts.status, ["queued", "prepared", "running"]),
        )).returning();
        current = updated ?? current;
      }
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

export async function acceptNativeHook(input: { actor: LocalAgentActor; spaceId: string; replicaId: string; value: unknown }) {
  const replica = await resolveReplicaForActor({ actor: input.actor, spaceId: input.spaceId, replicaId: input.replicaId });
  if (replica.kind !== "local" || !input.actor.deviceId) throw new LocalAgentServiceError("native events require a local device replica", "invalid_replica", 400);
  let event: LocalAgentHookEnvelopeV1;
  try {
    event = validateLocalAgentHookEnvelope(input.value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "hook payload is invalid";
    const tooLarge = message.startsWith("hook_payload_too_large:");
    throw new LocalAgentServiceError(message, tooLarge ? "hook_payload_too_large" : "invalid_request", tooLarge ? 413 : 400);
  }
  assertNativeProviderEnabled(event.provider);
  if (event.deviceId !== input.actor.deviceId || event.replicaId !== replica.id) {
    throw new LocalAgentServiceError("hook identity does not match the enrolled device or replica", "hook_identity_mismatch", 403);
  }
  if (event.workspace.relativeCwd.startsWith("/") || event.workspace.relativeCwd.split("/").some((part) => part === "..")) {
    throw new LocalAgentServiceError("hook cwd is outside the attached workspace", "invalid_cwd", 422);
  }
  const [policy] = await db.select().from(spaceLocalAgentPolicies).where(and(eq(spaceLocalAgentPolicies.spaceId, input.spaceId), eq(spaceLocalAgentPolicies.deviceId, input.actor.deviceId))).limit(1);
  if (!policy) throw new LocalAgentServiceError("local agent policy is not initialized", "policy_unavailable", 409);
  if (
    event.integrationPolicyVersion !== policy.integrationPolicyVersion
    || event.sessionMirrorMode !== policy.sessionMirrorMode
    || event.workspacePolicyVersion <= 0
  ) {
    throw new LocalAgentServiceError("hook uses an outdated or invalid policy version", "policy_version_stale", 409);
  }
  if (policy.sessionMirrorMode === "disabled") {
    throw new LocalAgentServiceError("session mirroring is disabled for this device and Space", "mirror_disabled", 403);
  }
  const eventHash = hashCanonical(event);
  const executionAttemptId = event.executionAttemptId;
  if (executionAttemptId) assertUuid(executionAttemptId, "executionAttemptId");
  const result = await db.transaction(async (tx) => {
    const binding = await ensureNativeBinding(tx, {
      spaceId: input.spaceId,
      replicaId: replica.id,
      deviceId: input.actor.deviceId as string,
      userUuid: input.actor.userUuid,
      provider: event.provider,
      nativeSessionKey: event.nativeSessionKey,
      providerVersion: event.providerVersion,
      adapterVersion: event.adapterVersion,
      fidelity: "hook_reconstructed",
      completeness: event.sessionMirrorMode === "metadata_only" ? "metadata_only" : "truncated",
    });
    const [existingReceipt] = await tx.select().from(nativeAgentEventReceipts).where(and(eq(nativeAgentEventReceipts.bindingId, binding.id), eq(nativeAgentEventReceipts.eventId, event.eventId))).for("update").limit(1);
    if (existingReceipt) {
      if (existingReceipt.eventSha256 !== eventHash) throw new LocalAgentServiceError("event id was reused with different content", "event_id_conflict", 409);
      return { bindingId: binding.id, nativeTurnId: existingReceipt.nativeAgentTurnId, executionAttemptId: existingReceipt.executionAttemptId, duplicate: true };
    }
    const terminalEvent = event.type === "turn_stopped" || event.type === "turn_failed" || event.type === "session_ended" || event.type === "provider_exited";
    if (event.executionAttemptId) {
      const attempt = await assertLocalNativeAttemptLease(tx, {
        spaceId: input.spaceId,
        replicaId: replica.id,
        deviceId: input.actor.deviceId as string,
        attemptId: executionAttemptId as string,
        leaseEpoch: event.workspace.leaseEpoch,
        baseSnapshotId: event.workspace.baseCanonicalSnapshotId,
        terminalEvent,
        provider: event.provider,
        sessionMirrorMode: event.sessionMirrorMode,
        integrationPolicyVersion: event.integrationPolicyVersion,
        workspacePolicyVersion: event.workspacePolicyVersion,
      });
      if (terminalEvent && event.sessionMirrorMode === "metadata_only" && ["prepared", "running"].includes(attempt.status)) {
        await tx.update(workspaceExecutionAttempts).set({
          status: "transcript_sealed",
          completedAt: null,
          updatedAt: now(),
        }).where(eq(workspaceExecutionAttempts.id, attempt.id));
      } else if (!terminalEvent && ["prepared", "queued"].includes(attempt.status) && (event.type === "prompt_submitted" || event.type === "turn_started")) {
        await tx.update(workspaceExecutionAttempts).set({ status: "running", startedAt: attempt.startedAt ?? now(), updatedAt: now() }).where(eq(workspaceExecutionAttempts.id, attempt.id));
      }
    }
    let nativeTurnId: string | null = null;
    if (event.nativeTurnKey && event.executionAttemptId) {
      let [nativeTurn] = await tx.select().from(nativeAgentTurns).where(and(eq(nativeAgentTurns.bindingId, binding.id), eq(nativeAgentTurns.nativeTurnKey, event.nativeTurnKey))).for("update").limit(1);
      if (!nativeTurn) {
        [nativeTurn] = await tx.insert(nativeAgentTurns).values({
          bindingId: binding.id,
          spaceId: input.spaceId,
          replicaId: replica.id,
          executionAttemptId: executionAttemptId as string,
          nativeTurnKey: event.nativeTurnKey,
          status: terminalEvent ? (event.sessionMirrorMode === "metadata_only" ? "applied" : "sealed") : "running",
          terminalEventKind: event.type === "turn_failed" ? "failed" : terminalEvent ? "stopped" : "none",
          relativeCwd: event.workspace.relativeCwd,
          firstEventSequence: event.nativeEventSequence,
          lastEventSequence: event.nativeEventSequence,
          startedAt: event.type === "prompt_submitted" || event.type === "turn_started" ? now() : null,
          stoppedAt: event.type === "turn_stopped" || event.type === "turn_failed" ? now() : null,
        }).returning();
      }
      if (nativeTurn && terminalEvent && nativeTurn.status !== "applied" && nativeTurn.status !== "quarantined") {
        const [updatedTurn] = await tx.update(nativeAgentTurns).set({
          status: event.sessionMirrorMode === "metadata_only" ? "applied" : "sealed",
          terminalEventKind: event.type === "turn_failed" ? "failed" : "stopped",
          lastEventSequence: event.nativeEventSequence,
          stoppedAt: now(),
          updatedAt: now(),
        }).where(eq(nativeAgentTurns.id, nativeTurn.id)).returning();
        nativeTurn = updatedTurn ?? nativeTurn;
      }
      nativeTurnId = nativeTurn?.id ?? null;
    }
    await tx.insert(nativeAgentEventReceipts).values({
      bindingId: binding.id,
      eventId: event.eventId,
      executionAttemptId,
      nativeAgentTurnId: nativeTurnId,
      eventSha256: eventHash,
      eventSequence: event.nativeEventSequence,
      eventType: event.type,
      firstIngestId: null,
    });
    await tx.update(nativeAgentSessions).set({
      nativeCursor: { eventId: event.eventId, localReceiptSequence: event.localReceiptSequence },
      relativeCwd: event.workspace.relativeCwd,
      lastSeenAt: now(),
      updatedAt: now(),
    }).where(eq(nativeAgentSessions.id, binding.id));
    return { bindingId: binding.id, nativeTurnId, executionAttemptId, duplicate: false };
  });
  return {
    version: 1,
    accepted: true,
    duplicate: result.duplicate,
    eventId: event.eventId,
    executionAttemptId: result.executionAttemptId,
    nativeTurnId: result.nativeTurnId,
    nativeSessionKey: event.nativeSessionKey,
  };
}

export async function acceptNativeIngestInline(input: { actor: LocalAgentActor; spaceId: string; replicaId: string; value: unknown; requestId?: string | null }) {
  const replica = await resolveReplicaForActor({ actor: input.actor, spaceId: input.spaceId, replicaId: input.replicaId });
  if (replica.kind !== "local" || !input.actor.deviceId) throw new LocalAgentServiceError("native ingest requires a local device replica", "invalid_replica", 400);
  const parsedRequest = NativeIngestInlineRequestSchema.parse(input.value);
  const bundle = NativeTurnBundleSchema.parse(parsedRequest.bundle);
  assertNativeProviderEnabled(bundle.provider);
  const canonicalBytes = canonicalizeJsonBytes(bundle);
  const calculatedHash = hashCanonical(bundle);
  if (calculatedHash !== parsedRequest.payloadSha256) throw new LocalAgentServiceError("payloadSha256 does not match bundle", "payload_hash_mismatch", 422);
  try {
    validateNativeTurnBundleSize(bundle);
  } catch (error) {
    const message = error instanceof Error ? error.message : "native bundle exceeds size limit";
    throw new LocalAgentServiceError(message, "bundle_limit", 413);
  }
  try {
    validateNativeTurnBundleInlineSize(bundle);
  } catch {
    throw new LocalAgentServiceError("inline native bundle exceeds 128 KiB; use prepare and object upload", "inline_bundle_limit", 413);
  }
  const [policy] = await db.select().from(spaceLocalAgentPolicies).where(and(eq(spaceLocalAgentPolicies.spaceId, input.spaceId), eq(spaceLocalAgentPolicies.deviceId, input.actor.deviceId))).limit(1);
  if (!policy) throw new LocalAgentServiceError("local agent policy is not initialized", "policy_unavailable", 409);
  if (bundle.sessionMirrorMode !== policy.sessionMirrorMode || bundle.integrationPolicyVersion !== policy.integrationPolicyVersion) {
    throw new LocalAgentServiceError("native bundle uses an outdated integration policy", "policy_version_stale", 409);
  }
  if (bundle.sessionMirrorMode === "disabled") throw new LocalAgentServiceError("session mirroring is disabled for this device and Space", "mirror_disabled", 403);
  if (bundle.workspacePolicyVersion <= 0) throw new LocalAgentServiceError("bundle workspace policy version is invalid", "policy_version_invalid", 422);
  if (bundle.events.some((event) => event.deviceId !== input.actor.deviceId || event.replicaId !== replica.id || event.executionAttemptId !== bundle.executionAttemptId)) {
    throw new LocalAgentServiceError("bundle events do not match the device, replica, or execution attempt", "bundle_identity_mismatch", 422);
  }
  assertUuid(bundle.executionAttemptId, "executionAttemptId");
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(nativeAgentIngests).where(and(eq(nativeAgentIngests.replicaId, replica.id), eq(nativeAgentIngests.bundleId, bundle.bundleId))).for("update").limit(1);
    if (existing) {
      if (existing.payloadSha256 !== calculatedHash) throw new LocalAgentServiceError("bundle id was reused with different content", "idempotency_conflict", 409);
      return existing;
    }
    const binding = await ensureNativeBinding(tx, {
      spaceId: input.spaceId,
      replicaId: replica.id,
      deviceId: input.actor.deviceId as string,
      userUuid: input.actor.userUuid,
      provider: bundle.provider,
      nativeSessionKey: bundle.nativeSessionKey,
      providerVersion: bundle.providerVersion,
      adapterVersion: bundle.adapterVersion,
      fidelity: bundle.fidelityHint,
      completeness: bundle.sessionMirrorMode === "metadata_only" ? "metadata_only" : "complete",
    });
    const [attempt] = await tx.select().from(workspaceExecutionAttempts).where(and(
      eq(workspaceExecutionAttempts.id, bundle.executionAttemptId),
      eq(workspaceExecutionAttempts.spaceId, input.spaceId),
      eq(workspaceExecutionAttempts.replicaId, replica.id),
    )).for("update").limit(1);
    if (!attempt) throw new LocalAgentServiceError("execution attempt must be prepared by a workspace lease", "attempt_identity_mismatch", 409);
    await assertLocalNativeAttemptLease(tx, {
      spaceId: input.spaceId,
      replicaId: replica.id,
      deviceId: input.actor.deviceId as string,
      attemptId: bundle.executionAttemptId,
      leaseEpoch: bundle.workspaceExecutionBase.leaseEpoch,
      baseSnapshotId: bundle.workspaceExecutionBase.canonicalSnapshotId,
      terminalEvent: true,
      provider: bundle.provider,
      sessionMirrorMode: bundle.sessionMirrorMode,
      integrationPolicyVersion: bundle.integrationPolicyVersion,
      workspacePolicyVersion: bundle.workspacePolicyVersion,
    });
    let [nativeTurn] = await tx.select().from(nativeAgentTurns).where(and(eq(nativeAgentTurns.bindingId, binding.id), eq(nativeAgentTurns.nativeTurnKey, bundle.nativeTurnKey))).for("update").limit(1);
    if (!nativeTurn) {
      [nativeTurn] = await tx.insert(nativeAgentTurns).values({
        bindingId: binding.id,
        spaceId: input.spaceId,
        replicaId: replica.id,
        executionAttemptId: bundle.executionAttemptId,
        nativeTurnKey: bundle.nativeTurnKey,
        status: bundle.events.some((event) => event.type === "turn_stopped" || event.type === "turn_failed") ? "sealed" : "running",
        terminalEventKind: bundle.events.find((event) => event.type === "turn_failed") ? "failed" : bundle.events.find((event) => event.type === "turn_stopped") ? "stopped" : "none",
        baseCohubCursor: bundle.cohubTranscriptBase,
        baseWorkspaceSnapshotId: bundle.workspaceExecutionBase.localSnapshotId,
        relativeCwd: bundle.events.at(-1)?.workspace.relativeCwd ?? null,
        startedAt: now(),
        stoppedAt: bundle.events.some((event) => event.type === "turn_stopped" || event.type === "turn_failed") ? now() : null,
      }).returning();
    }
    if (!nativeTurn) throw new LocalAgentServiceError("failed to create native turn", "native_turn_create_failed", 500);
    const [ingest] = await tx.insert(nativeAgentIngests).values({
      bindingId: binding.id,
      nativeAgentTurnId: nativeTurn.id,
      spaceId: input.spaceId,
      replicaId: replica.id,
      executionAttemptId: bundle.executionAttemptId,
      workspacePolicyVersion: bundle.workspacePolicyVersion,
      integrationPolicyVersion: bundle.integrationPolicyVersion,
      sessionMirrorMode: bundle.sessionMirrorMode,
      nativeTurnKey: bundle.nativeTurnKey,
      bundleId: bundle.bundleId,
      kind: nativeKind(bundle),
      policyMode: bundle.sessionMirrorMode,
      payloadInline: bundle as unknown as Record<string, unknown>,
      payloadSha256: calculatedHash,
      payloadBytes: canonicalBytes.byteLength,
      baseCohubCursor: bundle.cohubTranscriptBase,
      baseWorkspaceSnapshotId: bundle.workspaceExecutionBase.localSnapshotId,
      status: "committed",
      transcriptVisibility: bundle.sessionMirrorMode === "metadata_only" ? "orphaned" : "hidden",
    }).returning();
    if (!ingest) throw new LocalAgentServiceError("failed to create native ingest", "ingest_create_failed", 500);
    for (const event of bundle.events) {
      const eventHash = hashCanonical(event);
      const [receipt] = await tx.select().from(nativeAgentEventReceipts).where(and(eq(nativeAgentEventReceipts.bindingId, binding.id), eq(nativeAgentEventReceipts.eventId, event.eventId))).for("update").limit(1);
      if (receipt) {
        if (receipt.eventSha256 !== eventHash) throw new LocalAgentServiceError("event id was reused with different content", "event_id_conflict", 409);
        await tx.update(nativeAgentEventReceipts).set({
          executionAttemptId: receipt.executionAttemptId ?? bundle.executionAttemptId,
          nativeAgentTurnId: receipt.nativeAgentTurnId ?? nativeTurn.id,
          firstIngestId: receipt.firstIngestId ?? ingest.id,
        }).where(eq(nativeAgentEventReceipts.id, receipt.id));
        continue;
      }
      await tx.insert(nativeAgentEventReceipts).values({
        bindingId: binding.id,
        eventId: event.eventId,
        executionAttemptId: bundle.executionAttemptId,
        nativeAgentTurnId: nativeTurn.id,
        eventSha256: eventHash,
        eventSequence: event.nativeEventSequence,
        eventType: event.type,
        firstIngestId: ingest.id,
      });
    }
    await tx.update(nativeAgentTurns).set({ finalIngestId: nativeKind(bundle) === "turn_final" ? ingest.id : nativeTurn.finalIngestId, updatedAt: now() }).where(eq(nativeAgentTurns.id, nativeTurn.id));
    return ingest;
  });
  return serializeIngestResponse(result);
}

export async function prepareNativeIngest(input: { actor: LocalAgentActor; spaceId: string; replicaId: string; value: unknown }) {
  const replica = await resolveReplicaForActor({ actor: input.actor, spaceId: input.spaceId, replicaId: input.replicaId });
  if (replica.kind !== "local" || !input.actor.deviceId) throw new LocalAgentServiceError("native ingest requires a local device replica", "invalid_replica", 400);
  const request = NativeIngestPrepareRequestSchema.parse(input.value);
  assertNativeProviderEnabled(request.provider);
  assertUuid(request.executionAttemptId, "executionAttemptId");
  if (request.bindingId) assertUuid(request.bindingId, "bindingId");
  if (request.nativeAgentTurnId) assertUuid(request.nativeAgentTurnId, "nativeAgentTurnId");
  assertSha256(request.payloadSha256, "payloadSha256");
  if (!Number.isSafeInteger(request.payloadBytes) || request.payloadBytes <= 0 || request.payloadBytes > 256 * 1024 * 1024) throw new LocalAgentServiceError("payloadBytes is outside the allowed range", "bundle_limit", 413);
  const [policy] = await db.select().from(spaceLocalAgentPolicies).where(and(eq(spaceLocalAgentPolicies.spaceId, input.spaceId), eq(spaceLocalAgentPolicies.deviceId, input.actor.deviceId))).limit(1);
  if (!policy) throw new LocalAgentServiceError("local agent policy is not initialized", "policy_unavailable", 409);
  if (request.integrationPolicyVersion !== policy.integrationPolicyVersion || request.sessionMirrorMode !== policy.sessionMirrorMode) {
    throw new LocalAgentServiceError("native ingest uses an outdated integration policy", "policy_version_stale", 409);
  }
  if (request.sessionMirrorMode === "disabled") throw new LocalAgentServiceError("session mirroring is disabled", "mirror_disabled", 403);
  const objectKey = buildLocalAgentObjectKey({ spaceId: input.spaceId, kind: "native_payload", identity: `${request.payloadSha256}.json` });
  const ingest = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(nativeAgentIngests).where(and(eq(nativeAgentIngests.replicaId, replica.id), eq(nativeAgentIngests.bundleId, request.bundleId))).for("update").limit(1);
    if (existing) {
      if (existing.payloadSha256 !== request.payloadSha256 || existing.payloadBytes !== request.payloadBytes) {
        throw new LocalAgentServiceError("bundle id was reused with different content", "idempotency_conflict", 409);
      }
      return existing;
    }
    const binding = await ensureNativeBinding(tx, {
      spaceId: input.spaceId,
      replicaId: replica.id,
      deviceId: input.actor.deviceId as string,
      userUuid: input.actor.userUuid,
      provider: request.provider,
      nativeSessionKey: request.nativeSessionKey,
      providerVersion: request.providerVersion,
      adapterVersion: request.adapterVersion,
      fidelity: "hook_reconstructed",
      completeness: request.sessionMirrorMode === "metadata_only" ? "metadata_only" : "truncated",
    });
    if (request.bindingId && request.bindingId !== binding.id) throw new LocalAgentServiceError("bindingId does not match native session identity", "binding_identity_mismatch", 409);
    const [attempt] = await tx.select().from(workspaceExecutionAttempts).where(and(
      eq(workspaceExecutionAttempts.id, request.executionAttemptId),
      eq(workspaceExecutionAttempts.spaceId, input.spaceId),
      eq(workspaceExecutionAttempts.replicaId, replica.id),
    )).for("update").limit(1);
    if (!attempt) throw new LocalAgentServiceError("execution attempt must be prepared by a workspace lease", "attempt_identity_mismatch", 409);
    await assertLocalNativeAttemptLease(tx, {
      spaceId: input.spaceId,
      replicaId: replica.id,
      deviceId: input.actor.deviceId as string,
      attemptId: request.executionAttemptId,
      leaseEpoch: null,
      terminalEvent: true,
      provider: request.provider,
      sessionMirrorMode: request.sessionMirrorMode,
      integrationPolicyVersion: request.integrationPolicyVersion,
      workspacePolicyVersion: request.workspacePolicyVersion,
    });
    let [nativeTurn] = await tx.select().from(nativeAgentTurns).where(and(eq(nativeAgentTurns.bindingId, binding.id), eq(nativeAgentTurns.nativeTurnKey, request.nativeTurnKey))).for("update").limit(1);
    if (!nativeTurn) {
      [nativeTurn] = await tx.insert(nativeAgentTurns).values({
        bindingId: binding.id,
        spaceId: input.spaceId,
        replicaId: replica.id,
        executionAttemptId: request.executionAttemptId,
        nativeTurnKey: request.nativeTurnKey,
        status: "sealed",
        terminalEventKind: "stopped",
        startedAt: now(),
        stoppedAt: now(),
      }).returning();
    }
    if (!nativeTurn) throw new LocalAgentServiceError("failed to create native turn", "native_turn_create_failed", 500);
    if (request.nativeAgentTurnId && request.nativeAgentTurnId !== nativeTurn.id) throw new LocalAgentServiceError("nativeAgentTurnId does not match native turn identity", "native_turn_identity_mismatch", 409);
    const [created] = await tx.insert(nativeAgentIngests).values({
      bindingId: binding.id,
      nativeAgentTurnId: nativeTurn.id,
      spaceId: input.spaceId,
      replicaId: replica.id,
      executionAttemptId: request.executionAttemptId,
      workspacePolicyVersion: request.workspacePolicyVersion,
      integrationPolicyVersion: request.integrationPolicyVersion,
      sessionMirrorMode: request.sessionMirrorMode,
      nativeTurnKey: request.nativeTurnKey,
      bundleId: request.bundleId,
      kind: "turn_final",
      policyMode: request.sessionMirrorMode,
      payloadObjectKey: objectKey,
      payloadSha256: request.payloadSha256,
      payloadBytes: request.payloadBytes,
      status: "prepared",
      transcriptVisibility: request.sessionMirrorMode === "metadata_only" ? "orphaned" : "hidden",
    }).returning();
    if (!created) throw new LocalAgentServiceError("failed to prepare native ingest", "ingest_prepare_failed", 500);
    await tx.update(nativeAgentTurns).set({ finalIngestId: created.id, updatedAt: now() }).where(eq(nativeAgentTurns.id, nativeTurn.id));
    return created;
  });
  const signed = createLocalAgentObjectPutUrl({ objectKey: ingest.payloadObjectKey ?? objectKey, contentType: "application/json", contentLength: request.payloadBytes, sha256: request.payloadSha256 });
  return { ingestId: ingest.id, objectKey: ingest.payloadObjectKey ?? objectKey, uploadUrl: signed.uploadUrl, headers: signed.headers ?? null, expiresAt: signed.expiresAt, status: ingest.status };
}

export async function commitNativeIngestObject(input: { actor: LocalAgentActor; spaceId: string; replicaId: string; ingestId: string }) {
  await resolveReplicaForActor({ actor: input.actor, spaceId: input.spaceId, replicaId: input.replicaId });
  assertUuid(input.ingestId, "ingestId");
  const [row] = await db.select().from(nativeAgentIngests).where(and(eq(nativeAgentIngests.id, input.ingestId), eq(nativeAgentIngests.spaceId, input.spaceId), eq(nativeAgentIngests.replicaId, input.replicaId))).limit(1);
  if (!row) throw new LocalAgentServiceError("native ingest not found", "ingest_not_found", 404);
  if (row.status === "applied" || row.status === "quarantined") return serializeIngestResponse(row);
  if (!row.payloadObjectKey) throw new LocalAgentServiceError("native ingest has no object payload", "ingest_payload_missing", 409);
  try {
    const head = await headLocalAgentObject(row.payloadObjectKey);
    if (head.size !== row.payloadBytes) throw new LocalAgentServiceError("native payload size mismatch", "payload_size_mismatch", 422);
  } catch (error) {
    if (error instanceof LocalAgentServiceError) throw error;
    throw new LocalAgentServiceError("native payload object is not available", "payload_object_missing", 409);
  }
  const [updated] = await db.update(nativeAgentIngests).set({ status: "uploaded", updatedAt: now() }).where(and(eq(nativeAgentIngests.id, row.id), eq(nativeAgentIngests.status, "prepared"))).returning();
  return serializeIngestResponse(updated ?? row);
}

export async function getNativeIngest(input: { actor: LocalAgentActor; spaceId: string; ingestId: string }) {
  assertUuid(input.spaceId, "spaceId");
  assertUuid(input.ingestId, "ingestId");
  const conditions = [eq(nativeAgentIngests.id, input.ingestId), eq(nativeAgentIngests.spaceId, input.spaceId)];
  if (input.actor.deviceId) conditions.push(eq(workspaceReplicas.deviceId, input.actor.deviceId));
  else conditions.push(eq(workspaceReplicas.userUuid, input.actor.userUuid));
  const rows = await db.select({ ingest: nativeAgentIngests }).from(nativeAgentIngests)
    .innerJoin(workspaceReplicas, eq(workspaceReplicas.id, nativeAgentIngests.replicaId))
    .where(and(...conditions))
    .limit(1);
  const row = rows[0]?.ingest;
  if (!row) throw new LocalAgentServiceError("native ingest not found", "ingest_not_found", 404);
  return serializeIngestResponse(row);
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
