import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getMimeType } from "./space-fs.js";
import {
	isTextMime,
	normalizeMime,
	resolveReadMimeType,
} from "./space-fs-mime.js";

describe("space-fs-mime", () => {
	it("normalizes mime parameters", () => {
		assert.equal(normalizeMime("text/plain; charset=utf-8"), "text/plain");
		assert.equal(normalizeMime(" application/JSON "), "application/json");
	});

	it("treats parameterized text/* as text", () => {
		assert.equal(isTextMime("text/plain; charset=utf-8"), true);
		assert.equal(isTextMime("application/json; charset=utf-8"), true);
		assert.equal(isTextMime("application/octet-stream"), false);
	});

	it("prefers filename text types over generic sandbox sniffs", () => {
		// .npmrc → text/plain beats application/octet-stream from DetectContentType
		assert.equal(
			resolveReadMimeType("text/plain", "application/octet-stream"),
			"text/plain",
		);
		assert.equal(
			resolveReadMimeType("text/plain", "text/plain; charset=utf-8"),
			"text/plain",
		);
	});

	it("keeps real media sniffs when the filename has no text type", () => {
		assert.equal(resolveReadMimeType(null, "image/png"), "image/png");
		assert.equal(
			resolveReadMimeType(null, "application/pdf"),
			"application/pdf",
		);
		assert.equal(
			resolveReadMimeType(null, "application/octet-stream"),
			"application/octet-stream",
		);
	});

	it("treats board manifest mime (application/json) as text", () => {
		// .board is registered as application/json in space-fs getMimeType.
		assert.equal(isTextMime("application/json"), true);
		assert.equal(
			resolveReadMimeType("application/json", "application/octet-stream"),
			"application/json",
		);
	});

	it("classifies .csv as text by extension and MIME", () => {
		assert.equal(getMimeType("data/sales.csv"), "text/csv");
		assert.equal(getMimeType("data/SALES.CSV"), "text/csv");
		assert.equal(isTextMime("text/csv"), true);
		assert.equal(isTextMime("application/csv"), true);
	});
});
