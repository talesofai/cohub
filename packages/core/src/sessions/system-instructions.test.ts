import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH } from "@cohub/protocol";
import {
  parsePromptSystemInstructions,
  PromptSystemInstructionsValidationError,
  sanitizePromptMetaForClient,
} from "./system-instructions.js";

test("prompt system instructions are trimmed and optional", () => {
  assert.equal(parsePromptSystemInstructions(undefined), null);
  assert.equal(parsePromptSystemInstructions("   "), null);
  assert.equal(parsePromptSystemInstructions("  Return only the final prompt.  "), "Return only the final prompt.");
});

test("prompt system instructions reject invalid or oversized values", () => {
  const maximumLengthValue = "x".repeat(MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH);
  assert.equal(
    parsePromptSystemInstructions(` ${maximumLengthValue}\n`),
    maximumLengthValue,
  );
  assert.throws(
    () => parsePromptSystemInstructions({}),
    PromptSystemInstructionsValidationError,
  );
  assert.throws(
    () => parsePromptSystemInstructions("x".repeat(MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH + 1)),
    /cannot exceed 16000 characters/,
  );
});

test("client prompt metadata omits private prompt fields without mutating stored metadata", () => {
  const stored = {
    systemInstructions: "Do not expose this instruction",
    requestFingerprint: "internal-fingerprint",
    env: { API_KEY: "secret" },
    context: {
      kind: "public_api",
      requestId: "request_1",
      auth: { scopes: ["session.prompt.fullaccess"] },
      env: { HOOK_SECRET: "secret" },
    },
    clientMessageId: "message_1",
    billing: { status: "allowed_with_debt" },
  };

  assert.deepEqual(sanitizePromptMetaForClient(stored), {
    clientMessageId: "message_1",
    billing: { status: "allowed_with_debt" },
    context: { kind: "public_api", requestId: "request_1" },
  });
  assert.equal(stored.systemInstructions, "Do not expose this instruction");
  assert.equal(stored.requestFingerprint, "internal-fingerprint");
  assert.deepEqual(stored.env, { API_KEY: "secret" });
  assert.deepEqual(stored.context.auth, { scopes: ["session.prompt.fullaccess"] });
  assert.equal(sanitizePromptMetaForClient({ systemInstructions: "private" }), null);
  assert.equal(sanitizePromptMetaForClient({ context: { auth: { scopes: [] } } }), null);
  assert.equal(sanitizePromptMetaForClient(null), null);
  assert.equal(sanitizePromptMetaForClient([]), null);
});
