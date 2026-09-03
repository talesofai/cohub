import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileUploadedFiles } from "../lib/space-upload-cache.ts";
import { isBrowserManagedUploadHeader } from "../lib/upload-headers.ts";

describe("space upload headers", () => {
	it("leaves content length to the browser", () => {
		assert.equal(isBrowserManagedUploadHeader("content-length"), true);
		assert.equal(isBrowserManagedUploadHeader("Content-Length"), true);
		assert.equal(isBrowserManagedUploadHeader("content-type"), false);
	});
});

describe("space upload cache reconciliation", () => {
	it("replaces stale metadata after a same-path overwrite", () => {
		const entries = [
			{
				path: "images/cover.png",
				name: "cover.png",
				type: "file" as const,
				size: 1024,
				mimeType: "image/png",
				mtimeMs: 1_700_000_000_000,
			},
		];

		const reconciled = reconcileUploadedFiles(entries, [
			{
				path: "images/cover.png",
				name: "cover.png",
				size: 2048,
				mimeType: "image/png",
				mtimeMs: 1_700_000_066_000,
			},
		]);

		assert.deepEqual(reconciled, [
			{
				path: "images/cover.png",
				name: "cover.png",
				type: "file",
				size: 2048,
				mimeType: "image/png",
				mtimeMs: 1_700_000_066_000,
			},
		]);
	});
});
