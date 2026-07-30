import assert from "node:assert/strict";
import {
  getSnapshotMessageKey,
  mergeSessionStreamSnapshotIntermediates,
  resolvePersistedIntermediateOrdinals,
  resolveSnapshotStreamMessageId,
  type SnapshotIntermediateMessage,
} from "./session-stream-snapshot-merge.js";

const streamMessageId = resolveSnapshotStreamMessageId({
  sessionId: "session-1",
  turnId: "turn-1",
  messageOrdinal: 0,
});

assert.equal(streamMessageId, "turn:turn-1:assistant:0");
assert.equal(
  getSnapshotMessageKey({
    messageId: "db-message-1",
    messageOrdinal: 0,
    content: [{ type: "text", text: "snapshot" }],
  }),
  "ordinal:0",
);

const snapshotMessages: SnapshotIntermediateMessage[] = [
  {
    messageId: streamMessageId,
    messageOrdinal: 0,
    content: [{ type: "text", text: "live" }],
  },
];
const persistedMessages: SnapshotIntermediateMessage[] = [
  {
    id: "db-message-1",
    messageId: streamMessageId,
    messageOrdinal: 0,
    content: [{ type: "text", text: "persisted" }],
  },
];

const merged = mergeSessionStreamSnapshotIntermediates(snapshotMessages, persistedMessages);
assert.equal(merged.length, 1);
assert.equal(merged[0]?.id, "db-message-1");
assert.equal(merged[0]?.messageId, streamMessageId);
assert.deepEqual(merged[0]?.content, [{ type: "text", text: "persisted" }]);

const compacted = mergeSessionStreamSnapshotIntermediates(
  [
    {
      messageId: "turn:turn-1:assistant:0",
      messageOrdinal: 0,
      content: [{ type: "text", text: "synthetic" }],
    },
    {
      messageId: "db-message-1",
      messageOrdinal: 0,
      content: [{ type: "text", text: "db" }],
    },
  ],
  [],
);
assert.equal(compacted.length, 1);
assert.equal(compacted[0]?.messageId, "turn:turn-1:assistant:0");
assert.deepEqual(compacted[0]?.content, [{ type: "text", text: "db" }]);

assert.deepEqual(
  resolvePersistedIntermediateOrdinals([
    { role: "assistant", meta: {} },
    { role: "system", meta: { messageKind: "compacted" } },
    { role: "assistant", meta: {} },
  ]),
  [0, null, 1],
);

assert.deepEqual(
  resolvePersistedIntermediateOrdinals([
    { role: "assistant", meta: { messageOrdinal: 4 } },
    { role: "system", meta: { messageKind: "compacted" } },
    { role: "assistant", meta: { messageOrdinal: 7 } },
    { role: "assistant", meta: {} },
  ]),
  [4, null, 7, 8],
);

assert.deepEqual(
  resolvePersistedIntermediateOrdinals([
    { role: "assistant", meta: { messageOrdinal: 0 } },
    { role: "assistant", meta: { messageOrdinal: 0 } },
    { role: "assistant", meta: {} },
  ]),
  [0, 1, 2],
);

assert.deepEqual(
  resolvePersistedIntermediateOrdinals([
    { role: "assistant", meta: {} },
    { role: "assistant", meta: { messageOrdinal: 0 } },
  ]),
  [1, 0],
);
