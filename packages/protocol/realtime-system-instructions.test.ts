import assert from "node:assert/strict";
import test from "node:test";
import { wsClientEventSchema } from "./src/realtime/schema.js";
import { MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH } from "./src/system-instructions.js";

const baseEvent = {
  type: "session.message.create" as const,
  payload: {
    spaceId: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    content: [{ type: "text" as const, text: "Create a prompt" }],
  },
};

test("realtime system instructions validate their normalized value", () => {
  const instructions = "x".repeat(MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH);
  const parsed = wsClientEventSchema.parse({
    ...baseEvent,
    payload: {
      ...baseEvent.payload,
      systemInstructions: ` ${instructions}\n`,
    },
  });

  assert.equal(parsed.type, "session.message.create");
  assert.equal(parsed.payload.systemInstructions, instructions);
  assert.throws(() => wsClientEventSchema.parse({
    ...baseEvent,
    payload: {
      ...baseEvent.payload,
      systemInstructions: `${instructions}x\n`,
    },
  }));
});
