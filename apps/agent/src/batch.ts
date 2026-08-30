import { sql } from "drizzle-orm";
import type { ContentBlock } from "@cohub/protocol/core";
import { db } from "./db.js";
import { env } from "./env.js";
import type { AgentTurnJobData } from "./queue.js";

type TurnRow = {
  id: string;
  sessionId: string;
  userUuid: string | null;
  sequence: number;
  status: string;
  intent: string;
  userContent: ContentBlock[];
  userText: string | null;
  meta: unknown;
  updatedAt: Date | null;
};

type ExecutionBatchMeta = {
  ownerTurnId: string;
  turnIds: string[];
  mergedTurnIds: string[];
  userMessageIds: string[];
  anchorUserMessageId: string | null;
};

export type ClaimedTurnBatch = {
  ownerTurn: TurnRow;
  turns: TurnRow[];
  mergedTurns: TurnRow[];
  executionBatch: ExecutionBatchMeta;
};

export type ClaimResult =
  | { kind: "claimed"; batch: ClaimedTurnBatch }
  | { kind: "busy"; activeTurnId: string; activeUpdatedAt: Date | null; activeStatus: string }
  | { kind: "blocked"; reason: string; retryAfterMs: number }
  | { kind: "noop" };

const STALE_ACTIVE_TURN_MS = env.AGENT_STALE_ACTIVE_TURN_MS;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function normalizeTurn(row: Record<string, unknown>): TurnRow {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    userUuid: typeof row.user_uuid === "string" ? row.user_uuid : null,
    sequence: Number(row.sequence),
    status: String(row.status),
    intent: String(row.intent ?? "steer"),
    userContent: row.user_content as ContentBlock[],
    userText: typeof row.user_text === "string" ? row.user_text : null,
    meta: row.meta ?? null,
    updatedAt: asDate(row.updated_at),
  };
}

const getMetaString = (turn: TurnRow, key: string): string | null => {
  const value = asRecord(turn.meta)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

function getUserMessageId(turn: TurnRow): string {
  return getMetaString(turn, "userMessageId") ?? getMetaString(turn, "messageId") ?? turn.id;
}

function isStaleActiveTurn(turn: TurnRow) {
  const updatedAt = turn.updatedAt?.getTime();
  return updatedAt != null && Number.isFinite(updatedAt) && Date.now() - updatedAt > STALE_ACTIVE_TURN_MS;
}

async function markStaleTurnInterrupted(tx: Transaction, turn: TurnRow) {
  await tx.execute(sql`
    update v2.session_turns
    set status = 'interrupted',
        stop_reason = 'stale_active_recovered',
        summary = ${JSON.stringify({ finishReason: "interrupted", reason: "stale_active_recovered" })}::jsonb,
        meta = coalesce(meta, '{}'::jsonb) || ${JSON.stringify({ staleActiveRecoveredAt: new Date().toISOString(), previousStatus: turn.status })}::jsonb,
        completed_at = now(),
        updated_at = now()
    where id = ${turn.id} and status in ('running', 'abort_requested')
  `);
}

function createExecutionBatch(queued: TurnRow[]): ExecutionBatchMeta {
  const userMessageIds = queued.map(getUserMessageId).filter((value): value is string => Boolean(value));
  const owner = queued.at(-1);
  if (!owner) throw new Error("queued turns are required");
  return {
    ownerTurnId: owner.id,
    turnIds: queued.map((turn) => turn.id),
    mergedTurnIds: queued.slice(0, -1).map((turn) => turn.id),
    userMessageIds,
    anchorUserMessageId: userMessageIds.at(-1) ?? null,
  };
}

async function claimWorkspaceAttempt(tx: Transaction, spaceId: string, owner: TurnRow) {
  const originalMeta = asRecord(owner.meta);
  let attemptId = typeof originalMeta.executionAttemptId === "string" && originalMeta.executionAttemptId.trim()
    ? originalMeta.executionAttemptId.trim()
    : null;
  if (!attemptId) {
    const createdRows = await tx.execute(sql`
      insert into v2.workspace_execution_attempts
        (space_id, idempotency_key, executor_kind, workspace_required, transcript_required, session_id, turn_id, base_canonical_snapshot_id, workspace_policy_version, status, created_at, updated_at)
      select ws.space_id, ${`cloud-turn:${owner.id}`}, 'cloud_agent', true, true, ${owner.sessionId}, ${owner.id}, ws.canonical_snapshot_id, wp.policy_version, 'queued', now(), now()
      from v2.workspace_state ws
      left join v2.space_workspace_policies wp on wp.space_id = ws.space_id
      where ws.space_id = ${spaceId}
      on conflict (space_id, idempotency_key) do update set updated_at = now()
      returning id
    `);
    const value = (createdRows[0] as Record<string, unknown> | undefined)?.id;
    attemptId = typeof value === "string" ? value : null;
  }
  if (!attemptId) return originalMeta;

  const attemptRows = await tx.execute(sql`
    update v2.workspace_execution_attempts
    set status = 'running', started_at = coalesce(started_at, now()), updated_at = now()
    where id = ${attemptId} and space_id = ${spaceId} and turn_id = ${owner.id} and status in ('queued', 'prepared')
    returning base_canonical_snapshot_id
  `);
  if (attemptRows.length === 0) throw new Error(`workspace attempt ${attemptId} is not claimable`);
  const baseSnapshotId = (attemptRows[0] as Record<string, unknown>).base_canonical_snapshot_id;
  const leaseRows = await tx.execute(sql`
    insert into v2.workspace_writer_leases
      (space_id, holder_kind, holder_id, holder_user_uuid, epoch, base_snapshot_id, expires_at, last_heartbeat_at, takeover_requires_confirmation, updated_at)
    values (${spaceId}, 'cloud_agent', ${attemptId}, ${owner.userUuid}, 1, ${typeof baseSnapshotId === "string" ? baseSnapshotId : null}, now() + interval '30 seconds', now(), false, now())
    on conflict (space_id) do update set
      holder_kind = excluded.holder_kind,
      holder_id = excluded.holder_id,
      holder_user_uuid = excluded.holder_user_uuid,
      epoch = v2.workspace_writer_leases.epoch + 1,
      base_snapshot_id = excluded.base_snapshot_id,
      expires_at = excluded.expires_at,
      last_heartbeat_at = now(),
      takeover_requires_confirmation = false,
      updated_at = now()
    where v2.workspace_writer_leases.expires_at <= now()
    returning epoch
  `);
  const leaseEpoch = Number((leaseRows[0] as Record<string, unknown> | undefined)?.epoch);
  if (!Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) throw new Error("workspace writer lease is unavailable");
  await tx.execute(sql`
    update v2.workspace_execution_attempts
    set workspace_lease_epoch = ${leaseEpoch}, updated_at = now()
    where id = ${attemptId}
  `);
  await tx.execute(sql`
    update v2.workspace_state
    set active_execution_attempt_id = ${attemptId}, updated_at = now()
    where space_id = ${spaceId}
  `);
  await tx.execute(sql`
    update v2.workspace_replicas
    set active_execution_attempt_id = ${attemptId}, updated_at = now()
    where space_id = ${spaceId} and kind = 'cloud'
  `);
  return {
    ...originalMeta,
    executionAttemptId: attemptId,
    workspaceLeaseEpoch: leaseEpoch,
  };
}

async function claimQueuedTurns(tx: Transaction, spaceId: string, queued: TurnRow[]): Promise<ClaimedTurnBatch | null> {
  const owner = queued.at(-1);
  if (!owner) throw new Error("queued turns are required");
  const merged = queued.slice(0, -1);
  const executionBatch = createExecutionBatch(queued);

  const claimedMeta = await claimWorkspaceAttempt(tx, spaceId, owner);
  const ownerMeta = { ...claimedMeta, executionBatch };
  const updatedRows = await tx.execute(sql`
    update v2.session_turns
    set status = 'running',
        started_at = coalesce(started_at, now()),
        updated_at = now(),
        meta = ${JSON.stringify(ownerMeta)}::jsonb
    where id = ${owner.id} and status = 'queued'
    returning id
  `);
  if (updatedRows.length === 0) return null;

  for (const turn of merged) {
    const mergedAttemptId = getMetaString(turn, "executionAttemptId");
    if (mergedAttemptId) {
      await tx.execute(sql`
        update v2.workspace_execution_attempts
        set status = 'aborted', completed_at = now(), error_code = 'merged_into_turn', updated_at = now()
        where id = ${mergedAttemptId} and status in ('queued', 'prepared')
      `);
    }
    const mergedRows = await tx.execute(sql`
      update v2.session_turns
      set status = 'merged',
          stop_reason = 'merged',
          summary = ${JSON.stringify({ finishReason: "merged", reason: "merge", mergedIntoTurnId: owner.id })}::jsonb,
          meta = coalesce(meta, '{}'::jsonb) || ${JSON.stringify({ mergedIntoTurnId: owner.id, mergedAt: new Date().toISOString() })}::jsonb,
          completed_at = now(),
          updated_at = now()
      where id = ${turn.id} and status = 'queued'
      returning id
    `);
    if (mergedRows.length === 0) throw new Error(`failed to merge queued turn ${turn.id}`);
  }

  const updatedOwner = { ...owner, status: "running", meta: ownerMeta, updatedAt: new Date() };
  return {
    ownerTurn: updatedOwner,
    turns: [...merged, updatedOwner],
    mergedTurns: merged,
    executionBatch,
  };
}

export async function claimNextTurnBatch(input: Pick<AgentTurnJobData, "sessionId">): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    const sessionRows = await tx.execute(sql`select id, space_id from v2.space_sessions where id = ${input.sessionId} for update`);
    const spaceId = (sessionRows[0] as Record<string, unknown> | undefined)?.space_id;
    if (typeof spaceId !== "string") return { kind: "noop" as const };

    const gateRows = await tx.execute(sql`
      select
        ws.status as workspace_status,
        ws.canonical_snapshot_id,
        ws.cloud_applied_snapshot_id,
        exists (
          select 1 from v2.workspace_writer_leases wl
          where wl.space_id = ${spaceId}
            and wl.expires_at > now()
            and wl.holder_kind in ('cloud_agent', 'local_agent', 'local_offline_reservation', 'cloud_file_api', 'cloud_command', 'sync_apply')
        ) as has_blocking_lease,
        exists (
          select 1 from v2.workspace_execution_attempts wa
          where wa.space_id = ${spaceId}
            and wa.executor_kind = 'local_native'
            and wa.status in ('prepared', 'running', 'workspace_sealed', 'transcript_sealed', 'awaiting_recovery')
        ) as has_local_attempt,
        exists (
          select 1
          from v2.space_local_agent_policies lp
          join v2.workspace_replicas lr
            on lr.space_id = lp.space_id and lr.device_id = lp.device_id and lr.kind = 'local' and lr.status <> 'detached'
          where lp.space_id = ${spaceId} and lp.workspace_mode = 'one_way_to_cloud'
        ) as has_local_authoritative_policy,
        exists (
          select 1 from v2.native_agent_ingests ni
          where ni.cohub_session_id = ${input.sessionId}
            and ni.transcript_visibility in ('hidden', 'orphaned')
            and ni.status not in ('applied', 'quarantined', 'failed')
        ) as has_hidden_ingest,
        exists (
          select 1 from v2.native_agent_turns nt
          where nt.cohub_session_id = ${input.sessionId}
            and nt.status in ('pending', 'running', 'sealed', 'awaiting_recovery', 'applying', 'forking')
        ) as has_native_turn
      from v2.workspace_state ws
      where ws.space_id = ${spaceId}
      for update
    `);
    const gate = gateRows[0] as Record<string, unknown> | undefined;
    if (gate) {
      const reason = gate.workspace_status !== "ready"
        ? `workspace_${String(gate.workspace_status ?? "unknown")}`
        : gate.canonical_snapshot_id !== gate.cloud_applied_snapshot_id
          ? "cloud_replica_behind"
          : gate.has_blocking_lease === true
            ? "workspace_writer_active"
            : gate.has_local_attempt === true
              ? "local_attempt_active"
              : gate.has_local_authoritative_policy === true
                ? "cloud_workspace_write_disabled"
                  : gate.has_hidden_ingest === true
                  ? "native_ingest_pending"
                  : gate.has_native_turn === true
                    ? "native_turn_active"
                    : null;
      if (reason) return { kind: "blocked" as const, reason, retryAfterMs: 1_000 };
    }

    const activeRows = await tx.execute(sql`
      select id, session_id, user_uuid, sequence, status, intent, user_content, user_text, meta, updated_at
      from v2.session_turns
      where session_id = ${input.sessionId} and execution_kind = 'agent' and status in ('running', 'abort_requested')
      order by sequence asc
      limit 1
    `);
    const active = activeRows[0] ? normalizeTurn(activeRows[0] as Record<string, unknown>) : null;
    if (active) {
      if (isStaleActiveTurn(active)) {
        await markStaleTurnInterrupted(tx, active);
      } else {
        return { kind: "busy" as const, activeTurnId: active.id, activeUpdatedAt: active.updatedAt, activeStatus: active.status };
      }
    }

    const blockingRows = await tx.execute(sql`
      select sequence
      from v2.session_turns
      where session_id = ${input.sessionId}
        and execution_kind = 'direct_generation'
        and status not in ('completed', 'failed', 'cancelled', 'interrupted', 'merged')
      order by sequence asc
      limit 1
    `);
    const blockingSequenceValue = (blockingRows[0] as Record<string, unknown> | undefined)?.sequence;
    const parsedBlockingSequence = typeof blockingSequenceValue === "number" ? blockingSequenceValue : typeof blockingSequenceValue === "string" ? Number(blockingSequenceValue) : Number.NaN;
    const blockingSequence = Number.isFinite(parsedBlockingSequence) ? parsedBlockingSequence : null;
    const beforeGeneration = blockingSequence === null ? sql`true` : sql`sequence < ${blockingSequence}`;

    const steerRows = await tx.execute(sql`
      select id, session_id, user_uuid, sequence, status, intent, user_content, user_text, meta, updated_at
      from v2.session_turns
      where session_id = ${input.sessionId} and execution_kind = 'agent' and status = 'queued' and intent = 'steer' and ${beforeGeneration}
      order by updated_at asc, sequence asc
      limit 1
    `);
    const steer = steerRows[0] ? normalizeTurn(steerRows[0] as Record<string, unknown>) : null;
    if (steer) {
      const batch = await claimQueuedTurns(tx, spaceId, [steer]);
      return batch ? { kind: "claimed" as const, batch } : { kind: "noop" as const };
    }

    const followupRows = await tx.execute(sql`
      select id, session_id, user_uuid, sequence, status, intent, user_content, user_text, meta, updated_at
      from v2.session_turns
      where session_id = ${input.sessionId} and execution_kind = 'agent' and status = 'queued' and intent = 'followup' and ${beforeGeneration}
      order by sequence asc
    `);
    const followups = followupRows.map((row) => normalizeTurn(row as Record<string, unknown>));
    if (followups.length === 0) return { kind: "noop" as const };

    const batch = await claimQueuedTurns(tx, spaceId, followups);
    return batch ? { kind: "claimed" as const, batch } : { kind: "noop" as const };
  });
}

export async function enqueueNextRunnableTurn(input: { spaceId: string; sessionId: string; enqueue: (data: AgentTurnJobData) => Promise<unknown> }) {
  const rows = await db.execute(sql`
    select id
    from v2.session_turns
    where session_id = ${input.sessionId} and execution_kind = 'agent' and status = 'queued' and intent in ('steer', 'followup')
    order by case when intent = 'steer' then 0 else 1 end, updated_at asc, sequence asc
    limit 1
  `);
  const turnId = rows
    .map((row) => (row as Record<string, unknown>).id)
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (!turnId) return null;
  await input.enqueue({ spaceId: input.spaceId, sessionId: input.sessionId, reason: "drain" });
  return turnId;
}

export function buildUserMessagesForBatch(batch: ClaimedTurnBatch) {
  return batch.turns.map((turn) => {
    const meta = asRecord(turn.meta);
    const userMessageId = getUserMessageId(turn);
    return {
      turnId: turn.id,
      turnSeq: turn.sequence,
      userMessageId,
      content: turn.userContent,
      meta: {
        ...meta,
        userMessageId,
        messageId: typeof meta.messageId === "string" && meta.messageId.trim() ? meta.messageId : userMessageId,
        turnId: typeof meta.turnId === "string" && meta.turnId.trim() ? meta.turnId : turn.id,
      },
    };
  });
}
