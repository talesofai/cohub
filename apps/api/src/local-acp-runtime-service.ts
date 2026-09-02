import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { localAgentRuntimes, localAgentDevices, localAgentRuntimeCommands, localAgentRuntimeSessions, sessionTurns, spaceLocalAgentPolicies, workspaceExecutionAttempts, workspaceReplicas, workspaceState, workspaceWriterLeases } from "@cohub/db";
import {
  LocalAcpProviderSchema,
  LocalAcpRuntimeCapabilitiesSchema,
  isUuid,
  type LocalAcpProvider,
} from "@cohub/protocol";
import { db } from "./db/index.js";
import { config } from "./config.js";
import { LocalAgentServiceError, notifyWorkspaceState, type LocalAgentActor } from "./local-agent-service.js";
import { hasPermission } from "./permissions.js";
import { requestAgentTurnAbort } from "./agent-turn-abort.js";
import { isPostgresUniqueViolation } from "./db/postgres-error.js";

const assertUuid = (value: string, field: string) => {
  if (!isUuid(value)) {
    throw new LocalAgentServiceError(`${field} must be a UUID`, "invalid_id", 400);
  }
  return value;
};

const bounded = (value: unknown, field: string, max: number) => {
  if (typeof value !== "string") throw new LocalAgentServiceError(`${field} is required`, "invalid_input", 400);
  const result = value.trim();
  if (!result || result.length > max) throw new LocalAgentServiceError(`${field} is invalid`, "invalid_input", 400);
  return result;
};

const RUNTIME_REGISTRATION_UNIQUE_CONSTRAINT = "v2_uq_local_agent_runtimes_space_device_provider";

const providerEnabled = (provider: LocalAcpProvider) => {
  if (!config.localAcpRuntimeEnabled) return false;
  return provider === "pi"
    ? config.localAcpPiEnabled
    : provider === "codex"
      ? config.localAcpCodexEnabled
      : config.localAcpClaudeEnabled;
};

export const isLocalAcpProviderEnabled = (value: string) => {
  const parsed = LocalAcpProviderSchema.safeParse(value);
  return parsed.success && providerEnabled(parsed.data);
};

const serialize = (row: typeof localAgentRuntimes.$inferSelect) => ({
  id: row.id,
  spaceId: row.spaceId,
  deviceId: row.deviceId,
  replicaId: row.replicaId,
  userUuid: row.userUuid,
  provider: row.provider,
  displayName: row.displayName,
  providerVersion: row.providerVersion,
  adapterVersion: row.adapterVersion,
  protocolVersion: row.protocolVersion,
  capabilities: row.capabilities,
  status: row.status,
  connectionEpoch: row.connectionEpoch,
  lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
  connectedAt: row.connectedAt?.toISOString() ?? null,
  disconnectedAt: row.disconnectedAt?.toISOString() ?? null,
  lastError: row.lastError,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const assertActorCanViewSpace = async (actor: LocalAgentActor, spaceId: string) => {
  if (!(await hasPermission({ uuid: actor.userUuid }, "file.view", { spaceId }))) {
    throw new LocalAgentServiceError("missing workspace view permission", "forbidden", 403);
  }
};

const assertActorCanUseSpace = async (actor: LocalAgentActor, spaceId: string) => {
  if (!(await hasPermission({ uuid: actor.userUuid }, "file.edit", { spaceId }))) {
    throw new LocalAgentServiceError("missing workspace edit permission", "forbidden", 403);
  }
};

export async function registerLocalAcpRuntime(input: {
  actor: LocalAgentActor;
  spaceId: string;
  replicaId: string;
  deviceId?: string;
  provider: string;
  displayName: string;
  providerVersion?: string;
  adapterVersion?: string;
  capabilities?: Record<string, unknown>;
  protocolVersion?: number;
}) {
  assertUuid(input.spaceId, "spaceId");
  assertUuid(input.replicaId, "replicaId");
  const deviceId = input.actor.deviceId ?? (input.deviceId ? assertUuid(input.deviceId, "deviceId") : null);
  if (!deviceId) throw new LocalAgentServiceError("a device credential is required", "device_required", 401);
  const provider = LocalAcpProviderSchema.parse(input.provider);
  if (!providerEnabled(provider)) throw new LocalAgentServiceError(`${provider} local ACP runtime is disabled`, "provider_not_enabled", 403);
  await assertActorCanUseSpace(input.actor, input.spaceId);
  const displayName = bounded(input.displayName, "displayName", 255);
  const [device] = await db.select({ id: localAgentDevices.id }).from(localAgentDevices).where(and(
    eq(localAgentDevices.id, deviceId),
    eq(localAgentDevices.userUuid, input.actor.userUuid),
    eq(localAgentDevices.status, "active"),
    input.actor.credentialVersion != null ? eq(localAgentDevices.credentialVersion, input.actor.credentialVersion) : undefined,
  )).limit(1);
  if (!device) throw new LocalAgentServiceError("device is not enrolled or has been revoked", "device_not_found", 404);
  const [replica] = await db.select({ id: workspaceReplicas.id, deviceId: workspaceReplicas.deviceId, status: workspaceReplicas.status }).from(workspaceReplicas).where(and(
    eq(workspaceReplicas.id, input.replicaId),
    eq(workspaceReplicas.spaceId, input.spaceId),
    eq(workspaceReplicas.kind, "local"),
    eq(workspaceReplicas.deviceId, deviceId),
    ne(workspaceReplicas.status, "detached"),
  )).limit(1);
  if (!replica?.deviceId) throw new LocalAgentServiceError("local workspace replica is unavailable", "replica_not_found", 404);
  const [integrationPolicy] = await db.select({ sessionMirrorMode: spaceLocalAgentPolicies.sessionMirrorMode, workspaceMode: spaceLocalAgentPolicies.workspaceMode }).from(spaceLocalAgentPolicies).where(and(
    eq(spaceLocalAgentPolicies.spaceId, input.spaceId),
    eq(spaceLocalAgentPolicies.deviceId, deviceId),
  )).limit(1);
  if (integrationPolicy?.sessionMirrorMode !== "full") {
    throw new LocalAgentServiceError("full session mirror consent is required for ACP runtime execution", "runtime_transcript_consent_required", 403);
  }
  if (integrationPolicy.workspaceMode === "one_way_to_local") {
    throw new LocalAgentServiceError("local workspace is read-only under the current policy", "workspace_write_disabled", 403);
  }

  const capabilities = LocalAcpRuntimeCapabilitiesSchema.parse(input.capabilities ?? {});
  const persistRegistration = () => db.transaction(async (tx) => {
    const [existing] = await tx.select().from(localAgentRuntimes).where(and(
      eq(localAgentRuntimes.spaceId, input.spaceId),
      eq(localAgentRuntimes.deviceId, deviceId),
      eq(localAgentRuntimes.provider, provider),
      ne(localAgentRuntimes.status, "revoked"),
    )).for("update").limit(1);
    const values = {
      spaceId: input.spaceId,
      deviceId,
      replicaId: input.replicaId,
      userUuid: input.actor.userUuid,
      provider,
      displayName,
      providerVersion: bounded(input.providerVersion ?? "unknown", "providerVersion", 120),
      adapterVersion: bounded(input.adapterVersion ?? "cohub-locald-acp-v1", "adapterVersion", 120),
      protocolVersion: Number.isSafeInteger(input.protocolVersion) && (input.protocolVersion as number) > 0 ? input.protocolVersion as number : 1,
      capabilities: capabilities as unknown as Record<string, unknown>,
      status: "offline" as const,
      lastError: null,
      updatedAt: new Date(),
    };
    if (existing) {
      if (existing.replicaId !== input.replicaId && ["connecting", "ready", "busy"].includes(existing.status)) {
        throw new LocalAgentServiceError("cannot move a connected runtime to another workspace replica", "runtime_busy", 409);
      }
      const [updated] = await tx.update(localAgentRuntimes).set({
        ...values,
        status: existing.status,
        connectionEpoch: existing.connectionEpoch,
        connectedAt: existing.connectedAt,
        disconnectedAt: existing.disconnectedAt,
        lastSeenAt: existing.lastSeenAt,
      }).where(eq(localAgentRuntimes.id, existing.id)).returning();
      return updated ?? existing;
    }
    const [created] = await tx.insert(localAgentRuntimes).values(values).returning();
    if (!created) throw new LocalAgentServiceError("failed to register local ACP runtime", "runtime_registration_failed", 500);
    return created;
  });
  let result: typeof localAgentRuntimes.$inferSelect;
  try {
    result = await persistRegistration();
  } catch (error) {
    if (!isPostgresUniqueViolation(error, RUNTIME_REGISTRATION_UNIQUE_CONSTRAINT)) throw error;
    // A concurrent registration won the partial unique index; reread it under
    // the transaction lock and apply the same idempotent registration update.
    result = await persistRegistration();
  }
  return serialize(result);
}

export async function listLocalAcpRuntimes(input: { actor: LocalAgentActor; spaceId: string }) {
  assertUuid(input.spaceId, "spaceId");
  await assertActorCanViewSpace(input.actor, input.spaceId);
  const visibility = input.actor.deviceId
    ? eq(localAgentRuntimes.deviceId, input.actor.deviceId)
    : eq(localAgentRuntimes.userUuid, input.actor.userUuid);
  const rows = await db.select().from(localAgentRuntimes).where(and(eq(localAgentRuntimes.spaceId, input.spaceId), visibility)).orderBy(asc(localAgentRuntimes.createdAt));
  return { runtimes: rows.map(serialize) };
}

export async function getLocalAcpRuntime(input: { actor: LocalAgentActor; spaceId: string; runtimeId: string }) {
  assertUuid(input.spaceId, "spaceId");
  assertUuid(input.runtimeId, "runtimeId");
  await assertActorCanViewSpace(input.actor, input.spaceId);
  const conditions = [eq(localAgentRuntimes.id, input.runtimeId), eq(localAgentRuntimes.spaceId, input.spaceId)];
  if (input.actor.deviceId) conditions.push(eq(localAgentRuntimes.deviceId, input.actor.deviceId));
  else conditions.push(eq(localAgentRuntimes.userUuid, input.actor.userUuid));
  const [row] = await db.select().from(localAgentRuntimes).where(and(...conditions)).limit(1);
  if (!row) throw new LocalAgentServiceError("local ACP runtime not found", "runtime_not_found", 404);
  return serialize(row);
}

export async function revokeLocalAcpRuntime(input: { actor: LocalAgentActor; spaceId: string; runtimeId: string }) {
  assertUuid(input.spaceId, "spaceId");
  assertUuid(input.runtimeId, "runtimeId");
  await assertActorCanUseSpace(input.actor, input.spaceId);
  const conditions = [eq(localAgentRuntimes.id, input.runtimeId), eq(localAgentRuntimes.spaceId, input.spaceId)];
  if (input.actor.deviceId) conditions.push(eq(localAgentRuntimes.deviceId, input.actor.deviceId));
  else conditions.push(eq(localAgentRuntimes.userUuid, input.actor.userUuid));
  let abortRequests: Array<{ sessionId: string; turnId: string }> = [];
  const result = await db.transaction(async (tx) => {
    const [runtime] = await tx.select().from(localAgentRuntimes).where(and(...conditions)).for("update").limit(1);
    if (!runtime) throw new LocalAgentServiceError("local ACP runtime not found", "runtime_not_found", 404);
    const revokedAt = new Date();
    const [row] = await tx.update(localAgentRuntimes).set({
      status: "revoked",
      connectionEpoch: sql`${localAgentRuntimes.connectionEpoch} + 1`,
      disconnectedAt: revokedAt,
      lastError: "runtime revoked",
      updatedAt: revokedAt,
    }).where(eq(localAgentRuntimes.id, runtime.id)).returning();
    if (!row) throw new LocalAgentServiceError("local ACP runtime disappeared during revoke", "runtime_revoke_failed", 500);
    const attempts = await tx.select({ id: workspaceExecutionAttempts.id, sessionId: workspaceExecutionAttempts.sessionId, turnId: workspaceExecutionAttempts.turnId, status: workspaceExecutionAttempts.status }).from(workspaceExecutionAttempts).where(and(
      eq(workspaceExecutionAttempts.spaceId, input.spaceId),
      eq(workspaceExecutionAttempts.runtimeId, runtime.id),
      inArray(workspaceExecutionAttempts.status, ["queued", "prepared", "running", "workspace_sealed", "transcript_sealed", "awaiting_recovery"]),
    )).for("update");
    const attemptIds = attempts.map((attempt) => attempt.id);
    abortRequests = attempts
      .filter((attempt) => ["running", "workspace_sealed", "transcript_sealed", "awaiting_recovery"].includes(attempt.status) && typeof attempt.sessionId === "string" && typeof attempt.turnId === "string")
      .map((attempt) => ({ sessionId: attempt.sessionId as string, turnId: attempt.turnId as string }));
    const turnIds = attempts.map((attempt) => attempt.turnId).filter((turnId): turnId is string => typeof turnId === "string");
    await tx.update(localAgentRuntimeSessions).set({ status: "revoked", updatedAt: revokedAt }).where(eq(localAgentRuntimeSessions.runtimeId, runtime.id));
    await tx.update(localAgentRuntimeCommands).set({
      status: "failed",
      errorCode: -32004,
      errorMessage: "local ACP runtime was revoked",
      updatedAt: revokedAt,
    }).where(and(
      eq(localAgentRuntimeCommands.runtimeId, runtime.id),
      inArray(localAgentRuntimeCommands.status, ["prepared", "sent"]),
    ));
    if (attemptIds.length > 0) {
      await tx.update(workspaceExecutionAttempts).set({
        status: "aborted",
        errorCode: "runtime_revoked",
        errorMessage: "local ACP runtime was revoked",
        completedAt: revokedAt,
        updatedAt: revokedAt,
      }).where(inArray(workspaceExecutionAttempts.id, attemptIds));
      await tx.update(workspaceWriterLeases).set({ expiresAt: revokedAt, lastHeartbeatAt: revokedAt, updatedAt: revokedAt }).where(and(
        eq(workspaceWriterLeases.spaceId, input.spaceId),
        or(eq(workspaceWriterLeases.holderKind, "local_agent"), eq(workspaceWriterLeases.holderKind, "local_offline_reservation")),
        or(
          inArray(workspaceWriterLeases.holderId, attemptIds),
          eq(workspaceWriterLeases.holderId, runtime.id),
        ),
      ));
      await tx.update(workspaceState).set({ activeExecutionAttemptId: null, updatedAt: revokedAt }).where(and(
        eq(workspaceState.spaceId, input.spaceId),
        inArray(workspaceState.activeExecutionAttemptId, attemptIds),
      ));
      await tx.update(workspaceReplicas).set({ activeExecutionAttemptId: null, updatedAt: revokedAt }).where(and(
        eq(workspaceReplicas.spaceId, input.spaceId),
        eq(workspaceReplicas.kind, "local"),
        inArray(workspaceReplicas.activeExecutionAttemptId, attemptIds),
      ));
      if (turnIds.length > 0) {
        await tx.update(sessionTurns).set({
          status: "failed",
          errorMessage: "local ACP runtime was revoked",
          summary: { finishReason: "failed", reason: "runtime_revoked" },
          completedAt: revokedAt,
          updatedAt: revokedAt,
        }).where(and(
          inArray(sessionTurns.id, turnIds),
          inArray(sessionTurns.status, ["queued", "running", "abort_requested"]),
        ));
      }
    }
    return row;
  });
  for (const request of abortRequests) {
    void requestAgentTurnAbort({
      spaceId: input.spaceId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      reason: "abort",
      actorUserId: input.actor.userUuid,
    }).catch(() => undefined);
  }
  void notifyWorkspaceState({ spaceId: input.spaceId, reason: "runtime_revoked" }).catch(() => undefined);
  return serialize(result);
}

export async function fenceLocalAcpRuntimesForPolicy(input: {
  spaceId: string;
  deviceId: string;
  errorMessage: string;
}) {
  assertUuid(input.spaceId, "spaceId");
  assertUuid(input.deviceId, "deviceId");
  const errorMessage = bounded(input.errorMessage, "errorMessage", 2000);
  let abortRequests: Array<{ sessionId: string; turnId: string }> = [];
  await db.transaction(async (tx) => {
    const runtimes = await tx.select({ id: localAgentRuntimes.id }).from(localAgentRuntimes).where(and(
      eq(localAgentRuntimes.spaceId, input.spaceId),
      eq(localAgentRuntimes.deviceId, input.deviceId),
      ne(localAgentRuntimes.status, "revoked"),
    )).for("update");
    const runtimeIds = runtimes.map((runtime) => runtime.id);
    if (runtimeIds.length === 0) return;
    const fencedAt = new Date();
    await tx.update(localAgentRuntimes).set({
      status: "offline",
      connectionEpoch: sql`${localAgentRuntimes.connectionEpoch} + 1`,
      disconnectedAt: fencedAt,
      lastError: errorMessage,
      updatedAt: fencedAt,
    }).where(inArray(localAgentRuntimes.id, runtimeIds));
    const attempts = await tx.select({
      id: workspaceExecutionAttempts.id,
      sessionId: workspaceExecutionAttempts.sessionId,
      turnId: workspaceExecutionAttempts.turnId,
      status: workspaceExecutionAttempts.status,
    }).from(workspaceExecutionAttempts).where(and(
      eq(workspaceExecutionAttempts.spaceId, input.spaceId),
      inArray(workspaceExecutionAttempts.runtimeId, runtimeIds),
      inArray(workspaceExecutionAttempts.status, ["queued", "prepared", "running", "workspace_sealed", "transcript_sealed", "awaiting_recovery"]),
    )).for("update");
    const attemptIds = attempts.map((attempt) => attempt.id);
    const turnIds = attempts.map((attempt) => attempt.turnId).filter((turnId): turnId is string => typeof turnId === "string");
    abortRequests = attempts
      .filter((attempt) => ["running", "workspace_sealed", "transcript_sealed", "awaiting_recovery"].includes(attempt.status) && typeof attempt.sessionId === "string" && typeof attempt.turnId === "string")
      .map((attempt) => ({ sessionId: attempt.sessionId as string, turnId: attempt.turnId as string }));
    await tx.update(localAgentRuntimeSessions).set({ status: "error", updatedAt: fencedAt }).where(and(
      inArray(localAgentRuntimeSessions.runtimeId, runtimeIds),
      ne(localAgentRuntimeSessions.status, "revoked"),
    ));
    await tx.update(localAgentRuntimeCommands).set({
      status: "unknown",
      errorMessage,
      updatedAt: fencedAt,
    }).where(and(
      inArray(localAgentRuntimeCommands.runtimeId, runtimeIds),
      eq(localAgentRuntimeCommands.status, "sent"),
    ));
    await tx.update(localAgentRuntimeCommands).set({
      status: "failed",
      errorCode: -32005,
      errorMessage,
      updatedAt: fencedAt,
    }).where(and(
      inArray(localAgentRuntimeCommands.runtimeId, runtimeIds),
      eq(localAgentRuntimeCommands.status, "prepared"),
    ));
    if (attemptIds.length === 0) return;
    await tx.update(workspaceExecutionAttempts).set({
      status: "aborted",
      errorCode: "runtime_policy_changed",
      errorMessage,
      completedAt: fencedAt,
      updatedAt: fencedAt,
    }).where(inArray(workspaceExecutionAttempts.id, attemptIds));
    await tx.update(workspaceWriterLeases).set({ expiresAt: fencedAt, lastHeartbeatAt: fencedAt, updatedAt: fencedAt }).where(and(
      eq(workspaceWriterLeases.spaceId, input.spaceId),
      eq(workspaceWriterLeases.holderKind, "local_agent"),
      inArray(workspaceWriterLeases.holderId, attemptIds),
    ));
    await tx.update(workspaceState).set({ activeExecutionAttemptId: null, updatedAt: fencedAt }).where(and(
      eq(workspaceState.spaceId, input.spaceId),
      inArray(workspaceState.activeExecutionAttemptId, attemptIds),
    ));
    await tx.update(workspaceReplicas).set({ activeExecutionAttemptId: null, updatedAt: fencedAt }).where(and(
      eq(workspaceReplicas.spaceId, input.spaceId),
      eq(workspaceReplicas.kind, "local"),
      inArray(workspaceReplicas.activeExecutionAttemptId, attemptIds),
    ));
    if (turnIds.length > 0) {
      await tx.update(sessionTurns).set({
        status: "failed",
        errorMessage,
        summary: { finishReason: "failed", reason: "runtime_policy_changed" },
        completedAt: fencedAt,
        updatedAt: fencedAt,
      }).where(and(
        inArray(sessionTurns.id, turnIds),
        inArray(sessionTurns.status, ["queued", "running", "abort_requested"]),
      ));
    }
  });
  for (const request of abortRequests) {
    void requestAgentTurnAbort({
      spaceId: input.spaceId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      reason: "abort",
    }).catch(() => undefined);
  }
  void notifyWorkspaceState({ spaceId: input.spaceId, reason: "runtime_policy_changed" }).catch(() => undefined);
}

export async function authorizeLocalAcpRuntime(input: {
  runtimeId: string;
  spaceId: string;
  actor: LocalAgentActor;
  gatewayNodeId?: string | null;
  gatewayWsEndpoint?: string | null;
}) {
  assertUuid(input.runtimeId, "runtimeId");
  assertUuid(input.spaceId, "spaceId");
  if (!input.actor.deviceId) throw new LocalAgentServiceError("runtime device credential is required", "device_required", 401);
  await assertActorCanUseSpace(input.actor, input.spaceId);
  const result = await db.transaction(async (tx) => {
    const [device] = await tx.select({ id: localAgentDevices.id }).from(localAgentDevices).where(and(
      eq(localAgentDevices.id, input.actor.deviceId as string),
      eq(localAgentDevices.userUuid, input.actor.userUuid),
      eq(localAgentDevices.status, "active"),
      input.actor.credentialVersion != null ? eq(localAgentDevices.credentialVersion, input.actor.credentialVersion) : undefined,
    )).for("update").limit(1);
    if (!device) throw new LocalAgentServiceError("runtime device credential is invalid or revoked", "device_credential_invalid", 401);
    const [row] = await tx.select().from(localAgentRuntimes).where(and(
      eq(localAgentRuntimes.id, input.runtimeId),
      eq(localAgentRuntimes.spaceId, input.spaceId),
      eq(localAgentRuntimes.deviceId, input.actor.deviceId as string),
      eq(localAgentRuntimes.userUuid, input.actor.userUuid),
      ne(localAgentRuntimes.status, "revoked"),
    )).for("update").limit(1);
    if (!row) throw new LocalAgentServiceError("local ACP runtime is not registered for this Space", "runtime_not_found", 404);
    if (!providerEnabled(row.provider)) throw new LocalAgentServiceError(`${row.provider} local ACP runtime is disabled`, "provider_not_enabled", 403);
    const [integrationPolicy] = await tx.select({ sessionMirrorMode: spaceLocalAgentPolicies.sessionMirrorMode, workspaceMode: spaceLocalAgentPolicies.workspaceMode }).from(spaceLocalAgentPolicies).where(and(
      eq(spaceLocalAgentPolicies.spaceId, input.spaceId),
      eq(spaceLocalAgentPolicies.deviceId, input.actor.deviceId as string),
    )).limit(1);
    if (integrationPolicy?.sessionMirrorMode !== "full") {
      throw new LocalAgentServiceError("full session mirror consent is required for ACP runtime execution", "runtime_transcript_consent_required", 403);
    }
    if (integrationPolicy.workspaceMode === "one_way_to_local") {
      throw new LocalAgentServiceError("local workspace is read-only under the current policy", "workspace_write_disabled", 403);
    }
    const now = new Date();
    const gatewayNodeId = input.gatewayNodeId == null ? null : bounded(input.gatewayNodeId, "gatewayNodeId", 255);
    const gatewayWsEndpoint = input.gatewayWsEndpoint == null ? null : bounded(input.gatewayWsEndpoint, "gatewayWsEndpoint", 2048);
    if (gatewayWsEndpoint && !/^wss?:\/\//i.test(gatewayWsEndpoint)) {
      throw new LocalAgentServiceError("gatewayWsEndpoint is invalid", "invalid_gateway_endpoint", 400);
    }
    const [updated] = await tx.update(localAgentRuntimes).set({
      status: "ready",
      gatewayNodeId,
      gatewayWsEndpoint,
      connectionEpoch: row.connectionEpoch + 1,
      connectedAt: now,
      disconnectedAt: null,
      lastSeenAt: now,
      lastError: null,
      updatedAt: now,
    }).where(and(eq(localAgentRuntimes.id, row.id), ne(localAgentRuntimes.status, "revoked"))).returning();
    if (!updated) throw new LocalAgentServiceError("local ACP runtime was revoked during authorization", "runtime_revoked", 401);
    return updated;
  });
  return {
    runtimeId: result.id,
    spaceId: result.spaceId,
    replicaId: result.replicaId,
    provider: result.provider,
    connectionEpoch: result.connectionEpoch,
    capabilities: result.capabilities,
  };
}

export async function touchLocalAcpRuntime(input: { runtimeId: string; connectionEpoch: number; actor: LocalAgentActor }) {
  assertUuid(input.runtimeId, "runtimeId");
  if (!Number.isSafeInteger(input.connectionEpoch) || input.connectionEpoch < 1) throw new LocalAgentServiceError("connectionEpoch is invalid", "invalid_epoch", 400);
  if (!input.actor.deviceId) throw new LocalAgentServiceError("runtime device credential is required", "device_required", 401);
  const [runtime] = await db.select({ spaceId: localAgentRuntimes.spaceId, userUuid: localAgentRuntimes.userUuid, deviceId: localAgentRuntimes.deviceId, provider: localAgentRuntimes.provider }).from(localAgentRuntimes).where(eq(localAgentRuntimes.id, input.runtimeId)).limit(1);
  if (!runtime || runtime.userUuid !== input.actor.userUuid || runtime.deviceId !== input.actor.deviceId || !isLocalAcpProviderEnabled(runtime.provider)) return false;
  if (!(await hasPermission({ uuid: input.actor.userUuid }, "file.edit", { spaceId: runtime.spaceId }))) return false;
  const [device] = await db.select({ id: localAgentDevices.id }).from(localAgentDevices).where(and(
    eq(localAgentDevices.id, input.actor.deviceId),
    eq(localAgentDevices.userUuid, input.actor.userUuid),
    eq(localAgentDevices.status, "active"),
    input.actor.credentialVersion != null ? eq(localAgentDevices.credentialVersion, input.actor.credentialVersion) : undefined,
  )).limit(1);
  if (!device) return false;
  const current = new Date();
  const [row] = await db.update(localAgentRuntimes).set({
    lastSeenAt: current,
    updatedAt: current,
  }).where(and(
    eq(localAgentRuntimes.id, input.runtimeId),
    eq(localAgentRuntimes.connectionEpoch, input.connectionEpoch),
    eq(localAgentRuntimes.deviceId, input.actor.deviceId),
    eq(localAgentRuntimes.userUuid, input.actor.userUuid),
    ne(localAgentRuntimes.status, "revoked"),
    sql`exists (
      select 1 from v2.space_local_agent_policies policy
      where policy.space_id = ${localAgentRuntimes.spaceId}
        and policy.device_id = ${localAgentRuntimes.deviceId}
        and policy.session_mirror_mode = 'full'
        and policy.workspace_mode <> 'one_way_to_local'
    )`,
  )).returning({ id: localAgentRuntimes.id });
  return Boolean(row);
}

export async function reportLocalAcpRuntimeStatus(input: {
  runtimeId: string;
  connectionEpoch: number;
  status: "ready" | "offline" | "error";
  error?: string | null;
}) {
  assertUuid(input.runtimeId, "runtimeId");
  if (!Number.isSafeInteger(input.connectionEpoch) || input.connectionEpoch < 1) throw new LocalAgentServiceError("connectionEpoch is invalid", "invalid_epoch", 400);
  const errorMessage = input.error == null ? null : bounded(input.error, "error", 2000);
  const current = new Date();
  const [row] = await db.update(localAgentRuntimes).set({
    status: input.status,
    lastSeenAt: current,
    ...(input.status === "offline" ? { disconnectedAt: current } : { connectedAt: current, disconnectedAt: null }),
    lastError: errorMessage,
    updatedAt: current,
  }).where(and(eq(localAgentRuntimes.id, input.runtimeId), eq(localAgentRuntimes.connectionEpoch, input.connectionEpoch), ne(localAgentRuntimes.status, "revoked"))).returning();
  return row ? serialize(row) : null;
}
