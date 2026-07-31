import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWebsocketSessionPromptRequest,
  normalizeWebsocketSessionPromptPayload,
} from "./websocket-session-prompt.js";

test("gateway websocket prompts forward normalized turn instructions", () => {
  const prompt = normalizeWebsocketSessionPromptPayload({
    spaceId: "  space-1  ",
    sessionId: "  session-1  ",
    clientMessageId: "  message-1  ",
    content: [{ type: "text", text: "Hello" }],
    model: " model-1 ",
    provider: " provider-1 ",
    systemInstructions: "  Answer in JSON.  ",
  });

  assert.deepEqual(prompt, {
    spaceId: "space-1",
    sessionId: "session-1",
    clientMessageId: "message-1",
    content: [{ type: "text", text: "Hello" }],
    model: "model-1",
    provider: "provider-1",
    thinkingLevel: null,
    systemInstructions: "Answer in JSON.",
  });

  const request = buildWebsocketSessionPromptRequest({
    prompt,
    userId: "user-1",
    authToken: "token-1",
    requestId: "request-1",
    connectionId: "connection-1",
  });
  assert.equal(request.systemInstructions, "Answer in JSON.");
  assert.equal(request.source, "websocket");
  assert.deepEqual(request.context, {
    kind: "websocket",
    requestId: "request-1",
    connectionId: "connection-1",
  });
});
