import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SpaceFsChangedPayload } from "@cohub/protocol/fs";
import { getFsInvalidationTargets } from "../lib/cache/space-fs-invalidation.ts";
import {
	createSpaceFsRefreshCoordinator,
	type SpaceFsRefreshBatch,
} from "../lib/cache/space-fs-refresh-coordinator.ts";
import { reconcileSpaceFsSequence } from "../lib/cache/space-fs-sequence.ts";

function payload(
	changes: SpaceFsChangedPayload["changes"],
): SpaceFsChangedPayload {
	return { source: "sandbox-inotify", changes };
}

describe("space fs invalidation", () => {
	it("invalidates only the parent for file creates and modifies", () => {
		const targets = getFsInvalidationTargets(
			payload([
				{ path: "docs/new.md", kind: "create", nodeType: "file" },
				{ path: "src/index.ts", kind: "modify", nodeType: "file" },
			]),
		);

		assert.deepEqual([...targets.dirs].sort(), ["docs", "src"]);
		assert.deepEqual([...targets.subtrees], []);
	});

	it("invalidates deleted paths as subtrees even when node type is unknown", () => {
		const targets = getFsInvalidationTargets(
			payload([{ path: "docs/archive", kind: "delete", nodeType: "unknown" }]),
		);

		assert.deepEqual([...targets.dirs], ["docs"]);
		assert.deepEqual([...targets.subtrees], ["docs/archive"]);
	});

	it("invalidates both parents and cached subtrees for directory renames", () => {
		const targets = getFsInvalidationTargets(
			payload([
				{
					path: "archive/current",
					oldPath: "docs/current",
					kind: "rename",
					nodeType: "dir",
				},
			]),
		);

		assert.deepEqual([...targets.dirs].sort(), ["archive", "docs"]);
		assert.deepEqual([...targets.subtrees].sort(), [
			"archive/current",
			"docs/current",
		]);
	});

	it("invalidates the complete cache for resync events", () => {
		const targets = getFsInvalidationTargets({
			source: "sandbox-watch-started",
			resync: true,
			changes: [],
		});

		assert.deepEqual([...targets.dirs], []);
		assert.deepEqual([...targets.subtrees], [""]);
	});
});

function refreshBatch(sourceKey: string, dirs: string[]): SpaceFsRefreshBatch {
	return {
		eventSpaceId: "space-1",
		sourceKey,
		generation: 1,
		resync: false,
		dirs: new Set(dirs),
		boardManifestPaths: new Set(dirs.map((dir) => `${dir}/board.board`)),
		inlineFilePaths: new Set(dirs.map((dir) => `${dir}/note.md`)),
	};
}

describe("space fs refresh coordinator", () => {
	it("coalesces refreshes queued behind a slow request by directory", async () => {
		const seen: SpaceFsRefreshBatch[] = [];
		let releaseFirst = () => {};
		let markFirstStarted = () => {};
		let markSecondDone = () => {};
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const secondDone = new Promise<void>((resolve) => {
			markSecondDone = resolve;
		});
		const coordinator = createSpaceFsRefreshCoordinator(
			async (batch) => {
				seen.push(batch);
				if (seen.length === 1) {
					markFirstStarted();
					await firstBlocked;
				} else markSecondDone();
			},
			(error) => assert.fail(String(error)),
		);

		coordinator.enqueue(refreshBatch("live", ["first"]));
		await firstStarted;
		coordinator.enqueue(refreshBatch("live", ["docs"]));
		coordinator.enqueue(refreshBatch("live", ["docs", "src"]));
		releaseFirst();
		await secondDone;

		assert.equal(seen.length, 2);
		assert.deepEqual([...seen[1].dirs].sort(), ["docs", "src"]);
		assert.deepEqual([...seen[1].inlineFilePaths].sort(), [
			"docs/note.md",
			"src/note.md",
		]);
	});

	it("does not let a slow source block a different refresh context", async () => {
		let releaseSlow = () => {};
		let markSlowStarted = () => {};
		let markFastDone = () => {};
		const slowStarted = new Promise<void>((resolve) => {
			markSlowStarted = resolve;
		});
		const slowBlocked = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const fastDone = new Promise<void>((resolve) => {
			markFastDone = resolve;
		});
		const coordinator = createSpaceFsRefreshCoordinator(
			async (batch) => {
				if (batch.sourceKey === "slow") {
					markSlowStarted();
					await slowBlocked;
				} else markFastDone();
			},
			(error) => assert.fail(String(error)),
		);

		coordinator.enqueue(refreshBatch("slow", ["docs"]));
		await slowStarted;
		coordinator.enqueue(refreshBatch("fast", ["src"]));
		await fastDone;
		releaseSlow();
	});
});

describe("space fs sequence", () => {
	it("drops duplicate and older sandbox batches", () => {
		const result = reconcileSpaceFsSequence(
			{ source: "sandbox-inotify", seq: 4, changes: [] },
			5,
		);

		assert.equal(result.payload, null);
		assert.equal(result.lastSeq, 5);
	});

	it("turns sequence gaps into authoritative resyncs", () => {
		const result = reconcileSpaceFsSequence(
			{
				source: "sandbox-inotify",
				seq: 8,
				changes: [{ path: "stale.txt", kind: "create", nodeType: "file" }],
			},
			5,
		);

		assert.equal(result.payload?.resync, true);
		assert.deepEqual(result.payload?.changes, []);
		assert.equal(result.lastSeq, 8);
	});

	it("accepts watcher restart resyncs with a reset sequence", () => {
		const input: SpaceFsChangedPayload = {
			source: "sandbox-watch-started",
			seq: 1,
			resync: true,
			changes: [],
		};
		const result = reconcileSpaceFsSequence(input, 20);

		assert.equal(result.payload, input);
		assert.equal(result.lastSeq, 1);
	});
});
