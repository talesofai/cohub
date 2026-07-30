import assert from "node:assert/strict";
import { test } from "node:test";
import { markMessageAsFull, summarizeMessageForHistory } from "./session-content.js";

test("message REST serializers omit private system instructions", () => {
  const message = {
    content: [{ type: "text" as const, text: "hello" }],
    meta: {
      systemInstructions: "Do not expose this instruction",
      messageKind: "user",
    },
  };

  assert.deepEqual(summarizeMessageForHistory(message).meta, {
    messageKind: "user",
    contentDetail: "summary",
    historySummary: { toolCallCount: 0, thinkingCharCount: 0 },
  });
  assert.deepEqual(markMessageAsFull(message).meta, {
    messageKind: "user",
    contentDetail: "full",
  });
  assert.equal(message.meta.systemInstructions, "Do not expose this instruction");
});
