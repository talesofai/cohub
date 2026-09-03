import assert from "node:assert/strict";
import { File } from "node:buffer";
import { describe, it } from "node:test";
import {
	BOARD_FILE_DROP_TARGET_DIR,
	boardNativeDropKind,
	uploadBoardDataTransfer,
} from "../lib/board/board-file-drop.ts";
import type { UploadSpaceEntriesOptions } from "../lib/space-upload.ts";

function fileDataTransfer(files: File[], types = ["Files"]): DataTransfer {
	return {
		files,
		items: [],
		types,
	} as unknown as DataTransfer;
}

describe("board local file drops", () => {
	it("uploads OS files to the workspace root and maps fresh metadata", async () => {
		const file = new File(["png"], "photo.png", {
			type: "image/png",
			lastModified: 1_700_000_000_000,
		});
		const requests: UploadSpaceEntriesOptions[] = [];

		const items = await uploadBoardDataTransfer({
			spaceId: "space-1",
			dataTransfer: fileDataTransfer([file]),
			readonly: false,
			upload: async (options) => {
				requests.push(options);
				return [
					{
						path: "photo.png",
						name: "photo.png",
						size: 3,
						mimeType: "image/png",
						mtimeMs: 1_800_000_000_123,
					},
				];
			},
		});

		const [received] = requests;
		assert.ok(received);
		assert.equal(received.spaceId, "space-1");
		assert.equal(received.targetDir, BOARD_FILE_DROP_TARGET_DIR);
		assert.equal(received.entries.length, 1);
		assert.equal(received.entries[0]?.file, file);
		assert.equal(received.entries[0]?.relativePath, "photo.png");
		assert.deepEqual(items, [
			{
				path: "photo.png",
				snapshot: {
					title: "photo.png",
					mimeType: "image/png",
					size: 3,
					mtimeMs: 1_800_000_000_123,
				},
			},
		]);
	});

	it("rejects local files on read-only boards without starting an upload", async () => {
		const file = new File(["x"], "blocked.txt", { type: "text/plain" });
		let uploadCalled = false;
		const dataTransfer = fileDataTransfer([file]);

		assert.equal(boardNativeDropKind(dataTransfer.types, true), null);
		const items = await uploadBoardDataTransfer({
			spaceId: "space-1",
			dataTransfer,
			readonly: true,
			upload: async () => {
				uploadCalled = true;
				return [];
			},
		});

		assert.equal(uploadCalled, false);
		assert.deepEqual(items, []);
	});

	it("keeps internal Board drag payloads on the existing path", () => {
		assert.equal(
			boardNativeDropKind(["Files", "application/x-cohub-resource"], false),
			"internal",
		);
		assert.equal(boardNativeDropKind(["Files"], false), "local-files");
	});
});
