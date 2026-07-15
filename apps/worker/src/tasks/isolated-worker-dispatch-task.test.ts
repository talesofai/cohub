import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createIsolatedWorkerDispatchHandler,
  IsolatedWorkerDispatchRejectedError,
} from "./isolated-worker-dispatch-handler.js";

const taskRunId = "33333333-3333-4333-8333-333333333333";
const authoritySpaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const disposableSpaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const policySha256 = "a".repeat(64);
const inputBundleManifest = {
  authorityCheckpointId: "99999999-9999-4999-8999-999999999999",
  authorityCheckpointCommit: "c".repeat(40),
  authorityTreeSha256: "e".repeat(64),
  items: [{ sourcePath: "modules/task.md", destinationPath: "inputs/task.md", contentSha256: "f".repeat(64), sourceType: "regular_file" as const }],
};
const canonical = (value: unknown): string => value === null || typeof value !== "object"
  ? JSON.stringify(value)
  : Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
const inputManifestSha256 = createHash("sha256").update(canonical(inputBundleManifest)).digest("hex");
const inputBundle = { ...inputBundleManifest, inputManifestSha256, runtimeAuthorityReadAllowed: false as const };
const dispatchData = {
  authoritySpaceId,
  disposableSpaceId,
  sessionId,
  clientMessageId: "client-1",
  content: [{ type: "text" as const, text: "hello" }],
  source: "isolated_worker_dispatch",
  model: null,
  provider: null,
  policySha256,
  inputBundle,
  inputManifestSha256,
  creationPath: "dedicated_disposable_space_without_standard_sandbox" as const,
  ordinarySandboxProvisioned: false as const,
  terminatedSpaceReused: false as const,
  credentialMode: "engine_scoped_dispatch_authority" as const,
  engineInternalSecretIssued: false as const,
  publicPromptUsed: false as const,
  checkpointAdapter: "trusted_production" as const,
};
const calls: string[] = [];

const handler = createIsolatedWorkerDispatchHandler({
  async recoverReservation() {
    calls.push("recover");
    return { state: "none" };
  },
  async readReservation() {
    calls.push("read");
    return {
      authoritySpaceId,
      disposableSpaceId,
      sessionId,
      userId: "user-1",
      sandboxStatus: "allocated",
      sandboxPodName: null,
      allocation: { state: "allocated", authoritySpaceId, disposableSpaceId, inputBundle, resumable: false },
    };
  },
  async prepareWorkspace(input) {
    calls.push(`prepare:${input.disposableSpaceId}`);
    return { inputsMaterializedAt: "2026-07-15T00:00:00.000Z", preparedWorkspace: "/stage" };
  },
  async cleanupPreparedWorkspace() {
    calls.push("unexpected-cleanup");
  },
  async allocateReservation(input) {
    calls.push(`allocate:${input.data.disposableSpaceId}`);
  },
  async publishWorkspace() {
    calls.push("publish");
  },
  async rollbackReservation() {
    calls.push("unexpected-rollback");
  },
  async submitInternal(input) {
    calls.push(`submit:${input.dispatchTaskRunId}`);
    assert.equal("authToken" in input, false);
    assert.equal("workerSecret" in input, false);
    return { turnId: "44444444-4444-4444-8444-444444444444", podUid: "pod-uid-1", policySha256, podCreatedAt: "2026-07-15T00:00:01.000Z" };
  },
});

const result = await handler({
  taskRunId,
  payload: {
    type: "isolated_worker_dispatch",
    spaceId: authoritySpaceId,
    sessionId,
    userId: "user-1",
    data: dispatchData,
  },
});
assert.deepEqual(calls, ["recover", `prepare:${disposableSpaceId}`, `allocate:${disposableSpaceId}`, "publish", "read", `submit:${taskRunId}`]);
assert.deepEqual(result, {
  authoritySpaceId,
  disposableSpaceId,
  sessionId,
  turnId: "44444444-4444-4444-8444-444444444444",
  podUid: "pod-uid-1",
  policySha256,
  authorityCheckpointId: inputBundle.authorityCheckpointId,
  authorityCheckpointCommit: inputBundle.authorityCheckpointCommit,
  authorityTreeSha256: inputBundle.authorityTreeSha256,
  inputManifestSha256,
  inputCount: 1,
  inputsMaterializedAt: "2026-07-15T00:00:00.000Z",
  podCreatedAt: "2026-07-15T00:00:01.000Z",
  ordinarySandboxProvisioned: false,
  terminatedSpaceReused: false,
  executionTokenIssued: false,
  authorityExecutionTokenIssued: false,
  engineInternalSecretIssued: false,
  publicPromptUsed: false,
  checkpointAdapterReady: true,
});

const recoveredCalls: string[] = [];
const recoveredHandler = createIsolatedWorkerDispatchHandler({
  async recoverReservation() {
    recoveredCalls.push("recover-submitted");
    return { state: "submitted", result };
  },
  async readReservation() { throw new Error("submitted retry must not read allocation"); },
  async prepareWorkspace() { throw new Error("submitted retry must not rematerialize inputs"); },
  async cleanupPreparedWorkspace() { throw new Error("submitted retry must not clean workspace"); },
  async allocateReservation() { throw new Error("submitted retry must not allocate"); },
  async publishWorkspace() { throw new Error("submitted retry must not publish"); },
  async rollbackReservation() { throw new Error("submitted retry must not roll back"); },
  async submitInternal() { throw new Error("submitted retry must not submit a second prompt"); },
});
assert.deepEqual(await recoveredHandler({
  taskRunId,
  payload: {
    type: "isolated_worker_dispatch",
    spaceId: authoritySpaceId,
    sessionId,
    userId: "user-1",
    data: dispatchData,
  },
}), result);
assert.deepEqual(recoveredCalls, ["recover-submitted"]);

await assert.rejects(
  handler({
    taskRunId: "77777777-7777-4777-8777-777777777777",
    payload: {
      type: "isolated_worker_dispatch",
      spaceId: authoritySpaceId,
      sessionId,
      userId: "user-1",
      data: { ...dispatchData, callerForgedReceipt: "accepted" },
    },
  }),
  /isolated worker dispatch contains unknown field: callerForgedReceipt/,
);

await assert.rejects(
  handler({
    taskRunId: "88888888-8888-4888-8888-888888888888",
    payload: {
      type: "isolated_worker_dispatch",
      spaceId: authoritySpaceId,
      sessionId,
      userId: "user-1",
      data: {
        ...dispatchData,
        inputBundle: { ...inputBundle, callerForgedAuthority: true },
      },
    },
  }),
  /isolated worker input bundle contains unknown field: callerForgedAuthority/,
);

const reject = createIsolatedWorkerDispatchHandler({
  async recoverReservation() {
    throw new Error("must not recover a terminated workspace");
  },
  async readReservation() {
    throw new Error("must not read a reusable allocation");
  },
  async prepareWorkspace() {
    throw new Error("must not prepare a terminated workspace");
  },
  async cleanupPreparedWorkspace() {
    throw new Error("must not clean a terminated workspace");
  },
  async allocateReservation() {
    throw new Error("must not allocate a terminated workspace");
  },
  async publishWorkspace() {
    throw new Error("must not publish a terminated workspace");
  },
  async rollbackReservation() {
    throw new Error("must not roll back a terminated workspace");
  },
  async submitInternal() {
    throw new Error("must not submit a terminated worker");
  },
});
await assert.rejects(
  reject({
    taskRunId: "55555555-5555-4555-8555-555555555555",
    payload: {
      type: "isolated_worker_dispatch",
      spaceId: authoritySpaceId,
      sessionId,
      userId: "user-1",
      data: {
        authoritySpaceId,
        disposableSpaceId,
        reuseRejected: true,
        reason: "terminated_space_reuse_forbidden",
      },
    },
  }),
  (error: unknown) => {
    assert.ok(error instanceof IsolatedWorkerDispatchRejectedError);
    assert.deepEqual(error.taskResult, { disposableSpaceId, rejected: true, reason: "terminated_space_reuse_forbidden" });
    return true;
  },
);

for (const probe of [
  { message: "manifest source is not a regular file: link", reason: "input_symlink_forbidden" },
  { message: "input hash mismatch: modules/task.md", reason: "input_hash_mismatch" },
  { message: "unsafe manifest path: ../secret", reason: "input_path_forbidden" },
  { message: "ENOENT: no such file or directory", reason: "input_undeclared" },
] as const) {
  const failureCalls: string[] = [];
  const rejectInput = createIsolatedWorkerDispatchHandler({
    async recoverReservation() {
      failureCalls.push("recover");
      return { state: "none" };
    },
    async prepareWorkspace() {
      failureCalls.push("prepare");
      throw new Error(probe.message);
    },
    async cleanupPreparedWorkspace() {
      failureCalls.push("cleanup");
    },
    async allocateReservation() {
      failureCalls.push("allocate");
    },
    async publishWorkspace() {
      failureCalls.push("publish");
    },
    async rollbackReservation() {
      failureCalls.push("rollback");
    },
    async readReservation() {
      failureCalls.push("read");
      throw new Error("must not read after failed preflight");
    },
    async submitInternal() {
      failureCalls.push("submit");
      throw new Error("must not submit after failed preflight");
    },
  });
  await assert.rejects(
    rejectInput({
      taskRunId,
      payload: {
        type: "isolated_worker_dispatch",
        spaceId: authoritySpaceId,
        sessionId,
        userId: "user-1",
        data: dispatchData,
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof IsolatedWorkerDispatchRejectedError);
      assert.deepEqual(error.taskResult, {
        disposableSpaceId,
        rejected: true,
        reason: probe.reason,
        podCreated: false,
        disposableSpaceCreated: false,
        authorityExecutionTokenIssued: false,
      });
      return true;
    },
  );
  assert.deepEqual(failureCalls, ["recover", "prepare"]);
}

const allocationFailureCalls: string[] = [];
const allocationFailure = createIsolatedWorkerDispatchHandler({
  async recoverReservation() {
    allocationFailureCalls.push("recover");
    return { state: "none" };
  },
  async prepareWorkspace() {
    allocationFailureCalls.push("prepare");
    return { inputsMaterializedAt: "2026-07-15T00:00:00.000Z", preparedWorkspace: "/stage" };
  },
  async cleanupPreparedWorkspace() {
    allocationFailureCalls.push("cleanup");
  },
  async allocateReservation() {
    allocationFailureCalls.push("allocate");
    throw new Error("allocation kill point");
  },
  async publishWorkspace() {
    allocationFailureCalls.push("publish");
  },
  async rollbackReservation() {
    allocationFailureCalls.push("rollback");
  },
  async readReservation() {
    allocationFailureCalls.push("read");
    throw new Error("must not read after allocation failure");
  },
  async submitInternal() {
    allocationFailureCalls.push("submit");
    throw new Error("must not submit after allocation failure");
  },
});
await assert.rejects(
  allocationFailure({
    taskRunId,
    payload: { type: "isolated_worker_dispatch", spaceId: authoritySpaceId, sessionId, userId: "user-1", data: dispatchData },
  }),
  /allocation kill point/,
);
assert.deepEqual(allocationFailureCalls, ["recover", "prepare", "allocate", "cleanup"]);

const publishFailureCalls: string[] = [];
const publishFailure = createIsolatedWorkerDispatchHandler({
  async recoverReservation() {
    publishFailureCalls.push("recover");
    return { state: "none" };
  },
  async prepareWorkspace() {
    publishFailureCalls.push("prepare");
    return { inputsMaterializedAt: "2026-07-15T00:00:00.000Z", preparedWorkspace: "/stage" };
  },
  async cleanupPreparedWorkspace() {
    publishFailureCalls.push("cleanup");
  },
  async allocateReservation() {
    publishFailureCalls.push("allocate");
  },
  async publishWorkspace() {
    publishFailureCalls.push("publish");
    throw new Error("publish kill point");
  },
  async rollbackReservation() {
    publishFailureCalls.push("rollback");
  },
  async readReservation() {
    publishFailureCalls.push("read");
    throw new Error("must not read after publish failure");
  },
  async submitInternal() {
    publishFailureCalls.push("submit");
    throw new Error("must not submit after publish failure");
  },
});
await assert.rejects(
  publishFailure({
    taskRunId,
    payload: { type: "isolated_worker_dispatch", spaceId: authoritySpaceId, sessionId, userId: "user-1", data: dispatchData },
  }),
  /publish kill point/,
);
assert.deepEqual(publishFailureCalls, ["recover", "prepare", "allocate", "publish", "rollback"]);

const publishAndRollbackFailure = createIsolatedWorkerDispatchHandler({
  async recoverReservation() { return { state: "none" }; },
  async prepareWorkspace() {
    return { inputsMaterializedAt: "2026-07-15T00:00:00.000Z", preparedWorkspace: "/stage" };
  },
  async cleanupPreparedWorkspace() {},
  async allocateReservation() {},
  async publishWorkspace() { throw new Error("publish root cause"); },
  async rollbackReservation() { throw new Error("rollback root cause"); },
  async readReservation() { throw new Error("must not read after publish failure"); },
  async submitInternal() { throw new Error("must not submit after publish failure"); },
});
await assert.rejects(
  publishAndRollbackFailure({
    taskRunId,
    payload: { type: "isolated_worker_dispatch", spaceId: authoritySpaceId, sessionId, userId: "user-1", data: dispatchData },
  }),
  /publish root cause.*rollback root cause/,
);

for (const recoveryState of ["staged", "prepared", "published"] as const) {
  const recoveryCalls: string[] = [];
  const recovery = createIsolatedWorkerDispatchHandler({
    async recoverReservation() {
      recoveryCalls.push("recover");
      return {
        state: recoveryState,
        inputsMaterializedAt: "2026-07-15T00:00:00.000Z",
        preparedWorkspace: "/stage",
      };
    },
    async prepareWorkspace() {
      recoveryCalls.push("prepare");
      throw new Error("recovery must not rematerialize inputs");
    },
    async cleanupPreparedWorkspace() {
      recoveryCalls.push("cleanup");
    },
    async allocateReservation() {
      recoveryCalls.push("allocate");
    },
    async publishWorkspace() {
      recoveryCalls.push("publish");
    },
    async rollbackReservation() {
      recoveryCalls.push("rollback");
    },
    async readReservation() {
      recoveryCalls.push("read");
      return {
        authoritySpaceId,
        disposableSpaceId,
        sessionId,
        userId: "user-1",
        sandboxStatus: "allocated",
        sandboxPodName: null,
        allocation: { state: "allocated", authoritySpaceId, disposableSpaceId, inputBundle, resumable: false },
      };
    },
    async submitInternal() {
      recoveryCalls.push("submit");
      return {
        turnId: "44444444-4444-4444-8444-444444444444",
        podUid: "pod-uid-1",
        policySha256,
        podCreatedAt: "2026-07-15T00:00:01.000Z",
      };
    },
  });
  await recovery({
    taskRunId,
    payload: { type: "isolated_worker_dispatch", spaceId: authoritySpaceId, sessionId, userId: "user-1", data: dispatchData },
  });
  assert.deepEqual(
    recoveryCalls,
    recoveryState === "staged"
      ? ["recover", "allocate", "publish", "read", "submit"]
      : recoveryState === "prepared"
        ? ["recover", "publish", "read", "submit"]
        : ["recover", "read", "submit"],
  );
}

let concurrentPhase: "none" | "prepared" | "published" = "none";
let prepareCount = 0;
let allocateCount = 0;
let publishCount = 0;
const concurrent = createIsolatedWorkerDispatchHandler({
  async recoverReservation() {
    if (concurrentPhase === "none") return { state: "none" };
    return {
      state: concurrentPhase,
      inputsMaterializedAt: "2026-07-15T00:00:00.000Z",
      preparedWorkspace: "/stage",
    };
  },
  async prepareWorkspace() {
    prepareCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { inputsMaterializedAt: "2026-07-15T00:00:00.000Z", preparedWorkspace: "/stage" };
  },
  async cleanupPreparedWorkspace() {},
  async allocateReservation() {
    allocateCount += 1;
    concurrentPhase = "prepared";
  },
  async publishWorkspace() {
    publishCount += 1;
    concurrentPhase = "published";
  },
  async rollbackReservation() {},
  async readReservation() {
    return {
      authoritySpaceId,
      disposableSpaceId,
      sessionId,
      userId: "user-1",
      sandboxStatus: "allocated",
      sandboxPodName: null,
      allocation: { state: "allocated", authoritySpaceId, disposableSpaceId, inputBundle, resumable: false },
    };
  },
  async submitInternal() {
    return {
      turnId: "44444444-4444-4444-8444-444444444444",
      podUid: "pod-uid-1",
      policySha256,
      podCreatedAt: "2026-07-15T00:00:01.000Z",
    };
  },
});
const concurrentPayload = { type: "isolated_worker_dispatch" as const, spaceId: authoritySpaceId, sessionId, userId: "user-1", data: dispatchData };
const [firstConcurrent, secondConcurrent] = await Promise.all([
  concurrent({ taskRunId, payload: concurrentPayload }),
  concurrent({ taskRunId, payload: concurrentPayload }),
]);
assert.deepEqual(firstConcurrent, secondConcurrent);
assert.equal(prepareCount, 1);
assert.equal(allocateCount, 1);
assert.equal(publishCount, 1);

console.log("isolated worker dispatch task checks passed");
