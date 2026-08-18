import assert from "node:assert/strict";
import test from "node:test";
import { prepareCompaction } from "@earendil-works/pi-agent-core";
import {
  getCompactionSummaryMessageCount,
  resolveCompactionScope,
  validateCompactionEffect,
} from "../runtime/compaction-plan.js";

const timestamp = Date.now();

function messageEntry(id: string, parentId: string | null, message: Record<string, unknown>) {
  return {
    type: "message" as const,
    id,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message: { timestamp, ...message },
  };
}

test("single-turn split compaction accepts a turn prefix without prior history", () => {
  const entries = [
    messageEntry("user", null, { role: "user", content: "Keep working" }),
    messageEntry("assistant-1", "user", {
      role: "assistant",
      content: [{ type: "text", text: "Earlier work ".repeat(2_000) }],
      provider: "test",
      model: "test",
      stopReason: "toolUse",
      usage: { input: 1, output: 1, totalTokens: 2 },
    }),
    messageEntry("assistant-2", "assistant-1", {
      role: "assistant",
      content: [{ type: "text", text: "Recent work ".repeat(100) }],
      provider: "test",
      model: "test",
      stopReason: "stop",
      usage: { input: 1, output: 1, totalTokens: 2 },
    }),
  ] as Parameters<typeof prepareCompaction>[0];

  const prepared = prepareCompaction(entries, {
    enabled: true,
    reserveTokens: 100,
    keepRecentTokens: 20,
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok || !prepared.value) assert.fail("Expected compaction preparation");

  assert.equal(prepared.value.isSplitTurn, true);
  assert.equal(prepared.value.messagesToSummarize.length, 0);
  assert.ok(prepared.value.turnPrefixMessages.length > 0);
  assert.ok(getCompactionSummaryMessageCount(prepared.value) > 0);
  assert.equal(prepared.value.firstKeptEntryId, "assistant-2");
});

test("split compaction belongs to the containing turn", () => {
  assert.deepEqual(resolveCompactionScope({ isSplitTurn: true }, "turn-1"), {
    scope: "within_turn",
    ownerTurnId: "turn-1",
  });
  assert.deepEqual(resolveCompactionScope({ isSplitTurn: false }, "turn-1"), {
    scope: "between_turns",
    ownerTurnId: null,
  });
});

test("compaction effect must reduce context and fit the next input budget", () => {
  assert.equal(validateCompactionEffect({
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 100,
    inputBudget: 90,
  }), "compaction_no_effect");
  // Threshold compactions need a meaningful reduction (>=20%); marginal
  // shrinks are rejected so image-dominated contexts don't re-compact on
  // every round without reducing the actual payload.
  assert.equal(validateCompactionEffect({
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 95,
    inputBudget: 90,
  }), "compaction_no_effect");
  assert.equal(validateCompactionEffect({
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 81,
    inputBudget: 90,
  }), "compaction_no_effect");
  assert.equal(validateCompactionEffect({
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 70,
    inputBudget: 90,
  }), null);
  assert.equal(validateCompactionEffect({
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 70,
    inputBudget: 60,
  }), "compaction_still_over_budget");
  // Overflow-recovery compactions only require any reduction at all.
  assert.equal(validateCompactionEffect({
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 95,
    inputBudget: 90,
    force: true,
  }), "compaction_still_over_budget");
  assert.equal(validateCompactionEffect({
    estimatedTokensBefore: 100,
    estimatedTokensAfter: 100,
    inputBudget: 90,
    force: true,
  }), "compaction_no_effect");
});
