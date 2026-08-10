import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	coerceInlineTextFile,
	isTextFileResponse,
	isTextMime,
	tryResolveTextFileResponse,
} from "../lib/space-file-text.ts";

describe("space-file-text", () => {
	it("classifies parameterized text mime as text", () => {
		assert.equal(isTextMime("text/plain; charset=utf-8"), true);
		assert.equal(
			isTextFileResponse({
				kind: "binary",
				mimeType: "text/plain; charset=utf-8",
			}),
			true,
		);
	});

	it("recovers misclassified inline .npmrc binary as text", () => {
		const content = "registry=https://registry.npmjs.org/\n";
		const recovered = coerceInlineTextFile({
			path: ".npmrc",
			name: ".npmrc",
			size: content.length,
			mimeType: "application/octet-stream",
			mtimeMs: Date.now(),
			kind: "binary",
			encoding: "base64",
			content: Buffer.from(content, "utf8").toString("base64"),
			delivery: "inline",
		});
		assert.equal(recovered.kind, "text");
		assert.equal(recovered.content, content);
	});

	it("recovers misclassified inline .csv binary as text", () => {
		const content = "name,age\nAlice,30\nBob,25\n";
		const recovered = coerceInlineTextFile({
			path: "data/sales.csv",
			name: "sales.csv",
			size: content.length,
			mimeType: null,
			mtimeMs: Date.now(),
			kind: "binary",
			encoding: "base64",
			content: Buffer.from(content, "utf8").toString("base64"),
			delivery: "inline",
		});
		assert.equal(recovered.kind, "text");
		assert.equal(recovered.mimeType, "text/plain");
		assert.equal(recovered.content, content);
		// Non-text binary with a .csv name is not recovered.
		const binary = coerceInlineTextFile({
			path: "data/blob.csv",
			name: "blob.csv",
			size: 4,
			mimeType: null,
			mtimeMs: Date.now(),
			kind: "binary",
			encoding: "base64",
			content: Buffer.from([0, 1, 2, 3]).toString("base64"),
			delivery: "inline",
		});
		assert.equal(binary.kind, "binary");
	});

	it("recovers misclassified inline .board binary as JSON text", () => {
		const content =
			'{"kind":"cohub.board.manifest","version":1,"boardId":"d1","title":"Board"}\n';
		const recovered = coerceInlineTextFile({
			path: "Board.board",
			name: "Board.board",
			size: content.length,
			mimeType: null,
			mtimeMs: Date.now(),
			kind: "binary",
			encoding: "base64",
			content: Buffer.from(content, "utf8").toString("base64"),
			delivery: "inline",
		});
		assert.equal(recovered.kind, "text");
		assert.equal(recovered.mimeType, "application/json");
		assert.equal(recovered.content, content);
	});

	it("soft-fails CDN hydrate without dropping the file response", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("nope", { status: 403 })) as typeof fetch;
		try {
			const result = await tryResolveTextFileResponse({
				path: ".npmrc",
				name: ".npmrc",
				size: 12,
				mimeType: "text/plain",
				mtimeMs: Date.now(),
				kind: "text",
				encoding: "utf-8",
				content: "",
				delivery: "url",
				url: "https://cdn.example/file",
			});
			assert.equal(result.file.path, ".npmrc");
			assert.equal(result.file.delivery, "url");
			assert.match(result.error ?? "", /Failed to load file content/);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("hydrates text content from CDN url", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("registry=https://registry.npmjs.org/\n", {
				status: 200,
			})) as typeof fetch;
		try {
			const result = await tryResolveTextFileResponse({
				path: ".npmrc",
				name: ".npmrc",
				size: 12,
				mimeType: "text/plain",
				mtimeMs: Date.now(),
				kind: "text",
				encoding: "utf-8",
				content: "",
				delivery: "url",
				url: "https://cdn.example/file",
			});
			assert.equal(result.error, null);
			assert.equal(result.file.kind, "text");
			assert.match(result.file.content, /registry=/);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
