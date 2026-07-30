import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionTurnRecord } from "@cohub/protocol/model";
import {
  sanitizeSessionTurnMetaForClient,
  toRealtimeTurnRecord,
} from "./session-turn-public.js";

test("client turn metadata omits private system instructions", () => {
  const stored = {
    systemInstructions: "Do not expose this instruction",
    clientMessageId: "message_1",
    billing: { status: "allowed_with_debt" },
  };

  assert.deepEqual(sanitizeSessionTurnMetaForClient(stored), {
    clientMessageId: "message_1",
    billing: { status: "allowed_with_debt" },
  });
  assert.equal(stored.systemInstructions, "Do not expose this instruction");
});

test("client turn metadata becomes null when instructions are the only value", () => {
  assert.equal(
    sanitizeSessionTurnMetaForClient({ systemInstructions: "private" }),
    null,
  );
  assert.equal(sanitizeSessionTurnMetaForClient(null), null);
  assert.equal(sanitizeSessionTurnMetaForClient([]), null);
});

test("realtime turn records cannot expose stored system instructions", () => {
  const timestamp = "2026-07-30T00:00:00.000Z";
  const turn: SessionTurnRecord = {
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
  };

  assert.deepEqual(toRealtimeTurnRecord(turn).meta, {
    clientMessageId: "message_1",
  });
});
