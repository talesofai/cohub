import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkPreviewController } from "../lib/features/space/modules/work-preview-controller.svelte.ts";

(globalThis as unknown as { $state: <T>(value: T) => T }).$state = <T>(
	value: T,
) => value;

const WORK_ID = "123e4567-e89b-42d3-a456-426614174000";

const detailFor = (kind: "web" | "port" | "file" | "board" | null) => ({
	work: { id: WORK_ID, slug: "launch", meta: null, status: "published" },
	space: null,
	owner: null,
	publicUrl: "https://cohub.run/alice/studio/w/launch",
	content: kind ? { kind, url: "https://work.example/index.html" } : null,
});

function createController(
	options: { detail?: unknown; delayMs?: number; fail?: string } = {},
) {
	return createWorkPreviewController({
		getSpaceId: () => "space-1",
		loadWork: async () => {
			if (options.delayMs)
				await new Promise((r) => setTimeout(r, options.delayMs));
			if (options.fail) throw new Error(options.fail);
			return (options.detail ?? detailFor("web")) as never;
		},
	});
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("opening a work loads its detail and adopts the published title as the tab label", async () => {
	const controller = createController();
	controller.openWork({ workId: WORK_ID, label: "Work" });
	assert.equal(controller.preview?.loading, true);

	await settle();
	assert.equal(controller.preview?.loading, false);
	assert.equal(controller.preview?.label, "launch");
});

test("reopening a closed Work gets a fresh surface mount", () => {
	const controller = createController();
	controller.openWork({ workId: WORK_ID });
	const firstMountKey = controller.preview?.mountKey;

	controller.openWork({ workId: WORK_ID });
	assert.equal(controller.preview?.mountKey, firstMountKey);

	controller.closeWork(WORK_ID);
	controller.openWork({ workId: WORK_ID });
	assert.notEqual(controller.preview?.mountKey, firstMountKey);
});

test("Work composer context updates in place and is discarded with the preview", () => {
	const controller = createController();
	controller.openWork({ workId: WORK_ID });
	const chip = {
		key: "selection",
		label: "3 selected",
		content: "Selected records:\n- customer_123",
	};

	controller.setComposerChip(WORK_ID, chip);
	assert.deepEqual(controller.preview?.composerChip, chip);
	controller.setComposerChip(WORK_ID, { ...chip, label: "4 selected" });
	assert.equal(controller.preview?.composerChip?.label, "4 selected");
	controller.closeWork(WORK_ID);
	assert.equal(controller.preview, null);
});

test("a call issued right after opening waits for the detail and the mounted surface", async () => {
	// The realistic agent path: show and call in one command, before the iframe exists.
	const controller = createController({ delayMs: 20 });
	controller.openWork({ workId: WORK_ID });
	const pending = controller.callSurface({
		workId: WORK_ID,
		method: "ping",
		commandId: "command-1",
	});

	setTimeout(() => {
		controller.registerSurface(WORK_ID, async ({ method }) => ({
			ok: true,
			result: { echoed: method },
		}));
	}, 30);

	assert.deepEqual(await pending, { ok: true, result: { echoed: "ping" } });
});

for (const [name, options, code] of [
	[
		"a natively rendered work",
		{ detail: detailFor("board") },
		"surface_not_supported",
	],
	[
		"a work with no published content",
		{ detail: detailFor(null) },
		"surface_not_supported",
	],
	[
		"a work whose detail failed to load",
		{ fail: "Work not found" },
		"preview_failed",
	],
] as const) {
	test(`calling ${name} fails fast with ${code}`, async () => {
		const controller = createController(options);
		controller.openWork({ workId: WORK_ID });

		const result = await controller.callSurface({
			workId: WORK_ID,
			method: "ping",
			commandId: "command-1",
		});
		assert.equal(result.ok === false && result.code, code);
	});
}

test("a denied member read falls back to the public one, other errors do not", async () => {
	// `cohub ui preview` accepts public references, so a public Work in a Space we
	// cannot view must still preview.
	const build = (status: number) => {
		let publicReads = 0;
		const controller = createWorkPreviewController({
			getSpaceId: () => "space-1",
			loadWork: async () => {
				throw Object.assign(new Error("denied"), { status });
			},
			loadPublicWork: async () => {
				publicReads += 1;
				return detailFor("web") as never;
			},
		});
		return { controller, reads: () => publicReads };
	};

	const denied = build(403);
	denied.controller.openWork({ workId: WORK_ID });
	await settle();
	assert.equal(denied.reads(), 1);
	assert.equal(denied.controller.preview?.error, null);

	const failed = build(500);
	failed.controller.openWork({ workId: WORK_ID });
	await settle();
	assert.equal(failed.reads(), 0);
	assert.equal(failed.controller.preview?.error, "denied");
});

test("a work that is not open, or was closed, cannot be called", async () => {
	const controller = createController();
	const before = await controller.callSurface({
		workId: WORK_ID,
		method: "ping",
		commandId: "command-1",
	});
	assert.equal(before.ok === false && before.code, "preview_not_open");

	controller.openWork({ workId: WORK_ID });
	await settle();
	controller.registerSurface(WORK_ID, async () => ({ ok: true }));
	controller.closeWork(WORK_ID);

	assert.equal(controller.previews.length, 0);
	const after = await controller.callSurface({
		workId: WORK_ID,
		method: "ping",
		commandId: "command-1",
	});
	assert.equal(after.ok === false && after.code, "preview_not_open");
});
