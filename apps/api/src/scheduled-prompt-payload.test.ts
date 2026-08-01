import assert from "node:assert/strict";
import test from "node:test";
import {
  ScheduledPromptPayloadValidationError,
  validateScheduledSendMessagePayload,
} from "./scheduled-prompt-payload.js";

test("scheduled prompt payloads normalize persisted execution fields", () => {
  const result = validateScheduledSendMessagePayload({
    content: [{ type: "text", text: "Generate an image" }],
    accessMode: "read_only",
    intent: "steer",
    thinkingLevel: " high ",
    env: { API_KEY: "secret" },
    systemInstructions: "  Private instructions  ",
    labelRefs: ["Research", "Design"],
  });

  assert.equal(result.accessMode, "read_only");
  assert.deepEqual(result.payload, {
    content: [{ type: "text", text: "Generate an image" }],
    accessMode: "read_only",
    intent: "steer",
    thinkingLevel: "high",
    env: { API_KEY: "secret" },
    systemInstructions: "Private instructions",
    labelRefs: ["Design", "Research"],
  });
});

for (const [name, payload, message] of [
  ["invalid content", { content: [] }, /content must be/],
  ["malformed content block", { content: [{ type: "text" }] }, /content must be/],
  ["malformed nested tool result", { content: [{ type: "tool_result", tool_use_id: "tool-1", content: [{ invalid: true }] }] }, /content must be/],
  ["invalid access mode", { content: [{ type: "text", text: "prompt" }], accessMode: "write" }, /accessMode must be/],
  ["invalid intent", { content: [{ type: "text", text: "prompt" }], intent: "compact" }, /intent must be/],
  ["invalid environment", { content: [{ type: "text", text: "prompt" }], env: { "invalid-name": "value" } }, /env/],
  ["server-managed label ids", { content: [{ type: "text", text: "prompt" }], labelIds: ["label-id"] }, /payload\.labelIds is not supported/],
  ["read-only shell command", { content: [{ type: "shell_command", command: "ls", rawText: "!ls" }], accessMode: "read_only" }, /shell_command is not allowed/],
] as const) {
  test(`scheduled prompt payload rejects ${name}`, () => {
    assert.throws(() => validateScheduledSendMessagePayload(payload), ScheduledPromptPayloadValidationError);
    assert.throws(() => validateScheduledSendMessagePayload(payload), message);
  });
}
