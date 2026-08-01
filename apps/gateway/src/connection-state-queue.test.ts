import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConnectionStateQueueOverflowError,
  enqueueConnectionState,
} from "./connection-state-queue.js";

test("connection state operations run in arrival order", async () => {
  const queue = { stateTail: Promise.resolve(), pendingStateOperations: 0 };
  const events: string[] = [];
  let releaseFirst: () => void = () => undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = enqueueConnectionState(queue, async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  });
  const second = enqueueConnectionState(queue, async () => {
    events.push("second");
  });

  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second"]);
});

test("a failed state operation does not poison the connection queue", async () => {
  const queue = { stateTail: Promise.resolve(), pendingStateOperations: 0 };
  const failed = enqueueConnectionState(queue, async () => {
    throw new Error("authentication failed");
  });
  const recovered = enqueueConnectionState(queue, async () => "subscribed");

  await assert.rejects(failed, /authentication failed/);
  assert.equal(await recovered, "subscribed");
});

test("connection state queues reject excess work without retaining it", async () => {
  const queue = { stateTail: Promise.resolve(), pendingStateOperations: 0 };
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = enqueueConnectionState(queue, () => gate, { maxPending: 2 });
  const second = enqueueConnectionState(queue, async () => undefined, { maxPending: 2 });
  await assert.rejects(
    enqueueConnectionState(queue, async () => undefined, { maxPending: 2 }),
    ConnectionStateQueueOverflowError,
  );
  assert.equal(queue.pendingStateOperations, 2);

  release();
  await Promise.all([first, second]);
  assert.equal(queue.pendingStateOperations, 0);
});
