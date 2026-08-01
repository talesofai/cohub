import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionPromptFingerprint,
  SessionPromptIdempotencyConflictError,
  submitSessionPrompt,
  type SessionPromptDependencies,
} from "./prompt.js";

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
    content: [{ type: "text" as const, text: "persisted request" }],
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

test("an idempotency key reused with another request is rejected before side effects", async () => {
  let enqueueCalls = 0;
  let expansionCalls = 0;
  const deps: SessionPromptDependencies = {
    randomUUID: () => "unused",
    findSessionTurnByClientMessageId: async () => ({
      id: "existing-turn-id",
      userMessageId: "existing-message-id",
      requestFingerprint: "another-request",
    }),
    recoverSessionTurnForEnqueue: async () => true,
    expandPromptTemplate: async () => { expansionCalls += 1; return null; },
    createSessionTurn: async () => { throw new Error("must not create"); },
    enqueueSpacePrompt: async () => { enqueueCalls += 1; },
    failSessionTurn: async () => undefined,
  };

  await assert.rejects(() => submitSessionPrompt(deps, {
    spaceId: "space-id",
    sessionId: "session-id",
    userId: "user-id",
    clientMessageId: "stable-message-id",
    content: [{ type: "text", text: "new request" }],
    source: "public_api",
  }), SessionPromptIdempotencyConflictError);
  assert.equal(expansionCalls, 0);
  assert.equal(enqueueCalls, 0);
});

test("a queued idempotent turn is re-enqueued without moving it to failed on an ambiguous queue error", async () => {
  const input = {
    spaceId: "space-id",
    sessionId: "session-id",
    userId: "user-id",
    clientMessageId: "stable-message-id",
    content: [{ type: "text" as const, text: "same request" }],
    source: "public_api" as const,
  };
  let failCalls = 0;
  const deps: SessionPromptDependencies = {
    randomUUID: () => "unused",
    findSessionTurnByClientMessageId: async () => ({
      id: "queued-turn-id",
      userMessageId: "queued-message-id",
      requestFingerprint: createSessionPromptFingerprint(input),
      enqueueRecovery: {
        content: input.content,
        meta: { clientMessageId: input.clientMessageId, turnId: "queued-turn-id" },
      },
    }),
    recoverSessionTurnForEnqueue: async () => true,
    expandPromptTemplate: async () => null,
    createSessionTurn: async () => { throw new Error("must not create"); },
    enqueueSpacePrompt: async () => { throw new Error("queue timeout"); },
    failSessionTurn: async () => { failCalls += 1; },
  };

  await assert.rejects(() => submitSessionPrompt(deps, input), /queue timeout/);
  assert.equal(failCalls, 0);
});

test("a failure before enqueue is retried without creating or enqueuing another turn", async () => {
  const input = {
    spaceId: "space-id",
    sessionId: "session-id",
    userId: "user-id",
    clientMessageId: "stable-message-id",
    content: [{ type: "text" as const, text: "same request" }],
    source: "public_api" as const,
  };
  let stored: {
    id: string;
    userMessageId: string;
    requestFingerprint: string;
    enqueueRecovery?: { content: typeof input.content; meta: Record<string, unknown> };
  } | null = null;
  let createCalls = 0;
  let enqueueCalls = 0;
  let shouldFailPreparation = true;
  const deps: SessionPromptDependencies = {
    randomUUID: () => "user-message-id",
    findSessionTurnByClientMessageId: async () => stored,
    recoverSessionTurnForEnqueue: async () => Boolean(stored?.enqueueRecovery),
    expandPromptTemplate: async () => null,
    createSessionTurn: async ({ meta }) => {
      createCalls += 1;
      stored = {
        id: "turn-id",
        userMessageId: "user-message-id",
        requestFingerprint: String(meta.requestFingerprint),
      };
      return { id: stored.id, userMessageId: stored.userMessageId };
    },
    enqueueSpacePrompt: async () => { enqueueCalls += 1; },
    failSessionTurn: async ({ errorMessage }) => {
      if (!stored) throw new Error("missing stored turn");
      stored.enqueueRecovery = {
        content: input.content,
        meta: {
          clientMessageId: input.clientMessageId,
          requestFingerprint: stored.requestFingerprint,
          errorMessage,
          turnId: stored.id,
        },
      };
    },
  };
  const beforeEnqueue = async () => {
    if (!shouldFailPreparation) return;
    shouldFailPreparation = false;
    throw new Error("label assignment unavailable");
  };

  await assert.rejects(() => submitSessionPrompt(deps, input, { beforeEnqueue }), /label assignment unavailable/);
  assert.equal(createCalls, 1);
  assert.equal(enqueueCalls, 0);

  const result = await submitSessionPrompt(deps, input, { beforeEnqueue });
  assert.deepEqual(result, { turnId: "turn-id", userMessageId: "user-message-id" });
  assert.equal(createCalls, 1);
  assert.equal(enqueueCalls, 1);
});

test("prompt fingerprints ignore websocket tracing identity but preserve execution settings", () => {
  const base = {
    spaceId: "space-id",
    sessionId: "session-id",
    userId: "user-id",
    clientMessageId: "stable-message-id",
    content: [{ type: "text" as const, text: "same request" }],
    source: "websocket" as const,
    context: { kind: "websocket" as const, requestId: "request-1", connectionId: "connection-1" },
  };
  assert.equal(
    createSessionPromptFingerprint(base),
    createSessionPromptFingerprint({
      ...base,
      context: { kind: "websocket", requestId: "request-2", connectionId: "connection-2" },
    }),
  );
  assert.notEqual(
    createSessionPromptFingerprint(base),
    createSessionPromptFingerprint({ ...base, accessMode: "read_only" }),
  );
});

test("prompt fingerprints include route-owned persistent side effects", () => {
  const base = {
    spaceId: "space-id",
    sessionId: "session-id",
    userId: "user-id",
    clientMessageId: "stable-message-id",
    content: [{ type: "text" as const, text: "same request" }],
    source: "public_api" as const,
    idempotencyContext: { title: "Initial session", labelRefs: ["design", "research"] },
  };
  assert.notEqual(
    createSessionPromptFingerprint(base),
    createSessionPromptFingerprint({ ...base, idempotencyContext: { title: "Other title", labelRefs: ["design", "research"] } }),
  );
  assert.notEqual(
    createSessionPromptFingerprint(base),
    createSessionPromptFingerprint({ ...base, idempotencyContext: { title: "Initial session", labelRefs: ["other"] } }),
  );
});
