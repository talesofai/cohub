import { and, asc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { localAgentRuntimes, localAgentDevices, localAgentRuntimeCommands, localAgentRuntimeSessions, sessionTurns, spaceLocalAgentPolicies, workspaceExecutionAttempts, workspaceReplicas, workspaceState, workspaceWriterLeases } from "@cohub/db";
import {
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  isLocalRuntimeHeartbeatFresh,
  LocalRuntimeProviderSchema,
  isUuid,
} from "@cohub/protocol";
import { db } from "./db/index.js";
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
const UNRESOLVED_ATTEMPT_STATUSES = ["queued", "prepared", "running", "workspace_sealed", "transcript_sealed", "awaiting_recovery"] as const;
const CONNECTED_RUNTIME_STATUSES = ["ready", "busy"] as const;
const isConnectedRuntimeStatus = (status: string): status is (typeof CONNECTED_RUNTIME_STATUSES)[number] =>
  CONNECTED_RUNTIME_STATUSES.some((value) => value === status);

export const validateGatewayWsEndpoint = (value: string | null | undefined): string | null => {
  if (value == null) return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > 2048) {
    throw new LocalAgentServiceError("gatewayWsEndpoint is invalid", "invalid_gateway_endpoint", 400);
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new LocalAgentServiceError("gatewayWsEndpoint is invalid", "invalid_gateway_endpoint", 400);
  }
  if ((url.protocol !== "ws:" && url.protocol !== "wss:")
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "/internal/runtime-relay" && url.pathname !== "/internal/runtime-relay/")) {
    throw new LocalAgentServiceError("gatewayWsEndpoint is invalid", "invalid_gateway_endpoint", 400);
  }
  return `${url.protocol}//${url.host}/internal/runtime-relay`;
};

export const shouldFenceLocalRuntimeRegistration = (input: {
  status: string;
  lastSeenAt: Date | null | undefined;
  replicaChanged: boolean;
}) => input.replicaChanged
  || (isConnectedRuntimeStatus(input.status)
    && !isLocalRuntimeHeartbeatFresh(input.lastSeenAt));

/** Runtime frames and persisted registrations are pinned to the supported v1 contract. */
export const assertSupportedLocalRuntimeProtocolVersion = (value: unknown): number => {
  if (value !== LOCAL_RUNTIME_PROTOCOL_VERSION) {
    throw new LocalAgentServiceError(
      `local runtime protocol version ${String(value)} is unsupported`,
      "unsupported_protocol",
      400,
    );
  }
  return LOCAL_RUNTIME_PROTOCOL_VERSION;
};

export const isSupportedLocalRuntimeProvider = (value: string) => {
  const parsed = LocalRuntimeProviderSchema.safeParse(value);
  return parsed.success;
};

const serialize = (row: typeof localAgentRuntimes.$inferSelect) => ({
  id: row.id,
  spaceId: row.spaceId,
  deviceId: row.deviceId,
  replicaId: row.replicaId,
  userUuid: row.userUuid,
  provider: row.provider,
  displayName: row.displayName,
  protocolVersion: row.protocolVersion,
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

export async function registerLocalRuntime(input: {
  actor: LocalAgentActor;
  spaceId: string;
  replicaId: string;
  deviceId?: string;
  provider: string;
  displayName: string;
  protocolVersion: number;
}) {
  assertUuid(input.spaceId, "spaceId");
  assertUuid(input.replicaId, "replicaId");
  const protocolVersion = assertSupportedLocalRuntimeProtocolVersion(input.protocolVersion);
  const deviceId = input.actor.deviceId ?? (input.deviceId ? assertUuid(input.deviceId, "deviceId") : null);
  if (!deviceId) throw new LocalAgentServiceError("a device credential is required", "device_required", 401);
  const provider = LocalRuntimeProviderSchema.parse(input.provider);
  await assertActorCanUseSpace(input.actor, input.spaceId);
  const displayName = bounded(input.displayName, "displayName", 255);
  const persistRegistration = () => db.transaction(async (tx) => {
    // Re-check and lock the authorization inputs in the same transaction as
    // the runtime upsert. The preflight checks above used to leave a window
    // where device revocation, replica detachment, or a policy change could
    // race registration and still leave a usable runtime row behind.
    const [device] = await tx.select({ id: localAgentDevices.id }).from(localAgentDevices).where(and(
      eq(localAgentDevices.id, deviceId),
      eq(localAgentDevices.userUuid, input.actor.userUuid),
      eq(localAgentDevices.status, "active"),
      input.actor.credentialVersion != null ? eq(localAgentDevices.credentialVersion, input.actor.credentialVersion) : undefined,
    )).for("update").limit(1);
    if (!device) throw new LocalAgentServiceError("device is not enrolled or has been revoked", "device_not_found", 404);
    const [integrationPolicy] = await tx.select({ workspaceMode: spaceLocalAgentPolicies.workspaceMode }).from(spaceLocalAgentPolicies).where(and(
      eq(spaceLocalAgentPolicies.spaceId, input.spaceId),
      eq(spaceLocalAgentPolicies.deviceId, deviceId),
    )).for("update").limit(1);
    if (!integrationPolicy) throw new LocalAgentServiceError("local agent policy is unavailable", "policy_unavailable", 409);
    if (integrationPolicy.workspaceMode === "one_way_to_local") {
      throw new LocalAgentServiceError("local workspace is read-only under the current policy", "workspace_write_disabled", 403);
    }
    const [replica] = await tx.select({ id: workspaceReplicas.id, deviceId: workspaceReplicas.deviceId, status: workspaceReplicas.status }).from(workspaceReplicas).where(and(
      eq(workspaceReplicas.id, input.replicaId),
      eq(workspaceReplicas.spaceId, input.spaceId),
      eq(workspaceReplicas.kind, "local"),
      eq(workspaceReplicas.deviceId, deviceId),
      ne(workspaceReplicas.status, "detached"),
    )).for("update").limit(1);
    if (!replica?.deviceId) throw new LocalAgentServiceError("local workspace replica is unavailable", "replica_not_found", 404);
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
      protocolVersion,
      status: "offline" as const,
      lastError: null,
      updatedAt: new Date(),
    };
    if (existing) {
      const replicaChanged = existing.replicaId !== input.replicaId;
      const staleConnection = isConnectedRuntimeStatus(existing.status)
        && !isLocalRuntimeHeartbeatFresh(existing.lastSeenAt);
      const connectionFenced = shouldFenceLocalRuntimeRegistration({
        status: existing.status,
        lastSeenAt: existing.lastSeenAt,
        replicaChanged,
      });
      const now = new Date();
      if (existing.protocolVersion !== protocolVersion) {
        throw new LocalAgentServiceError(
          `local runtime protocol version ${existing.protocolVersion} is unsupported`,
          "unsupported_protocol",
          409,
        );
      }
      if (existing.replicaId !== input.replicaId) {
        // Runtime status is only a connection hint. The attempt ledger and
        // writer lease are the authoritative handoff state, so a registration
        // update must not orphan work created for the old replica.
        const [unresolvedAttempt] = await tx.select({ id: workspaceExecutionAttempts.id }).from(workspaceExecutionAttempts).where(and(
          eq(workspaceExecutionAttempts.spaceId, input.spaceId),
          eq(workspaceExecutionAttempts.runtimeId, existing.id),
          inArray(workspaceExecutionAttempts.status, [...UNRESOLVED_ATTEMPT_STATUSES]),
        )).for("update").limit(1);
        if (unresolvedAttempt) {
          throw new LocalAgentServiceError("cannot move a runtime with an unresolved execution attempt", "runtime_busy", 409);
        }
        const [activeLease] = await tx.select({ holderId: workspaceWriterLeases.holderId }).from(workspaceWriterLeases)
          .innerJoin(workspaceExecutionAttempts, and(
            eq(workspaceExecutionAttempts.id, workspaceWriterLeases.holderId),
            eq(workspaceExecutionAttempts.runtimeId, existing.id),
          ))
          .where(and(
            eq(workspaceWriterLeases.spaceId, input.spaceId),
            eq(workspaceWriterLeases.holderKind, "local_agent"),
            gt(workspaceWriterLeases.expiresAt, new Date()),
          )).for("update").limit(1);
        if (activeLease) {
          throw new LocalAgentServiceError("cannot move a runtime with an active workspace lease", "runtime_busy", 409);
        }
      }
      const preserveGatewayRoute = isConnectedRuntimeStatus(existing.status) && !connectionFenced;
      const [updated] = await tx.update(localAgentRuntimes).set({
        ...values,
        status: connectionFenced ? "offline" : existing.status,
        connectionEpoch: connectionFenced ? existing.connectionEpoch + 1 : existing.connectionEpoch,
        gatewayNodeId: preserveGatewayRoute ? existing.gatewayNodeId : null,
        gatewayWsEndpoint: preserveGatewayRoute ? existing.gatewayWsEndpoint : null,
        connectedAt: connectionFenced ? null : existing.connectedAt,
        disconnectedAt: connectionFenced ? now : existing.disconnectedAt,
        lastSeenAt: connectionFenced ? null : existing.lastSeenAt,
        lastError: staleConnection ? "runtime heartbeat expired" : null,
      }).where(eq(localAgentRuntimes.id, existing.id)).returning();
      return updated ?? existing;
    }
    const [created] = await tx.insert(localAgentRuntimes).values(values).returning();
    if (!created) throw new LocalAgentServiceError("failed to register local runtime", "runtime_registration_failed", 500);
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

export async function listLocalRuntimes(input: { actor: LocalAgentActor; spaceId: string }) {
  assertUuid(input.spaceId, "spaceId");
  await assertActorCanViewSpace(input.actor, input.spaceId);
  const visibility = input.actor.deviceId
    ? eq(localAgentRuntimes.deviceId, input.actor.deviceId)
    : eq(localAgentRuntimes.userUuid, input.actor.userUuid);
  const rows = await db.select().from(localAgentRuntimes).where(and(eq(localAgentRuntimes.spaceId, input.spaceId), visibility)).orderBy(asc(localAgentRuntimes.createdAt));
  return { runtimes: rows.map(serialize) };
}

export async function getLocalRuntime(input: { actor: LocalAgentActor; spaceId: string; runtimeId: string }) {
  assertUuid(input.spaceId, "spaceId");
  assertUuid(input.runtimeId, "runtimeId");
  await assertActorCanViewSpace(input.actor, input.spaceId);
  const conditions = [eq(localAgentRuntimes.id, input.runtimeId), eq(localAgentRuntimes.spaceId, input.spaceId)];
  if (input.actor.deviceId) conditions.push(eq(localAgentRuntimes.deviceId, input.actor.deviceId));
  else conditions.push(eq(localAgentRuntimes.userUuid, input.actor.userUuid));
  const [row] = await db.select().from(localAgentRuntimes).where(and(...conditions)).limit(1);
  if (!row) throw new LocalAgentServiceError("local runtime not found", "runtime_not_found", 404);
  return serialize(row);
}

export async function revokeLocalRuntime(input: { actor: LocalAgentActor; spaceId: string; runtimeId: string }) {
  assertUuid(input.spaceId, "spaceId");
  assertUuid(input.runtimeId, "runtimeId");
  await assertActorCanUseSpace(input.actor, input.spaceId);
  const conditions = [eq(localAgentRuntimes.id, input.runtimeId), eq(localAgentRuntimes.spaceId, input.spaceId)];
  if (input.actor.deviceId) conditions.push(eq(localAgentRuntimes.deviceId, input.actor.deviceId));
  else conditions.push(eq(localAgentRuntimes.userUuid, input.actor.userUuid));
  let abortRequests: Array<{ sessionId: string; turnId: string }> = [];
  const result = await db.transaction(async (tx) => {
    const [runtime] = await tx.select().from(localAgentRuntimes).where(and(...conditions)).for("update").limit(1);
    if (!runtime) throw new LocalAgentServiceError("local runtime not found", "runtime_not_found", 404);
    const revokedAt = new Date();
    const [row] = await tx.update(localAgentRuntimes).set({
      status: "revoked",
      connectionEpoch: sql`${localAgentRuntimes.connectionEpoch} + 1`,
      gatewayNodeId: null,
      gatewayWsEndpoint: null,
      disconnectedAt: revokedAt,
      lastError: "runtime revoked",
      updatedAt: revokedAt,
    }).where(eq(localAgentRuntimes.id, runtime.id)).returning();
    if (!row) throw new LocalAgentServiceError("local runtime disappeared during revoke", "runtime_revoke_failed", 500);
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
      errorMessage: "local runtime was revoked",
      updatedAt: revokedAt,
    }).where(and(
      eq(localAgentRuntimeCommands.runtimeId, runtime.id),
      inArray(localAgentRuntimeCommands.status, ["prepared", "sent"]),
    ));
    if (attemptIds.length > 0) {
      await tx.update(workspaceExecutionAttempts).set({
        status: "aborted",
        errorCode: "runtime_revoked",
        errorMessage: "local runtime was revoked",
        completedAt: revokedAt,
        updatedAt: revokedAt,
      }).where(inArray(workspaceExecutionAttempts.id, attemptIds));
      await tx.update(workspaceWriterLeases).set({ expiresAt: revokedAt, lastHeartbeatAt: revokedAt, updatedAt: revokedAt }).where(and(
        eq(workspaceWriterLeases.spaceId, input.spaceId),
        eq(workspaceWriterLeases.holderKind, "local_agent"),
        inArray(workspaceWriterLeases.holderId, attemptIds),
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
          errorMessage: "local runtime was revoked",
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

type PolicyTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function fenceLocalRuntimesInTransaction(tx: PolicyTransaction, input: {
  spaceId: string;
  deviceId: string;
  errorMessage: string;
}) {
  const runtimes = await tx.select({ id: localAgentRuntimes.id }).from(localAgentRuntimes).where(and(
    eq(localAgentRuntimes.spaceId, input.spaceId),
    eq(localAgentRuntimes.deviceId, input.deviceId),
    ne(localAgentRuntimes.status, "revoked"),
  )).for("update");
  const runtimeIds = runtimes.map((runtime) => runtime.id);
  const abortRequests: Array<{ sessionId: string; turnId: string }> = [];
  if (runtimeIds.length === 0) return abortRequests;
  const fencedAt = new Date();
  await tx.update(localAgentRuntimes).set({
    status: "offline",
    connectionEpoch: sql`${localAgentRuntimes.connectionEpoch} + 1`,
    gatewayNodeId: null,
    gatewayWsEndpoint: null,
    disconnectedAt: fencedAt,
    lastError: input.errorMessage,
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
  for (const attempt of attempts) {
    if (["running", "workspace_sealed", "transcript_sealed", "awaiting_recovery"].includes(attempt.status) && typeof attempt.sessionId === "string" && typeof attempt.turnId === "string") {
      abortRequests.push({ sessionId: attempt.sessionId, turnId: attempt.turnId });
    }
  }
  await tx.update(localAgentRuntimeSessions).set({ status: "error", updatedAt: fencedAt }).where(and(
    inArray(localAgentRuntimeSessions.runtimeId, runtimeIds),
    ne(localAgentRuntimeSessions.status, "revoked"),
  ));
  await tx.update(localAgentRuntimeCommands).set({
    status: "unknown",
    errorMessage: input.errorMessage,
    updatedAt: fencedAt,
  }).where(and(
    inArray(localAgentRuntimeCommands.runtimeId, runtimeIds),
    eq(localAgentRuntimeCommands.status, "sent"),
  ));
  await tx.update(localAgentRuntimeCommands).set({
    status: "failed",
    errorCode: -32005,
    errorMessage: input.errorMessage,
    updatedAt: fencedAt,
  }).where(and(
    inArray(localAgentRuntimeCommands.runtimeId, runtimeIds),
    eq(localAgentRuntimeCommands.status, "prepared"),
  ));
  if (attemptIds.length === 0) return abortRequests;
  await tx.update(workspaceExecutionAttempts).set({
    status: "aborted",
    errorCode: "runtime_policy_changed",
    errorMessage: input.errorMessage,
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
      errorMessage: input.errorMessage,
      summary: { finishReason: "failed", reason: "runtime_policy_changed" },
      completedAt: fencedAt,
      updatedAt: fencedAt,
    }).where(and(
      inArray(sessionTurns.id, turnIds),
      inArray(sessionTurns.status, ["queued", "running", "abort_requested"]),
    ));
  }
  return abortRequests;
}

/**
 * Change a device's workspace policy and fence every connected runtime for
 * that device in the same transaction. A runtime that reconnects afterwards
 * re-authorizes against the new policy version; there is no window in which it
 * can submit work under the previous policy.
 */
export async function updateLocalAgentPolicy(input: {
  spaceId: string;
  deviceId: string;
  expectedVersion: number;
  workspaceMode: typeof spaceLocalAgentPolicies.$inferSelect["workspaceMode"];
  updatedBy: string;
  fenceMessage: string;
}) {
  assertUuid(input.spaceId, "spaceId");
  assertUuid(input.deviceId, "deviceId");
  const fenceMessage = bounded(input.fenceMessage, "fenceMessage", 2000);
  let abortRequests: Array<{ sessionId: string; turnId: string }> = [];
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(spaceLocalAgentPolicies).where(and(
      eq(spaceLocalAgentPolicies.spaceId, input.spaceId),
      eq(spaceLocalAgentPolicies.deviceId, input.deviceId),
    )).for("update").limit(1);
    if (!row || row.integrationPolicyVersion !== input.expectedVersion) return null;
    abortRequests = await fenceLocalRuntimesInTransaction(tx, { spaceId: input.spaceId, deviceId: input.deviceId, errorMessage: fenceMessage });
    const [next] = await tx.update(spaceLocalAgentPolicies).set({
      workspaceMode: input.workspaceMode,
      integrationPolicyVersion: row.integrationPolicyVersion + 1,
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    }).where(and(
      eq(spaceLocalAgentPolicies.id, row.id),
      eq(spaceLocalAgentPolicies.integrationPolicyVersion, row.integrationPolicyVersion),
    )).returning();
    return next ?? null;
  });
  if (!updated) return null;
  for (const request of abortRequests) {
    void requestAgentTurnAbort({
      spaceId: input.spaceId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      reason: "abort",
    }).catch(() => undefined);
  }
  void notifyWorkspaceState({ spaceId: input.spaceId, reason: "runtime_policy_changed" }).catch(() => undefined);
  return updated;
}

export async function authorizeLocalRuntime(input: {
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
    if (!row) throw new LocalAgentServiceError("local runtime is not registered for this Space", "runtime_not_found", 404);
    const [replica] = await tx.select({
      appliedSnapshotId: workspaceReplicas.appliedSnapshotId,
      workspaceStatus: workspaceState.status,
      workspaceCanonicalSnapshotId: workspaceState.canonicalSnapshotId,
    }).from(workspaceReplicas)
      .innerJoin(workspaceState, eq(workspaceState.spaceId, workspaceReplicas.spaceId))
      .where(and(
        eq(workspaceReplicas.id, row.replicaId),
        eq(workspaceReplicas.spaceId, input.spaceId),
        eq(workspaceReplicas.kind, "local"),
        eq(workspaceReplicas.deviceId, input.actor.deviceId as string),
        eq(workspaceReplicas.userUuid, input.actor.userUuid),
        eq(workspaceReplicas.status, "ready"),
      ))
      .for("update", { of: workspaceReplicas })
      .limit(1);
    if (!replica) {
      throw new LocalAgentServiceError("local workspace replica is not ready for this runtime", "runtime_replica_not_ready", 409);
    }
    if (replica.workspaceStatus !== "ready" || !replica.workspaceCanonicalSnapshotId || replica.appliedSnapshotId !== replica.workspaceCanonicalSnapshotId) {
      throw new LocalAgentServiceError("local workspace replica is not synchronized for this runtime", "runtime_replica_not_ready", 409);
    }
    if (row.protocolVersion !== LOCAL_RUNTIME_PROTOCOL_VERSION) {
      throw new LocalAgentServiceError(
        `local runtime protocol version ${row.protocolVersion} is unsupported`,
        "unsupported_protocol",
        409,
      );
    }
    if (!isSupportedLocalRuntimeProvider(row.provider)) throw new LocalAgentServiceError("local runtime provider is unsupported", "unsupported_provider", 409);
    const [integrationPolicy] = await tx.select({ workspaceMode: spaceLocalAgentPolicies.workspaceMode }).from(spaceLocalAgentPolicies).where(and(
      eq(spaceLocalAgentPolicies.spaceId, input.spaceId),
      eq(spaceLocalAgentPolicies.deviceId, input.actor.deviceId as string),
    )).limit(1);
    if (!integrationPolicy) throw new LocalAgentServiceError("local agent policy is unavailable", "policy_unavailable", 409);
    if (integrationPolicy.workspaceMode === "one_way_to_local") {
      throw new LocalAgentServiceError("local workspace is read-only under the current policy", "workspace_write_disabled", 403);
    }
    const now = new Date();
    const gatewayNodeId = input.gatewayNodeId == null ? null : bounded(input.gatewayNodeId, "gatewayNodeId", 255);
    const gatewayWsEndpoint = validateGatewayWsEndpoint(input.gatewayWsEndpoint);
    if ((gatewayNodeId == null) !== (gatewayWsEndpoint == null)) {
      throw new LocalAgentServiceError("gateway node and peer endpoint must be provided together", "invalid_gateway_endpoint", 400);
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
    if (!updated) throw new LocalAgentServiceError("local runtime was revoked during authorization", "runtime_revoked", 401);
    return updated;
  });
  return {
    runtimeId: result.id,
    spaceId: result.spaceId,
    replicaId: result.replicaId,
    provider: result.provider,
    connectionEpoch: result.connectionEpoch,
  };
}

export async function touchLocalRuntime(input: { runtimeId: string; connectionEpoch: number; actor: LocalAgentActor }) {
  assertUuid(input.runtimeId, "runtimeId");
  if (!Number.isSafeInteger(input.connectionEpoch) || input.connectionEpoch < 1) throw new LocalAgentServiceError("connectionEpoch is invalid", "invalid_epoch", 400);
  if (!input.actor.deviceId) throw new LocalAgentServiceError("runtime device credential is required", "device_required", 401);
  const [runtime] = await db.select({ spaceId: localAgentRuntimes.spaceId, userUuid: localAgentRuntimes.userUuid, deviceId: localAgentRuntimes.deviceId, provider: localAgentRuntimes.provider, protocolVersion: localAgentRuntimes.protocolVersion, status: localAgentRuntimes.status }).from(localAgentRuntimes).where(eq(localAgentRuntimes.id, input.runtimeId)).limit(1);
  if (!runtime || runtime.userUuid !== input.actor.userUuid || runtime.deviceId !== input.actor.deviceId || runtime.protocolVersion !== LOCAL_RUNTIME_PROTOCOL_VERSION || !isSupportedLocalRuntimeProvider(runtime.provider) || !["ready", "busy"].includes(runtime.status)) return false;
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
    eq(localAgentRuntimes.protocolVersion, LOCAL_RUNTIME_PROTOCOL_VERSION),
    eq(localAgentRuntimes.deviceId, input.actor.deviceId),
    eq(localAgentRuntimes.userUuid, input.actor.userUuid),
    inArray(localAgentRuntimes.status, ["ready", "busy"]),
    sql`exists (
      select 1 from v2.space_local_agent_policies policy
      where policy.space_id = ${localAgentRuntimes.spaceId}
        and policy.device_id = ${localAgentRuntimes.deviceId}
        and policy.workspace_mode <> 'one_way_to_local'
    )`,
  )).returning({ id: localAgentRuntimes.id });
  return Boolean(row);
}

export async function disconnectLocalRuntime(input: {
  runtimeId: string;
  connectionEpoch: number;
  actor: LocalAgentActor;
  reason?: string | null;
}) {
  assertUuid(input.runtimeId, "runtimeId");
  if (!Number.isSafeInteger(input.connectionEpoch) || input.connectionEpoch < 1) throw new LocalAgentServiceError("connectionEpoch is invalid", "invalid_epoch", 400);
  if (!input.actor.deviceId) throw new LocalAgentServiceError("runtime device credential is required", "device_required", 401);
  const [device] = await db.select({ id: localAgentDevices.id }).from(localAgentDevices).where(and(
    eq(localAgentDevices.id, input.actor.deviceId),
    eq(localAgentDevices.userUuid, input.actor.userUuid),
    eq(localAgentDevices.status, "active"),
    input.actor.credentialVersion != null ? eq(localAgentDevices.credentialVersion, input.actor.credentialVersion) : undefined,
  )).limit(1);
  if (!device) return null;
  const reason = input.reason == null ? null : bounded(input.reason, "reason", 2000);
  const current = new Date();
  const [row] = await db.update(localAgentRuntimes).set({
    status: "offline",
    lastSeenAt: current,
    gatewayNodeId: null,
    gatewayWsEndpoint: null,
    disconnectedAt: current,
    lastError: reason,
    updatedAt: current,
  }).where(and(
    eq(localAgentRuntimes.id, input.runtimeId),
    eq(localAgentRuntimes.connectionEpoch, input.connectionEpoch),
    eq(localAgentRuntimes.deviceId, input.actor.deviceId),
    eq(localAgentRuntimes.userUuid, input.actor.userUuid),
    ne(localAgentRuntimes.status, "revoked"),
  )).returning();
  return row ? serialize(row) : null;
}
