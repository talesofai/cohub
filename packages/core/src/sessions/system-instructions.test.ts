import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH } from "@cohub/protocol";
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
