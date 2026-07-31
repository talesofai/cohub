import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH } from "@cohub/protocol";
import {
	applySystemInstructionsUpdate,
	buildPromptSystemInstructionsInput,
	buildSendMessagePayload,
	validateCronjobForm,
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

test("scheduled prompt creation normalizes and validates turn instructions", () => {
	assert.deepEqual(buildPromptSystemInstructionsInput("  Create a report  "), {
		systemInstructions: "Create a report",
	});
	assert.deepEqual(buildPromptSystemInstructionsInput("  "), {});

	const input = {
		title: "Daily report",
		cronExpression: "0 9 * * *",
		timezone: "UTC",
		prompt: "Summarize the day",
	};
	assert.equal(
		validateCronjobForm({
			...input,
			systemInstructions: "x".repeat(MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH + 1),
		}),
		`Turn instructions must be ${MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH.toLocaleString()} characters or fewer`,
	);
	assert.equal(
		validateCronjobForm({
			...input,
			systemInstructions: "x".repeat(MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH),
		}),
		"",
	);
});
