import assert from "node:assert/strict";
import { submitSessionPrompt, type SessionPromptDependencies } from "./prompt.js";

const events: string[] = [];
let enqueuedMeta: Record<string, unknown> | null = null;

const deps: SessionPromptDependencies = {
  randomUUID: () => "message-1",
  expandPromptTemplate: async () => null,
  sandboxRecovery: {
    maybeRecoverForPrompt: async () => { events.push("sandbox-recovered"); },
  },
  createSessionTurn: async () => {
    events.push("turn-created");
    return { id: "turn-1" };
  },
  mergeSessionTurnMeta: async () => {
    events.push("meta-persisted");
  },
  enqueueSpacePrompt: async (input) => {
    events.push("enqueued");
    enqueuedMeta = input.meta;
  },
  failSessionTurn: async () => null,
};

const isolatedWorker = {
  podName: "sandbox-disposable-1",
  status: "running",
  resumable: false,
  isolatedWorkerPolicy: {
    authoritySpaceId: "authority-1",
    disposableSpaceId: "disposable-1",
    writableRoot: "/workspace/work",
    workspaceReadOnly: true,
    executionTokenIssued: false,
    podUid: "pod-uid-1",
    policySha256: "a".repeat(64),
  },
};

await submitSessionPrompt(deps, {
  spaceId: "authority-1",
  sessionId: "session-1",
  userId: "user-1",
  clientMessageId: "client-1",
  content: [{ type: "text", text: "work" }],
  source: "internal",
  accessMode: "isolated_worker",
}, {
  beforeEnqueue: async ({ turnId }) => {
    assert.equal(turnId, "turn-1");
    events.push("pod-created");
    return { isolatedWorker };
  },
  afterMetaPersistedBeforeEnqueue: async () => { events.push("dispatch-completed"); },
});

assert.deepEqual(events, ["turn-created", "pod-created", "meta-persisted", "dispatch-completed", "enqueued"]);
assert.deepEqual((enqueuedMeta as Record<string, unknown> | null)?.isolatedWorker, isolatedWorker);

events.length = 0;
await assert.rejects(
  submitSessionPrompt(deps, {
    spaceId: "authority-1",
    sessionId: "session-1",
    userId: "user-1",
    clientMessageId: "client-2",
    content: [{ type: "text", text: "work" }],
    source: "internal",
    accessMode: "isolated_worker",
  }, {
    beforeEnqueue: async () => {
      events.push("pod-failed");
      throw new Error("pod creation failed");
    },
  }),
  /pod creation failed/,
);
assert.deepEqual(events, ["turn-created", "pod-failed"]);

events.length = 0;
await assert.rejects(
  submitSessionPrompt({
    ...deps,
    enqueueSpacePrompt: async () => {
      events.push("enqueue-failed");
      throw new Error("queue unavailable");
    },
    failSessionTurn: async () => {
      events.push("turn-failed");
      return null;
    },
  }, {
    spaceId: "disposable-1",
    sessionId: "session-1",
    userId: "user-1",
    clientMessageId: "client-3",
    content: [{ type: "text", text: "work" }],
    source: "internal",
    accessMode: "isolated_worker",
  }, {
    beforeEnqueue: async () => {
      events.push("pod-created");
      return { isolatedWorker };
    },
    beforeFailureTerminalized: async () => {
      events.push("revoke-task-completed");
    },
  }),
  /queue unavailable/,
);
assert.deepEqual(events, [
  "turn-created",
  "pod-created",
  "meta-persisted",
  "enqueue-failed",
  "revoke-task-completed",
  "turn-failed",
]);
