import assert from "node:assert/strict";
import test from "node:test";
import {
	resolveAcceptedPromptGenerationTurnId,
	resolveSessionPromptIntent,
	resolveSteerGenerationTurnId,
} from "$lib/features/session-chat/session-prompt-intent";

test("ordinary send uses native steer intent while a turn is active", () => {
	assert.equal(resolveSessionPromptIntent(true), "steer");
});

test("ordinary send starts a normal turn when no turn is active", () => {
	assert.equal(resolveSessionPromptIntent(false), "followup");
});

test("checkpoint delivery keeps generation attached to the active turn", () => {
	assert.equal(
		resolveSteerGenerationTurnId({
			queuedTurnId: "queued-1",
			delivery: { mode: "checkpoint", targetTurnId: "active-1" },
		}),
		"active-1",
	);
	assert.equal(
		resolveSteerGenerationTurnId({
			queuedTurnId: "queued-1",
			delivery: { mode: "after_run" },
		}),
		"queued-1",
	);
});

test("server checkpoint metadata repairs stale client generation ownership", () => {
	assert.equal(
		resolveAcceptedPromptGenerationTurnId({
			turnId: "queued-1",
			meta: {
				agentTurnSteer: {
					mode: "checkpoint",
					status: "pending",
					targetTurnId: "active-1",
				},
			},
		}),
		"active-1",
	);
	assert.equal(
		resolveAcceptedPromptGenerationTurnId({
			turnId: "queued-1",
			meta: { agentTurnSteer: { mode: "after_run" } },
		}),
		"queued-1",
	);
});
