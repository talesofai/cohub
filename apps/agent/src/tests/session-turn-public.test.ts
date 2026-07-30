import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionTurnRecord } from "@cohub/protocol/model";
import { toPublicSessionTurnRecord } from "../session-turn-public.js";

test("published agent turns omit private system instructions", () => {
  const timestamp = "2026-07-30T00:00:00.000Z";
  const turn = {
    id: "turn_1",
    sessionId: "session_1",
    userUuid: "user_1",
    sequence: 1,
    status: "running",
    intent: "followup",
    userContent: [{ type: "text", text: "Create a prompt" }],
    userText: "Create a prompt",
    assistantContent: null,
    assistantText: null,
    provider: "test",
    model: "test",
    stopReason: null,
    errorMessage: null,
    finalUsage: null,
    totalUsage: null,
    summary: null,
    intermediateIndex: null,
    intermediateSummary: null,
    meta: {
      systemInstructions: "Do not expose this instruction",
      clientMessageId: "message_1",
    },
    startedAt: timestamp,
    completedAt: null,
    durationMs: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  } satisfies SessionTurnRecord;

  assert.deepEqual(toPublicSessionTurnRecord(turn).meta, {
    clientMessageId: "message_1",
  });
  assert.equal(turn.meta.systemInstructions, "Do not expose this instruction");
});
