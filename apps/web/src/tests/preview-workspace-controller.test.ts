import assert from "node:assert/strict";
import { test } from "node:test";
import { createPreviewWorkspaceController } from "../lib/features/space/modules/preview-workspace-controller.svelte.ts";

(globalThis as unknown as { $state: <T>(value: T) => T }).$state = <T>(
	value: T,
) => value;

type Deferred = {
	promise: Promise<void>;
	resolve: () => void;
};

function deferred(): Deferred {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function createHarness() {
	let fileTabs: Array<{ path: string; response: unknown; draft: string }> = [];
	let activeFilePath: string | null = null;
	const reads = new Map<string, Deferred>();
	const urls: Array<{
		ref: { kind: "file" | "board" | "port"; key: string } | null;
		replace: boolean;
	}> = [];

	const controller = createPreviewWorkspaceController({
		getFileTabs: () => fileTabs,
		getActiveFilePath: () => activeFilePath,
		getBoardTabs: () => [],
		getActiveBoardPath: () => null,
		getPortTabs: () => [],
		getActivePort: () => null,
		openFile: (path) => {
			activeFilePath = path;
			if (!fileTabs.some((tab) => tab.path === path))
				fileTabs = [...fileTabs, { path, response: null, draft: "" }];
			const read = deferred();
			reads.set(path, read);
			return read.promise;
		},
		activateFile: (path) => {
			activeFilePath = path;
		},
		closeFile: (path) => {
			if (!path) return;
			fileTabs = fileTabs.filter((tab) => tab.path !== path);
			if (activeFilePath === path)
				activeFilePath = fileTabs.at(-1)?.path ?? null;
		},
		goBackFile: async () => null,
		openBoard: async () => {},
		activateBoard: () => {},
		closeBoard: () => {},
		openPort: () => {},
		activatePort: () => {},
		closePort: () => {},
		getPortEndpointUrl: () => null,
		syncUrl: (ref, replace = true) => {
			urls.push({ ref, replace });
		},
		weightLimit: 100,
	});

	return { controller, reads, urls };
}

test("route acknowledgement preserves the user transition", async () => {
	const { controller, reads, urls } = createHarness();
	const opening = controller.openFile("docs/a.md");
	const transitionId = controller.navigation.transitionId;

	assert.deepEqual(controller.currentRef(), {
		kind: "file",
		key: "docs/a.md",
	});
	assert.deepEqual(urls.at(-1), {
		ref: { kind: "file", key: "docs/a.md" },
		replace: false,
	});

	controller.applyRoute({ kind: "file", key: "docs/a.md" });
	assert.equal(controller.navigation.transitionId, transitionId);
	assert.equal(controller.navigation.source, "user");

	reads.get("docs/a.md")?.resolve();
	await opening;
	assert.deepEqual(urls.at(-1)?.ref, {
		kind: "file",
		key: "docs/a.md",
	});
});

test("stale file completion cannot revert a newer preview", async () => {
	const { controller, reads, urls } = createHarness();
	const slow = controller.openFile("slow.md");
	const fast = controller.openFile("fast.md");

	reads.get("fast.md")?.resolve();
	await fast;
	reads.get("slow.md")?.resolve();
	await slow;

	assert.deepEqual(controller.currentRef(), {
		kind: "file",
		key: "fast.md",
	});
	assert.deepEqual(controller.navigation.desiredRef, {
		kind: "file",
		key: "fast.md",
	});
	assert.deepEqual(urls.at(-1)?.ref, {
		kind: "file",
		key: "fast.md",
	});
});

test("route removal closes the active preview without writing URL again", async () => {
	const { controller, reads, urls } = createHarness();
	const opening = controller.openFile("docs/a.md");
	reads.get("docs/a.md")?.resolve();
	await opening;
	const writesBeforeBack = urls.length;

	controller.applyRoute(null);

	assert.equal(controller.currentRef(), null);
	assert.equal(controller.navigation.desiredRef, null);
	assert.equal(controller.navigation.source, "route");
	assert.equal(urls.length, writesBeforeBack);
});
