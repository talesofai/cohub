import { createHash } from "node:crypto";
import { and, eq, gt, ne } from "drizzle-orm";
import { spaceLocalAgentPolicies, spaceSandboxes, workspaceReplicas, workspaceState, workspaceSyncCycles, workspaceWriterLeases } from "@cohub/db";
import { db } from "./db/index.js";

export class WorkspaceWriterLeaseError extends Error {
  override name = "WorkspaceWriterLeaseError";
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 409,
  ) {
    super(message);
  }
}

export type WorkspaceMutationLease = {
  holderKind: "cloud_file_api";
  holderId: string;
  epoch: number;
  baseSnapshotId: string;
  expiresAt: string;
};

/**
 * Acquire the short user-owned lease used by direct cloud filesystem writes.
 * A missing workspace_state is the legacy, non-replicated Space shape and is
 * intentionally left unchanged. Once replication is initialized, every cloud
 * mutation must pass this gate before touching the workspace tree.
 */
export async function ensureCloudFileWriterLease(input: { spaceId: string; userUuid: string }): Promise<WorkspaceMutationLease | null> {
  const holderId = `user:${input.userUuid}`;
  const lease = await db.transaction(async (tx) => {
    const [sandbox] = await tx.select({ provider: spaceSandboxes.provider }).from(spaceSandboxes).where(eq(spaceSandboxes.spaceId, input.spaceId)).limit(1);
    if (sandbox?.provider === "local") return null;
    const [workspace] = await tx.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).for("update").limit(1);
    if (!workspace) return null;
    if (workspace.status !== "ready" || !workspace.canonicalSnapshotId || workspace.cloudAppliedSnapshotId !== workspace.canonicalSnapshotId) {
      throw new WorkspaceWriterLeaseError("workspace is not ready for a cloud file mutation", "workspace_not_ready");
    }
    const [localAuthoritative] = await tx.select({ id: spaceLocalAgentPolicies.id }).from(spaceLocalAgentPolicies).innerJoin(workspaceReplicas, and(
      eq(workspaceReplicas.spaceId, spaceLocalAgentPolicies.spaceId),
      eq(workspaceReplicas.deviceId, spaceLocalAgentPolicies.deviceId),
      eq(workspaceReplicas.kind, "local"),
      ne(workspaceReplicas.status, "detached"),
    )).where(and(
      eq(spaceLocalAgentPolicies.spaceId, input.spaceId),
      eq(spaceLocalAgentPolicies.workspaceMode, "one_way_to_cloud"),
    )).limit(1);
    if (localAuthoritative) throw new WorkspaceWriterLeaseError("cloud workspace writes are disabled by replica policy", "workspace_write_disabled", 403);
    const [existing] = await tx.select().from(workspaceWriterLeases).where(eq(workspaceWriterLeases.spaceId, input.spaceId)).for("update").limit(1);
    const current = new Date();
    if (existing && existing.expiresAt > current) {
      throw new WorkspaceWriterLeaseError("workspace is currently in use by another writer", "workspace_lease_busy");
    }
    const epoch = (existing?.epoch ?? 0) + 1;
    const expiresAt = new Date(current.getTime() + 30_000);
    const [updated] = await tx.insert(workspaceWriterLeases).values({
      spaceId: input.spaceId,
      holderKind: "cloud_file_api",
      holderId,
      holderUserUuid: input.userUuid,
      epoch,
      baseSnapshotId: workspace.canonicalSnapshotId,
      expiresAt,
      lastHeartbeatAt: current,
      maximumDurationAt: null,
      takeoverRequiresConfirmation: false,
      updatedAt: current,
    }).onConflictDoUpdate({
      target: workspaceWriterLeases.spaceId,
      set: {
        holderKind: "cloud_file_api",
        holderId,
        holderUserUuid: input.userUuid,
        epoch,
        baseSnapshotId: workspace.canonicalSnapshotId,
        expiresAt,
        lastHeartbeatAt: current,
        maximumDurationAt: null,
        takeoverRequiresConfirmation: false,
        updatedAt: current,
      },
    }).returning();
    if (!updated) throw new WorkspaceWriterLeaseError("failed to acquire the workspace writer lease", "workspace_lease_failed", 500);
    return updated;
  });
  if (!lease) return null;
  return {
    holderKind: "cloud_file_api",
    holderId: lease.holderId,
    epoch: lease.epoch,
    baseSnapshotId: lease.baseSnapshotId ?? "",
    expiresAt: lease.expiresAt.toISOString(),
  };
}

const deterministicUuid = (domain: string, value: string) => {
  const bytes = createHash("sha256").update(`cohub-${domain}-v1\0${value}`).digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

export async function beginCloudFileMutation(input: {
  spaceId: string;
  lease: WorkspaceMutationLease;
  operationKey: string;
}) {
  return db.transaction(async (tx) => {
    const [activeLease] = await tx.select().from(workspaceWriterLeases).where(and(
      eq(workspaceWriterLeases.spaceId, input.spaceId),
      eq(workspaceWriterLeases.holderKind, input.lease.holderKind),
      eq(workspaceWriterLeases.holderId, input.lease.holderId),
      eq(workspaceWriterLeases.epoch, input.lease.epoch),
      gt(workspaceWriterLeases.expiresAt, new Date()),
    )).for("update").limit(1);
    if (!activeLease) throw new WorkspaceWriterLeaseError("workspace writer lease was lost", "workspace_lease_lost");
    const [workspace] = await tx.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).for("update").limit(1);
    const [cloudReplica] = await tx.select({ id: workspaceReplicas.id }).from(workspaceReplicas).where(and(
      eq(workspaceReplicas.spaceId, input.spaceId),
      eq(workspaceReplicas.kind, "cloud"),
    )).limit(1);
    if (!workspace || !cloudReplica) throw new WorkspaceWriterLeaseError("workspace replication state is unavailable", "workspace_state_unavailable");
    const cycleId = deterministicUuid("cloud-file-cycle", `${input.spaceId}\0${input.operationKey}`);
    const [created] = await tx.insert(workspaceSyncCycles).values({
      id: cycleId,
      spaceId: input.spaceId,
      replicaId: cloudReplica.id,
      baseSnapshotId: activeLease.baseSnapshotId ?? workspace.canonicalSnapshotId,
      direction: "reconcile",
      canonicalGenerationAtStart: workspace.generation,
      leaseEpoch: activeLease.epoch,
      status: "applying_cloud",
    }).onConflictDoNothing().returning({ id: workspaceSyncCycles.id });
    if (!created) {
      const [existingCycle] = await tx.select({
        id: workspaceSyncCycles.id,
        spaceId: workspaceSyncCycles.spaceId,
        replicaId: workspaceSyncCycles.replicaId,
        leaseEpoch: workspaceSyncCycles.leaseEpoch,
        status: workspaceSyncCycles.status,
      }).from(workspaceSyncCycles).where(eq(workspaceSyncCycles.id, cycleId)).for("update").limit(1);
      if (
        !existingCycle
        || existingCycle.spaceId !== input.spaceId
        || existingCycle.replicaId !== cloudReplica.id
      ) {
        throw new WorkspaceWriterLeaseError("workspace mutation id was reused for a different operation", "workspace_mutation_conflict");
      }
      return { cycleId: existingCycle.id, replicaId: existingCycle.replicaId, duplicate: true };
    }
    await tx.update(workspaceState).set({ status: "syncing", activeCycleId: cycleId, updatedAt: new Date() }).where(eq(workspaceState.spaceId, input.spaceId));
    return { cycleId: created.id, replicaId: cloudReplica.id, duplicate: false };
  });
}

export async function heartbeatCloudFileWriterLease(input: { spaceId: string; lease: WorkspaceMutationLease }) {
  const current = new Date();
  const [updated] = await db.update(workspaceWriterLeases).set({
    expiresAt: new Date(current.getTime() + 30_000),
    lastHeartbeatAt: current,
    updatedAt: current,
  }).where(and(
    eq(workspaceWriterLeases.spaceId, input.spaceId),
    eq(workspaceWriterLeases.holderKind, input.lease.holderKind),
    eq(workspaceWriterLeases.holderId, input.lease.holderId),
    eq(workspaceWriterLeases.epoch, input.lease.epoch),
    gt(workspaceWriterLeases.expiresAt, current),
  )).returning({ epoch: workspaceWriterLeases.epoch });
  if (!updated) throw new WorkspaceWriterLeaseError("workspace writer lease was lost", "workspace_lease_lost");
}

export async function releaseCloudFileWriterLease(input: { spaceId: string; lease: WorkspaceMutationLease }) {
  const current = new Date();
  await db.update(workspaceWriterLeases).set({
    expiresAt: current,
    lastHeartbeatAt: current,
    updatedAt: current,
  }).where(and(
    eq(workspaceWriterLeases.spaceId, input.spaceId),
    eq(workspaceWriterLeases.holderKind, input.lease.holderKind),
    eq(workspaceWriterLeases.holderId, input.lease.holderId),
    eq(workspaceWriterLeases.epoch, input.lease.epoch),
  ));
}

export async function completeCloudFileMutation(input: {
  spaceId: string;
  lease: WorkspaceMutationLease;
  operationKey: string;
}) {
  return db.transaction(async (tx) => {
    const [activeLease] = await tx.select().from(workspaceWriterLeases).where(and(
      eq(workspaceWriterLeases.spaceId, input.spaceId),
      eq(workspaceWriterLeases.holderKind, input.lease.holderKind),
      eq(workspaceWriterLeases.holderId, input.lease.holderId),
      eq(workspaceWriterLeases.epoch, input.lease.epoch),
      gt(workspaceWriterLeases.expiresAt, new Date()),
    )).for("update").limit(1);
    if (!activeLease) throw new WorkspaceWriterLeaseError("workspace writer lease was replaced before the mutation completed", "workspace_lease_lost");
    const [workspace] = await tx.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).for("update").limit(1);
    const [cloudReplica] = await tx.select({ id: workspaceReplicas.id }).from(workspaceReplicas).where(and(
      eq(workspaceReplicas.spaceId, input.spaceId),
      eq(workspaceReplicas.kind, "cloud"),
    )).limit(1);
    if (!workspace || !cloudReplica) throw new WorkspaceWriterLeaseError("workspace replication state is unavailable", "workspace_state_unavailable");
    const cycleId = deterministicUuid("cloud-file-cycle", `${input.spaceId}\0${input.operationKey}`);
    const [cycle] = await tx.select({ id: workspaceSyncCycles.id, status: workspaceSyncCycles.status }).from(workspaceSyncCycles).where(and(
      eq(workspaceSyncCycles.id, cycleId),
      eq(workspaceSyncCycles.spaceId, input.spaceId),
      eq(workspaceSyncCycles.replicaId, cloudReplica.id),
    )).for("update").limit(1);
    if (!cycle) throw new WorkspaceWriterLeaseError("workspace mutation cycle is unavailable", "workspace_cycle_unavailable", 500);
    if (!["completed", "conflicted", "failed", "cancelled"].includes(cycle.status)) {
      await tx.update(workspaceSyncCycles).set({ status: "planned", updatedAt: new Date() }).where(eq(workspaceSyncCycles.id, cycleId));
      await tx.update(workspaceState).set({ status: "syncing", activeCycleId: cycleId, updatedAt: new Date() }).where(eq(workspaceState.spaceId, input.spaceId));
    }
    await tx.update(workspaceWriterLeases).set({
      expiresAt: new Date(),
      lastHeartbeatAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(workspaceWriterLeases.spaceId, input.spaceId),
      eq(workspaceWriterLeases.holderKind, input.lease.holderKind),
      eq(workspaceWriterLeases.holderId, input.lease.holderId),
      eq(workspaceWriterLeases.epoch, input.lease.epoch),
    ));
    return { cycleId: cycle.id, replicaId: cloudReplica.id };
  });
}

export async function assertWorkspaceMutationLease(input: {
  spaceId: string;
  holderKind: "cloud_file_api" | "cloud_command";
  holderId: string;
  epoch: number;
}) {
  const [lease] = await db.select({
    holderId: workspaceWriterLeases.holderId,
    epoch: workspaceWriterLeases.epoch,
    expiresAt: workspaceWriterLeases.expiresAt,
  }).from(workspaceWriterLeases).where(and(
    eq(workspaceWriterLeases.spaceId, input.spaceId),
    eq(workspaceWriterLeases.holderKind, input.holderKind),
    eq(workspaceWriterLeases.holderId, input.holderId),
    eq(workspaceWriterLeases.epoch, input.epoch),
    gt(workspaceWriterLeases.expiresAt, new Date()),
  )).limit(1);
  if (!lease) throw new WorkspaceWriterLeaseError("workspace writer lease is no longer active", "workspace_lease_lost");
  return lease;
}
