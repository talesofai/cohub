import { createHash } from "node:crypto";
import type { TaskPayload } from "@cohub/protocol/task";
import {
  ISOLATED_WORKER_RECEIPT_SCAN_TASK_TYPE,
  ISOLATED_WORKER_REVOKE_TASK_TYPE,
  type IsolatedWorkerReceiptScanTaskData,
  type IsolatedWorkerRevokeTaskData,
  type IsolatedWorkerTerminalStatus,
} from "@cohub/protocol/isolated-worker";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
const TERMINAL_STATUSES = new Set<IsolatedWorkerTerminalStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const REVOKE_DATA_KEYS = [
  "authoritySpaceId",
  "disposableSpaceId",
  "podUid",
  "sessionId",
  "terminalStatus",
  "trigger",
  "turnId",
] as const;
const RECEIPT_SCAN_DATA_KEYS = [
  "authoritySpaceId",
  "checkpointId",
  "checkpointTreeSha256",
  "disposableSpaceId",
  "podUid",
  "revokeTaskRunId",
  "workerSessionId",
  "workerTurnId",
] as const;
const TASK_PAYLOAD_KEYS = ["data", "sessionId", "spaceId", "turnId", "type", "userId"] as const;
const REVOKE_RESULT_KEYS = ["automatic", "manualEndpointInvoked", "receipt", "terminalStatus"] as const;
const RECEIPT_KEYS = [
  "automaticTrigger",
  "checkpointAdapter",
  "checkpointCommit",
  "checkpointCreatedAfterPodDeletion",
  "checkpointId",
  "checkpointTreeSha256",
  "credentialRevoked",
  "manualEndpointInvoked",
  "podDeleted",
  "podDeletedAt",
  "podUid",
  "revokeTaskRunId",
  "sandboxTerminated",
  "terminatedAt",
] as const;

export type IsolatedWorkerRevocationReceipt = {
  revokeTaskRunId: string;
  automaticTrigger: "turn_terminal_event";
  manualEndpointInvoked: false;
  podUid: string;
  podDeleted: true;
  podDeletedAt: string;
  credentialRevoked: true;
  sandboxTerminated: true;
  checkpointCreatedAfterPodDeletion: true;
  checkpointAdapter: "trusted_production";
  terminatedAt: string;
  checkpointId: string;
  checkpointCommit: string;
  checkpointTreeSha256: string;
};

export type IsolatedWorkerRevokeResult = {
  automatic: true;
  manualEndpointInvoked: false;
  terminalStatus: IsolatedWorkerTerminalStatus;
  receipt: IsolatedWorkerRevocationReceipt;
};

export type IsolatedWorkerRevokeInvocation = {
  taskRunId: string;
  payload: TaskPayload;
};

export type IsolatedWorkerReceiptScanInvocation = {
  taskRunId: string;
  startedAt: Date;
  payload: TaskPayload;
};

export type IsolatedWorkerRevokeTaskReadback = {
  id: string;
  jobId: string;
  taskType: string;
  status: string;
  spaceId: string | null;
  sessionId: string | null;
  turnId: string | null;
  userUuid: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  payload: unknown;
  result: unknown;
};

export type IsolatedWorkerRevokeHandlerDependencies = {
  revokeInternal(input: {
    disposableSpaceId: string;
    sessionId: string;
    turnId: string;
    body: {
      authoritySpaceId: string;
      disposableSpaceId: string;
      podUid: string;
      revokeTaskRunId: string;
      automaticTrigger: "turn_terminal_event";
      manualEndpointInvoked: false;
      terminalStatus: IsolatedWorkerTerminalStatus;
    };
  }): Promise<unknown>;
};

export type IsolatedWorkerReceiptScanHandlerDependencies = {
  readRevokeTaskRun(revokeTaskRunId: string): Promise<IsolatedWorkerRevokeTaskReadback | null>;
};

export type IsolatedWorkerRevokeCompletion = {
  taskRunId: string;
  payload: TaskPayload;
  result: Record<string, unknown>;
  finishedAt: Date;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} fields mismatch`);
  }
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new Error(`${label} is malformed`);
}

function assertNonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
}

function parseTaskPayload(payload: TaskPayload, expectedType: string) {
  if (!isRecord(payload)) throw new Error(`${expectedType} payload is required`);
  assertExactKeys(payload, TASK_PAYLOAD_KEYS, `${expectedType} payload`);
  if (payload.type !== expectedType) throw new Error(`${expectedType} task type mismatch`);
  assertUuid(payload.spaceId, `${expectedType} spaceId`);
  assertUuid(payload.sessionId, `${expectedType} sessionId`);
  assertUuid(payload.turnId, `${expectedType} turnId`);
  assertNonempty(payload.userId, `${expectedType} userId`);
  if (!isRecord(payload.data)) throw new Error(`${expectedType} data is required`);
  return payload as TaskPayload & {
    spaceId: string;
    sessionId: string;
    turnId: string;
    userId: string;
    data: Record<string, unknown>;
  };
}

export function parseIsolatedWorkerRevokePayload(payload: TaskPayload) {
  const parsed = parseTaskPayload(payload, ISOLATED_WORKER_REVOKE_TASK_TYPE);
  assertExactKeys(parsed.data, REVOKE_DATA_KEYS, "isolated worker revoke data");
  const data = parsed.data;
  assertUuid(data.authoritySpaceId, "isolated worker revoke authoritySpaceId");
  assertUuid(data.disposableSpaceId, "isolated worker revoke disposableSpaceId");
  assertUuid(data.sessionId, "isolated worker revoke sessionId");
  assertUuid(data.turnId, "isolated worker revoke turnId");
  assertNonempty(data.podUid, "isolated worker revoke podUid");
  if (data.trigger !== "turn_terminal_event") throw new Error("isolated worker revoke trigger mismatch");
  if (!TERMINAL_STATUSES.has(data.terminalStatus as IsolatedWorkerTerminalStatus)) {
    throw new Error("isolated worker revoke terminalStatus mismatch");
  }
  if (
    parsed.spaceId !== data.disposableSpaceId
    || parsed.sessionId !== data.sessionId
    || parsed.turnId !== data.turnId
  ) {
    throw new Error("isolated worker revoke TaskRun binding mismatch");
  }
  return {
    ...parsed,
    data: data as unknown as IsolatedWorkerRevokeTaskData,
  };
}

export function parseIsolatedWorkerReceiptScanPayload(payload: TaskPayload) {
  const parsed = parseTaskPayload(payload, ISOLATED_WORKER_RECEIPT_SCAN_TASK_TYPE);
  assertExactKeys(parsed.data, RECEIPT_SCAN_DATA_KEYS, "isolated worker receipt scan data");
  const data = parsed.data;
  for (const field of [
    "authoritySpaceId",
    "disposableSpaceId",
    "workerSessionId",
    "workerTurnId",
    "revokeTaskRunId",
    "checkpointId",
  ] as const) {
    assertUuid(data[field], `isolated worker receipt scan ${field}`);
  }
  assertNonempty(data.podUid, "isolated worker receipt scan podUid");
  if (typeof data.checkpointTreeSha256 !== "string" || !SHA256_RE.test(data.checkpointTreeSha256)) {
    throw new Error("isolated worker receipt scan checkpointTreeSha256 is malformed");
  }
  if (
    parsed.spaceId !== data.authoritySpaceId
    || parsed.sessionId !== data.workerSessionId
    || parsed.turnId !== data.workerTurnId
  ) {
    throw new Error("isolated worker receipt scan TaskRun binding mismatch");
  }
  return {
    ...parsed,
    data: data as unknown as IsolatedWorkerReceiptScanTaskData,
  };
}

function parseRevocationReceipt(
  value: unknown,
  expected: {
    revokeTaskRunId: string;
    podUid: string;
    checkpointId?: string;
    checkpointTreeSha256?: string;
  },
) {
  if (!isRecord(value)) throw new Error("isolated worker revocation receipt is required");
  assertExactKeys(value, RECEIPT_KEYS, "isolated worker revocation receipt");
  if (
    value.revokeTaskRunId !== expected.revokeTaskRunId
    || value.automaticTrigger !== "turn_terminal_event"
    || value.manualEndpointInvoked !== false
    || value.podUid !== expected.podUid
    || value.podDeleted !== true
    || value.credentialRevoked !== true
    || value.sandboxTerminated !== true
    || value.checkpointCreatedAfterPodDeletion !== true
    || value.checkpointAdapter !== "trusted_production"
  ) {
    throw new Error("isolated worker revocation receipt binding mismatch");
  }
  assertUuid(value.checkpointId, "isolated worker revocation receipt checkpointId");
  assertNonempty(value.checkpointCommit, "isolated worker revocation receipt checkpointCommit");
  if (typeof value.checkpointTreeSha256 !== "string" || !SHA256_RE.test(value.checkpointTreeSha256)) {
    throw new Error("isolated worker revocation receipt checkpointTreeSha256 is malformed");
  }
  if (
    (expected.checkpointId !== undefined && value.checkpointId !== expected.checkpointId)
    || (expected.checkpointTreeSha256 !== undefined && value.checkpointTreeSha256 !== expected.checkpointTreeSha256)
  ) {
    throw new Error("isolated worker revocation checkpoint binding mismatch");
  }
  const podDeletedAt = typeof value.podDeletedAt === "string" ? Date.parse(value.podDeletedAt) : Number.NaN;
  const terminatedAt = typeof value.terminatedAt === "string" ? Date.parse(value.terminatedAt) : Number.NaN;
  if (!Number.isFinite(podDeletedAt) || !Number.isFinite(terminatedAt) || podDeletedAt > terminatedAt) {
    throw new Error("isolated worker revocation receipt timestamps are invalid");
  }
  return value as unknown as IsolatedWorkerRevocationReceipt;
}

export function parseIsolatedWorkerRevokeResult(
  value: unknown,
  expected: { revokeTaskRunId: string; terminalStatus: IsolatedWorkerTerminalStatus; podUid: string },
) {
  if (!isRecord(value)) throw new Error("isolated worker revoke result is required");
  assertExactKeys(value, REVOKE_RESULT_KEYS, "isolated worker revoke result");
  if (
    value.automatic !== true
    || value.manualEndpointInvoked !== false
    || value.terminalStatus !== expected.terminalStatus
  ) {
    throw new Error("isolated worker revoke result binding mismatch");
  }
  const receipt = parseRevocationReceipt(value.receipt, expected);
  return {
    automatic: true,
    manualEndpointInvoked: false,
    terminalStatus: expected.terminalStatus,
    receipt,
  } satisfies IsolatedWorkerRevokeResult;
}

export function createIsolatedWorkerRevokeHandler(deps: IsolatedWorkerRevokeHandlerDependencies) {
  return async (input: IsolatedWorkerRevokeInvocation): Promise<IsolatedWorkerRevokeResult> => {
    assertUuid(input.taskRunId, "isolated worker revoke TaskRun id");
    const payload = parseIsolatedWorkerRevokePayload(input.payload);
    const data = payload.data;
    const response = await deps.revokeInternal({
      disposableSpaceId: data.disposableSpaceId,
      sessionId: data.sessionId,
      turnId: data.turnId,
      body: {
        authoritySpaceId: data.authoritySpaceId,
        disposableSpaceId: data.disposableSpaceId,
        podUid: data.podUid,
        revokeTaskRunId: input.taskRunId,
        automaticTrigger: "turn_terminal_event",
        manualEndpointInvoked: false,
        terminalStatus: data.terminalStatus,
      },
    });
    const body = isRecord(response) ? response : null;
    if (body?.ok !== true || !isRecord(body.receipt)) {
      throw new Error("isolated worker internal revoke response is incomplete");
    }
    const receipt = parseRevocationReceipt(body.receipt, {
      revokeTaskRunId: input.taskRunId,
      podUid: data.podUid,
    });
    return {
      automatic: true,
      manualEndpointInvoked: false,
      terminalStatus: data.terminalStatus,
      receipt,
    };
  };
}

export function createIsolatedWorkerReceiptScanHandler(deps: IsolatedWorkerReceiptScanHandlerDependencies) {
  return async (input: IsolatedWorkerReceiptScanInvocation) => {
    assertUuid(input.taskRunId, "isolated worker receipt scan TaskRun id");
    if (!Number.isFinite(input.startedAt.getTime())) throw new Error("isolated worker receipt scan startedAt is invalid");
    const payload = parseIsolatedWorkerReceiptScanPayload(input.payload);
    const data = payload.data;
    const revokeTask = await deps.readRevokeTaskRun(data.revokeTaskRunId);
    if (!revokeTask) throw new Error("isolated worker revoke TaskRun is missing");
    if (
      revokeTask.id !== data.revokeTaskRunId
      || revokeTask.jobId !== data.revokeTaskRunId
      || revokeTask.taskType !== ISOLATED_WORKER_REVOKE_TASK_TYPE
      || revokeTask.status !== "completed"
      || revokeTask.spaceId !== data.disposableSpaceId
      || revokeTask.sessionId !== data.workerSessionId
      || revokeTask.turnId !== data.workerTurnId
      || revokeTask.userUuid !== payload.userId
    ) {
      throw new Error("isolated worker revoke TaskRun readback binding mismatch");
    }
    if (!revokeTask.startedAt || !revokeTask.finishedAt) {
      throw new Error("isolated worker revoke TaskRun timestamps are missing");
    }
    if (
      !Number.isFinite(revokeTask.startedAt.getTime())
      || !Number.isFinite(revokeTask.finishedAt.getTime())
      || revokeTask.startedAt.getTime() > revokeTask.finishedAt.getTime()
      || input.startedAt.getTime() <= revokeTask.finishedAt.getTime()
    ) {
      throw new Error("isolated worker receipt scan did not start after revoke completion");
    }
    const revokePayload = parseIsolatedWorkerRevokePayload(revokeTask.payload as TaskPayload);
    if (
      revokePayload.userId !== payload.userId
      || revokePayload.data.authoritySpaceId !== data.authoritySpaceId
      || revokePayload.data.disposableSpaceId !== data.disposableSpaceId
      || revokePayload.data.sessionId !== data.workerSessionId
      || revokePayload.data.turnId !== data.workerTurnId
      || revokePayload.data.podUid !== data.podUid
    ) {
      throw new Error("isolated worker revoke payload and receipt scan binding mismatch");
    }
    const revokeResult = parseIsolatedWorkerRevokeResult(revokeTask.result, {
      revokeTaskRunId: data.revokeTaskRunId,
      terminalStatus: revokePayload.data.terminalStatus,
      podUid: data.podUid,
    });
    if (
      revokeResult.receipt.checkpointId !== data.checkpointId
      || revokeResult.receipt.checkpointTreeSha256 !== data.checkpointTreeSha256
    ) {
      throw new Error("isolated worker receipt scan checkpoint binding mismatch");
    }
    return {
      revokeTaskRunId: data.revokeTaskRunId,
      scanStartedAfterRevoke: true,
      receiptEligible: true,
      checkpointId: data.checkpointId,
      checkpointTreeSha256: data.checkpointTreeSha256,
    } as const;
  };
}

export function createIsolatedWorkerRevokeCompletionHook(deps: {
  enqueueReceiptScan(input: { payload: TaskPayload; taskRunId: string }): Promise<void>;
  waitUntilAfter?: (finishedAt: Date) => Promise<void>;
}) {
  const waitUntilAfter = deps.waitUntilAfter ?? (async (finishedAt: Date) => {
    while (Date.now() <= finishedAt.getTime()) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  });
  return async (completion: IsolatedWorkerRevokeCompletion) => {
    const payload = parseIsolatedWorkerRevokePayload(completion.payload);
    const result = parseIsolatedWorkerRevokeResult(completion.result, {
      revokeTaskRunId: completion.taskRunId,
      terminalStatus: payload.data.terminalStatus,
      podUid: payload.data.podUid,
    });
    await waitUntilAfter(completion.finishedAt);
    const scanTaskRunId = getIsolatedWorkerReceiptScanTaskRunId(completion.taskRunId);
    await deps.enqueueReceiptScan({
      taskRunId: scanTaskRunId,
      payload: {
        type: ISOLATED_WORKER_RECEIPT_SCAN_TASK_TYPE,
        spaceId: payload.data.authoritySpaceId,
        sessionId: payload.data.sessionId,
        turnId: payload.data.turnId,
        userId: payload.userId,
        data: {
          authoritySpaceId: payload.data.authoritySpaceId,
          disposableSpaceId: payload.data.disposableSpaceId,
          workerSessionId: payload.data.sessionId,
          workerTurnId: payload.data.turnId,
          podUid: payload.data.podUid,
          revokeTaskRunId: completion.taskRunId,
          checkpointId: result.receipt.checkpointId,
          checkpointTreeSha256: result.receipt.checkpointTreeSha256,
        },
      },
    });
  };
}

export function getIsolatedWorkerReceiptScanTaskRunId(revokeTaskRunId: string) {
  assertUuid(revokeTaskRunId, "isolated worker revoke TaskRun id");
  const hex = createHash("sha256").update(`${revokeTaskRunId}:receipt-scan`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
