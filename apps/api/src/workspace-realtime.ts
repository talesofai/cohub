import { randomUUID } from "node:crypto";
import { getRealtimeSpaceRoom, type WorkspaceStateUpdatedEvent } from "@cohub/protocol/realtime";
import { dispatchRealtimeEvent } from "./channels.js";

export type WorkspaceRealtimeState = WorkspaceStateUpdatedEvent["payload"]["workspace"];
export type WorkspaceRealtimeLease = NonNullable<WorkspaceStateUpdatedEvent["payload"]["lease"]>;

export async function dispatchWorkspaceStateUpdated(input: {
  spaceId: string;
  workspace: WorkspaceRealtimeState;
  replica?: WorkspaceStateUpdatedEvent["payload"]["replica"] | Record<string, unknown> | null;
  openConflictCount?: number;
  lease?: WorkspaceRealtimeLease | null;
  reason?: string | null;
}) {
  const sourceReplica = input.replica && typeof input.replica === "object" ? input.replica as Record<string, unknown> : null;
  const replicaKind = sourceReplica?.kind === "cloud" || sourceReplica?.kind === "local" ? sourceReplica.kind : null;
  const replica: WorkspaceStateUpdatedEvent["payload"]["replica"] = sourceReplica && typeof sourceReplica.id === "string" && replicaKind
    ? {
        id: sourceReplica.id,
        kind: replicaKind as "cloud" | "local",
        status: typeof sourceReplica.status === "string" ? sourceReplica.status : "unknown",
        currentSnapshotId: typeof sourceReplica.currentSnapshotId === "string" ? sourceReplica.currentSnapshotId : null,
        appliedSnapshotId: typeof sourceReplica.appliedSnapshotId === "string" ? sourceReplica.appliedSnapshotId : null,
        lastCommonSnapshotId: typeof sourceReplica.lastCommonSnapshotId === "string" ? sourceReplica.lastCommonSnapshotId : null,
        updatedAt: typeof sourceReplica.updatedAt === "string" ? sourceReplica.updatedAt : new Date().toISOString(),
      }
    : null;
  const workspace = {
    canonicalSnapshotId: input.workspace.canonicalSnapshotId,
    cloudAppliedSnapshotId: input.workspace.cloudAppliedSnapshotId,
    generation: input.workspace.generation,
    status: input.workspace.status,
    activeCycleId: input.workspace.activeCycleId,
    lastWriterKind: input.workspace.lastWriterKind,
    updatedAt: input.workspace.updatedAt,
  };
  const lease = input.lease
    ? {
        holderKind: input.lease.holderKind,
        epoch: input.lease.epoch,
        baseSnapshotId: input.lease.baseSnapshotId,
        expiresAt: input.lease.expiresAt,
        lastHeartbeatAt: input.lease.lastHeartbeatAt,
        updatedAt: input.lease.updatedAt,
      }
    : null;
  const event: WorkspaceStateUpdatedEvent = {
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "workspace",
    type: "workspace.state.updated",
    spaceId: input.spaceId,
    sessionId: null,
    rooms: [getRealtimeSpaceRoom(input.spaceId)],
    payload: {
      workspace,
      replica,
      ...(input.openConflictCount === undefined ? {} : { openConflictCount: input.openConflictCount }),
      lease,
      reason: input.reason ?? null,
    },
  };
  await dispatchRealtimeEvent(event);
}
