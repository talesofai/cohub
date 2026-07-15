import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { sessionTurns, taskRuns } from "@cohub/db";
import {
  ISOLATED_WORKER_RECEIPT_SCAN_TASK_TYPE,
  ISOLATED_WORKER_REVOKE_TASK_TYPE,
  type IsolatedWorkerRevokeTaskData,
  type IsolatedWorkerTerminalStatus,
} from "@cohub/protocol/isolated-worker";
import type { TaskPayload } from "@cohub/protocol/task";
import { db } from "./db/index.js";
import { enqueueTask } from "./tasks.js";
import type { IsolatedWorkerPodHandle } from "./isolated-worker-pods.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deterministicUuid(seed: string) {
  const value = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  value[12] = "4";
  value[16] = ["8", "9", "a", "b"][Number.parseInt(value[16] ?? "0", 16) % 4] ?? "8";
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseHandle(meta: unknown, input: { spaceId: string; sessionId: string; turnId: string }) {
  const record = isRecord(meta) ? meta : null;
  const handle = record && isRecord(record.isolatedWorker)
    ? record.isolatedWorker as unknown as IsolatedWorkerPodHandle
    : null;
  if (
    !handle
    || handle.sessionId !== input.sessionId
    || handle.turnId !== input.turnId
    || handle.isolatedWorkerPolicy?.disposableSpaceId !== input.spaceId
    || !handle.isolatedWorkerPolicy.authoritySpaceId
    || !handle.isolatedWorkerPolicy.podUid
  ) {
    throw new Error("isolated worker termination binding mismatch");
  }
  return { meta: record ?? {}, handle };
}

export async function scheduleIsolatedWorkerTermination(input: {
  spaceId: string;
  sessionId: string;
  turnId: string;
  terminalStatus: IsolatedWorkerTerminalStatus;
}) {
  const [turn] = await db.select().from(sessionTurns).where(and(
    eq(sessionTurns.id, input.turnId),
    eq(sessionTurns.sessionId, input.sessionId),
  )).limit(1);
  if (!turn) throw new Error("isolated worker Turn not found");
  if (["completed", "failed", "interrupted", "cancelled"].includes(turn.status)) {
    const { meta, handle } = parseHandle(turn.meta, input);
    const receipt = isRecord(meta.isolatedWorkerTermination) ? meta.isolatedWorkerTermination : null;
    if (receipt?.podUid === handle.isolatedWorkerPolicy.podUid) {
      return {
        revokeTaskRunId: String(receipt.revokeTaskRunId),
        receipt,
        alreadyTerminated: true as const,
      };
    }
    throw new Error("isolated worker Turn became terminal without a termination receipt");
  }
  const { meta, handle } = parseHandle(turn.meta, input);
  const existingRevocation = isRecord(meta.isolatedWorkerRevocation) ? meta.isolatedWorkerRevocation : null;
  const existingTaskRunId = typeof existingRevocation?.taskRunId === "string" ? existingRevocation.taskRunId : null;
  const [existingTask] = existingTaskRunId
    ? await db.select().from(taskRuns).where(eq(taskRuns.id, existingTaskRunId)).limit(1)
    : [];
  if (existingTask && existingTask.status === "completed") {
    return { revokeTaskRunId: existingTask.id, alreadyTerminated: false as const };
  }
  if (existingTask && ["pending", "running"].includes(existingTask.status)) {
    return { revokeTaskRunId: existingTask.id, alreadyTerminated: false as const };
  }
  const previousAttempt = isRecord(meta.isolatedWorkerTerminationState)
    && typeof meta.isolatedWorkerTerminationState.attempt === "number"
    ? meta.isolatedWorkerTerminationState.attempt
    : 0;
  const attempt = previousAttempt + 1;
  const revokeTaskRunId = deterministicUuid(`isolated-worker-revoke:${input.turnId}:${handle.isolatedWorkerPolicy.podUid}:${attempt}`);
  const revocationMeta = {
    taskRunId: revokeTaskRunId,
    taskType: ISOLATED_WORKER_REVOKE_TASK_TYPE,
    trigger: "turn_terminal_event",
    terminalStatus: input.terminalStatus,
    automatic: true,
    manualEndpointInvoked: false,
    podUid: handle.isolatedWorkerPolicy.podUid,
  } as const;
  const terminationState = {
    state: "stopping",
    attempt,
    requestedTerminalStatus: input.terminalStatus,
    requestedAt: new Date().toISOString(),
    revokeTaskRunId,
  } as const;
  const [claimed] = await db.update(sessionTurns).set({
    meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify({
      isolatedWorkerRevocation: revocationMeta,
      isolatedWorkerTerminationState: terminationState,
    })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(
    eq(sessionTurns.id, input.turnId),
    eq(sessionTurns.sessionId, input.sessionId),
    inArray(sessionTurns.status, ["queued", "running", "abort_requested"]),
  )).returning({ id: sessionTurns.id });
  if (!claimed) throw new Error("isolated worker Turn changed before termination scheduling");
  const data: IsolatedWorkerRevokeTaskData = {
    trigger: "turn_terminal_event",
    terminalStatus: input.terminalStatus,
    authoritySpaceId: handle.isolatedWorkerPolicy.authoritySpaceId,
    disposableSpaceId: input.spaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    podUid: handle.isolatedWorkerPolicy.podUid,
  };
  const payload: TaskPayload = {
    type: ISOLATED_WORKER_REVOKE_TASK_TYPE,
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    userId: turn.userUuid ?? undefined,
    data,
  };
  await enqueueTask(payload, {
    taskRunId: revokeTaskRunId,
    attempts: 8,
    backoff: { type: "exponential", delay: 1_000 },
  });
  return { revokeTaskRunId, alreadyTerminated: false as const };
}

export async function readIsolatedWorkerTermination(input: {
  spaceId: string;
  sessionId: string;
  turnId: string;
  revokeTaskRunId: string;
}) {
  const [revokeTask] = await db.select().from(taskRuns).where(and(
    eq(taskRuns.id, input.revokeTaskRunId),
    eq(taskRuns.taskType, ISOLATED_WORKER_REVOKE_TASK_TYPE),
    eq(taskRuns.spaceId, input.spaceId),
    eq(taskRuns.sessionId, input.sessionId),
    eq(taskRuns.turnId, input.turnId),
  )).limit(1);
  if (!revokeTask) return { state: "pending" as const };
  if (revokeTask.status === "failed") throw new Error(`isolated worker revoke failed: ${revokeTask.errorMessage ?? "unknown error"}`);
  if (revokeTask.status !== "completed" || !revokeTask.finishedAt) return { state: "pending" as const };
  const revokeResult = isRecord(revokeTask.result) ? revokeTask.result : null;
  const receipt = revokeResult && isRecord(revokeResult.receipt) ? revokeResult.receipt : null;
  if (!receipt || receipt.revokeTaskRunId !== input.revokeTaskRunId) {
    throw new Error("isolated worker revoke receipt is missing or mismatched");
  }
  const [scanTask] = await db.select().from(taskRuns).where(and(
    eq(taskRuns.taskType, ISOLATED_WORKER_RECEIPT_SCAN_TASK_TYPE),
    eq(taskRuns.spaceId, String((revokeTask.payload.data as Record<string, unknown>).authoritySpaceId)),
    sql`${taskRuns.payload}->'data'->>'revokeTaskRunId' = ${input.revokeTaskRunId}`,
  )).orderBy(desc(taskRuns.createdAt)).limit(1);
  if (!scanTask || scanTask.status === "pending" || scanTask.status === "running") return { state: "pending" as const };
  if (scanTask.status === "failed") throw new Error(`isolated worker receipt scan failed: ${scanTask.errorMessage ?? "unknown error"}`);
  const scanResult = isRecord(scanTask.result) ? scanTask.result : null;
  if (
    scanTask.status !== "completed"
    || !scanTask.startedAt
    || scanTask.startedAt.getTime() <= revokeTask.finishedAt.getTime()
    || scanResult?.revokeTaskRunId !== input.revokeTaskRunId
    || scanResult.scanStartedAfterRevoke !== true
    || scanResult.receiptEligible !== true
  ) {
    throw new Error("isolated worker receipt scan proof is invalid");
  }
  return { state: "terminated" as const, receipt, scanTaskRunId: scanTask.id };
}

export async function waitForIsolatedWorkerTermination(input: {
  spaceId: string;
  sessionId: string;
  turnId: string;
  revokeTaskRunId: string;
  timeoutMs?: number;
}) {
  const deadline = Date.now() + (input.timeoutMs ?? 20 * 60_000);
  while (Date.now() < deadline) {
    const state = await readIsolatedWorkerTermination(input);
    if (state.state === "terminated") return state;
    await sleep(500);
  }
  throw new Error("timed out waiting for isolated worker termination receipt scan");
}
