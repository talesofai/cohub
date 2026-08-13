import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_TURN_STEER_CHANNEL,
  AGENT_TURN_STEER_META_KEY,
  buildAgentTurnSteerEvent,
  buildAgentTurnSteerMeta,
  decideCheckpointSteering,
  decideSessionPromptSteering,
  getAgentTurnSteerKey,
} from "./checkpoint-steering.js";

test("a running turn chooses native checkpoint steering without an abort action", () => {
  const decision = decideCheckpointSteering({
    activeTurn: { id: "active-1", status: "running" },
  });
  assert.deepEqual(decision, { mode: "checkpoint", targetTurnId: "active-1" });
  assert.deepEqual(buildAgentTurnSteerMeta(decision), {
    [AGENT_TURN_STEER_META_KEY]: {
      mode: "checkpoint",
      status: "pending",
      targetTurnId: "active-1",
    },
  });
});

test("an aborting turn falls back to delivery after the run", () => {
  assert.deepEqual(decideCheckpointSteering({
    activeTurn: { id: "active-2", status: "abort_requested" },
  }), {
    mode: "after_run",
    targetTurnId: "active-2",
    reason: "active_turn_abort_requested",
  });
});

test("no active turn records an honest after-run fallback", () => {
  assert.deepEqual(decideCheckpointSteering({ activeTurn: null }), {
    mode: "after_run",
    targetTurnId: null,
    reason: "no_active_run",
  });
});

test("steer events target one active turn and key each queued delivery", () => {
  const event = buildAgentTurnSteerEvent({
    id: "event-1",
    spaceId: "space-1",
    sessionId: "session-1",
    activeTurnId: "active-1",
    queuedTurnId: "queued-1",
    actorUserId: "user-1",
    timestamp: 123,
  });
  assert.equal(AGENT_TURN_STEER_CHANNEL, "pubsub:agent:turn_steer");
  assert.equal(getAgentTurnSteerKey(event.queuedTurnId), "agent:turn:queued-1:steer");
  assert.deepEqual(event, {
    id: "event-1",
    spaceId: "space-1",
    sessionId: "session-1",
    activeTurnId: "active-1",
    queuedTurnId: "queued-1",
    actorUserId: "user-1",
    timestamp: 123,
  });
});

test("the server upgrades a stale client follow-up when a turn is actually active", () => {
  assert.deepEqual(decideSessionPromptSteering({
    requestedIntent: "followup",
    submittedTurnId: "queued-1",
    activeTurn: { id: "active-1", status: "running" },
  }), {
    mode: "checkpoint",
    targetTurnId: "active-1",
  });
  assert.equal(decideSessionPromptSteering({
    requestedIntent: "followup",
    submittedTurnId: "queued-1",
    activeTurn: null,
  }), null);
});
