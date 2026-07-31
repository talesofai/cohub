import assert from "node:assert/strict";
import test from "node:test";
import {
  createGenerationTaskJobId,
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

test("generation jobs reuse only the same user, key, and canonical request", () => {
  const input = {
    userId: "user-a",
    clientRequestId: "open-tap:image:payload-a",
    request: { model: "image-model", parameters: { quality: "high", size: 1024 } },
  };
  const jobId = createGenerationTaskJobId(input);

  assert.doesNotMatch(jobId ?? "", /:/);
  assert.equal(createGenerationTaskJobId({
    ...input,
    request: { parameters: { size: 1024, quality: "high" }, model: "image-model" },
  }), jobId);
  assert.notEqual(createGenerationTaskJobId({ ...input, userId: "user-b" }), jobId);
  assert.notEqual(createGenerationTaskJobId({ ...input, request: { model: "other-model" } }), jobId);
  assert.equal(createGenerationTaskJobId({ ...input, clientRequestId: null }), undefined);
});
