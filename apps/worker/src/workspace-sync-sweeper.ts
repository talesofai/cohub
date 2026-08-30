import { and, asc, eq, inArray, isNotNull, lt, notExists, sql } from "drizzle-orm";
import { workspaceExecutionAttempts, workspaceReplicas, workspaceSnapshots, workspaceState, workspaceSyncCycles } from "@cohub/db";
import { COHUB_WORKSPACE_SYNC_QUEUE, createBullmqQueue, defaultCriticalJobOptions } from "@cohub/infra/bullmq";
import { config } from "./config.js";
import { db } from "./db.js";

const queue = createBullmqQueue(COHUB_WORKSPACE_SYNC_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-worker-workspace-sweeper",
});

const STALE_WORKSPACE_CYCLE_MS = Number(process.env.WORKSPACE_SYNC_STALE_CYCLE_MS ?? 60 * 60 * 1000);

export async function sweepWorkspaceSyncWork() {
  // Recover local attempts whose bounded online lease disappeared. A prepared
  // attempt never reached provider preflight and can be aborted. A running
  // attempt may still own an unfenced local process, so retain it as recovery
  // work and require explicit takeover.
  await db.execute(sql`
    update v2.workspace_execution_attempts attempt
    set status = case when attempt.status = 'prepared' then 'aborted' else 'awaiting_recovery' end,
        error_code = case when attempt.status = 'prepared' then 'permit_expired_before_start' else 'local_lease_expired' end,
        completed_at = case when attempt.status = 'prepared' then now() else attempt.completed_at end,
        updated_at = now()
    where attempt.executor_kind = 'local_native'
      and attempt.status in ('prepared', 'running')
      and attempt.updated_at < now() - interval '60 seconds'
      and not exists (
        select 1 from v2.workspace_writer_leases lease
        where lease.space_id = attempt.space_id
          and lease.epoch = attempt.workspace_lease_epoch
          and lease.expires_at > now()
          and (
            (lease.holder_kind = 'local_agent' and lease.holder_id = attempt.id::text)
            or lease.holder_kind = 'local_offline_reservation'
          )
      )
  `);
  await db.execute(sql`
    update v2.workspace_writer_leases lease
    set takeover_requires_confirmation = true, updated_at = now()
    where lease.holder_kind in ('local_agent', 'local_offline_reservation')
      and lease.expires_at <= now()
      and exists (
        select 1 from v2.workspace_execution_attempts attempt
        where attempt.space_id = lease.space_id
          and attempt.status = 'awaiting_recovery'
      )
  `);
  await db.execute(sql`
    update v2.workspace_state state
    set active_execution_attempt_id = null, updated_at = now()
    where state.active_execution_attempt_id is not null
      and exists (
        select 1 from v2.workspace_execution_attempts attempt
        where attempt.id = state.active_execution_attempt_id and attempt.status = 'aborted'
      )
  `);
  await db.execute(sql`
    update v2.workspace_replicas replica
    set active_execution_attempt_id = null, updated_at = now()
    where replica.active_execution_attempt_id is not null
      and exists (
        select 1 from v2.workspace_execution_attempts attempt
        where attempt.id = replica.active_execution_attempt_id and attempt.status = 'aborted'
      )
  `);

  const staleBefore = new Date(Date.now() - Math.max(5 * 60 * 1000, STALE_WORKSPACE_CYCLE_MS));
  // A worker can die after changing a cycle out of `planned` and before the
  // next queue delivery. Reopen only old cycles; large active transfers keep a
  // much longer window and are refreshed at each phase boundary.
  await db.update(workspaceSyncCycles).set({
    status: "planned",
    errorCode: "worker_recovery_retry",
    errorMessage: "Workspace sync worker stopped before completion; retrying the durable cycle.",
    updatedAt: new Date(),
  }).where(and(
    inArray(workspaceSyncCycles.status, ["transferring", "applying_cloud", "applying_local", "verifying"]),
    lt(workspaceSyncCycles.updatedAt, staleBefore),
  ));

  const orphanCandidates = await db.select({
    spaceId: workspaceReplicas.spaceId,
    replicaId: workspaceReplicas.id,
    snapshotId: workspaceReplicas.currentSnapshotId,
  }).from(workspaceReplicas)
    .innerJoin(workspaceSnapshots, eq(workspaceSnapshots.id, workspaceReplicas.currentSnapshotId))
    .where(and(
      eq(workspaceReplicas.kind, "local"),
      eq(workspaceReplicas.status, "syncing"),
      isNotNull(workspaceReplicas.currentSnapshotId),
      eq(workspaceSnapshots.replicaId, workspaceReplicas.id),
      eq(workspaceSnapshots.status, "ready"),
      notExists(db.select({ id: workspaceSyncCycles.id }).from(workspaceSyncCycles).where(eq(workspaceSyncCycles.localSnapshotId, workspaceReplicas.currentSnapshotId))),
    ))
    .orderBy(asc(workspaceReplicas.updatedAt))
    .limit(50);

  for (const candidate of orphanCandidates) {
    if (!candidate.snapshotId) continue;
    await db.insert(workspaceSyncCycles).values({
      spaceId: candidate.spaceId,
      replicaId: candidate.replicaId,
      localSnapshotId: candidate.snapshotId,
      direction: "reconcile",
      status: "planned",
      canonicalGenerationAtStart: 0,
    }).onConflictDoNothing();
  }

  const recoverableAttempts = await db.select({
    attemptId: workspaceExecutionAttempts.id,
    spaceId: workspaceExecutionAttempts.spaceId,
    baseSnapshotId: workspaceExecutionAttempts.baseCanonicalSnapshotId,
    generation: workspaceState.generation,
    replicaId: workspaceReplicas.id,
  }).from(workspaceExecutionAttempts)
    .innerJoin(workspaceState, eq(workspaceState.spaceId, workspaceExecutionAttempts.spaceId))
    .innerJoin(workspaceReplicas, and(eq(workspaceReplicas.spaceId, workspaceExecutionAttempts.spaceId), eq(workspaceReplicas.kind, "cloud")))
    .where(and(
      eq(workspaceExecutionAttempts.executorKind, "cloud_agent"),
      eq(workspaceExecutionAttempts.status, "awaiting_recovery"),
      notExists(db.select({ id: workspaceSyncCycles.id }).from(workspaceSyncCycles).where(eq(workspaceSyncCycles.executionAttemptId, workspaceExecutionAttempts.id))),
    ))
    .orderBy(asc(workspaceExecutionAttempts.updatedAt))
    .limit(50);
  for (const attempt of recoverableAttempts) {
    const [cycle] = await db.insert(workspaceSyncCycles).values({
      spaceId: attempt.spaceId,
      replicaId: attempt.replicaId,
      baseSnapshotId: attempt.baseSnapshotId,
      executionAttemptId: attempt.attemptId,
      direction: "reconcile",
      canonicalGenerationAtStart: attempt.generation,
      status: "planned",
    }).onConflictDoNothing().returning({ id: workspaceSyncCycles.id });
    if (cycle) {
      await db.update(workspaceExecutionAttempts).set({ workspaceCycleId: cycle.id, status: "transcript_sealed", updatedAt: new Date() }).where(and(eq(workspaceExecutionAttempts.id, attempt.attemptId), eq(workspaceExecutionAttempts.status, "awaiting_recovery")));
    }
  }

  const cycles = await db.select({
    id: workspaceSyncCycles.id,
    spaceId: workspaceSyncCycles.spaceId,
    replicaId: workspaceSyncCycles.replicaId,
  }).from(workspaceSyncCycles)
    .where(inArray(workspaceSyncCycles.status, ["planned"]))
    .orderBy(asc(workspaceSyncCycles.createdAt))
    .limit(100);

  for (const cycle of cycles) {
    await queue.add("workspace_sync", {
      cycleId: cycle.id,
      spaceId: cycle.spaceId,
      replicaId: cycle.replicaId,
    }, {
      jobId: `workspace-sync-${cycle.id}`,
      ...defaultCriticalJobOptions,
    });
  }
  return { enqueued: cycles.length, recovered: orphanCandidates.length + recoverableAttempts.length };
}

export async function closeWorkspaceSyncSweeper() {
  await queue.close();
}
