import assert from "node:assert/strict";
import { test } from "node:test";
import {
	boardPathMatchesTarget,
	canAdoptBoardVersion,
	hasBoardIdentity,
	mergeChangedRecords,
} from "../lib/board/board-sync-policy.ts";

test("board identity lookup is independent of the active path", () => {
	const boards = [
		{ path: "active.board", boardId: "board-active" },
		{ path: "background.board", boardId: "board-background" },
	];

	assert.equal(hasBoardIdentity(boards, "board-background"), true);
	assert.equal(hasBoardIdentity(boards, "board-missing"), false);
});

test("recursive path matching respects directory boundaries", () => {
	assert.equal(boardPathMatchesTarget("plans/a.board", "plans", true), true);
	assert.equal(boardPathMatchesTarget("plans.board", "plans", true), false);
	assert.equal(boardPathMatchesTarget("plans/a.board", "plans", false), false);
	assert.equal(
		boardPathMatchesTarget("plans/a.board", "plans/a.board", false),
		true,
	);
});

test("changed record merge preserves untouched records and applies deletes", () => {
	const merged = mergeChangedRecords(
		[
			{ id: "keep", value: 1 },
			{ id: "update", value: 1 },
			{ id: "delete", value: 1 },
		],
		[
			{ id: "update", value: 2 },
			{ id: "create", value: 3 },
		],
		["update", "delete", "create"],
	);
	assert.deepEqual(merged, [
		{ id: "keep", value: 1 },
		{ id: "update", value: 2 },
		{ id: "create", value: 3 },
	]);
});

test("board bootstrap versions only move forward", () => {
	assert.equal(canAdoptBoardVersion(null, 0), true);
	assert.equal(canAdoptBoardVersion(4, 4), true);
	assert.equal(canAdoptBoardVersion(4, 5), true);
	assert.equal(canAdoptBoardVersion(5, 4), false);
});
