import assert from "node:assert/strict";
import test from "node:test";

import {
  abortActiveTurnExecutions,
  clearActiveAbortController,
  clearActiveAbortEvent,
  getActiveAbortEvent,
  registerActiveAbortHandle,
  setActiveAbortController,
} from "../active-turns.js";

test("explicit Stop still aborts the active turn", async () => {
  const turnId = "turn-stop";
  const controller = new AbortController();
  let handleAbortCount = 0;
  setActiveAbortController(turnId, controller);
  const unregisterHandle = registerActiveAbortHandle(turnId, {
    id: "session-handle",
    kind: "turn",
    abort: () => {
      handleAbortCount += 1;
    },
  });

  try {
    const result = abortActiveTurnExecutions({
      id: "abort-event-stop",
      spaceId: "space-a",
      sessionId: "session-a",
      turnId,
      reason: "abort",
      timestamp: Date.now(),
    });
    await Promise.resolve();

    assert.deepEqual(result, { controllersAborted: 1, handlesAborted: 1 });
    assert.equal(controller.signal.aborted, true);
    assert.equal(handleAbortCount, 1);
    assert.equal(getActiveAbortEvent(turnId)?.reason, "abort");
  } finally {
    unregisterHandle();
    clearActiveAbortController(turnId, controller);
    clearActiveAbortEvent(turnId);
  }
});
