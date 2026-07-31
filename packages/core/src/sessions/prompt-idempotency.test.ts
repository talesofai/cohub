import assert from "node:assert/strict";
import test from "node:test";
import { submitSessionPrompt, type SessionPromptDependencies } from "./prompt.js";

test("an idempotent session turn returns its original identity without re-enqueueing", async () => {
  let enqueueCalls = 0;
  let beforeEnqueueCalls = 0;
  const deps: SessionPromptDependencies = {
    randomUUID: () => "new-user-message-id",
    expandPromptTemplate: async () => null,
    createSessionTurn: async () => ({
      id: "existing-turn-id",
      idempotent: true,
      userMessageId: "existing-user-message-id",
    }),
    enqueueSpacePrompt: async () => { enqueueCalls += 1; },
    failSessionTurn: async () => undefined,
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
});
