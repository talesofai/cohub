import assert from "node:assert/strict";
import type { V1Pod } from "@kubernetes/client-node";
import { config } from "./config.js";
import {
  buildIsolatedWorkerSandboxRegistration,
  createIsolatedWorkerPodLifecycle,
  type FrozenCheckpointReadback,
  IsolatedWorkerCheckpointNoEffectError,
  renderIsolatedWorkerPodTemplate,
  type IsolatedWorkerRevocationReceipt,
  validateFrozenCheckpointReadback,
} from "./isolated-worker-pods.js";

const binding = {
  authoritySpaceId: "7d8f6814-b123-410f-861f-67c07717ac68",
  disposableSpaceId: "6d8f6814-b123-410f-861f-67c07717ac69",
  sessionId: "5212eda6-7336-4b30-8050-e9d27dbc77f0",
  turnId: "0212eda6-7336-4b30-8050-e9d27dbc77f1",
};
const policySha256 = "a".repeat(64);
const revocationContext = {
  revokeTaskRunId: "1212eda6-7336-4b30-8050-e9d27dbc77f2",
  automaticTrigger: "turn_terminal_event" as const,
  manualEndpointInvoked: false as const,
};

const pod = renderIsolatedWorkerPodTemplate({
  ...binding,
  image: "registry.example/cohub-sandbox:test",
  spaceStoragePvc: "cohub-spaces-pvc",
  spaceStorageSubpath: "cohub-dev",
  writableRoot: "/workspace/work",
  policySha256,
});

assert.equal(pod.spec?.restartPolicy, "Never");
assert.equal(pod.spec?.automountServiceAccountToken, false);
assert.equal(pod.spec?.enableServiceLinks, false);
assert.deepEqual(pod.spec?.containers?.[0]?.env?.map((item) => item.name), [
  "COHUB_SPACE_ID",
  "WORKSPACE_DIR",
  "IMAGE_VERSION",
  "POD_IP",
]);
assert.equal(pod.spec?.containers?.[0]?.env?.some((item) => /TOKEN|SECRET|KEY|CREDENTIAL/i.test(item.name)), false);
assert.equal(pod.spec?.containers?.[0]?.envFrom, undefined);
assert.deepEqual(pod.spec?.imagePullSecrets, [{ name: "gitea-registry" }]);
assert.equal(pod.spec?.securityContext?.runAsNonRoot, true);
assert.equal(pod.spec?.securityContext?.runAsUser, 1000);
assert.equal(pod.spec?.securityContext?.seccompProfile?.type, "RuntimeDefault");
assert.equal(pod.spec?.containers?.[0]?.securityContext?.allowPrivilegeEscalation, false);
assert.equal(pod.spec?.containers?.[0]?.securityContext?.readOnlyRootFilesystem, true);
assert.deepEqual(pod.spec?.containers?.[0]?.securityContext?.capabilities?.drop, ["ALL"]);
assert.deepEqual(pod.spec?.containers?.[0]?.resources, {
  requests: { cpu: "100m", memory: "256Mi" },
  limits: { cpu: "2", memory: "4Gi" },
});
assert.deepEqual(
  pod.spec?.nodeSelector,
  Object.keys(config.sandboxNodeSelector).length > 0 ? config.sandboxNodeSelector : undefined,
);
assert.deepEqual(
  pod.spec?.tolerations,
  config.sandboxTolerations.length > 0 ? config.sandboxTolerations : undefined,
);
assert.deepEqual(pod.spec?.containers?.[0]?.volumeMounts, [
  {
    name: "space-storage",
    mountPath: "/workspace",
    subPath: `cohub-dev/${binding.disposableSpaceId}/workspace`,
    readOnly: true,
  },
  {
    name: "space-storage",
    mountPath: "/workspace/work",
    subPath: `cohub-dev/${binding.disposableSpaceId}/workspace/work`,
    readOnly: false,
  },
  {
    name: "runtime-tmp",
    mountPath: "/tmp",
  },
]);
assert.deepEqual(pod.spec?.volumes, [
  {
    name: "space-storage",
    persistentVolumeClaim: { claimName: "cohub-spaces-pvc" },
  },
  {
    name: "runtime-tmp",
    emptyDir: {},
  },
]);
assert.equal(pod.metadata?.labels?.["cohub.run/space-id"], binding.disposableSpaceId);
assert.equal(pod.metadata?.labels?.["cohub.run/authority-space-id"], binding.authoritySpaceId);
assert.equal(pod.metadata?.labels?.["cohub.run/session-id"], binding.sessionId);
assert.equal(pod.metadata?.labels?.["cohub.run/turn-id"], binding.turnId);
assert.equal(pod.metadata?.labels?.["cohub.run/disposable-space-id"], binding.disposableSpaceId);
assert.deepEqual(pod.metadata?.annotations, {
  "cohub.run/authority_space_id": binding.authoritySpaceId,
  "cohub.run/worker_identity.access_mode": "isolated_worker",
  "cohub.run/write_scope.mode": "isolated_task_space",
  "cohub.run/write_scope.root": "work/",
  "cohub.run/disposable_space_id": binding.disposableSpaceId,
  "cohub.run/termination_required": "true",
  "cohub.run/workflow_execution_token_issued": "false",
  "cohub.run/policy_sha256": policySha256,
});

for (const writableRoot of [
  "/workspace/tasks/work",
  "/workspace/tasks/not-work",
  "/workspace/tasks/work/child",
  "/workspace/tasks/../work",
  "/tmp/tasks/work",
]) {
  assert.throws(() => renderIsolatedWorkerPodTemplate({
    ...binding,
    image: "sandbox:test",
    spaceStoragePvc: "cohub-spaces-pvc",
    spaceStorageSubpath: "cohub-dev",
    writableRoot,
    policySha256,
  }), /writableRoot/);
}
assert.throws(() => renderIsolatedWorkerPodTemplate({
  ...binding,
  image: "sandbox:test",
  spaceStoragePvc: "cohub-spaces-pvc",
  spaceStorageSubpath: "cohub-dev",
  writableRoot: "/workspace/work",
  policySha256: "not-a-hash",
}), /policySha256/);

const calls: string[] = [];
let createdPod: V1Pod | null = null;
let persistedReceipt: IsolatedWorkerRevocationReceipt | null = null;
let persistedCheckpoint: FrozenCheckpointReadback | null = null;
const lifecycle = createIsolatedWorkerPodLifecycle({
  namespace: "cohub-dev",
  infra: {
    async createPod(input) {
      calls.push(`create:${input.namespace}`);
      createdPod = {
        ...input.pod,
        metadata: { ...input.pod.metadata, uid: "pod-uid-1", creationTimestamp: new Date("2026-07-15T00:00:00.500Z") },
      };
      return createdPod;
    },
    async readPod(input) {
      calls.push(`read:${input.podName}`);
      return createdPod;
    },
    async waitForPodReady(input) {
      calls.push(`ready:${input.podName}`);
      if (!createdPod) return null;
      createdPod = {
        ...createdPod,
        status: {
          podIP: "10.0.0.5",
          conditions: [{ type: "Ready", status: "True" }],
        },
      };
      return createdPod;
    },
    async deletePod(input) {
      calls.push(`delete:${input.podUid}`);
      createdPod = null;
    },
    async waitForPodDeleted(input) {
      calls.push(`wait:${input.podName}`);
      return createdPod === null;
    },
  },
  state: {
    async claimCreate() { calls.push("claim-create"); return true; },
    async markCreateFailed() { calls.push("mark-create-failed"); return true; },
    async markRunning() { calls.push("mark-running"); },
    async readTerminationReceipt() { return persistedReceipt; },
    async claimTermination() {
      calls.push("claim-termination");
      return persistedReceipt === null;
    },
    async markPodDeleted(input) { calls.push("mark-pod-deleted"); return input.podDeletedAt; },
    async claimCheckpoint() { calls.push("claim-checkpoint"); return true; },
    async readCheckpoint() { return persistedCheckpoint; },
    async persistCheckpoint(input) { calls.push("persist-checkpoint"); persistedCheckpoint = input.checkpoint; return true; },
    async completeTermination(input) {
      calls.push("complete-termination");
      persistedReceipt = input.receipt;
      return true;
    },
  },
  async createFrozenCheckpoint() {
    calls.push("checkpoint");
    return {
      disposableSpaceId: binding.disposableSpaceId,
      checkpointId: "checkpoint-1",
      commit: "abc123",
      tree: "tree123",
      treeSha256: "b".repeat(64),
      currentHead: "abc123",
      checkpointCreatedAt: "2099-01-01T00:00:00.000Z",
    };
  },
});

const handle = await lifecycle.create({
  ...binding,
  image: "sandbox:test",
  spaceStoragePvc: "cohub-spaces-pvc",
  spaceStorageSubpath: "cohub-dev",
  writableRoot: "/workspace/work",
  policySha256,
});
assert.deepEqual(handle.metadata, {
  worker_identity: { access_mode: "isolated_worker" },
  write_scope: { mode: "isolated_task_space", root: "work/" },
  disposable_space_id: binding.disposableSpaceId,
  termination_required: true,
  workflow_execution_token_issued: false,
});
assert.deepEqual(handle.isolatedWorkerPolicy, {
  authoritySpaceId: binding.authoritySpaceId,
  disposableSpaceId: binding.disposableSpaceId,
  writableRoot: "/workspace/work",
  workspaceReadOnly: true,
  executionTokenIssued: false,
  podUid: "pod-uid-1",
  policySha256,
});
assert.equal(handle.resumable, false);
assert.equal(handle.status, "running");
assert.equal(handle.podCreatedAt, "2026-07-15T00:00:00.500Z");
if (!createdPod) throw new Error("ready pod was not retained by the test infra");
const boundPod: V1Pod = createdPod;
const registration = buildIsolatedWorkerSandboxRegistration(handle, boundPod);
assert.equal(registration.spaceId, binding.disposableSpaceId);
assert.equal(registration.status, "ready");
assert.equal(registration.runtimeStatus, "healthy");
assert.equal(registration.meta.podIp, "10.0.0.5");
assert.equal(registration.meta.wsEndpoint, "ws://10.0.0.5:8788/sandbox");

const receipt = await lifecycle.revoke(handle, revocationContext);
assert.deepEqual(calls.map((call) => call.split(":")[0]), ["claim-create", "create", "ready", "mark-running", "claim-termination", "read", "delete", "wait", "mark-pod-deleted", "claim-checkpoint", "checkpoint", "persist-checkpoint", "complete-termination"]);
assert.equal(receipt.podUid, "pod-uid-1");
assert.equal(receipt.podDeleted, true);
assert.ok(receipt.podDeletedAt.length > 0);
assert.equal(receipt.credentialRevoked, true);
assert.equal(receipt.sandboxTerminated, true);
assert.equal(receipt.checkpointCreatedAfterPodDeletion, true);
assert.equal(receipt.checkpointAdapter, "trusted_production");
assert.ok(receipt.terminatedAt.length > 0);
assert.equal(receipt.checkpointId, "checkpoint-1");
assert.equal(receipt.checkpointCommit, "abc123");
assert.equal(receipt.checkpointTreeSha256, "b".repeat(64));
assert.equal(receipt.revokeTaskRunId, revocationContext.revokeTaskRunId);
assert.equal(receipt.automaticTrigger, "turn_terminal_event");
assert.equal(receipt.manualEndpointInvoked, false);

const callsAfterFirstRevocation = calls.length;
const repeatedReceipt = await lifecycle.revoke(handle, revocationContext);
assert.deepEqual(repeatedReceipt, receipt, "repeated revocation must return the exact persisted receipt");
assert.equal(calls.length, callsAfterFirstRevocation, "repeated revocation must not delete or checkpoint again");
await assert.rejects(
  () => lifecycle.revoke(handle, {
    ...revocationContext,
    revokeTaskRunId: "2212eda6-7336-4b30-8050-e9d27dbc77f3",
  }),
  /TaskRun binding mismatch/,
);
await assert.rejects(
  () => lifecycle.revoke(handle, {
    ...revocationContext,
    manualEndpointInvoked: true as never,
  }),
  /automatic terminal Turn event/,
);

let inProgressSideEffect = false;
const inProgressLifecycle = createIsolatedWorkerPodLifecycle({
  infra: {
    async createPod() { throw new Error("not used"); },
    async readPod() { inProgressSideEffect = true; return null; },
    async waitForPodReady() { throw new Error("not used"); },
    async deletePod() { inProgressSideEffect = true; },
    async waitForPodDeleted() { inProgressSideEffect = true; return true; },
  },
  state: {
    async claimCreate() { throw new Error("not used"); },
    async markCreateFailed() { throw new Error("not used"); },
    async markRunning() { throw new Error("not used"); },
    async readTerminationReceipt() { return null; },
    async claimTermination() { return false; },
    async markPodDeleted() { inProgressSideEffect = true; return null; },
    async claimCheckpoint() { inProgressSideEffect = true; return false; },
    async readCheckpoint() { inProgressSideEffect = true; return null; },
    async persistCheckpoint() { inProgressSideEffect = true; return false; },
    async completeTermination() { inProgressSideEffect = true; return true; },
  },
  async createFrozenCheckpoint() {
    inProgressSideEffect = true;
    throw new Error("must not checkpoint an already claimed revocation");
  },
});
await assert.rejects(() => inProgressLifecycle.revoke(handle, revocationContext), /already in progress/);
assert.equal(inProgressSideEffect, false);

let concurrentClaims = 0;
let concurrentCheckpoints = 0;
let concurrentReceipt: IsolatedWorkerRevocationReceipt | null = null;
const concurrentLifecycle = createIsolatedWorkerPodLifecycle({
  infra: {
    async createPod() { throw new Error("not used"); },
    async readPod() { return null; },
    async waitForPodReady() { throw new Error("not used"); },
    async deletePod() {},
    async waitForPodDeleted() { return true; },
  },
  state: {
    async claimCreate() { throw new Error("not used"); },
    async markCreateFailed() { throw new Error("not used"); },
    async markRunning() { throw new Error("not used"); },
    async readTerminationReceipt() { return concurrentReceipt; },
    async claimTermination() { concurrentClaims += 1; return true; },
    async markPodDeleted(input) { return input.podDeletedAt; },
    async claimCheckpoint() { return true; },
    async readCheckpoint() { return null; },
    async persistCheckpoint() { return true; },
    async completeTermination(input) { concurrentReceipt = input.receipt; return true; },
  },
  async createFrozenCheckpoint() {
    concurrentCheckpoints += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      disposableSpaceId: binding.disposableSpaceId,
      checkpointId: "checkpoint-concurrent",
      commit: "concurrent123",
      tree: "tree-concurrent",
      treeSha256: "c".repeat(64),
      currentHead: "concurrent123",
      checkpointCreatedAt: "2099-01-01T00:00:00.000Z",
    };
  },
});
const [concurrentFirst, concurrentSecond] = await Promise.all([
  concurrentLifecycle.revoke(handle, revocationContext),
  concurrentLifecycle.revoke(handle, revocationContext),
]);
assert.deepEqual(concurrentSecond, concurrentFirst);
assert.equal(concurrentClaims, 1);
assert.equal(concurrentCheckpoints, 1);

let restartClaimId: string | null = null;
let restartPodDeletedAt: string | null = null;
let restartCheckpointAttemptId: string | null = null;
let restartCheckpointTaskRunId: string | null = null;
let restartCheckpoint: FrozenCheckpointReadback | null = null;
let restartReceipt: IsolatedWorkerRevocationReceipt | null = null;
let restartCheckpointCalls = 0;
let crashBeforeReceipt = true;
const restartState = {
  async claimCreate() { throw new Error("not used"); },
  async markCreateFailed() { throw new Error("not used"); },
  async markRunning() { throw new Error("not used"); },
  async readTerminationReceipt() { return restartReceipt; },
  async claimTermination(input: { claimId: string }) {
    if (restartClaimId && restartClaimId !== input.claimId) return false;
    restartClaimId = input.claimId;
    return true;
  },
  async markPodDeleted(input: { podDeletedAt: string }) {
    restartPodDeletedAt ??= input.podDeletedAt;
    return restartPodDeletedAt;
  },
  async claimCheckpoint(input: { checkpointAttemptId: string; checkpointTaskRunId: string }) {
    if (restartCheckpointAttemptId && restartCheckpointAttemptId !== input.checkpointAttemptId) return false;
    if (restartCheckpointTaskRunId && restartCheckpointTaskRunId !== input.checkpointTaskRunId) return false;
    restartCheckpointAttemptId = input.checkpointAttemptId;
    restartCheckpointTaskRunId = input.checkpointTaskRunId;
    return true;
  },
  async readCheckpoint() { return restartCheckpoint; },
  async persistCheckpoint(input: { checkpoint: FrozenCheckpointReadback }) {
    restartCheckpoint = input.checkpoint;
    return true;
  },
  async completeTermination(input: { receipt: IsolatedWorkerRevocationReceipt }) {
    if (crashBeforeReceipt) {
      crashBeforeReceipt = false;
      throw new Error("simulated crash before receipt persistence");
    }
    restartReceipt = input.receipt;
    return true;
  },
};
const restartInfra = {
  async createPod() { throw new Error("not used"); },
  async readPod() { return null; },
  async waitForPodReady() { throw new Error("not used"); },
  async deletePod() {},
  async waitForPodDeleted() { return true; },
};
const restartCheckpointFactory = async () => {
  restartCheckpointCalls += 1;
  return {
    disposableSpaceId: binding.disposableSpaceId,
    checkpointId: "checkpoint-restart",
    commit: "restart123",
    tree: "tree-restart",
    treeSha256: "d".repeat(64),
    currentHead: "restart123",
    checkpointCreatedAt: "2099-01-01T00:00:00.000Z",
  };
};
await assert.rejects(
  () => createIsolatedWorkerPodLifecycle({ infra: restartInfra, state: restartState, createFrozenCheckpoint: restartCheckpointFactory }).revoke(handle, revocationContext),
  /simulated crash/,
);
const restartedReceipt = await createIsolatedWorkerPodLifecycle({
  infra: restartInfra,
  state: restartState,
  createFrozenCheckpoint: restartCheckpointFactory,
}).revoke(handle, revocationContext);
assert.equal(restartCheckpointCalls, 1, "restart after checkpoint must reuse persisted checkpoint readback");
assert.equal(restartedReceipt.checkpointId, "checkpoint-restart");
assert.ok(restartClaimId);
assert.ok(restartPodDeletedAt);
assert.ok(restartCheckpointAttemptId);
assert.match(restartCheckpointTaskRunId ?? "", /^[a-f0-9-]{36}$/);

let retryAttemptBinding: { checkpointAttemptId: string; checkpointTaskRunId: string } | null = null;
let retryRotations = 0;
let retryCheckpoint: FrozenCheckpointReadback | null = null;
const retryState = {
  async claimCreate() { throw new Error("not used"); },
  async markCreateFailed() { throw new Error("not used"); },
  async markRunning() { throw new Error("not used"); },
  async readTerminationReceipt() { return null; },
  async claimTermination() { return true; },
  async markPodDeleted(input: { podDeletedAt: string }) { return input.podDeletedAt; },
  async claimCheckpoint(input: { checkpointAttemptId: string; checkpointTaskRunId: string }) {
    retryAttemptBinding ??= input;
    return retryAttemptBinding;
  },
  async rotateCheckpoint(input: {
    checkpointAttemptId: string;
    checkpointTaskRunId: string;
    nextCheckpointAttemptId: string;
    nextCheckpointTaskRunId: string;
  }) {
    if (
      retryAttemptBinding?.checkpointAttemptId !== input.checkpointAttemptId
      || retryAttemptBinding.checkpointTaskRunId !== input.checkpointTaskRunId
    ) return retryAttemptBinding;
    retryRotations += 1;
    retryAttemptBinding = {
      checkpointAttemptId: input.nextCheckpointAttemptId,
      checkpointTaskRunId: input.nextCheckpointTaskRunId,
    };
    return retryAttemptBinding;
  },
  async readCheckpoint() { return retryCheckpoint; },
  async persistCheckpoint(input: { checkpoint: FrozenCheckpointReadback }) {
    retryCheckpoint = input.checkpoint;
    return true;
  },
  async completeTermination() { return true; },
};
const retryTaskRunIds: string[] = [];
const retryReceipt = await createIsolatedWorkerPodLifecycle({
  infra: restartInfra,
  state: retryState,
  createFrozenCheckpoint: async (_handle, _attemptId, taskRunId) => {
    retryTaskRunIds.push(taskRunId);
    if (retryTaskRunIds.length === 1) {
      throw new IsolatedWorkerCheckpointNoEffectError("checkpoint TaskRun failed with proven no effect");
    }
    return {
      disposableSpaceId: binding.disposableSpaceId,
      checkpointId: "checkpoint-after-cas-retry",
      commit: "retry123",
      tree: "tree-retry",
      treeSha256: "e".repeat(64),
      currentHead: "retry123",
      checkpointCreatedAt: "2099-01-01T00:00:00.000Z",
    };
  },
}).revoke(handle, revocationContext);
assert.equal(retryRotations, 1, "proven no-effect failure must CAS to a new persisted checkpoint attempt");
assert.equal(new Set(retryTaskRunIds).size, 2, "checkpoint retry must use a new deterministic TaskRun ID");
assert.equal(retryReceipt.checkpointId, "checkpoint-after-cas-retry");

let responseCrashReceipt: IsolatedWorkerRevocationReceipt | null = null;
let responseCrashCheckpoint: FrozenCheckpointReadback | null = null;
let responseCrashPersist = true;
const responseCrashTaskRunIds: string[] = [];
const responseCrashState = {
  async claimCreate() { throw new Error("not used"); },
  async markCreateFailed() { throw new Error("not used"); },
  async markRunning() { throw new Error("not used"); },
  async readTerminationReceipt() { return responseCrashReceipt; },
  async claimTermination() { return true; },
  async markPodDeleted() { return "2026-01-01T00:00:00.000Z"; },
  async claimCheckpoint(input: { checkpointAttemptId: string; checkpointTaskRunId: string }) { return input; },
  async readCheckpoint() { return responseCrashCheckpoint; },
  async persistCheckpoint(input: { checkpoint: FrozenCheckpointReadback }) {
    if (responseCrashPersist) {
      responseCrashPersist = false;
      throw new Error("simulated crash after checkpoint response before sandbox persistence");
    }
    responseCrashCheckpoint = input.checkpoint;
    return true;
  },
  async completeTermination(input: { receipt: IsolatedWorkerRevocationReceipt }) {
    responseCrashReceipt = input.receipt;
    return true;
  },
};
const authoritativeResponseCrashCheckpoint = {
  disposableSpaceId: binding.disposableSpaceId,
  checkpointId: "checkpoint-response-crash",
  commit: "response123",
  tree: "tree-response-crash",
  treeSha256: "f".repeat(64),
  currentHead: "response123",
  checkpointCreatedAt: "2099-01-01T00:00:00.000Z",
};
const responseCrashFactory = async (_handle: unknown, _attemptId: string, taskRunId: string) => {
  responseCrashTaskRunIds.push(taskRunId);
  return authoritativeResponseCrashCheckpoint;
};
await assert.rejects(
  () => createIsolatedWorkerPodLifecycle({
    infra: restartInfra,
    state: responseCrashState,
    createFrozenCheckpoint: responseCrashFactory,
  }).revoke(handle, revocationContext),
  /simulated crash after checkpoint response/,
);
const responseCrashRecovered = await createIsolatedWorkerPodLifecycle({
  infra: restartInfra,
  state: responseCrashState,
  createFrozenCheckpoint: responseCrashFactory,
}).revoke(handle, revocationContext);
assert.equal(new Set(responseCrashTaskRunIds).size, 1, "restart before sandbox persistence must reuse the persisted TaskRun binding");
assert.equal(responseCrashRecovered.checkpointId, authoritativeResponseCrashCheckpoint.checkpointId);

let doubleWorkerReceipt: IsolatedWorkerRevocationReceipt | null = null;
let doubleWorkerCheckpoint: FrozenCheckpointReadback | null = null;
let doubleWorkerCompletionClaims = 0;
const doubleWorkerState = {
  async claimCreate() { throw new Error("not used"); },
  async markCreateFailed() { throw new Error("not used"); },
  async markRunning() { throw new Error("not used"); },
  async readTerminationReceipt() { return doubleWorkerReceipt; },
  async claimTermination() { return true; },
  async markPodDeleted() { return "2026-01-01T00:00:00.000Z"; },
  async claimCheckpoint(input: { checkpointAttemptId: string; checkpointTaskRunId: string }) { return input; },
  async readCheckpoint() { return doubleWorkerCheckpoint; },
  async persistCheckpoint(input: { checkpoint: FrozenCheckpointReadback }) {
    doubleWorkerCheckpoint ??= input.checkpoint;
    return true;
  },
  async completeTermination(input: { receipt: IsolatedWorkerRevocationReceipt }) {
    doubleWorkerCompletionClaims += 1;
    if (doubleWorkerReceipt) return false;
    doubleWorkerReceipt = input.receipt;
    return true;
  },
};
const doubleWorkerTaskRunIds: string[] = [];
const doubleWorkerFactory = async (_handle: unknown, _attemptId: string, taskRunId: string) => {
  doubleWorkerTaskRunIds.push(taskRunId);
  await new Promise((resolve) => setTimeout(resolve, 5));
  return {
    disposableSpaceId: binding.disposableSpaceId,
    checkpointId: "checkpoint-double-worker",
    commit: "double123",
    tree: "tree-double-worker",
    treeSha256: "1".repeat(64),
    currentHead: "double123",
    checkpointCreatedAt: "2099-01-01T00:00:00.000Z",
  };
};
const doubleWorkerA = createIsolatedWorkerPodLifecycle({ infra: restartInfra, state: doubleWorkerState, createFrozenCheckpoint: doubleWorkerFactory });
const doubleWorkerB = createIsolatedWorkerPodLifecycle({ infra: restartInfra, state: doubleWorkerState, createFrozenCheckpoint: doubleWorkerFactory });
const [doubleWorkerReceiptA, doubleWorkerReceiptB] = await Promise.all([
  doubleWorkerA.revoke(handle, revocationContext),
  doubleWorkerB.revoke(handle, revocationContext),
]);
assert.deepEqual(doubleWorkerReceiptB, doubleWorkerReceiptA, "losing termination CAS must return the exact winning receipt");
assert.equal(new Set(doubleWorkerTaskRunIds).size, 1, "double workers must share one deterministic checkpoint TaskRun binding");
assert.equal(doubleWorkerCompletionClaims, 2);

let terminalCreateAttempted = false;
const terminalCreateLifecycle = createIsolatedWorkerPodLifecycle({
  infra: {
    async createPod() { terminalCreateAttempted = true; throw new Error("pod must not be created"); },
    async readPod() { return null; },
    async waitForPodReady() { return null; },
    async deletePod() {},
    async waitForPodDeleted() { return true; },
  },
  state: {
    async claimCreate() { return false; },
    async markCreateFailed() { return false; },
    async markRunning() {},
    async readTerminationReceipt() { return null; },
    async claimTermination() { return false; },
    async markPodDeleted() { return null; },
    async claimCheckpoint() { return false; },
    async readCheckpoint() { return null; },
    async persistCheckpoint() { return false; },
    async completeTermination() { return false; },
  },
});
await assert.rejects(() => terminalCreateLifecycle.create({
  ...binding,
  image: "sandbox:test",
  spaceStoragePvc: "cohub-spaces-pvc",
  spaceStorageSubpath: "cohub-dev",
  writableRoot: "/workspace/work",
  policySha256,
}), /not allocated or has already been used/);
assert.equal(terminalCreateAttempted, false);

let createFailureMarked = false;
const failedCreateLifecycle = createIsolatedWorkerPodLifecycle({
  infra: {
    async createPod() { throw new Error("kubernetes rejected pod"); },
    async readPod() { return null; },
    async waitForPodReady() { throw new Error("not used"); },
    async deletePod() {},
    async waitForPodDeleted() { return true; },
  },
  state: {
    async claimCreate() { return true; },
    async markCreateFailed() { createFailureMarked = true; return true; },
    async markRunning() { throw new Error("not used"); },
    async readTerminationReceipt() { return null; },
    async claimTermination() { return false; },
    async markPodDeleted() { return null; },
    async claimCheckpoint() { return false; },
    async readCheckpoint() { return null; },
    async persistCheckpoint() { return false; },
    async completeTermination() { return false; },
  },
});
await assert.rejects(() => failedCreateLifecycle.create({
  ...binding,
  image: "sandbox:test",
  spaceStoragePvc: "cohub-spaces-pvc",
  spaceStorageSubpath: "cohub-dev",
  writableRoot: "/workspace/work",
  policySha256,
}), /kubernetes rejected pod/);
assert.equal(createFailureMarked, true, "a proven no-pod create failure must leave a terminal allocation state");

let lostResponsePod: V1Pod | null = null;
let lostResponseMarkedRunning = false;
const lostResponseLifecycle = createIsolatedWorkerPodLifecycle({
  infra: {
    async createPod(input) {
      lostResponsePod = { ...input.pod, metadata: { ...input.pod.metadata, uid: "pod-uid-lost", creationTimestamp: new Date("2026-07-15T00:00:00.750Z") } };
      throw new Error("response lost after server create");
    },
    async readPod() { return lostResponsePod; },
    async waitForPodReady() {
      return lostResponsePod
        ? { ...lostResponsePod, status: { podIP: "10.0.0.9", conditions: [{ type: "Ready", status: "True" }] } }
        : null;
    },
    async deletePod() { lostResponsePod = null; },
    async waitForPodDeleted() { return lostResponsePod === null; },
  },
  state: {
    async claimCreate() { return true; },
    async markCreateFailed() { throw new Error("must not mark reconciled pod failed"); },
    async markRunning() { lostResponseMarkedRunning = true; },
    async readTerminationReceipt() { return null; },
    async claimTermination() { return false; },
    async markPodDeleted() { return null; },
    async claimCheckpoint() { return false; },
    async readCheckpoint() { return null; },
    async persistCheckpoint() { return false; },
    async completeTermination() { return false; },
  },
});
const lostResponseHandle = await lostResponseLifecycle.create({
  ...binding,
  image: "sandbox:test",
  spaceStoragePvc: "cohub-spaces-pvc",
  spaceStorageSubpath: "cohub-dev",
  writableRoot: "/workspace/work",
  policySha256,
});
assert.equal(lostResponseHandle.isolatedWorkerPolicy.podUid, "pod-uid-lost");
assert.equal(lostResponseMarkedRunning, true);

const timeoutLifecycle = createIsolatedWorkerPodLifecycle({
  namespace: "cohub-dev",
  infra: {
    async createPod() { throw new Error("not used"); },
    async readPod() { return { metadata: { ...pod.metadata, uid: "pod-uid-1" } }; },
    async waitForPodReady() { throw new Error("not used"); },
    async deletePod() {},
    async waitForPodDeleted() { return false; },
  },
  state: {
    async claimCreate() { throw new Error("not used"); },
    async markCreateFailed() { throw new Error("not used"); },
    async markRunning() { throw new Error("not used"); },
    async readTerminationReceipt() { return null; },
    async claimTermination() { return true; },
    async markPodDeleted() { throw new Error("must not mark deleted before deletion"); },
    async claimCheckpoint() { throw new Error("must not checkpoint before deletion"); },
    async readCheckpoint() { throw new Error("must not checkpoint before deletion"); },
    async persistCheckpoint() { throw new Error("must not checkpoint before deletion"); },
    async completeTermination() { throw new Error("must not mark terminated before deletion"); },
  },
  async createFrozenCheckpoint() { throw new Error("must not checkpoint before deletion"); },
});
await assert.rejects(() => timeoutLifecycle.revoke(handle, revocationContext), /timed out/);

let wrongUidDeleted = false;
const wrongUidLifecycle = createIsolatedWorkerPodLifecycle({
  namespace: "cohub-dev",
  infra: {
    async createPod() { throw new Error("not used"); },
    async readPod() {
      return { ...boundPod, metadata: { ...boundPod.metadata, uid: "different-pod-uid" } };
    },
    async waitForPodReady() { throw new Error("not used"); },
    async deletePod() { wrongUidDeleted = true; },
    async waitForPodDeleted() { throw new Error("must not wait after binding mismatch"); },
  },
  state: {
    async claimCreate() { throw new Error("not used"); },
    async markCreateFailed() { throw new Error("not used"); },
    async markRunning() { throw new Error("not used"); },
    async readTerminationReceipt() { return null; },
    async claimTermination() { return true; },
    async markPodDeleted() { throw new Error("must not mark mismatched pod deleted"); },
    async claimCheckpoint() { throw new Error("must not checkpoint mismatched pod"); },
    async readCheckpoint() { throw new Error("must not checkpoint mismatched pod"); },
    async persistCheckpoint() { throw new Error("must not checkpoint mismatched pod"); },
    async completeTermination() { throw new Error("must not terminate mismatched pod"); },
  },
  async createFrozenCheckpoint() { throw new Error("must not checkpoint mismatched pod"); },
});
await assert.rejects(() => wrongUidLifecycle.revoke(handle, revocationContext), /UID mismatch/);
assert.equal(wrongUidDeleted, false);

const validCheckpoint = {
  disposableSpaceId: binding.disposableSpaceId,
  checkpointId: "checkpoint-1",
  commit: "abc123",
  tree: "tree123",
  treeSha256: "b".repeat(64),
  currentHead: "abc123",
  checkpointCreatedAt: "2099-01-01T00:00:00.000Z",
};
assert.throws(() => validateFrozenCheckpointReadback(handle, { ...validCheckpoint, disposableSpaceId: binding.authoritySpaceId }), /binding mismatch/);
assert.throws(() => validateFrozenCheckpointReadback(handle, { ...validCheckpoint, commit: "" }), /incomplete/);
assert.throws(() => validateFrozenCheckpointReadback(handle, { ...validCheckpoint, currentHead: "older-head" }), /current head/);

console.log("isolated worker pod template and lifecycle checks passed");
