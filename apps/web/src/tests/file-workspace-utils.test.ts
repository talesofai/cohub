import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import type { SpaceFsFileResponse } from "@neta-art/cohub";
import {
	classifySaveConflict,
	isPdfFile,
	isPdfPath,
} from "../lib/features/space/modules/file-workspace-utils.ts";

describe("file workspace utils", () => {
	it("recognizes PDF paths case-insensitively", () => {
		assert.equal(isPdfPath("docs/report.pdf"), true);
		assert.equal(isPdfPath("REPORT.PDF"), true);
		assert.equal(isPdfPath("report.pdf.txt"), false);
	});

	it("prefers PDF MIME while retaining an extension fallback", () => {
		assert.equal(
			isPdfFile({ path: "download", mimeType: "application/pdf" }),
			true,
		);
		assert.equal(
			isPdfFile({
				path: "docs/report.pdf",
				mimeType: "application/octet-stream",
			}),
			true,
		);
		assert.equal(
			isPdfFile({ path: "docs/report.txt", mimeType: "text/plain" }),
			false,
		);
		assert.equal(isPdfFile(null), false);
	});
});

function textFile(
	overrides: Partial<SpaceFsFileResponse>,
): SpaceFsFileResponse {
	return {
		path: "notes.md",
		name: "notes.md",
		size: 12,
		mimeType: "text/markdown",
		mtimeMs: 1_700_000_000_000.75,
		kind: "text",
		encoding: "utf-8",
		content: "hello world",
		...overrides,
	};
}

test("classifySaveConflict distinguishes idempotency, retry, and divergence", () => {
	assert.equal(
		classifySaveConflict(
			textFile({ content: "typed draft" }),
			"opened content",
			"typed draft",
		),
		"already-saved",
	);
	assert.equal(
		classifySaveConflict(
			textFile({ content: "opened content" }),
			"opened content",
			"typed draft",
		),
		"retry",
	);
	assert.equal(
		classifySaveConflict(
			textFile({ content: "changed elsewhere" }),
			"opened content",
			"typed draft",
		),
		"conflict",
	);
	assert.equal(
		classifySaveConflict(textFile({ content: "" }), "", "typed draft"),
		"retry",
	);
	assert.equal(
		classifySaveConflict(textFile({ content: "" }), "opened content", ""),
		"already-saved",
	);
	assert.equal(
		classifySaveConflict(null, "opened content", "typed draft"),
		"conflict",
	);
	assert.equal(
		classifySaveConflict(
			textFile({ kind: "binary", encoding: "base64", content: "" }),
			"opened content",
			"typed draft",
		),
		"conflict",
	);
});
