import assert from "node:assert/strict";
import test from "node:test";

const {
  isCheckpointSteerConsumedForTarget,
  isCheckpointSteerTargetStatusConsumable,
} = await import("./checkpoint-steering.js");

test("recognizes only an idempotently consumed steer for the exact target", () => {
  const meta = {
    agentTurnSteer: {
      mode: "checkpoint",
      status: "consumed",
      targetTurnId: "target-1",
    },
  };
  assert.equal(isCheckpointSteerConsumedForTarget({
    status: "merged",
    intent: "steer",
    meta,
    targetTurnId: "target-1",
  }), true);
  assert.equal(isCheckpointSteerConsumedForTarget({
    status: "merged",
    intent: "steer",
    meta,
    targetTurnId: "target-2",
  }), false);
});

test("does not treat a queued pending delivery as consumed", () => {
  assert.equal(isCheckpointSteerConsumedForTarget({
    status: "queued",
    intent: "steer",
    meta: {
      agentTurnSteer: {
        mode: "checkpoint",
        status: "pending",
        targetTurnId: "target-1",
      },
    },
    targetTurnId: "target-1",
  }), false);
});

test("a persisted steer is consumed when explicit Stop wins the completion race", () => {
  assert.equal(isCheckpointSteerTargetStatusConsumable("abort_requested"), true);
  assert.equal(isCheckpointSteerTargetStatusConsumable("interrupted"), true);
  assert.equal(isCheckpointSteerTargetStatusConsumable("aborted"), true);
  assert.equal(isCheckpointSteerTargetStatusConsumable("queued"), false);
});
