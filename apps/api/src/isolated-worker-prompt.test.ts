import assert from "node:assert/strict";
import type { SubmitSessionPromptHooks } from "@cohub/core/sessions";
import {
  assertExactIsolatedWorkerPromptBody,
  parseIsolatedWorkerPolicyInput,
  submitIsolatedWorkerPrompt,
} from "./isolated-worker-prompt.js";

const authoritySpaceId = "7d8f6814-b123-410f-861f-67c07717ac68";
const disposableSpaceId = "6d8f6814-b123-410f-861f-67c07717ac69";
const sessionId = "5212eda6-7336-4b30-8050-e9d27dbc77f0";
const policySha256 = "a".repeat(64);

const policy = parseIsolatedWorkerPolicyInput({
  authoritySpaceId,
  disposableSpaceId,
  writableRoot: "/workspace/work",
  workspaceReadOnly: true,
  executionTokenIssued: false,
  policySha256,
}, disposableSpaceId);

assert.throws(() => parseIsolatedWorkerPolicyInput({ ...policy, workspaceReadOnly: false }, disposableSpaceId), /workspaceReadOnly/);
assert.throws(() => parseIsolatedWorkerPolicyInput({ ...policy, authoritySpaceId: disposableSpaceId }, disposableSpaceId), /differ/);
assert.throws(() => parseIsolatedWorkerPolicyInput({ ...policy, disposableSpaceId: authoritySpaceId }, disposableSpaceId), /binding mismatch/);
assert.throws(() => parseIsolatedWorkerPolicyInput({ ...policy, extra: true }, disposableSpaceId), /unknown field/);

assert.throws(
  () => assertExactIsolatedWorkerPromptBody({
    content: [{ type: "text", text: "work" }],
    userId: "user-1",
    clientMessageId: "client-1",
    source: "isolated_worker_dispatch",
    model: null,
    provider: null,
    accessMode: "isolated_worker",
    isolatedWorkerPolicy: policy,
    inputsMaterializedAt: "2026-07-15T00:00:00.000Z",
    dispatchTaskRunId: "44444444-4444-4444-8444-444444444444",
    context: { kind: "scheduled_task", taskRunId: "44444444-4444-4444-8444-444444444444" },
    inputBundle: { callerSupplied: true },
  }),
  /isolated worker prompt contains unknown field: inputBundle/,
);

const events: string[] = [];
const handle = {
  sessionId,
  turnId: "turn-1",
  podName: `sandbox-${disposableSpaceId}`,
  podCreatedAt: "2026-07-15T00:00:01.000Z",
  isolatedWorkerPolicy: {
    ...policy,
    podUid: "pod-uid-1",
  },
  metadata: {
    worker_identity: { access_mode: "isolated_worker" as const },
    write_scope: { mode: "isolated_task_space" as const, root: "work/" as const },
    disposable_space_id: disposableSpaceId,
    termination_required: true as const,
    workflow_execution_token_issued: false as const,
  },
  status: "running" as const,
  resumable: false as const,
};

let submittedHook: SubmitSessionPromptHooks["beforeEnqueue"];
const result = await submitIsolatedWorkerPrompt({
  policy,
  sessionId,
  turnMeta: { isolatedWorkerDispatch: { taskRunId: "dispatch-1" } },
  submitPrompt: async (promptInput, hooks) => {
    assert.equal(promptInput.spaceId, disposableSpaceId);
    events.push("turn-created");
    submittedHook = hooks.beforeEnqueue;
    const patch = await submittedHook?.({ turnId: "turn-1", userMessageId: "message-1", content: [], meta: {} });
    await hooks.afterMetaPersistedBeforeEnqueue?.({ turnId: "turn-1", userMessageId: "message-1", content: [], meta: {} });
    events.push("enqueued");
    assert.deepEqual(patch, {
      isolatedWorkerDispatch: { taskRunId: "dispatch-1" },
      isolatedWorker: handle,
      isolatedWorkerPolicy: handle.isolatedWorkerPolicy,
    });
    return { turnId: "turn-1", userMessageId: "message-1" };
  },
  createPod: async (input) => {
    events.push(`pod-created:${input.turnId}`);
    return handle;
  },
  onPodCreatedBeforeEnqueue: async () => ({ podCreatedAt: "2026-07-15T00:00:01.000Z" }),
  revokePod: async () => { throw new Error("must not revoke successful prompt"); },
  prompt: {
    spaceId: disposableSpaceId,
    sessionId,
    userId: "user-1",
    clientMessageId: "client-1",
    content: [{ type: "text", text: "work" }],
    source: "internal",
    accessMode: "isolated_worker",
  },
});
assert.deepEqual(result, { turnId: "turn-1", userMessageId: "message-1", podUid: "pod-uid-1", policySha256, podCreatedAt: "2026-07-15T00:00:01.000Z" });
assert.deepEqual(events, ["turn-created", "pod-created:turn-1", "enqueued"]);

events.length = 0;
await assert.rejects(() => submitIsolatedWorkerPrompt({
  policy,
  sessionId,
  submitPrompt: async (_input, hooks) => {
    events.push("turn-created");
    await hooks.beforeEnqueue?.({ turnId: "turn-2", userMessageId: "message-2", content: [], meta: {} });
    throw new Error("persistence failed");
  },
  createPod: async () => {
    events.push("pod-created");
    return { ...handle, turnId: "turn-2" };
  },
  revokePod: async (created) => { events.push(`revoked:${created.turnId}`); return {} as never; },
  prompt: {
    spaceId: disposableSpaceId,
    sessionId,
    userId: "user-1",
    clientMessageId: "client-2",
    content: [{ type: "text", text: "work" }],
    source: "internal",
    accessMode: "isolated_worker",
  },
}), /persistence failed/);
assert.deepEqual(events, ["turn-created", "pod-created", "revoked:turn-2"]);

console.log("isolated worker prompt integration checks passed");
