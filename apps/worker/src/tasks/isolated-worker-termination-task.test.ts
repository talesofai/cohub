import assert from "node:assert/strict";
import type { TaskPayload } from "@cohub/protocol/task";
import {
  createIsolatedWorkerReceiptScanHandler,
  createIsolatedWorkerRevokeCompletionHook,
  createIsolatedWorkerRevokeHandler,
  getIsolatedWorkerReceiptScanTaskRunId,
} from "./isolated-worker-termination-handler.js";

const revokeTaskRunId = "11111111-1111-4111-8111-111111111111";
const scanTaskRunId = "22222222-2222-4222-8222-222222222222";
const authoritySpaceId = "33333333-3333-4333-8333-333333333333";
const disposableSpaceId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
const turnId = "66666666-6666-4666-8666-666666666666";
const checkpointId = "77777777-7777-4777-8777-777777777777";
const checkpointTreeSha256 = "a".repeat(64);
const userId = "user-1";
const podUid = "pod-uid-1";

const revokePayload: TaskPayload = {
  type: "isolated_worker_revoke",
  spaceId: disposableSpaceId,
  sessionId,
  turnId,
  userId,
  data: {
    trigger: "turn_terminal_event",
    terminalStatus: "completed",
    authoritySpaceId,
    disposableSpaceId,
    sessionId,
    turnId,
    podUid,
  },
};

const receipt = {
  revokeTaskRunId,
  automaticTrigger: "turn_terminal_event" as const,
  manualEndpointInvoked: false as const,
  podUid,
  podDeleted: true as const,
  podDeletedAt: "2026-07-15T00:00:01.000Z",
  credentialRevoked: true as const,
  sandboxTerminated: true as const,
  checkpointCreatedAfterPodDeletion: true as const,
  checkpointAdapter: "trusted_production" as const,
  terminatedAt: "2026-07-15T00:00:02.000Z",
  checkpointId,
  checkpointCommit: "b".repeat(40),
  checkpointTreeSha256,
};

const revokeResult = {
  automatic: true as const,
  manualEndpointInvoked: false as const,
  terminalStatus: "completed" as const,
  receipt,
};

let internalRequest: unknown = null;
const revokeHandler = createIsolatedWorkerRevokeHandler({
  async revokeInternal(input) {
    internalRequest = input;
    return { ok: true, receipt };
  },
});
assert.deepEqual(await revokeHandler({ taskRunId: revokeTaskRunId, payload: revokePayload }), revokeResult);
assert.deepEqual(internalRequest, {
  disposableSpaceId,
  sessionId,
  turnId,
  body: {
    authoritySpaceId,
    disposableSpaceId,
    podUid,
    revokeTaskRunId,
    automaticTrigger: "turn_terminal_event",
    manualEndpointInvoked: false,
    terminalStatus: "completed",
  },
});

let badPayloadCalled = false;
const strictRevokeHandler = createIsolatedWorkerRevokeHandler({
  async revokeInternal() {
    badPayloadCalled = true;
    return { ok: true, receipt };
  },
});
await assert.rejects(
  strictRevokeHandler({
    taskRunId: revokeTaskRunId,
    payload: {
      ...revokePayload,
      data: { ...revokePayload.data, manualEndpointInvoked: false },
    },
  }),
  /data fields mismatch/,
);
assert.equal(badPayloadCalled, false);

const completionCalls: string[] = [];
let enqueuedScan: { payload: TaskPayload; taskRunId: string } | null = null;
const completionHook = createIsolatedWorkerRevokeCompletionHook({
  async waitUntilAfter(finishedAt) {
    completionCalls.push(`wait:${finishedAt.toISOString()}`);
  },
  async enqueueReceiptScan(input) {
    completionCalls.push("enqueue");
    enqueuedScan = input;
  },
});
const revokeFinishedAt = new Date("2026-07-15T00:00:03.000Z");
await completionHook({
  taskRunId: revokeTaskRunId,
  payload: revokePayload,
  result: revokeResult,
  finishedAt: revokeFinishedAt,
});
assert.deepEqual(completionCalls, [`wait:${revokeFinishedAt.toISOString()}`, "enqueue"]);
assert.deepEqual(enqueuedScan, {
  taskRunId: getIsolatedWorkerReceiptScanTaskRunId(revokeTaskRunId),
  payload: {
    type: "isolated_worker_receipt_scan",
    spaceId: authoritySpaceId,
    sessionId,
    turnId,
    userId,
    data: {
      authoritySpaceId,
      disposableSpaceId,
      workerSessionId: sessionId,
      workerTurnId: turnId,
      podUid,
      revokeTaskRunId,
      checkpointId,
      checkpointTreeSha256,
    },
  },
});

let observedDefaultEnqueueAt = 0;
const defaultTimingHook = createIsolatedWorkerRevokeCompletionHook({
  async enqueueReceiptScan() {
    observedDefaultEnqueueAt = Date.now();
  },
});
const immediateFinishedAt = new Date();
await defaultTimingHook({
  taskRunId: revokeTaskRunId,
  payload: revokePayload,
  result: revokeResult,
  finishedAt: immediateFinishedAt,
});
assert.ok(observedDefaultEnqueueAt > immediateFinishedAt.getTime());

const scanPayload = (enqueuedScan as { payload: TaskPayload }).payload;
const revokeStartedAt = new Date("2026-07-15T00:00:00.000Z");
const scanStartedAt = new Date("2026-07-15T00:00:03.001Z");
const scanHandler = createIsolatedWorkerReceiptScanHandler({
  async readRevokeTaskRun(id) {
    assert.equal(id, revokeTaskRunId);
    return {
      id: revokeTaskRunId,
      jobId: revokeTaskRunId,
      taskType: "isolated_worker_revoke",
      status: "completed",
      spaceId: disposableSpaceId,
      sessionId,
      turnId,
      userUuid: userId,
      startedAt: revokeStartedAt,
      finishedAt: revokeFinishedAt,
      payload: revokePayload,
      result: revokeResult,
    };
  },
});
assert.deepEqual(await scanHandler({ taskRunId: scanTaskRunId, startedAt: scanStartedAt, payload: scanPayload }), {
  revokeTaskRunId,
  scanStartedAfterRevoke: true,
  receiptEligible: true,
  checkpointId,
  checkpointTreeSha256,
});

await assert.rejects(
  scanHandler({ taskRunId: scanTaskRunId, startedAt: revokeFinishedAt, payload: scanPayload }),
  /did not start after revoke completion/,
);

const mismatchedScanHandler = createIsolatedWorkerReceiptScanHandler({
  async readRevokeTaskRun() {
    return {
      id: revokeTaskRunId,
      jobId: revokeTaskRunId,
      taskType: "isolated_worker_revoke",
      status: "completed",
      spaceId: disposableSpaceId,
      sessionId,
      turnId,
      userUuid: userId,
      startedAt: revokeStartedAt,
      finishedAt: revokeFinishedAt,
      payload: revokePayload,
      result: {
        ...revokeResult,
        receipt: { ...receipt, checkpointTreeSha256: "c".repeat(64) },
      },
    };
  },
});
await assert.rejects(
  mismatchedScanHandler({ taskRunId: scanTaskRunId, startedAt: scanStartedAt, payload: scanPayload }),
  /checkpoint binding mismatch/,
);

console.log("isolated worker revoke and receipt scan task tests passed");
