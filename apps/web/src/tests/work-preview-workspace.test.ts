import assert from "node:assert/strict";
import { test } from "node:test";
import { createPreviewWorkspaceController } from "../lib/features/space/modules/preview-workspace-controller.svelte.ts";

(globalThis as unknown as { $state: <T>(value: T) => T }).$state = <T>(
	value: T,
) => value;

const WORK_A = "123e4567-e89b-42d3-a456-426614174000";
const WORK_B = "223e4567-e89b-42d3-a456-426614174001";

type OpenWorkInput = {
	workId: string;
	label?: string;
	launch?: { search?: string; hash?: string } | null;
};

function createHarness() {
	let workTabs: Array<{ workId: string; loading: boolean }> = [];
	let activeWorkId: string | null = null;
	const opens: OpenWorkInput[] = [];
	const urls: Array<{ kind: string; key: string } | null> = [];

	const controller = createPreviewWorkspaceController({
		getFileTabs: () => [],
		getActiveFilePath: () => null,
		getBoardTabs: () => [],
		getActiveBoardPath: () => null,
		getPortTabs: () => [],
		getActivePort: () => null,
		getWorkTabs: () => workTabs,
		getActiveWorkId: () => activeWorkId,
		openFile: async () => {},
		activateFile: () => {},
		closeFile: () => {},
		goBackFile: async () => null,
		openBoard: async () => {},
		activateBoard: () => {},
		closeBoard: () => {},
		openPort: () => {},
		activatePort: () => {},
		closePort: () => {},
		openWork: (input) => {
			opens.push(input);
			if (!workTabs.some((tab) => tab.workId === input.workId)) {
				workTabs = [...workTabs, { workId: input.workId, loading: false }];
			}
			activeWorkId = input.workId;
		},
		activateWork: (workId) => {
			activeWorkId = workId;
		},
		closeWork: (workId) => {
			if (!workId) return;
			workTabs = workTabs.filter((tab) => tab.workId !== workId);
			if (activeWorkId === workId)
				activeWorkId = workTabs.at(-1)?.workId ?? null;
		},
		getPortEndpointUrl: () => null,
		syncUrl: (ref) => {
			urls.push(ref);
		},
		weightLimit: 100,
	});

	return { controller, opens, urls, getWorkTabs: () => workTabs };
}

test("showing a work opens one tab and syncs a work preview URL", () => {
	const { controller, urls, getWorkTabs } = createHarness();
	controller.openWork({ workId: WORK_A, label: "Launch" });

	assert.deepEqual(controller.currentRef(), { kind: "work", key: WORK_A });
	assert.equal(controller.activeKind, "work");
	assert.equal(getWorkTabs().length, 1);
	assert.deepEqual(urls.at(-1), { kind: "work", key: WORK_A });
});

test("showing the same work again reuses the tab and forwards new launch state", () => {
	const { controller, opens, getWorkTabs } = createHarness();
	controller.openWork({ workId: WORK_A });
	controller.openWork({ workId: WORK_A, launch: { search: "?view=timeline" } });

	// Idempotent by work id: a repeat re-activates instead of stacking duplicates.
	assert.equal(getWorkTabs().length, 1);
	assert.equal(opens.length, 2);
	assert.deepEqual(opens.at(-1)?.launch, { search: "?view=timeline" });
});

test("work previews are rejected unless the key is a work id", () => {
	const { controller, opens } = createHarness();
	controller.openWork({ workId: "alice/studio/launch" });
	assert.equal(opens.length, 0);
	assert.equal(controller.currentRef(), null);
});

test("route hydration opens a work preview without writing the URL back", () => {
	const { controller, urls } = createHarness();
	const result = controller.applyRoute({ kind: "work", key: WORK_B });

	assert.equal(result.ok, true);
	assert.deepEqual(controller.currentRef(), { kind: "work", key: WORK_B });
	assert.equal(urls.length, 0);
});

test("closing the active work falls back to the remaining tab", () => {
	const { controller, getWorkTabs } = createHarness();
	controller.openWork({ workId: WORK_A });
	controller.openWork({ workId: WORK_B });
	controller.close("work", WORK_B);

	assert.equal(getWorkTabs().length, 1);
	assert.deepEqual(controller.currentRef(), { kind: "work", key: WORK_A });
});

test("closeAll clears work tabs alongside the other preview domains", () => {
	const { controller, getWorkTabs } = createHarness();
	controller.openWork({ workId: WORK_A });
	controller.openWork({ workId: WORK_B });
	controller.closeAll();

	assert.equal(getWorkTabs().length, 0);
	assert.equal(controller.currentRef(), null);
});
