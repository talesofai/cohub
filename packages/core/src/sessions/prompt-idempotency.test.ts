import assert from "node:assert/strict";
import test from "node:test";
import { submitSessionPrompt, type SessionPromptDependencies } from "./prompt.js";

test("an idempotent session turn returns its original identity without re-enqueueing", async () => {
  let enqueueCalls = 0;
  let beforeEnqueueCalls = 0;
  let createCalls = 0;
  let expansionCalls = 0;
  let billingCalls = 0;
  const deps: SessionPromptDependencies = {
    randomUUID: () => "new-user-message-id",
    findSessionTurnByClientMessageId: async () => ({
      id: "existing-turn-id",
      userMessageId: "existing-user-message-id",
    }),
    recoverSessionTurnForEnqueue: async () => false,
    expandPromptTemplate: async () => { expansionCalls += 1; return null; },
    createSessionTurn: async () => {
      createCalls += 1;
      throw new Error("must not create an idempotent turn");
    },
    enqueueSpacePrompt: async () => { enqueueCalls += 1; },
    failSessionTurn: async () => undefined,
    billingUsageGate: {
      evaluate: async () => {
        billingCalls += 1;
        return { status: "blocked", reason: "insufficient_balance" } as never;
      },
    },
  };

  const result = await submitSessionPrompt(deps, {
    spaceId: "space-id",
    sessionId: "session-id",
    userId: "user-id",
    clientMessageId: "stable-message-id",
    content: [{ type: "text", text: "same request" }],
    source: "public_api",
  }, {
    beforeEnqueue: async () => { beforeEnqueueCalls += 1; },
  });

  assert.deepEqual(result, {
    turnId: "existing-turn-id",
    userMessageId: "existing-user-message-id",
  });
  assert.equal(beforeEnqueueCalls, 0);
  assert.equal(enqueueCalls, 0);
  assert.equal(createCalls, 0);
  assert.equal(expansionCalls, 0);
  assert.equal(billingCalls, 0);
});

test("a turn that failed before enqueue is recovered exactly once", async () => {
  let recovered = false;
  let enqueueCalls = 0;
  let beforeEnqueueCalls = 0;
  const deps: SessionPromptDependencies = {
    randomUUID: () => "unused",
    findSessionTurnByClientMessageId: async () => ({
      id: "failed-turn-id",
      userMessageId: "failed-message-id",
      enqueueRecovery: {
        content: [{ type: "text", text: "persisted request" }],
        meta: { clientMessageId: "stable-message-id", turnId: "failed-turn-id" },
      },
    }),
    recoverSessionTurnForEnqueue: async () => {
      if (recovered) return false;
      recovered = true;
      return true;
    },
    expandPromptTemplate: async () => null,
    createSessionTurn: async () => { throw new Error("must not create another turn"); },
    enqueueSpacePrompt: async (input) => {
      enqueueCalls += 1;
      assert.equal(input.turnId, "failed-turn-id");
      assert.deepEqual(input.content, [{ type: "text", text: "persisted request" }]);
    },
    failSessionTurn: async () => undefined,
  };
  const input = {
    spaceId: "space-id",
    sessionId: "session-id",
    userId: "user-id",
    clientMessageId: "stable-message-id",
    content: [{ type: "text" as const, text: "caller retry body" }],
    source: "public_api" as const,
  };

  const first = await submitSessionPrompt(deps, input, {
    beforeEnqueue: async () => { beforeEnqueueCalls += 1; },
  });
  const second = await submitSessionPrompt(deps, input, {
    beforeEnqueue: async () => { beforeEnqueueCalls += 1; },
  });

  assert.deepEqual(first, { turnId: "failed-turn-id", userMessageId: "failed-message-id" });
  assert.deepEqual(second, first);
  assert.equal(beforeEnqueueCalls, 1);
  assert.equal(enqueueCalls, 1);
});
