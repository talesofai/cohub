import assert from "node:assert/strict";
import test from "node:test";
import type { SpaceFsFileResponse } from "@neta-art/cohub";
import { filePreviewModel } from "$lib/file-preview-model";

const file = (
	overrides: Partial<SpaceFsFileResponse> & Pick<SpaceFsFileResponse, "path">,
): SpaceFsFileResponse => ({
	name: overrides.path.split("/").pop() ?? overrides.path,
	size: 12,
	mimeType: null,
	mtimeMs: 0,
	kind: "binary",
	encoding: "base64",
	content: "",
	...overrides,
});

test("text kinds are classified by path, not just MIME", () => {
	assert.equal(
		filePreviewModel(
			file({ path: "docs/readme.md", kind: "text", encoding: "utf-8" }),
		).kind,
		"markdown",
	);
	assert.equal(
		filePreviewModel(
			file({ path: "site/index.html", kind: "text", encoding: "utf-8" }),
		).kind,
		"html",
	);
	const code = filePreviewModel(
		file({ path: "src/main.ts", kind: "text", encoding: "utf-8" }),
	);
	assert.equal(code.kind, "text");
	assert.equal(code.language, "ts");
	assert.equal(code.hasRenderedPreview, false);
	const csv = filePreviewModel(
		file({ path: "data/sales.csv", kind: "text", encoding: "utf-8" }),
	);
	assert.equal(csv.kind, "csv");
	assert.equal(csv.hasRenderedPreview, true);
	assert.equal(csv.isText, true);
	// A text/csv MIME classifies as csv even without a .csv extension.
	assert.equal(
		filePreviewModel(file({ path: "data/export", mimeType: "text/csv" })).kind,
		"csv",
	);
	// Uppercase extensions are matched case-insensitively.
	assert.equal(
		filePreviewModel(
			file({ path: "data/report.CSV", kind: "text", encoding: "utf-8" }),
		).kind,
		"csv",
	);
});

test("media kinds come from MIME, with a PDF extension fallback", () => {
	assert.equal(
		filePreviewModel(file({ path: "a.png", mimeType: "image/png" })).kind,
		"image",
	);
	assert.equal(
		filePreviewModel(file({ path: "a.mp4", mimeType: "video/mp4" })).kind,
		"video",
	);
	assert.equal(
		filePreviewModel(file({ path: "a.mp3", mimeType: "audio/mpeg" })).kind,
		"audio",
	);
	// No MIME at all still previews as a PDF rather than degrading to download.
	assert.equal(filePreviewModel(file({ path: "a.pdf" })).kind, "pdf");
});

test("unknown binary degrades to fallback rather than being rejected", () => {
	assert.equal(
		filePreviewModel(
			file({ path: "a.bin", mimeType: "application/octet-stream" }),
		).kind,
		"fallback",
	);
	assert.equal(filePreviewModel(null).kind, "fallback");
});

test("media URL prefers CDN delivery and falls back to inline base64", () => {
	assert.equal(
		filePreviewModel(
			file({
				path: "a.png",
				mimeType: "image/png",
				delivery: "url",
				url: "https://cdn.example/a.png",
			}),
		).mediaUrl,
		"https://cdn.example/a.png",
	);
	assert.equal(
		filePreviewModel(
			file({ path: "a.png", mimeType: "image/png", content: "AAA" }),
		).mediaUrl,
		"data:image/png;base64,AAA",
	);
	// Text is rendered from its content, so it never carries a media URL.
	assert.equal(
		filePreviewModel(file({ path: "a.md", kind: "text", encoding: "utf-8" }))
			.mediaUrl,
		null,
	);
});
