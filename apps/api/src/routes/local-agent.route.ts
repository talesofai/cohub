import { Hono, type Context } from "hono";
import { ZodError } from "zod";
import { LocalAgentPolicySchema } from "@cohub/protocol";
import { and, eq } from "drizzle-orm";
import { localAgentDevices, spaceLocalAgentPolicies } from "@cohub/db";
import { useAccountPrincipal, getLocalAgentPrincipal, authzDenied, requireValidId, useAuth } from "../lib/middleware.js";
import { hasPermission } from "../permissions.js";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { enqueueWorkspaceSyncJob } from "../workspace-sync-queue.js";
import {
  LocalAgentServiceError,
  acquireWorkspaceWriterLease,
  commitWorkspaceSnapshot,
  enrollLocalAgentDevice,
  getWorkspaceReplicaState,
  getWorkspaceSnapshot,
  ackWorkspaceReplicaApplied,
  heartbeatWorkspaceWriterLease,
  issueLocalAgentToken,
  listLocalAgentDevices,
  listWorkspaceConflicts,
  resolveWorkspaceConflict,
  listWorkspaceReplicaStates,
  prepareWorkspaceSnapshot,
  releaseWorkspaceWriterLease,
  registerLocalWorkspaceAttempt,
  revokeLocalAgentDevice,
  ensureWorkspaceReplica,
  type LocalAgentActor,
} from "../local-agent-service.js";
import {
  getLocalAcpRuntime,
  listLocalAcpRuntimes,
  registerLocalAcpRuntime,
  revokeLocalAcpRuntime,
  updateLocalAgentPolicy,
} from "../local-acp-runtime-service.js";

const router = new Hono();

router.use("*", async (c, next) => {
  if (!config.workspaceReplicationEnabled) return c.json({ code: "not_found", message: "not found" }, 404);
  await next();
});

type JsonRecord = Record<string, unknown>;

const errorResponse = (c: Context, error: unknown) => {
  if (error instanceof LocalAgentServiceError) return c.json({ code: error.code, message: error.message }, error.status as never);
  if (error instanceof ZodError) return c.json({ code: "invalid_request", message: "request body is invalid", issues: error.issues.map((issue) => ({ path: issue.path, code: issue.code })) }, 400);
  return c.json({ code: "local_agent_error", message: error instanceof Error ? error.message : "local agent request failed" }, 500);
};

const actorFromContext = async (c: Context): Promise<LocalAgentActor | Response> => {
  const local = getLocalAgentPrincipal(c);
  if (local) {
    const [device] = await db.select({
      userUuid: localAgentDevices.userUuid,
      credentialVersion: localAgentDevices.credentialVersion,
      status: localAgentDevices.status,
      revokedAt: localAgentDevices.revokedAt,
    }).from(localAgentDevices).where(eq(localAgentDevices.id, local.deviceId)).limit(1);
    if (device?.status !== "active" || device.revokedAt || device.userUuid !== local.userUuid || device.credentialVersion !== local.credentialVersion) {
      return c.json({ code: "device_credential_invalid", message: "device credential is invalid or revoked" }, 401);
    }
    return {
      userUuid: local.userUuid,
      deviceId: local.deviceId,
      credentialVersion: local.credentialVersion,
      principal: "device",
    };
  }
  const user = useAccountPrincipal(c);
  if (user instanceof Response) return user;
  return { userUuid: user.uuid, deviceId: null, principal: "user" };
};

const requireSpacePermission = async (c: Context, actor: LocalAgentActor, spaceId: string, permission: "file.view" | "file.edit" | "member.manage") => {
  const allowed = await hasPermission({ uuid: actor.userUuid }, permission, { spaceId });
  return allowed ? null : authzDenied(c);
};

router.post("/devices", async (c) => {
  const user = useAccountPrincipal(c);
  if (user instanceof Response) return user;
  try {
    const body = await c.req.json<JsonRecord>().catch(() => ({} as JsonRecord));
    return c.json(await enrollLocalAgentDevice(user.uuid, {
      displayName: body.displayName as string,
      platform: body.platform as string,
      daemonVersion: body.daemonVersion as string | null | undefined,
    }), 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.get("/devices", async (c) => {
  const user = useAccountPrincipal(c);
  if (user instanceof Response) return user;
  try {
    return c.json({ devices: await listLocalAgentDevices(user.uuid) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.post("/devices/:deviceId/token", async (c) => {
  const user = useAccountPrincipal(c);
  const deviceId = c.req.param("deviceId");
  if (!requireValidId(deviceId)) return c.json({ code: "invalid_id", message: "device not found" }, 404);
  try {
    const body = await c.req.json<{ refreshToken?: unknown }>().catch(() => ({} as { refreshToken?: unknown }));
    if (typeof body.refreshToken !== "string") return c.json({ code: "invalid_request", message: "refreshToken is required" }, 400);
    const result = await issueLocalAgentToken({ deviceId, userUuid: user instanceof Response ? undefined : user.uuid, refreshToken: body.refreshToken });
    return c.json(result);
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.delete("/devices/:deviceId", async (c) => {
  const user = useAccountPrincipal(c);
  if (user instanceof Response) return user;
  const deviceId = c.req.param("deviceId");
  if (!requireValidId(deviceId)) return c.json({ code: "device_not_found", message: "device not found" }, 404);
  try {
    return c.json({ device: await revokeLocalAgentDevice({ userUuid: user.uuid, deviceId }) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.post("/spaces/:spaceId/runtimes", async (c) => {
  const actor = await actorFromContext(c);
  if (actor instanceof Response) return actor;
  const spaceId = c.req.param("spaceId");
  if (!requireValidId(spaceId)) return c.json({ code: "space_not_found", message: "space not found" }, 404);
  try {
    const body = await c.req.json<JsonRecord>().catch(() => ({} as JsonRecord));
    if (typeof body.replicaId !== "string" || typeof body.provider !== "string") {
      return c.json({ code: "invalid_request", message: "replicaId and provider are required" }, 400);
    }
    return c.json(await registerLocalAcpRuntime({
      actor,
      spaceId,
      deviceId: typeof body.deviceId === "string" ? body.deviceId : undefined,
      replicaId: body.replicaId,
      provider: body.provider,
      displayName: body.displayName as string,
      providerVersion: body.providerVersion as string | undefined,
      adapterVersion: body.adapterVersion as string | undefined,
      capabilities: body.capabilities as Record<string, unknown> | undefined,
      protocolVersion: typeof body.protocolVersion === "number" ? body.protocolVersion : undefined,
    }), 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.get("/spaces/:spaceId/runtimes", async (c) => {
  const actor = await actorFromContext(c);
  if (actor instanceof Response) return actor;
  const spaceId = c.req.param("spaceId");
  if (!requireValidId(spaceId)) return c.json({ code: "space_not_found", message: "space not found" }, 404);
  try {
    return c.json(await listLocalAcpRuntimes({ actor, spaceId }));
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.get("/spaces/:spaceId/runtimes/:runtimeId", async (c) => {
  const actor = await actorFromContext(c);
  if (actor instanceof Response) return actor;
  const spaceId = c.req.param("spaceId");
  const runtimeId = c.req.param("runtimeId");
  if (!requireValidId(spaceId) || !requireValidId(runtimeId)) return c.json({ code: "runtime_not_found", message: "runtime not found" }, 404);
  try {
    return c.json(await getLocalAcpRuntime({ actor, spaceId, runtimeId }));
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.delete("/spaces/:spaceId/runtimes/:runtimeId", async (c) => {
  const actor = await actorFromContext(c);
  if (actor instanceof Response) return actor;
  const spaceId = c.req.param("spaceId");
  const runtimeId = c.req.param("runtimeId");
  if (!requireValidId(spaceId) || !requireValidId(runtimeId)) return c.json({ code: "runtime_not_found", message: "runtime not found" }, 404);
  try {
    return c.json({ runtime: await revokeLocalAcpRuntime({ actor, spaceId, runtimeId }) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.post("/spaces/:spaceId/replicas/attach", async (c) => {
  const actor = await actorFromContext(c);
  if (actor instanceof Response) return actor;
  const spaceId = c.req.param("spaceId");
  if (!requireValidId(spaceId)) return c.json({ code: "space_not_found", message: "space not found" }, 404);
  const permissionError = await requireSpacePermission(c, actor, spaceId, "file.edit");
  if (permissionError) return permissionError;
  try {
    const body = await c.req.json<JsonRecord>().catch(() => ({} as JsonRecord));
    const requestedDeviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    const effectiveActor = actor.deviceId || !requestedDeviceId
      ? actor
      : { ...actor, deviceId: requestedDeviceId };
    const result = await ensureWorkspaceReplica({
      actor: effectiveActor,
      spaceId,
      rootFingerprint: body.rootFingerprint as string,
      displayName: body.displayName as string,
      capabilities: body.capabilities as Record<string, unknown> | undefined,
      protocolVersion: typeof body.protocolVersion === "number" ? body.protocolVersion : undefined,
    });
    if (result.bootstrapCycleId) {
      await enqueueWorkspaceSyncJob({ cycleId: result.bootstrapCycleId, spaceId, replicaId: result.cloudReplica.id }).catch(() => undefined);
    }
    return c.json(result, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.get("/spaces/:spaceId/replicas", async (c) => {
  const actor = await actorFromContext(c);
  if (actor instanceof Response) return actor;
  const spaceId = c.req.param("spaceId");
  if (!requireValidId(spaceId)) return c.json({ code: "space_not_found", message: "space not found" }, 404);
  const permissionError = await requireSpacePermission(c, actor, spaceId, "file.view");
  if (permissionError) return permissionError;
  try {
    const [replication, runtimes] = await Promise.all([
      listWorkspaceReplicaStates({ actor, spaceId }),
      listLocalAcpRuntimes({ actor, spaceId }),
    ]);
    return c.json({ ...replication, runtimes: runtimes.runtimes });
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.get("/spaces/:spaceId/replicas/:replicaId/state", async (c) => {
  const actor = await actorFromContext(c);
  if (actor instanceof Response) return actor;
  const spaceId = c.req.param("spaceId");
  const replicaId = c.req.param("replicaId");
  if (!requireValidId(spaceId) || !requireValidId(replicaId)) return c.json({ code: "replica_not_found", message: "replica not found" }, 404);
  const permissionError = await requireSpacePermission(c, actor, spaceId, "file.view");
  if (permissionError) return permissionError;
  try {
    return c.json(await getWorkspaceReplicaState({ actor, spaceId, replicaId }));
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.post("/spaces/:spaceId/conflicts/:conflictId/resolve", async (c) => {
  const actor = await actorFromContext(c);
  if (actor instanceof Response) return actor;
  const spaceId = c.req.param("spaceId");
  const conflictId = c.req.param("conflictId");
  if (!requireValidId(spaceId) || !requireValidId(conflictId)) return c.json({ code: "conflict_not_found", message: "workspace conflict not found" }, 404);
  const permissionError = await requireSpacePermission(c, actor, spaceId, "file.edit");
  if (permissionError) return permissionError;
  try {
    const body = await c.req.json<{ resolution?: unknown }>();
    if (typeof body.resolution !== "string") return c.json({ code: "resolution_invalid", message: "resolution is required" }, 400);
    return c.json(await resolveWorkspaceConflict({ actor, spaceId, conflictId, resolution: body.resolution }));
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.get("/spaces/:spaceId/conflicts", async (c) => {
  const actor = await actorFromContext(c);
  if (actor instanceof Response) return actor;
  const spaceId = c.req.param("spaceId");
  if (!requireValidId(spaceId)) return c.json({ code: "space_not_found", message: "space not found" }, 404);
  const permissionError = await requireSpacePermission(c, actor, spaceId, "file.view");
  if (permissionError) return permissionError;
  try {
    return c.json({ conflicts: await listWorkspaceConflicts({ actor, spaceId, replicaId: c.req.query("replicaId") ?? null }) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.post("/spaces/:spaceId/replicas/:replicaId/snapshots/prepare", async (c) => {
  const actor = await actorFromContext(c);
  if (actor instanceof Response) return actor;
  const spaceId = c.req.param("spaceId");
  const replicaId = c.req.param("replicaId");
  if (!requireValidId(spaceId) || !requireValidId(replicaId)) return c.json({ code: "replica_not_found", message: "replica not found" }, 404);
  const permissionError = await requireSpacePermission(c, actor, spaceId, "file.edit");
  if (permissionError) return permissionError;
  try {
    return c.json(await prepareWorkspaceSnapshot({
      actor,
      spaceId,
      replicaId,
      value: await c.req.json(),
    }));
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.get("/spaces/:spaceId/replicas/:replicaId/snapshots/:snapshotId", async (c) => {
  const actor = await actorFromContext(c);
  if (actor instanceof Response) return actor;
  const spaceId = c.req.param("spaceId");
  const replicaId = c.req.param("replicaId");
  const snapshotId = c.req.param("snapshotId");
  if (!requireValidId(spaceId) || !requireValidId(replicaId) || !requireValidId(snapshotId)) return c.json({ code: "snapshot_not_found", message: "snapshot not found" }, 404);
  const permissionError = await requireSpacePermission(c, actor, spaceId, "file.view");
  if (permissionError) return permissionError;
  try {
    return c.json(await getWorkspaceSnapshot({ actor, spaceId, replicaId, snapshotId }));
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.post("/spaces/:spaceId/replicas/:replicaId/snapshots/:snapshotId/applied", async (c) => {
  const actor = await actorFromContext(c);
  if (actor instanceof Response) return actor;
  const spaceId = c.req.param("spaceId");
  const replicaId = c.req.param("replicaId");
  const snapshotId = c.req.param("snapshotId");
  if (!requireValidId(spaceId) || !requireValidId(replicaId) || !requireValidId(snapshotId)) return c.json({ code: "snapshot_not_found", message: "snapshot not found" }, 404);
  const permissionError = await requireSpacePermission(c, actor, spaceId, "file.edit");
  if (permissionError) return permissionError;
  try {
    const body = await c.req.json<{ generation?: unknown }>().catch(() => ({} as { generation?: unknown }));
    return c.json(await ackWorkspaceReplicaApplied({ actor, spaceId, replicaId, snapshotId, generation: typeof body.generation === "number" ? body.generation : 0 }));
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.post("/spaces/:spaceId/replicas/:replicaId/snapshots/:snapshotId/commit", async (c) => {
  const actor = await actorFromContext(c);
  if (actor instanceof Response) return actor;
  const spaceId = c.req.param("spaceId");
  const replicaId = c.req.param("replicaId");
  const snapshotId = c.req.param("snapshotId");
  if (!requireValidId(spaceId) || !requireValidId(replicaId) || !requireValidId(snapshotId)) return c.json({ code: "snapshot_not_found", message: "snapshot not found" }, 404);
  const permissionError = await requireSpacePermission(c, actor, spaceId, "file.edit");
  if (permissionError) return permissionError;
  try {
    const result = await commitWorkspaceSnapshot({ actor, spaceId, replicaId, snapshotId });
    if (result.cycleId) {
      await enqueueWorkspaceSyncJob({ cycleId: result.cycleId, spaceId, replicaId }).catch(() => undefined);
    }
    return c.json(result);
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.post("/spaces/:spaceId/leases/acquire", async (c) => {
  const actor = await actorFromContext(c);
  if (actor instanceof Response) return actor;
  const spaceId = c.req.param("spaceId");
  if (!requireValidId(spaceId)) return c.json({ code: "space_not_found", message: "space not found" }, 404);
  const permissionError = await requireSpacePermission(c, actor, spaceId, "file.edit");
  if (permissionError) return permissionError;
  try {
    const body = await c.req.json<JsonRecord>().catch(() => ({} as JsonRecord));
    const holderKind = typeof body.holderKind === "string" ? body.holderKind : "local_agent";
    if (holderKind !== "local_agent") {
      return c.json({ code: "invalid_holder_kind", message: "holderKind is not available on the public local-agent API" }, 400);
    }
    return c.json(await acquireWorkspaceWriterLease({
      actor,
      spaceId,
      holderKind,
      holderId: body.holderId as string,
      replicaId: typeof body.replicaId === "string" ? body.replicaId : null,
      baseSnapshotId: body.baseSnapshotId as string | null | undefined,
      durationSeconds: typeof body.durationSeconds === "number" ? body.durationSeconds : undefined,
    }));
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.post("/spaces/:spaceId/leases/heartbeat", async (c) => {
  const actor = await actorFromContext(c);
  if (actor instanceof Response) return actor;
  const spaceId = c.req.param("spaceId");
  if (!requireValidId(spaceId)) return c.json({ code: "space_not_found", message: "space not found" }, 404);
  try {
    const body = await c.req.json<JsonRecord>();
    if (body.holderKind !== "local_agent") return c.json({ code: "invalid_holder_kind", message: "holderKind is not available on the public local-agent API" }, 400);
    return c.json(await heartbeatWorkspaceWriterLease({
      actor,
      spaceId,
      holderKind: body.holderKind,
      holderId: body.holderId as string,
      epoch: body.epoch as number,
      durationSeconds: body.durationSeconds as number | undefined,
    }));
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.post("/spaces/:spaceId/leases/release", async (c) => {
  const actor = await actorFromContext(c);
  if (actor instanceof Response) return actor;
  const spaceId = c.req.param("spaceId");
  if (!requireValidId(spaceId)) return c.json({ code: "space_not_found", message: "space not found" }, 404);
  try {
    const body = await c.req.json<JsonRecord>();
    if (body.holderKind !== "local_agent") return c.json({ code: "invalid_holder_kind", message: "holderKind is not available on the public local-agent API" }, 400);
    return c.json(await releaseWorkspaceWriterLease({
      actor,
      spaceId,
      holderKind: body.holderKind,
      holderId: body.holderId as string,
      epoch: body.epoch as number,
    }));
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.post("/spaces/:spaceId/replicas/:replicaId/attempts/:attemptId/register", async (c) => {
  const actor = await actorFromContext(c);
  if (actor instanceof Response) return actor;
  const spaceId = c.req.param("spaceId");
  const replicaId = c.req.param("replicaId");
  const attemptId = c.req.param("attemptId");
  if (!requireValidId(spaceId) || !requireValidId(replicaId) || !requireValidId(attemptId)) return c.json({ code: "attempt_not_found", message: "execution attempt not found" }, 404);
  if (actor.principal !== "device") return c.json({ code: "device_required", message: "a local device credential is required" }, 401);
  const permissionError = await requireSpacePermission(c, actor, spaceId, "file.edit");
  if (permissionError) return permissionError;
  try {
    const body = await c.req.json<JsonRecord>();
    return c.json(await registerLocalWorkspaceAttempt({
      actor,
      spaceId,
      replicaId,
      attemptId,
      leaseEpoch: body.leaseEpoch as number,
      baseSnapshotId: typeof body.baseSnapshotId === "string" ? body.baseSnapshotId : null,
      workspacePolicyVersion: body.workspacePolicyVersion as number,
      integrationPolicyVersion: body.integrationPolicyVersion as number,
    }));
  } catch (error) {
    return errorResponse(c, error);
  }
});

router.patch("/spaces/:spaceId/devices/:deviceId/policy", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("spaceId");
  const deviceId = c.req.param("deviceId");
  if (!requireValidId(spaceId) || !requireValidId(deviceId)) return c.json({ code: "invalid_id", message: "invalid id" }, 400);
  const [deviceOwner] = await db.select({ userUuid: localAgentDevices.userUuid }).from(localAgentDevices).where(eq(localAgentDevices.id, deviceId)).limit(1);
  const permission = deviceOwner?.userUuid === user.uuid ? "file.edit" : "member.manage";
  if (!(await hasPermission(user, permission, { spaceId }))) return authzDenied(c);
  try {
    const body = await c.req.json<JsonRecord>();
    const allowedKeys = new Set(["workspaceMode"]);
    if (Object.keys(body).some((key) => !allowedKeys.has(key))) return c.json({ code: "invalid_request", message: "unknown policy field" }, 400);
    const [row] = await db.select().from(spaceLocalAgentPolicies).where(and(
      eq(spaceLocalAgentPolicies.spaceId, spaceId),
      eq(spaceLocalAgentPolicies.deviceId, deviceId),
    )).limit(1);
    if (!row) return c.json({ code: "policy_not_found", message: "local agent policy not found" }, 404);
    const candidate = LocalAgentPolicySchema.safeParse({
      version: 1,
      workspaceMode: body.workspaceMode ?? row.workspaceMode,
    });
    if (!candidate.success) return c.json({ code: "invalid_policy", message: "policy values are invalid" }, 400);
    if (candidate.data.workspaceMode === row.workspaceMode) return c.json({ policy: row });
    // Fence connected runtimes and bump the policy version in one transaction
    // so a runtime cannot reconnect under the old policy between the two steps.
    const updated = await updateLocalAgentPolicy({
      spaceId,
      deviceId,
      expectedVersion: row.integrationPolicyVersion,
      workspaceMode: candidate.data.workspaceMode,
      updatedBy: user.uuid,
      fenceMessage: "workspace policy changed; runtime must reconnect",
    });
    if (!updated) return c.json({ code: "policy_changed", message: "local agent policy changed; reload and retry" }, 409);
    return c.json({ policy: updated });
  } catch (error) {
    return errorResponse(c, error);
  }
});

export default router;
