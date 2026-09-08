import { and, asc, desc, eq, inArray, isNotNull, lt, notExists, sql } from "drizzle-orm";
import { workspaceExecutionAttempts, workspaceReplicas, workspaceSnapshots, workspaceState, workspaceSyncCycles } from "@cohub/db";
import { COHUB_WORKSPACE_SYNC_QUEUE, buildWorkspaceSyncJobId, createBullmqQueue, defaultCriticalJobOptions } from "@cohub/infra/bullmq";
import { config } from "./config.js";
import { db } from "./db.js";

const queue = createBullmqQueue(COHUB_WORKSPACE_SYNC_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-worker-workspace-sweeper",
});

const STALE_WORKSPACE_CYCLE_MS = Number(process.env.WORKSPACE_SYNC_STALE_CYCLE_MS ?? 60 * 60 * 1000);

export async function sweepWorkspaceSyncWork() {
  // Recover local runtime attempts whose bounded writer lease disappeared. A
  // prepared attempt never reached the provider and can be aborted. A running
  // attempt may still own an unfenced local process, so retain it as recovery
  // work; the next lease acquisition refuses to take over an unresolved attempt.
  await db.execute(sql`
    update v2.workspace_execution_attempts attempt
    set status = case when attempt.status = 'prepared' then 'aborted' else 'awaiting_recovery' end,
        error_code = case when attempt.status = 'prepared' then 'permit_expired_before_start' else 'local_lease_expired' end,
        completed_at = case when attempt.status = 'prepared' then now() else attempt.completed_at end,
        updated_at = now()
    where attempt.executor_kind = 'local_runtime'
      and attempt.status in ('prepared', 'running', 'workspace_sealed', 'transcript_sealed')
      and attempt.updated_at < now() - interval '60 seconds'
      and not exists (
        select 1 from v2.workspace_writer_leases lease
        where lease.space_id = attempt.space_id
          and lease.epoch = attempt.workspace_lease_epoch
          and lease.expires_at > now()
          and lease.holder_kind = 'local_agent'
          and lease.holder_id = attempt.id::text
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
    inArray(workspaceSyncCycles.status, ["transferring", "applying_cloud"]),
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
      status: "planned",
    }).onConflictDoNothing();
  }

  const recoverableAttempts = await db.select({
    attemptId: workspaceExecutionAttempts.id,
    spaceId: workspaceExecutionAttempts.spaceId,
    baseSnapshotId: workspaceExecutionAttempts.baseCanonicalSnapshotId,
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
      status: "planned",
    }).onConflictDoNothing().returning({ id: workspaceSyncCycles.id });
    if (cycle) {
      await db.update(workspaceExecutionAttempts).set({ workspaceCycleId: cycle.id, status: "transcript_sealed", updatedAt: new Date() }).where(and(eq(workspaceExecutionAttempts.id, attempt.attemptId), eq(workspaceExecutionAttempts.status, "awaiting_recovery")));
    }
  }

  // A local runtime can die after locald has committed a verified candidate
  // snapshot but before the normal sync job is delivered. Recover only that
  // durable case. Without a candidate there is no server-side evidence that
  // the provider stopped writing, so the awaiting_recovery status remains a
  // deliberate takeover fence until locald reconnects and finalizes it.
  const recoverableLocalAttempts = await db.select({
    attemptId: workspaceExecutionAttempts.id,
    spaceId: workspaceExecutionAttempts.spaceId,
    replicaId: workspaceReplicas.id,
    baseSnapshotId: workspaceExecutionAttempts.baseCanonicalSnapshotId,
    leaseEpoch: workspaceExecutionAttempts.workspaceLeaseEpoch,
  }).from(workspaceExecutionAttempts)
    .innerJoin(workspaceState, eq(workspaceState.spaceId, workspaceExecutionAttempts.spaceId))
    .innerJoin(workspaceReplicas, and(
      eq(workspaceReplicas.id, workspaceExecutionAttempts.replicaId),
      eq(workspaceReplicas.spaceId, workspaceExecutionAttempts.spaceId),
      eq(workspaceReplicas.kind, "local"),
    ))
    .where(and(
      eq(workspaceExecutionAttempts.executorKind, "local_runtime"),
      eq(workspaceExecutionAttempts.status, "awaiting_recovery"),
      notExists(db.select({ id: workspaceSyncCycles.id }).from(workspaceSyncCycles).where(eq(workspaceSyncCycles.executionAttemptId, workspaceExecutionAttempts.id))),
    ))
    .orderBy(asc(workspaceExecutionAttempts.updatedAt))
    .limit(50);

  let recoveredLocalAttempts = 0;
  for (const attempt of recoverableLocalAttempts) {
    if (!attempt.leaseEpoch) continue;
    // A ready snapshot is created only after all manifest/blob integrity
    // checks pass. Select the newest snapshot for this attempt in case a
    // retry left an older, superseded upload behind.
    const [candidate] = await db.select({
      id: workspaceSnapshots.id,
      baseSnapshotId: workspaceSnapshots.baseCanonicalSnapshotId,
      leaseEpoch: workspaceSnapshots.leaseEpoch,
    }).from(workspaceSnapshots).where(and(
      eq(workspaceSnapshots.spaceId, attempt.spaceId),
      eq(workspaceSnapshots.replicaId, attempt.replicaId),
      eq(workspaceSnapshots.sourceExecutionAttemptId, attempt.attemptId),
      eq(workspaceSnapshots.status, "ready"),
    )).orderBy(desc(workspaceSnapshots.createdAt)).limit(1);
    if (!candidate
      || (candidate.baseSnapshotId ?? null) !== (attempt.baseSnapshotId ?? null)
      || candidate.leaseEpoch !== attempt.leaseEpoch) {
      continue;
    }

    const [cycle] = await db.insert(workspaceSyncCycles).values({
      spaceId: attempt.spaceId,
      replicaId: attempt.replicaId,
      baseSnapshotId: candidate.baseSnapshotId ?? attempt.baseSnapshotId,
      localSnapshotId: candidate.id,
      executionAttemptId: attempt.attemptId,
      leaseEpoch: attempt.leaseEpoch,
      status: "planned",
    }).onConflictDoNothing().returning({ id: workspaceSyncCycles.id });
    if (!cycle) continue;
    const [updated] = await db.update(workspaceExecutionAttempts).set({
      workspaceCycleId: cycle.id,
      status: "transcript_sealed",
      updatedAt: new Date(),
    }).where(and(
      eq(workspaceExecutionAttempts.id, attempt.attemptId),
      eq(workspaceExecutionAttempts.status, "awaiting_recovery"),
    )).returning({ id: workspaceExecutionAttempts.id });
    if (updated) recoveredLocalAttempts += 1;
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
      jobId: buildWorkspaceSyncJobId(cycle.id),
      ...defaultCriticalJobOptions,
    });
  }
  return { enqueued: cycles.length, recovered: orphanCandidates.length + recoverableAttempts.length + recoveredLocalAttempts };
}

export async function closeWorkspaceSyncSweeper() {
  await queue.close();
}
