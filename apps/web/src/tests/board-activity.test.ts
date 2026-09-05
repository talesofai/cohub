import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BOARD_AGENT_ACTIVITY_MS,
	BOARD_AUTOMATION_MAX_ACTIVITY_MS,
	BOARD_CLI_ACTIVITY_MS,
	boardAutomationExpiresAt,
	boardAutomationFocus,
	boardAutomationVisibleMs,
	createBoardAutomationActivity,
	mergeBoardAutomationActivity,
} from "../lib/board/board-activity.ts";
import { createEmptyBoardDocument } from "../lib/board/board-document.ts";
import { createGeoBoardItem } from "../lib/board/board-items.ts";

test("board automation focus covers every touched item", () => {
	const first = createGeoBoardItem("rectangle", 20, 30, "neutral", "first");
	const second = createGeoBoardItem("rectangle", 300, 200, "neutral", "second");
	const document = {
		...createEmptyBoardDocument(),
		items: [first, second],
	};

	assert.deepEqual(boardAutomationFocus(document, [first.id, second.id]), {
		x: -80,
		y: -40,
		width: 480,
		height: 310,
		rotation: 0,
	});
});

test("a deleted item keeps its pre-transaction focus", () => {
	const document = createEmptyBoardDocument();
	const fallbackFocus = {
		x: 80,
		y: 120,
		width: 200,
		height: 140,
		rotation: 0,
	};
	const activity = createBoardAutomationActivity(
		document,
		{
			boardId: "board-a",
			actorId: "actor-a",
			txId: "tx-a",
			itemIds: ["deleted"],
			source: { toolCallId: "tool-a", turnId: "turn-a" },
			timestamp: 100,
		},
		fallbackFocus,
	);

	assert.deepEqual(activity?.focus, fallbackFocus);
	assert.equal(activity?.kind, "agent");
	assert.equal(activity?.status, "active");
});

test("a repeated tool call moves one marker and preserves resolved context", () => {
	const firstDocument = {
		...createEmptyBoardDocument(),
		items: [createGeoBoardItem("rectangle", 10, 20, "neutral", "target")],
	};
	const movedDocument = {
		...createEmptyBoardDocument(),
		items: [createGeoBoardItem("rectangle", 400, 500, "neutral", "target")],
	};
	const source = { toolCallId: "tool-a", turnId: "turn-a" };
	const first = createBoardAutomationActivity(firstDocument, {
		boardId: "board-a",
		actorId: "actor-a",
		txId: "tx-a",
		itemIds: ["target"],
		source,
		timestamp: 100,
	});
	const moved = createBoardAutomationActivity(movedDocument, {
		boardId: "board-a",
		actorId: "actor-a",
		txId: "tx-b",
		itemIds: ["target"],
		source,
		timestamp: 200,
	});
	assert.ok(first && moved);
	first.model = { provider: "anthropic", id: "claude-sonnet" };
	first.status = "settled";

	const merged = mergeBoardAutomationActivity([first], moved);
	assert.equal(merged.length, 1);
	assert.equal(merged[0]?.focus.x, 300);
	assert.equal(merged[0]?.status, "active");
	assert.equal(merged[0]?.startedAt, 100);
	assert.deepEqual(merged[0]?.model, first.model);
});

test("agent attribution remains visible longer without becoming permanent", () => {
	assert.equal(boardAutomationVisibleMs("agent"), BOARD_AGENT_ACTIVITY_MS);
	assert.equal(boardAutomationVisibleMs("cli"), BOARD_CLI_ACTIVITY_MS);
	assert.ok(BOARD_AGENT_ACTIVITY_MS > BOARD_CLI_ACTIVITY_MS);
	assert.equal(
		boardAutomationExpiresAt({
			kind: "agent",
			startedAt: 100,
			updatedAt: 100 + BOARD_AUTOMATION_MAX_ACTIVITY_MS,
		}),
		100 + BOARD_AUTOMATION_MAX_ACTIVITY_MS,
	);
});
