import assert from "node:assert/strict";
import {
  REALTIME_MESSAGE_META_KEYS,
  pickRealtimeMessageMeta,
} from "../realtime-message-meta.js";

// Regression: session.message.persisted realtime events must carry
// messageOrdinal so the web client's intermediate-message dedupe (keyed by
// `ordinal:N`) matches the REST stream-snapshot path. Dropping it caused
// each_key_duplicate crashes and a frozen streaming UI until finalize.
function testOrdinalWhitelisted() {
  assert.ok(
    REALTIME_MESSAGE_META_KEYS.includes("messageOrdinal"),
    "messageOrdinal must be whitelisted for realtime broadcast",
  );

  const picked = pickRealtimeMessageMeta({
    messageKind: "assistant_intermediate",
    turnId: "turn-1",
    messageOrdinal: 7,
    // fields outside the whitelist must be dropped
    rawStopReason: "tool_use",
    thinking: "should not leak",
    toolCallRenderStates: [{ id: "x" }],
  });

  assert.deepEqual(picked, {
    messageKind: "assistant_intermediate",
    turnId: "turn-1",
    messageOrdinal: 7,
  });
}

// ordinal === 0 is a valid ordinal (first assistant message) and must survive.
function testZeroOrdinalSurvives() {
  const picked = pickRealtimeMessageMeta({ messageOrdinal: 0 });
  assert.deepEqual(picked, { messageOrdinal: 0 });
}

// null meta and empty-after-filter meta return null.
function testEmptyReturnsNull() {
  assert.equal(pickRealtimeMessageMeta(null), null);
  assert.equal(pickRealtimeMessageMeta(undefined), null);
  assert.equal(pickRealtimeMessageMeta({ notWhitelisted: 1 }), null);
}

// undefined ordinal is simply omitted (not serialized as undefined).
function testUndefinedOrdinalOmitted() {
  const picked = pickRealtimeMessageMeta({
    messageKind: "assistant_final",
    messageOrdinal: undefined,
  });
  assert.deepEqual(picked, { messageKind: "assistant_final" });
}

function testCompactionMetaIsSanitized() {
  assert.ok(
    REALTIME_MESSAGE_META_KEYS.includes("compaction"),
    "compaction metadata must be whitelisted for realtime placement",
  );

  const picked = pickRealtimeMessageMeta({
    messageKind: "compacted",
    compaction: {
      version: 1,
      compactionId: "compact-1",
      scope: "within_turn",
      tokensBefore: 120_000,
      estimatedTokensAfter: 18_000,
      model: "model-1",
      providerCalls: {
        total: 3,
        succeeded: 2,
        failed: 1,
        internalRequestId: "secret",
      },
      providerCallCount: 3,
      archivePath: "/private/archive.jsonl",
      firstKeptEntryId: "session-entry-1",
      placement: {
        beforeSessionEntryId: "session-entry-2",
        beforeMessageId: "message-2",
      },
    },
  });

  assert.deepEqual(picked, {
    messageKind: "compacted",
    compaction: {
      version: 1,
      compactionId: "compact-1",
      scope: "within_turn",
      tokensBefore: 120_000,
      estimatedTokensAfter: 18_000,
      model: "model-1",
      providerCalls: {
        total: 3,
        succeeded: 2,
        failed: 1,
      },
      providerCallCount: 3,
      placement: { beforeMessageId: "message-2" },
    },
  });
}

testOrdinalWhitelisted();
testZeroOrdinalSurvives();
testEmptyReturnsNull();
testUndefinedOrdinalOmitted();
testCompactionMetaIsSanitized();
