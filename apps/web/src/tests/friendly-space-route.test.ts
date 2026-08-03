import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFriendlySpaceResourceRoute } from "../lib/friendly-space-route.ts";

test("parses friendly Space resource routes", () => {
	assert.deepEqual(parseFriendlySpaceResourceRoute("sessions/session-1"), {
		kind: "session",
		sessionId: "session-1",
	});
	assert.deepEqual(parseFriendlySpaceResourceRoute("checkpoints/new"), {
		kind: "checkpoint",
		checkpointId: null,
	});
	assert.deepEqual(parseFriendlySpaceResourceRoute("cronjobs/job-1"), {
		kind: "cronjob",
		cronjobId: "job-1",
	});
	// SvelteKit passes route params after one URL decode.
	assert.deepEqual(parseFriendlySpaceResourceRoute("files/docs/a b.md"), {
		kind: "file",
		path: "docs/a b.md",
	});
	assert.deepEqual(parseFriendlySpaceResourceRoute("files/100%.md"), {
		kind: "file",
		path: "100%.md",
	});
	assert.deepEqual(parseFriendlySpaceResourceRoute("files/%2F.txt"), {
		kind: "file",
		path: "%2F.txt",
	});
});

test("rejects incomplete and unknown resource routes", () => {
	assert.equal(parseFriendlySpaceResourceRoute("sessions"), null);
	assert.equal(
		parseFriendlySpaceResourceRoute("sessions/session-1/extra"),
		null,
	);
	assert.equal(parseFriendlySpaceResourceRoute("settings"), null);
	assert.equal(parseFriendlySpaceResourceRoute("settings/commerce"), null);
	assert.equal(parseFriendlySpaceResourceRoute("unknown/value"), null);
});
