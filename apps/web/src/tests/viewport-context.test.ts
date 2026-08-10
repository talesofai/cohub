import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildViewportContentBlock,
	buildViewportReferencesText,
	formatViewportContextLabel,
	parseViewportContextsFromMeta,
	viewportContextId,
} from "@cohub/protocol";
import { visibleWorldRect } from "@neta-art/cohub/board";
import {
	activeViewportSourceId,
	nextDismissedIdsAfterSourceChange,
} from "../lib/features/session-chat/viewport-context-controller.svelte.ts";

test("visibleWorldRect converts camera offset into world bounds", () => {
	const rect = visibleWorldRect({ x: -100, y: -50, zoom: 2 }, 400, 300);
	assert.deepEqual(rect, {
		x: 50,
		y: 25,
		width: 200,
		height: 150,
	});
});

test("viewport reference text stays agent-readable", () => {
	const text = buildViewportReferencesText([
		{
			kind: "file",
			path: "src/main.ts",
			visibleLines: { start: 8, end: 32 },
		},
		{
			kind: "port",
			port: "5173",
			url: "https://preview.example",
		},
	]);
	assert.equal(
		text,
		[
			"Viewport:",
			"- file: `src/main.ts` (L8-32)",
			"- port: `5173` (https://preview.example)",
		].join("\n"),
	);
});

test("board context carries boardId and view for agent inspection", () => {
	const boardId = "550e8400-e29b-41d4-a716-446655440000";
	const contexts = [
		{
			kind: "board" as const,
			path: "board.board",
			boardId,
			visibleRect: { x: 0, y: 0, width: 1200, height: 800 },
			selectedNodes: [{ id: "card-1", type: "text", title: "Note" }],
		},
	];
	const text = buildViewportReferencesText(contexts);
	assert.equal(
		text,
		[
			"Viewport:",
			`- board: \`board.board\` (id: ${boardId}; selected: Note; view 1200×800 at (0, 0))`,
		].join("\n"),
	);
});

test("Work context preserves custom chip content for the Agent and timeline", () => {
	const context = {
		kind: "work" as const,
		workId: "550e8400-e29b-41d4-a716-446655440000",
		key: "selection",
		label: "3 selected",
		content: "Selected records:\n- customer_123\n- customer_456",
	};
	const block = buildViewportContentBlock([context]);

	assert.equal(viewportContextId(context), `work:${context.workId}:selection`);
	assert.equal(formatViewportContextLabel(context), context.label);
	assert.equal(
		block?.text,
		[
			"Viewport:",
			`- work: \`${context.workId}\` (3 selected)`,
			context.content,
		].join("\n"),
	);
	assert.deepEqual(parseViewportContextsFromMeta(block?._meta), [context]);
});

test("viewport content block meta round-trips for timeline chips", () => {
	const boardId = "550e8400-e29b-41d4-a716-446655440000";
	const contexts = [
		{
			kind: "board" as const,
			path: "board.board",
			boardId,
			selectedNodes: [{ id: "card-1", type: "text", title: "Note" }],
		},
	];
	const block = buildViewportContentBlock(contexts);
	assert.ok(block);
	assert.equal(block?._meta?.attachmentKind, "viewport");
	assert.equal(viewportContextId(contexts[0]), "board:board.board");
	assert.equal(
		formatViewportContextLabel(contexts[0]),
		"board.board · 1 selected",
	);
	// boardId survives the meta round-trip
	const parsed = parseViewportContextsFromMeta(block?._meta);
	assert.equal(parsed[0].kind, "board");
	assert.equal(parsed[0].boardId, boardId);
});

test("activeViewportSourceId matches viewportContextId shape", () => {
	assert.equal(
		activeViewportSourceId({ kind: "file", path: "src/main.ts" }),
		"file:src/main.ts",
	);
	assert.equal(
		activeViewportSourceId({ kind: "board", path: "board.board" }),
		"board:board.board",
	);
	assert.equal(
		activeViewportSourceId({
			kind: "port",
			port: "5173",
			url: "https://preview.example",
		}),
		"port:5173",
	);
	assert.equal(
		activeViewportSourceId({
			kind: "work",
			workId: "work-1",
			key: "selection",
			label: "Selected",
			content: "customer_123",
		}),
		"work:work-1:selection",
	);
	assert.equal(activeViewportSourceId(null), null);
});

test("dismiss sticks across send; only real source change prunes it", () => {
	const board = "board:board.board";
	const other = "file:src/main.ts";
	const dismissed = [board];

	// Closing preview keeps dismiss so reopening the same source stays quiet.
	assert.deepEqual(nextDismissedIdsAfterSourceChange(dismissed, board, null), [
		board,
	]);
	// Same source again — no-op (setActiveSource short-circuits before this,
	// but the helper itself must not clear).
	assert.deepEqual(nextDismissedIdsAfterSourceChange(dismissed, board, board), [
		board,
	]);
	// Switching to another source drops the old dismiss so a later return can auto-attach.
	assert.deepEqual(
		nextDismissedIdsAfterSourceChange(dismissed, board, other),
		[],
	);
	// Unrelated dismiss ids are preserved when pruning the previous source.
	assert.deepEqual(
		nextDismissedIdsAfterSourceChange([board, other], board, other),
		[other],
	);
});
