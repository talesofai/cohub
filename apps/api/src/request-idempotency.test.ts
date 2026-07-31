import assert from "node:assert/strict";
import test from "node:test";
import {
  createGenerationTaskJobId,
  createRequestFingerprint,
  createRepeatPromptCronJobIdempotencyKey,
  createSessionlessPromptSessionId,
} from "./request-idempotency.js";

test("sessionless prompts reuse one scoped deterministic session", () => {
  const input = {
    spaceId: "00000000-0000-4000-8000-000000000001",
    userId: "user-a",
    clientMessageId: "open-tap:text:payload-a",
  };
  const sessionId = createSessionlessPromptSessionId(input);

  assert.equal(createSessionlessPromptSessionId(input), sessionId);
  assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(createSessionlessPromptSessionId({ ...input, userId: "user-b" }), sessionId);
});

test("repeat prompt identities are scoped by payer, space, and target session", () => {
  const input = {
    userId: "user-a",
    spaceId: "space-a",
    sessionId: "session-a",
    clientMessageId: "schedule-a",
  };
  const key = createRepeatPromptCronJobIdempotencyKey(input);

  assert.equal(createRepeatPromptCronJobIdempotencyKey(input), key);
  assert.notEqual(createRepeatPromptCronJobIdempotencyKey({ ...input, spaceId: "space-b" }), key);
  assert.notEqual(createRepeatPromptCronJobIdempotencyKey({ ...input, sessionId: "session-b" }), key);
  assert.notEqual(createRepeatPromptCronJobIdempotencyKey({ ...input, userId: "user-b" }), key);
});

test("generation job identity is stable for one user and client key", () => {
  const input = {
    userId: "user-a",
    clientRequestId: "open-tap:image:payload-a",
  };
  const jobId = createGenerationTaskJobId(input);

  assert.doesNotMatch(jobId ?? "", /:/);
  assert.equal(createGenerationTaskJobId(input), jobId);
  assert.notEqual(createGenerationTaskJobId({ ...input, userId: "user-b" }), jobId);
  assert.equal(createGenerationTaskJobId({ ...input, clientRequestId: null }), undefined);
});

test("request fingerprints canonicalize object key order independently of the idempotency key", () => {
  assert.equal(
    createRequestFingerprint({ model: "image-model", parameters: { quality: "high", size: 1024 } }),
    createRequestFingerprint({ parameters: { size: 1024, quality: "high" }, model: "image-model" }),
  );
  assert.notEqual(
    createRequestFingerprint({ model: "image-model" }),
    createRequestFingerprint({ model: "other-model" }),
  );
});
