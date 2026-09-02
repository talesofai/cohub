import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createWindowManager } from "../lib/features/space/modules/window-manager.svelte.ts";

(globalThis as unknown as { $state: <T>(value: T) => T }).$state = <T>(
	value: T,
) => value;

const WORK_ID = "123e4567-e89b-42d3-a456-426614174000";

type Ref = { kind: "file" | "board" | "port" | "app"; key: string };

/**
 * A harness with all four domains mounted, so cross-domain fallback and
 * out-of-band closes can be exercised the way the page wires them.
 */
function createHarness() {
	let filePaths: string[] = [];
	let activeFilePath: string | null = null;
	let boardPaths: string[] = [];
	let activeBoardPath: string | null = null;
	let ports: string[] = [];
	let activePort: string | null = null;
	let appIds: string[] = [];
	let activeAppId: string | null = null;
	let boardOpenCount = 0;
	const urls: Array<Ref | null> = [];
	const appInvocations: Array<unknown> = [];

	const drop = (list: string[], key: string) =>
		list.filter((item) => item !== key);

	const controller = createWindowManager({
		getFileTabs: () =>
			filePaths.map((path) => ({ path, response: null, draft: "" })),
		getActiveFilePath: () => activeFilePath,
		getBoardTabs: () => boardPaths.map((path) => ({ path, saving: false })),
		getActiveBoardPath: () => activeBoardPath,
		getPortTabs: () => ports.map((port) => ({ port, url: "http://x" })),
		getActivePort: () => activePort,
		getAppTabs: () => appIds.map((appId) => ({ appId, loading: false })),
		getActiveAppId: () => activeAppId,
		openFile: async (path) => {
			if (!filePaths.includes(path)) filePaths = [...filePaths, path];
			activeFilePath = path;
		},
		activateFile: (path) => {
			activeFilePath = path;
		},
		closeFile: (path) => {
			if (!path) return;
			filePaths = drop(filePaths, path);
			if (activeFilePath === path) activeFilePath = filePaths.at(-1) ?? null;
		},
		goBackFile: async () => null,
		openBoard: async (path) => {
			boardOpenCount += 1;
			if (!boardPaths.includes(path)) boardPaths = [...boardPaths, path];
			activeBoardPath = path;
		},
		activateBoard: (path) => {
			activeBoardPath = path;
		},
		closeBoard: (path) => {
			if (!path) return;
			boardPaths = drop(boardPaths, path);
			if (activeBoardPath === path) activeBoardPath = boardPaths.at(-1) ?? null;
		},
		openPort: (port) => {
			if (!ports.includes(port)) ports = [...ports, port];
			activePort = port;
		},
		activatePort: (port) => {
			activePort = port;
		},
		closePort: (port) => {
			if (!port) return;
			ports = drop(ports, port);
			if (activePort === port) activePort = ports.at(-1) ?? null;
		},
		openApp: (input) => {
			if (!appIds.includes(input.appId)) appIds = [...appIds, input.appId];
			appInvocations.push(input.openContext);
			activeAppId = input.appId;
		},
		activateApp: (appId) => {
			activeAppId = appId;
		},
		closeApp: (appId) => {
			if (!appId) return;
			appIds = drop(appIds, appId);
			if (activeAppId === appId) activeAppId = appIds.at(-1) ?? null;
		},
		getPortEndpointUrl: () => "http://x",
		syncUrl: (ref) => {
			urls.push(ref);
		},
		weightLimit: 100,
	});

	return {
		controller,
		urls,
		appInvocations,
		counts: () => ({
			files: filePaths.length,
			boards: boardPaths.length,
			ports: ports.length,
			apps: appIds.length,
		}),
		boardOpenCount: () => boardOpenCount,
		/** Simulate a domain closing a tab on its own schedule. */
		closeFileOutOfBand: (path: string) => {
			filePaths = drop(filePaths, path);
			if (activeFilePath === path) activeFilePath = filePaths.at(-1) ?? null;
		},
	};
}

test("closing the active preview falls back to the most recently used surface", async () => {
	const { controller } = createHarness();
	await controller.openFile("docs/a.md");
	controller.openPort("5173", "http://x");
	controller.openApp({
		appId: WORK_ID,
		openContext: { source: "user" },
	});

	controller.close("app", WORK_ID);

	// The remaining file and port tabs are both mounted; the port was used more
	// recently, so a fixed kind order must not send the user back to the file.
	assert.deepEqual(controller.currentRef(), { kind: "port", key: "5173" });
	assert.equal(controller.activeKind, "port");
});

test("re-activating an older tab makes it the fallback again", async () => {
	const { controller } = createHarness();
	await controller.openFile("docs/a.md");
	await controller.openBoard("plans/main.board");
	controller.activate("file", "docs/a.md");
	controller.openApp({
		appId: WORK_ID,
		openContext: { source: "user" },
	});

	controller.close("app", WORK_ID);

	assert.deepEqual(controller.currentRef(), { kind: "file", key: "docs/a.md" });
});

test("a deferred domain close re-derives the active ref and rewrites the URL", async () => {
	const { controller, urls, closeFileOutOfBand } = createHarness();
	await controller.openFile("docs/a.md");
	await controller.openFile("docs/b.md");
	const writesBefore = urls.length;

	// A file that flushed its autosave closes itself after the user's click has
	// already returned; without a report the URL keeps pointing at it.
	closeFileOutOfBand("docs/b.md");
	controller.tabClosed("file", "docs/b.md");

	assert.deepEqual(controller.currentRef(), { kind: "file", key: "docs/a.md" });
	assert.deepEqual(urls.at(-1), { kind: "file", key: "docs/a.md" });
	assert.ok(urls.length > writesBefore);
});

test("the last deferred close clears the preview URL", async () => {
	const { controller, urls, closeFileOutOfBand } = createHarness();
	await controller.openFile("docs/a.md");

	closeFileOutOfBand("docs/a.md");
	controller.tabClosed("file", "docs/a.md");

	assert.equal(controller.currentRef(), null);
	assert.equal(controller.activeKind, null);
	assert.equal(urls.at(-1), null);
});

test("a close driven by the coordinator is not reconciled twice", async () => {
	const { controller, urls } = createHarness();
	await controller.openFile("docs/a.md");
	await controller.openFile("docs/b.md");
	controller.close("file", "docs/b.md");
	const writesAfterClose = urls.length;

	// The domain also reports the close it was just asked to perform.
	controller.tabClosed("file", "docs/b.md");

	assert.equal(urls.length, writesAfterClose);
	assert.deepEqual(controller.currentRef(), { kind: "file", key: "docs/a.md" });
});

test("a reopened tab does not inherit its previous access order", async () => {
	const { controller } = createHarness();
	await controller.openFile("docs/a.md");
	controller.openPort("5173", "http://x");
	controller.close("port", "5173");

	// Reopening the port must rank it as newest, not restore the stale ordering
	// left behind by the closed tab.
	controller.openPort("5173", "http://x");
	controller.openApp({
		appId: WORK_ID,
		openContext: { source: "user" },
	});
	controller.close("app", WORK_ID);

	assert.deepEqual(controller.currentRef(), { kind: "port", key: "5173" });
});

test("compact session navigation suspends tabs without disposing runtimes", async () => {
	const { controller, counts, boardOpenCount } = createHarness();
	await controller.openFile("docs/a.md");
	await controller.openBoard("plans/main.board");
	controller.openPort("5173", "http://x");
	controller.openApp({
		appId: WORK_ID,
		openContext: { source: "user" },
	});
	const opensBeforeSuspend = boardOpenCount();

	assert.equal(controller.suspendForRoute(), true);
	assert.equal(controller.suspended, true);
	assert.equal(controller.currentRef(), null);
	assert.equal(controller.activeKind, null);
	assert.deepEqual(counts(), { files: 1, boards: 1, ports: 1, apps: 1 });

	controller.applyRoute({ kind: "board", key: "plans/main.board" });
	assert.equal(controller.suspended, false);
	assert.deepEqual(controller.currentRef(), {
		kind: "board",
		key: "plans/main.board",
	});
	assert.equal(
		boardOpenCount(),
		opensBeforeSuspend,
		"restoring a mounted Board must reuse its editor runtime",
	);
});

test("closeAll drops every domain tab and the active ref", async () => {
	const { controller, counts } = createHarness();
	await controller.openFile("docs/a.md");
	await controller.openBoard("plans/main.board");
	controller.openPort("5173", "http://x");
	controller.openApp({
		appId: WORK_ID,
		openContext: { source: "user" },
	});

	controller.closeAll();

	assert.deepEqual(counts(), { files: 0, boards: 0, ports: 0, apps: 0 });
	assert.equal(controller.currentRef(), null);
});

test("route hydration adopts each preview kind without writing the URL back", async () => {
	for (const ref of [
		{ kind: "file", key: "docs/a.md" },
		{ kind: "board", key: "plans/main.board" },
		{ kind: "port", key: "5173" },
		{ kind: "app", key: WORK_ID },
	] as const) {
		const { controller, urls, appInvocations } = createHarness();
		const result = controller.applyRoute(ref);
		// File and Board open asynchronously; let their domain tab land.
		await Promise.resolve();

		assert.equal(result.ok, true);
		assert.deepEqual(controller.currentRef(), ref);
		assert.equal(urls.length, 0);
		if (ref.kind === "app") {
			assert.deepEqual(appInvocations, [{ source: "route" }]);
		}
	}
});

test("a context teardown never writes the URL of the route it is leaving for", async () => {
	const { controller, urls } = createHarness();
	await controller.openFile("docs/a.md");
	controller.openPort("5173", "http://x");
	controller.openApp({
		appId: WORK_ID,
		openContext: { source: "user" },
	});
	const writesBefore = urls.length;

	// Leaving a Space/FS context: the new route is already in the address bar, so
	// closing the outgoing previews must not sync a URL of its own.
	controller.resetForContext(() => {
		controller.tabClosed("app", WORK_ID);
		controller.tabClosed("port", "5173");
		controller.tabClosed("file", "docs/a.md");
	});

	assert.equal(urls.length, writesBefore, "teardown must not sync any URL");
});

test("the route that follows a context teardown survives", async () => {
	const { controller, urls } = createHarness();
	controller.openApp({
		appId: WORK_ID,
		openContext: { source: "user" },
	});
	const writesBefore = urls.length;

	// Full sequence of a Space switch: tear the old context down, then hydrate the
	// preview the new URL asked for.
	controller.resetForContext(() => {
		controller.tabClosed("app", WORK_ID);
	});
	const result = controller.applyRoute({ kind: "file", key: "README.md" });
	await Promise.resolve();

	assert.equal(result.ok, true);
	assert.deepEqual(controller.currentRef(), { kind: "file", key: "README.md" });
	assert.deepEqual(
		urls.slice(writesBefore),
		[],
		"neither the discarded context nor route hydration may write the URL",
	);
});

test("context teardown runs through the coordinator, not the page", () => {
	const page = readFileSync(
		new URL("../lib/features/space/SpaceWorkspacePage.svelte", import.meta.url),
		"utf8",
	);

	// Both teardown paths (route context change, entering a Space) must close their
	// domains inside resetForContext, or a dying context writes over the new route.
	const teardowns = [...page.matchAll(/resetForContext\(\(\) => \{/g)];
	assert.equal(teardowns.length, 2);
	for (const match of teardowns) {
		const body = page.slice(match.index, match.index + 600);
		assert.match(body, /close(Board|Port|All)\(/);
	}
});

test("every domain reports closed tabs to the coordinator", () => {
	const features = new URL("../lib/features/space/", import.meta.url);
	const modules = new URL("modules/", features);
	const page = readFileSync(
		new URL("SpaceWorkspacePage.svelte", features),
		"utf8",
	);

	// A domain can close a tab without being asked — a file flushing its autosave
	// first, or a deleted path. Without a report the URL and panel keep pointing
	// at a surface that no longer exists.
	for (const [file, callback] of [
		["file-workspace-controller.svelte.ts", "onInlineFileClosed"],
		["board-window-controller.svelte.ts", "onBoardClosed"],
		["port-window-controller.svelte.ts", "onPortClosed"],
		["app-window-controller.svelte.ts", "onAppClosed"],
	] as const) {
		const source = readFileSync(new URL(file, modules), "utf8");
		assert.match(source, new RegExp(`options\\.${callback}\\?\\.\\(`));
		assert.match(page, new RegExp(`${callback}:[\\s\\S]{0,80}tabClosed\\(`));
	}
});

test("panels open only once their tab is the committed active surface", () => {
	const modules = new URL("../lib/features/space/modules/", import.meta.url);
	const board = readFileSync(
		new URL("board-window-controller.svelte.ts", modules),
		"utf8",
	);
	const port = readFileSync(
		new URL("port-window-controller.svelte.ts", modules),
		"utf8",
	);
	const app = readFileSync(
		new URL("app-window-controller.svelte.ts", modules),
		"utf8",
	);

	// Same failure mode for every domain: opening the panel before the tab and
	// the active key are committed paints a preview stage with nothing in it.
	for (const [source, activeAssignment] of [
		[board, "activeBoardPath = path"],
		[port, "activePort = port"],
		[app, "activeAppId = input.appId"],
	] as const) {
		const activeAt = source.indexOf(activeAssignment);
		const openPanelAt = source.indexOf("options.onOpenPanel?.()");
		assert.ok(activeAt > 0, `missing active assignment: ${activeAssignment}`);
		assert.ok(openPanelAt > 0, "missing onOpenPanel call");
		assert.ok(
			activeAt < openPanelAt,
			`onOpenPanel must follow ${activeAssignment}`,
		);
	}
});
