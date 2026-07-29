import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePromptSystemInstructions,
  PromptSystemInstructionsValidationError,
} from "./system-instructions.js";

test("prompt system instructions are trimmed and optional", () => {
  assert.equal(parsePromptSystemInstructions(undefined), null);
  assert.equal(parsePromptSystemInstructions("   "), null);
  assert.equal(parsePromptSystemInstructions("  Return only the final prompt.  "), "Return only the final prompt.");
});

test("prompt system instructions reject invalid or oversized values", () => {
  assert.throws(
    () => parsePromptSystemInstructions({}),
    PromptSystemInstructionsValidationError,
  );
  assert.throws(
    () => parsePromptSystemInstructions("x".repeat(16_001)),
    /cannot exceed 16000 characters/,
  );
});
