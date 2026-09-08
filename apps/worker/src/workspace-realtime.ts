import { randomUUID } from "node:crypto";
import { count, eq, and } from "drizzle-orm";
import { workspaceReplicas, workspaceState, workspaceSyncConflicts, workspaceWriterLeases } from "@cohub/db";
import { getRealtimeSpaceRoom, REALTIME_OUTBOUND_CHANNEL, type RealtimeEnvelope } from "@cohub/protocol/realtime";
import { db } from "./db.js";
import { redisCommandClient } from "./redis.js";

const toWorkspace = (row: typeof workspaceState.$inferSelect) => ({
  canonicalSnapshotId: row.canonicalSnapshotId,
  cloudAppliedSnapshotId: row.cloudAppliedSnapshotId,
  generation: row.generation,
  status: row.status,
  activeCycleId: row.activeCycleId,
  lastWriterKind: row.lastWriterKind,
  updatedAt: row.updatedAt.toISOString(),
});

const toReplica = (row: typeof workspaceReplicas.$inferSelect) => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  currentSnapshotId: row.currentSnapshotId,
  appliedSnapshotId: row.appliedSnapshotId,
  lastCommonSnapshotId: row.lastCommonSnapshotId,
  updatedAt: row.updatedAt.toISOString(),
});

export async function publishWorkspaceStateUpdated(input: {
  spaceId: string;
  replicaId?: string | null;
  reason?: string | null;
}) {
  const [state] = await db.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).limit(1);
  if (!state) return;
  const replica = input.replicaId
    ? (await db.select().from(workspaceReplicas).where(and(eq(workspaceReplicas.id, input.replicaId), eq(workspaceReplicas.spaceId, input.spaceId))).limit(1))[0] ?? null
    : null;
  const [conflictCount] = await db.select({ count: count() }).from(workspaceSyncConflicts).where(and(
    eq(workspaceSyncConflicts.spaceId, input.spaceId),
    eq(workspaceSyncConflicts.status, "open"),
  ));
  const [lease] = await db.select().from(workspaceWriterLeases).where(eq(workspaceWriterLeases.spaceId, input.spaceId)).limit(1);
  const envelope: RealtimeEnvelope = {
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "workspace",
    type: "workspace.state.updated",
    spaceId: input.spaceId,
    sessionId: null,
    rooms: [getRealtimeSpaceRoom(input.spaceId)],
    payload: {
      workspace: toWorkspace(state),
      replica: replica ? toReplica(replica) : null,
      openConflictCount: Number(conflictCount?.count ?? 0),
      lease: lease ? {
        holderKind: lease.holderKind,
        epoch: lease.epoch,
        baseSnapshotId: lease.baseSnapshotId,
        expiresAt: lease.expiresAt.toISOString(),
        lastHeartbeatAt: lease.lastHeartbeatAt.toISOString(),
        updatedAt: lease.updatedAt.toISOString(),
      } : null,
      reason: input.reason ?? null,
    },
  };
  await redisCommandClient.publish(REALTIME_OUTBOUND_CHANNEL, JSON.stringify(envelope));
}
