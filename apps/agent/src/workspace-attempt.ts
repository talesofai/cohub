import { and, eq, inArray, sql } from "drizzle-orm";
import {
  sessionTurns,
  workspaceExecutionAttempts,
  workspaceReplicas,
  workspaceState,
  workspaceSyncCycles,
  workspaceWriterLeases,
} from "@cohub/db";
import { db } from "./db.js";
import { logger } from "./logger.js";

const ATTEMPT_TERMINAL_TURN_STATUSES = ["completed", "failed", "interrupted", "cancelled", "merged"] as const;

export function workspaceAttemptFromMeta(meta: unknown): { attemptId: string; leaseEpoch: number } | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const record = meta as Record<string, unknown>;
  const attemptId = typeof record.executionAttemptId === "string" ? record.executionAttemptId.trim() : "";
  const leaseEpoch = typeof record.workspaceLeaseEpoch === "number" ? record.workspaceLeaseEpoch : Number(record.workspaceLeaseEpoch);
  return attemptId && Number.isSafeInteger(leaseEpoch) && leaseEpoch > 0 ? { attemptId, leaseEpoch } : null;
}

export async function startWorkspaceAttemptHeartbeat(input: { spaceId: string; attemptId: string; leaseEpoch: number; onLost?: (error: Error) => void }): Promise<() => Promise<void>> {
  let stopped = false;
  let heartbeatInFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let failureReported = false;
  const heartbeat = async () => {
    const current = new Date();
    const expiresAt = new Date(current.getTime() + 30_000);
    const [lease] = await db.update(workspaceWriterLeases).set({
      expiresAt,
      lastHeartbeatAt: current,
      updatedAt: current,
    }).where(and(
      eq(workspaceWriterLeases.spaceId, input.spaceId),
      eq(workspaceWriterLeases.holderKind, "cloud_agent"),
      eq(workspaceWriterLeases.holderId, input.attemptId),
      eq(workspaceWriterLeases.epoch, input.leaseEpoch),
      // An expired lease must never be resurrected by a delayed heartbeat.
      sql`${workspaceWriterLeases.expiresAt} > now()`,
    )).returning({ epoch: workspaceWriterLeases.epoch });
    if (!lease) throw new Error("cloud workspace writer lease was lost");
    await db.update(workspaceExecutionAttempts).set({ updatedAt: current }).where(and(
      eq(workspaceExecutionAttempts.id, input.attemptId),
      eq(workspaceExecutionAttempts.status, "running"),
    ));
  };
  const handleFailure = (error: unknown) => {
    if (failureReported) return;
    failureReported = true;
    stopped = true;
    if (timer) clearInterval(timer);
    const failure = error instanceof Error ? error : new Error(String(error));
    logger.error("[WorkspaceAttempt] heartbeat failed", { spaceId: input.spaceId, attemptId: input.attemptId, leaseEpoch: input.leaseEpoch, error: failure });
    input.onLost?.(failure);
  };
  try {
    await heartbeat();
  } catch (error) {
    handleFailure(error);
    throw error;
  }
  const runHeartbeat = () => {
    if (stopped || heartbeatInFlight) return;
    const pending = heartbeat().catch(handleFailure).finally(() => {
      if (heartbeatInFlight === pending) heartbeatInFlight = null;
    });
    heartbeatInFlight = pending;
  };
  timer = setInterval(runHeartbeat, 10_000);
  timer.unref();
  return async () => {
    stopped = true;
    if (timer) clearInterval(timer);
    const pendingHeartbeat = heartbeatInFlight;
    if (pendingHeartbeat) await pendingHeartbeat.catch(() => undefined);
  };
}

export async function sealCloudWorkspaceAttempt(input: { spaceId: string; sessionId: string; turnId: string; attemptId: string; leaseEpoch: number }) {
  await db.transaction(async (tx) => {
    const [turn] = await tx.select({ status: sessionTurns.status }).from(sessionTurns).where(and(
      eq(sessionTurns.id, input.turnId),
      eq(sessionTurns.sessionId, input.sessionId),
      eq(sessionTurns.executionKind, "agent"),
      inArray(sessionTurns.status, [...ATTEMPT_TERMINAL_TURN_STATUSES]),
    )).for("update").limit(1);
    if (!turn) return;
    const [attempt] = await tx.select().from(workspaceExecutionAttempts).where(and(
      eq(workspaceExecutionAttempts.id, input.attemptId),
      eq(workspaceExecutionAttempts.spaceId, input.spaceId),
      eq(workspaceExecutionAttempts.turnId, input.turnId),
    )).for("update").limit(1);
    if (!attempt || ["completed", "failed", "aborted"].includes(attempt.status)) return;
    const [state] = await tx.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).for("update").limit(1);
    const [cloudReplica] = await tx.select({ id: workspaceReplicas.id }).from(workspaceReplicas).where(and(
      eq(workspaceReplicas.spaceId, input.spaceId),
      eq(workspaceReplicas.kind, "cloud"),
    )).limit(1);
    let cycleId = attempt.workspaceCycleId;
    if (state && cloudReplica && !cycleId) {
      const [existingCycle] = await tx.select({ id: workspaceSyncCycles.id }).from(workspaceSyncCycles).where(eq(workspaceSyncCycles.executionAttemptId, input.attemptId)).limit(1);
      cycleId = existingCycle?.id ?? null;
      if (!cycleId) {
        const [created] = await tx.insert(workspaceSyncCycles).values({
          spaceId: input.spaceId,
          replicaId: cloudReplica.id,
          baseSnapshotId: attempt.baseCanonicalSnapshotId,
          executionAttemptId: input.attemptId,
          direction: "reconcile",
          canonicalGenerationAtStart: state.generation,
          leaseEpoch: input.leaseEpoch,
          status: "planned",
        }).onConflictDoNothing().returning({ id: workspaceSyncCycles.id });
        cycleId = created?.id ?? null;
      }
    }
    await tx.update(workspaceExecutionAttempts).set({
      status: cycleId ? "transcript_sealed" : "awaiting_recovery",
      workspaceCycleId: cycleId,
      ...(turn.status === "failed" ? { errorCode: "cloud_turn_failed" } : {}),
      updatedAt: new Date(),
    }).where(eq(workspaceExecutionAttempts.id, attempt.id));
    await tx.update(workspaceWriterLeases).set({
      expiresAt: new Date(),
      lastHeartbeatAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(workspaceWriterLeases.spaceId, input.spaceId),
      eq(workspaceWriterLeases.holderKind, "cloud_agent"),
      eq(workspaceWriterLeases.holderId, input.attemptId),
      eq(workspaceWriterLeases.epoch, input.leaseEpoch),
    ));
    if (state?.activeExecutionAttemptId === input.attemptId || cycleId) {
      await tx.update(workspaceState).set({
        activeExecutionAttemptId: null,
        ...(cycleId ? { status: "syncing", activeCycleId: cycleId } : {}),
        updatedAt: new Date(),
      }).where(eq(workspaceState.spaceId, input.spaceId));
      await tx.update(workspaceReplicas).set({ activeExecutionAttemptId: null, updatedAt: new Date() }).where(and(
        eq(workspaceReplicas.spaceId, input.spaceId),
        eq(workspaceReplicas.kind, "cloud"),
        eq(workspaceReplicas.activeExecutionAttemptId, input.attemptId),
      ));
    }
  });
}
