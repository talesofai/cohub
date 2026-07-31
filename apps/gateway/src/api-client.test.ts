import assert from "node:assert/strict";
import { test } from "node:test";
import { internalPromptErrorFromBody } from "./api-client.js";

test("internal prompt errors preserve non-billing error codes", () => {
  const error = internalPromptErrorFromBody({
    code: "session_prompt_idempotency_conflict",
    message: "clientMessageId was reused",
  });

  assert.equal(error?.code, "session_prompt_idempotency_conflict");
  assert.equal(error?.message, "clientMessageId was reused");
  assert.equal(error?.billing, null);
});
