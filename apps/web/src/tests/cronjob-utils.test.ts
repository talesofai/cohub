import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applySystemInstructionsUpdate,
	buildSendMessagePayload,
} from "../lib/features/space/modules/cronjob-utils";

test("cron edits preserve, replace, or explicitly clear hidden turn instructions", () => {
	const visiblePayload = buildSendMessagePayload(
		{ content: [{ type: "text", text: "Before" }] },
		"After",
		null,
	);

	assert.deepEqual(applySystemInstructionsUpdate(visiblePayload, "", false), {
		content: [{ type: "text", text: "After" }],
	});
	assert.deepEqual(
		applySystemInstructionsUpdate(visiblePayload, "  Replacement  ", false),
		{
			content: [{ type: "text", text: "After" }],
			systemInstructions: "Replacement",
		},
	);
	assert.deepEqual(applySystemInstructionsUpdate(visiblePayload, "", true), {
		content: [{ type: "text", text: "After" }],
		systemInstructions: null,
	});
});
