import { createHash } from "node:crypto";
import { and, eq, gt, ne } from "drizzle-orm";
import { spaceLocalAgentPolicies, workspaceReplicas, workspaceState, workspaceSyncCycles, workspaceWriterLeases } from "@cohub/db";
import { db } from "./db.js";
import { logger } from "./logger.js";

export type AgentWorkspaceLeaseRef = {
  holderKind: "cloud_file_api" | "cloud_command" | "cloud_agent";
  holderId: string;
  epoch: number;
};

export async function assertActiveWorkspaceLease(spaceId: string, lease: AgentWorkspaceLeaseRef) {
  const [row] = await db.select({ epoch: workspaceWriterLeases.epoch }).from(workspaceWriterLeases).where(and(
    eq(workspaceWriterLeases.spaceId, spaceId),
    eq(workspaceWriterLeases.holderKind, lease.holderKind),
    eq(workspaceWriterLeases.holderId, lease.holderId),
    eq(workspaceWriterLeases.epoch, lease.epoch),
    gt(workspaceWriterLeases.expiresAt, new Date()),
  )).limit(1);
  if (!row) throw new Error("workspace_lease_lost");
}

/**
 * Keep a short API-owned lease alive while a queued filesystem operation runs.
 * The callback receives an abort signal so long shell uploads stop when the
 * lease is replaced. A final check closes the race between the last heartbeat
 * and the operation's completion.
 */
export async function withAgentWorkspaceLease<T>(input: {
  spaceId: string;
  lease: AgentWorkspaceLeaseRef | null | undefined;
  run: (signal: AbortSignal) => Promise<T>;
  abortSignal?: AbortSignal;
}): Promise<T> {
  if (!input.lease) return input.run(input.abortSignal ?? new AbortController().signal);
  await assertActiveWorkspaceLease(input.spaceId, input.lease);
  const abortController = new AbortController();
  const forwardAbort = () => abortController.abort();
  if (input.abortSignal) {
    if (input.abortSignal.aborted) abortController.abort();
    else input.abortSignal.addEventListener("abort", forwardAbort, { once: true });
  }
  let stopped = false;
  let heartbeatError: Error | null = null;
  let heartbeatInFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const heartbeat = async () => {
    const current = new Date();
    const [row] = await db.update(workspaceWriterLeases).set({
      expiresAt: new Date(current.getTime() + 30_000),
      lastHeartbeatAt: current,
      updatedAt: current,
    }).where(and(
      eq(workspaceWriterLeases.spaceId, input.spaceId),
      eq(workspaceWriterLeases.holderKind, input.lease?.holderKind ?? "cloud_file_api"),
      eq(workspaceWriterLeases.holderId, input.lease?.holderId ?? ""),
      eq(workspaceWriterLeases.epoch, input.lease?.epoch ?? 0),
      gt(workspaceWriterLeases.expiresAt, current),
    )).returning({ epoch: workspaceWriterLeases.epoch });
    if (!row) throw new Error("workspace_lease_lost");
  };
  const runHeartbeat = () => {
    if (stopped || heartbeatInFlight) return;
    const pending = heartbeat().catch((error) => {
      heartbeatError = error instanceof Error ? error : new Error(String(error));
      stopped = true;
      if (timer) clearInterval(timer);
      abortController.abort();
      logger.warn("[WorkspaceLease] operation lease heartbeat failed", { spaceId: input.spaceId, lease: input.lease, error });
    }).finally(() => {
      if (heartbeatInFlight === pending) heartbeatInFlight = null;
    });
    heartbeatInFlight = pending;
  };
  timer = setInterval(runHeartbeat, 10_000);
  timer.unref();
  let result: T | undefined;
  let operationError: unknown = null;
  try {
    result = await input.run(abortController.signal);
    if (heartbeatError) throw heartbeatError;
    await assertActiveWorkspaceLease(input.spaceId, input.lease);
  } catch (error) {
    operationError = error;
  } finally {
    stopped = true;
    if (timer) clearInterval(timer);
    const pendingHeartbeat = heartbeatInFlight;
    if (pendingHeartbeat) await pendingHeartbeat;
    if (!operationError && heartbeatError) operationError = heartbeatError;
    input.abortSignal?.removeEventListener("abort", forwardAbort);
  }
  if (operationError) throw operationError;
  return result as T;
}

const commandLeaseUuid = (spaceId: string, holderId: string) => {
  const bytes = createHash("sha256").update(`cohub-cloud-command-v1\0${spaceId}\0${holderId}`).digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

export async function acquireCloudCommandLease(input: { spaceId: string; holderId: string; userUuid?: string | null }): Promise<AgentWorkspaceLeaseRef | null> {
  return db.transaction(async (tx) => {
    const [workspace] = await tx.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).for("update").limit(1);
    if (!workspace) return null;
    if (workspace.status !== "ready" || !workspace.canonicalSnapshotId || workspace.cloudAppliedSnapshotId !== workspace.canonicalSnapshotId) {
      throw new Error("workspace_not_ready");
    }
    const [cloudReplica] = await tx.select({ id: workspaceReplicas.id }).from(workspaceReplicas).where(and(
      eq(workspaceReplicas.spaceId, input.spaceId),
      eq(workspaceReplicas.kind, "cloud"),
    )).limit(1);
    if (!cloudReplica) throw new Error("workspace_cloud_replica_unavailable");
    const [localAuthoritative] = await tx.select({ id: spaceLocalAgentPolicies.id }).from(spaceLocalAgentPolicies).innerJoin(workspaceReplicas, and(
      eq(workspaceReplicas.spaceId, spaceLocalAgentPolicies.spaceId),
      eq(workspaceReplicas.deviceId, spaceLocalAgentPolicies.deviceId),
      eq(workspaceReplicas.kind, "local"),
      ne(workspaceReplicas.status, "detached"),
    )).where(and(
      eq(spaceLocalAgentPolicies.spaceId, input.spaceId),
      eq(spaceLocalAgentPolicies.workspaceMode, "one_way_to_cloud"),
    )).limit(1);
    if (localAuthoritative) throw new Error("cloud_workspace_write_disabled");
    const [existing] = await tx.select().from(workspaceWriterLeases).where(eq(workspaceWriterLeases.spaceId, input.spaceId)).for("update").limit(1);
    const now = new Date();
    const sameActive = existing?.holderKind === "cloud_command" && existing.holderId === input.holderId && existing.expiresAt > now;
    if (existing && existing.expiresAt > now && !sameActive) throw new Error("workspace_writer_active");
    const epoch = (existing?.epoch ?? 0) + (sameActive ? 0 : 1);
    const [lease] = await tx.insert(workspaceWriterLeases).values({
      spaceId: input.spaceId,
      holderKind: "cloud_command",
      holderId: input.holderId,
      holderUserUuid: input.userUuid ?? null,
      epoch,
      baseSnapshotId: workspace.canonicalSnapshotId,
      expiresAt: new Date(now.getTime() + 30_000),
      lastHeartbeatAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: workspaceWriterLeases.spaceId,
      set: {
        holderKind: "cloud_command",
        holderId: input.holderId,
        holderUserUuid: input.userUuid ?? null,
        epoch,
        baseSnapshotId: workspace.canonicalSnapshotId,
        expiresAt: new Date(now.getTime() + 30_000),
        lastHeartbeatAt: now,
        updatedAt: now,
      },
    }).returning();
    if (!lease) throw new Error("workspace_lease_failed");
    const cycleId = commandLeaseUuid(input.spaceId, input.holderId);
    const [cycle] = await tx.insert(workspaceSyncCycles).values({
      id: cycleId,
      spaceId: input.spaceId,
      replicaId: cloudReplica.id,
      baseSnapshotId: workspace.canonicalSnapshotId,
      direction: "reconcile",
      canonicalGenerationAtStart: workspace.generation,
      leaseEpoch: lease.epoch,
      status: "applying_cloud",
    }).onConflictDoNothing().returning({ id: workspaceSyncCycles.id });
    if (!cycle) throw new Error("workspace_command_cycle_unavailable");
    await tx.update(workspaceState).set({ status: "syncing", activeCycleId: cycleId, updatedAt: now }).where(eq(workspaceState.spaceId, input.spaceId));
    return { holderKind: "cloud_command", holderId: input.holderId, epoch: lease.epoch };
  });
}

export async function completeCloudCommandLease(input: { spaceId: string; lease: AgentWorkspaceLeaseRef }) {
  return db.transaction(async (tx) => {
    const [workspace] = await tx.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).for("update").limit(1);
    const [cloudReplica] = await tx.select({ id: workspaceReplicas.id }).from(workspaceReplicas).where(and(eq(workspaceReplicas.spaceId, input.spaceId), eq(workspaceReplicas.kind, "cloud"))).limit(1);
    if (!workspace || !cloudReplica) return null;
    const cycleId = commandLeaseUuid(input.spaceId, input.lease.holderId);
    const [activeLease] = await tx.select().from(workspaceWriterLeases).where(and(
      eq(workspaceWriterLeases.spaceId, input.spaceId),
      eq(workspaceWriterLeases.holderKind, input.lease.holderKind),
      eq(workspaceWriterLeases.holderId, input.lease.holderId),
      eq(workspaceWriterLeases.epoch, input.lease.epoch),
      gt(workspaceWriterLeases.expiresAt, new Date()),
    )).for("update").limit(1);
    if (!activeLease) throw new Error("workspace_lease_lost");
    const [cycle] = await tx.select({ status: workspaceSyncCycles.status }).from(workspaceSyncCycles).where(and(
      eq(workspaceSyncCycles.id, cycleId),
      eq(workspaceSyncCycles.spaceId, input.spaceId),
      eq(workspaceSyncCycles.replicaId, cloudReplica.id),
    )).for("update").limit(1);
    if (!cycle) throw new Error("workspace_command_cycle_unavailable");
    if (!["completed", "conflicted", "failed", "cancelled"].includes(cycle.status)) {
      await tx.update(workspaceSyncCycles).set({ status: "planned", updatedAt: new Date() }).where(eq(workspaceSyncCycles.id, cycleId));
      await tx.update(workspaceState).set({ status: "syncing", activeCycleId: cycleId, updatedAt: new Date() }).where(eq(workspaceState.spaceId, input.spaceId));
    }
    await tx.update(workspaceWriterLeases).set({ expiresAt: new Date(), lastHeartbeatAt: new Date(), updatedAt: new Date() }).where(and(
      eq(workspaceWriterLeases.spaceId, input.spaceId),
      eq(workspaceWriterLeases.holderKind, input.lease.holderKind),
      eq(workspaceWriterLeases.holderId, input.lease.holderId),
      eq(workspaceWriterLeases.epoch, input.lease.epoch),
    ));
    return cycleId;
  });
}
