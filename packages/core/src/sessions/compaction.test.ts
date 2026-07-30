import assert from "node:assert/strict";
import test from "node:test";
import type { ContextCompactionMeta } from "@cohub/protocol/model";
import { summarizeSessionTurnCompactions } from "./compaction.js";

type TestedCompactionMeta = ContextCompactionMeta & {
  providerCalls: NonNullable<ContextCompactionMeta["providerCalls"]>;
};

const compactionMeta = (
  input: Partial<TestedCompactionMeta> & Pick<TestedCompactionMeta, "compactionId">,
): TestedCompactionMeta => ({
  version: 1,
  scope: "within_turn",
  ownerTurnId: "turn-1",
  ordinalInTurn: 1,
  llmRound: 2,
  triggerReason: "threshold",
  contextWindow: 272_000,
  tokensBefore: 240_000,
  estimatedTokensAfter: 40_000,
  provider: "cohub",
  model: "model-1",
  keepRecentTokens: 20_000,
  summarizedMessageCount: 12,
  attemptCount: 1,
  providerCalls: { total: 2, succeeded: 2, failed: 0 },
  isSplitTurn: true,
  firstKeptEntryId: "entry-1",
  archivePath: "archives/session.1.jsonl",
  compactedAt: "2026-07-30T00:00:00.000Z",
  placement: {
    beforeSessionEntryId: "entry-1",
    beforeMessageId: "message-1",
  },
  ...input,
  compactionId: input.compactionId,
});

test("summarizeSessionTurnCompactions sums only within-turn compaction work", () => {
  const summary = summarizeSessionTurnCompactions([
    {
      meta: { messageKind: "compacted", compaction: compactionMeta({ compactionId: "compact-1" }) },
      usage: {
        input: 100,
        output: 20,
        totalTokens: 120,
        cost: { input: 0.1, output: 0.2, total: 0.3 },
      },
      durationMs: 1_200,
    },
    {
      meta: {
        messageKind: "compacted",
        compaction: compactionMeta({
          compactionId: "compact-2",
          ordinalInTurn: 2,
          summarizedMessageCount: 8,
          attemptCount: 2,
          tokensBefore: 230_000,
          estimatedTokensAfter: 35_000,
          compactedAt: "2026-07-30T00:01:00.000Z",
        }),
      },
      usage: {
        input: 80,
        output: 10,
        totalTokens: 90,
        cost: { input: 0.08, output: 0.1, total: 0.18 },
      },
      durationMs: 800,
    },
    {
      meta: {
        messageKind: "compacted",
        compaction: compactionMeta({ compactionId: "between", scope: "between_turns" }),
      },
      usage: { totalTokens: 999, cost: { total: 9 } },
      durationMs: 999,
    },
  ]);

  assert.deepEqual(summary, {
    count: 2,
    summarizedMessageCountTotal: 20,
    attemptCountTotal: 3,
    usage: {
      input: 180,
      output: 30,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 210,
      cost: {
        input: 0.18,
        output: 0.30000000000000004,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.48,
      },
    },
    durationMsTotal: 2_000,
    last: {
      compactionId: "compact-2",
      tokensBefore: 230_000,
      estimatedTokensAfter: 35_000,
      compactedAt: "2026-07-30T00:01:00.000Z",
    },
  });
});

test("summarizeSessionTurnCompactions accepts legacy provider call metadata", () => {
  const legacy = compactionMeta({ compactionId: "legacy" }) as unknown as Record<string, unknown>;
  delete legacy.providerCalls;
  legacy.providerCallCount = 2;

  assert.equal(summarizeSessionTurnCompactions([
    { meta: { messageKind: "compacted", compaction: legacy } },
  ])?.count, 1);
});

test("summarizeSessionTurnCompactions rejects inconsistent provider call outcomes", () => {
  const malformed = compactionMeta({ compactionId: "malformed-provider-calls" });
  malformed.providerCalls = { total: 2, succeeded: 2, failed: 1 };

  assert.equal(summarizeSessionTurnCompactions([
    { meta: { messageKind: "compacted", compaction: malformed } },
  ]), null);
});

test("summarizeSessionTurnCompactions ignores malformed messages", () => {
  const malformed = compactionMeta({ compactionId: "malformed" }) as unknown as Record<string, unknown>;
  delete malformed.summarizedMessageCount;
  malformed.attemptCount = Number.NaN;

  assert.equal(summarizeSessionTurnCompactions([
    { meta: { messageKind: "assistant_intermediate" }, usage: { totalTokens: 100 }, durationMs: 10 },
    { meta: { messageKind: "compacted", compaction: { triggerReason: "threshold" } } },
    { meta: { messageKind: "compacted", compaction: malformed } },
  ]), null);
});
