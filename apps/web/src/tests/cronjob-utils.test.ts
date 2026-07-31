import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH } from "@cohub/protocol";
import {
	applySystemInstructionsUpdate,
	buildCronjobUpdatePatch,
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
	assert.deepEqual(
		applySystemInstructionsUpdate(
			{ ...visiblePayload, systemInstructions: "Keep me" },
			"",
			false,
		),
		{
			content: [{ type: "text", text: "After" }],
			systemInstructions: "Keep me",
		},
	);
});

test("cron updates send only fields that actually changed", () => {
	const detail = {
		id: "cron-1",
		userUuid: "user-1",
		title: "Daily report",
		taskType: "send_message",
		payload: {
			content: [{ type: "text", text: "Report" }],
			systemInstructions: "Keep me",
		},
		cronExpression: "0 9 * * *",
		timezone: "UTC",
		bullJobKey: "job-1",
		scheduleVersion: 1,
		queueSyncedVersion: 1,
		spaceId: "space-1",
		sessionId: null,
		enabled: true,
		deletedAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		queueSyncStatus: "synced" as const,
		hasSystemInstructions: true,
	};
	assert.deepEqual(
		buildCronjobUpdatePatch({
			detail,
			title: "Renamed",
			cronExpression: detail.cronExpression,
			timezone: detail.timezone,
			payload: {
				systemInstructions: "Keep me",
				content: [{ text: "Report", type: "text" }],
			},
		}),
		{
			expectedUpdatedAt: detail.updatedAt,
			title: "Renamed",
		},
	);
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
