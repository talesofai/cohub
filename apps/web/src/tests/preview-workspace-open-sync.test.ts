import assert from "node:assert/strict";
import { test } from "node:test";
import {
	activePreviewFilePath,
	workspaceFilePreviewKind,
} from "../lib/features/space/modules/preview-tabs.ts";

test("file-tree selection follows the active preview kind", () => {
	const filePath = "docs/readme.md";
	const boardPath = "boards/plan.board";

	assert.equal(activePreviewFilePath("file", filePath, boardPath), filePath);
	assert.equal(activePreviewFilePath("board", filePath, boardPath), boardPath);
	assert.equal(activePreviewFilePath("port", filePath, boardPath), "");
	assert.equal(activePreviewFilePath(null, filePath, boardPath), "");
});

test("workspace file links use the same Board routing as the file tree", () => {
	assert.equal(workspaceFilePreviewKind("docs/readme.md", false), "file");
	assert.equal(workspaceFilePreviewKind("boards/plan.board", false), "board");
	assert.equal(workspaceFilePreviewKind("boards/PLAN.BOARD", false), "board");
	assert.equal(workspaceFilePreviewKind("boards/plan.board", true), "file");
});
