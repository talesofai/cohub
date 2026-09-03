import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpaceFsFileResponse } from "@neta-art/cohub";
import { resolveBoardMediaFile } from "../lib/board/board-media-file-source.ts";

test("a stale media snapshot resolves authoritative metadata for repair", async () => {
	const reads: string[] = [];
	const current: SpaceFsFileResponse = {
		path: "images/cover.png",
		name: "cover.png",
		size: 2048,
		mimeType: "image/png",
		mtimeMs: 1_700_000_066_000,
		kind: "binary",
		encoding: "base64",
		content: "fresh",
	};

	const result = await resolveBoardMediaFile(
		current.path,
		{
			size: 1024,
			mimeType: "image/png",
			mtimeMs: current.mtimeMs - 66_000,
		},
		async (path) => {
			reads.push(path);
			return current;
		},
	);

	assert.deepEqual(
		reads,
		[current.path],
		"the workspace path remains authoritative",
	);
	assert.equal(result?.changed, true);
	assert.deepEqual(result?.metadata, {
		size: current.size,
		mimeType: current.mimeType,
		mtimeMs: current.mtimeMs,
	});
});

test("fractional Node mtimes match transport millisecond precision", async () => {
	const result = await resolveBoardMediaFile(
		"images/cover.png",
		{ size: 10, mimeType: "image/png", mtimeMs: 1234 },
		async () => ({
			path: "images/cover.png",
			name: "cover.png",
			size: 10,
			mimeType: "image/png",
			mtimeMs: 1234.75,
			kind: "binary",
			encoding: "base64",
			content: "fresh",
		}),
	);

	assert.equal(result?.changed, false);
});
