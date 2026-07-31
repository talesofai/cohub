import assert from "node:assert/strict";
import test from "node:test";
import { reconcileQueuedSessionTurnBatch } from "./session-turn-queue-reconciler.js";

test("queued session reconciliation advances its cursor and retries queue failures on a later pass", async () => {
  const queued = [
    { sessionId: "session-1", spaceId: "space-1" },
    { sessionId: "session-2", spaceId: "space-2" },
  ];
  const enqueued: string[] = [];
  const result = await reconcileQueuedSessionTurnBatch({ afterSessionId: "session-0", limit: 2 }, {
    listQueuedSessions: async (input) => {
      assert.deepEqual(input, { afterSessionId: "session-0", limit: 2 });
      return queued;
    },
    enqueue: async ({ sessionId }) => {
      enqueued.push(sessionId);
      if (sessionId === "session-2") throw new Error("queue unavailable");
    },
  });

  assert.deepEqual(enqueued, ["session-1", "session-2"]);
  assert.deepEqual(result, { scanned: 2, failed: 1, nextCursor: "session-2" });
});

test("queued session reconciliation wraps after a partial batch", async () => {
  const result = await reconcileQueuedSessionTurnBatch({ afterSessionId: "session-9", limit: 10 }, {
    listQueuedSessions: async () => [],
    enqueue: async () => undefined,
  });
  assert.deepEqual(result, { scanned: 0, failed: 0, nextCursor: null });
});
