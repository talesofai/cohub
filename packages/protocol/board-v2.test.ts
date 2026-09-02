import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BOARD_AUTHORING_SCHEMAS,
	BOARD_BUILTIN_CLIP_KINDS,
	BoardConnectionSchema,
	BoardEffectInputSchema,
	BoardTrackSchema,
	applyBoardItemPatch,
	boardAuthoringItemToNode,
	boardNodeToAuthoringItem,
	parseBoardCompositionInput,
	isPureBoardAnimationChange,
	validateBoardNodeInput,
	BoardItemValidationError,
} from "./src/index.js";

test("built protocol exports stay aligned with source exports", async () => {
	const built = await import("./dist/index.js");
	for (const key of [
		"BOARD_BUILTIN_CLIP_KINDS",
		"BOARD_BUILTIN_EFFECT_KINDS",
		"BOARD_NATIVE_NODE_TYPES",
	]) {
		assert.ok(key in built, `missing built protocol export: ${key}`);
	}
});

test("item patch errors stay structured and point back to props", () => {
	assert.throws(() => applyBoardItemPatch({
		id: "title",
		type: "text",
		frame: { x: 0, y: 0, width: 100, height: 40, rotation: 0 },
		props: { text: "Hello", fontSize: 24 },
	}, { props: { fontSize: 0 } }, "commands.0.item"), (error) => {
		assert.ok(error instanceof BoardItemValidationError);
		assert.equal(error.diagnostics[0]?.path, "commands.0.item.props.fontSize");
		return true;
	});
});

test("authoring draw items derive their frame from world points", () => {
	const node = boardAuthoringItemToNode({
		id: "stroke",
		type: "draw",
		rotation: 0,
		props: { points: [{ x: 100, y: 180, p: 0.5 }, { x: 190, y: 110, p: 0.5 }, { x: 280, y: 170, p: 0.5 }] },
		style: { color: "violet", strokeWidth: 4 },
	}, { path: "items.0" });
	assert.equal(node.x, 98);
	assert.equal(node.y, 108);
	assert.equal(node.data.points[0]?.x, 2);
});

test("the draw item example matches the frame geometry contract", async () => {
	const example = {
		nodeId: "stroke",
		type: "draw",
		x: 100,
		y: 100,
		width: 180,
		height: 100,
		rotation: 0,
		parentId: null,
		orderKey: null,
		refKind: null,
		refPath: null,
		refUrl: null,
		style: {},
		data: {
			points: [{ x: 2, y: 98, p: 0.5 }, { x: 90, y: 2, p: 0.5 }, { x: 178, y: 98, p: 0.5 }],
			color: "violet",
			size: 4,
		},
		view: {},
	};
	assert.deepEqual(validateBoardNodeInput(example), []);
	const { BoardAuthoringItemSchema } = await import("./src/index.js");
	assert.equal(BoardAuthoringItemSchema.safeParse({
		id: "stroke",
		type: "draw",
		rotation: 0,
		props: { points: [{ x: 102, y: 198, p: 0.5 }, { x: 190, y: 102, p: 0.5 }, { x: 278, y: 198, p: 0.5 }] },
		style: { color: "violet", strokeWidth: 4 },
	}).success, true);
});

test("Board animation capabilities stay honest and allow hidden scale", () => {
	assert.equal(BOARD_BUILTIN_CLIP_KINDS.includes("draw.reveal"), true);
	assert.equal((BOARD_BUILTIN_CLIP_KINDS as readonly string[]).includes("draw.handwrite"), false);
	assert.equal(BoardTrackSchema.safeParse({
		id: "grow",
		target: { type: "item", itemId: "title" },
		channel: "transform.scale",
		fill: "both",
		keyframes: [{ time: 0, value: 0 }, { time: 300, value: 1, easing: "ease-out-cubic" }],
	}).success, true);
});

test("animation patch limits and purity rules are shared by clients", () => {
	const changed = {
		items: [],
		connections: [],
		effects: ["pulse"],
		compositions: ["intro"],
		board: false,
		orderChanged: false,
	};
	assert.equal(isPureBoardAnimationChange(changed), true);
	assert.equal(isPureBoardAnimationChange({ ...changed, items: ["node"] }), false);
	assert.equal(isPureBoardAnimationChange({ ...changed, connections: ["edge"] }), false);
	assert.equal(isPureBoardAnimationChange({ ...changed, orderChanged: true }), false);
});

test("authoring sources reject unsafe workspace paths", async () => {
	const { BoardAuthoringItemSchema } = await import("./src/index.js");
	const item = (path: string) => ({
		id: "image",
		type: "image",
		position: { x: 0, y: 0 },
		size: { width: 100, height: 100 },
		rotation: 0,
		props: {},
		source: { kind: "space-file", path },
	});
	assert.equal(BoardAuthoringItemSchema.safeParse(item("assets/image.png")).success, true);
	assert.equal(BoardAuthoringItemSchema.safeParse(item("../secret.png")).success, false);
	assert.equal(BoardAuthoringItemSchema.safeParse(item("/etc/passwd")).success, false);
});

test("authoring items expose only semantic fields", () => {
	const item = boardNodeToAuthoringItem({
		nodeId: "title",
		type: "text",
		parentId: null,
		orderKey: "00004096",
		x: 0,
		y: 0,
		width: 200,
		height: 40,
		rotation: 0,
		refKind: null,
		refPath: null,
		refUrl: null,
		view: {},
		style: {},
		data: { text: "Hello", fontSize: 24, color: "neutral" },
	});
	assert.equal("opaque" in item, false);
	assert.equal("orderKey" in item, false);
	assert.equal(boardAuthoringItemToNode(item).data.text, "Hello");
});

test("Composition inspect output can be applied without server revision", () => {
	const input = parseBoardCompositionInput({
		id: "intro",
		name: "Intro",
		timeline: { duration: 100, tracks: [], clips: [], markers: [] },
		playback: { loop: false, endBehavior: "hold", reducedMotion: { mode: "base" } },
		metadata: {},
		revision: 7,
	});
	assert.equal("revision" in input, false);
});

test("authoring capabilities serialize every schema lazily", () => {
	assert.deepEqual(Object.keys(BOARD_AUTHORING_SCHEMAS), [
		"item", "itemPatch", "mutation", "composition", "effect", "create",
	]);
	const serialized = JSON.parse(JSON.stringify(BOARD_AUTHORING_SCHEMAS));
	assert.ok(serialized.item);
	assert.ok(serialized.mutation);
	assert.ok(serialized.composition);
});

test("connection and effect envelopes reject unknown fields", () => {
	assert.equal(BoardConnectionSchema.safeParse({
		id: "connection",
		source: { nodeId: "a", anchor: { kind: "auto" } },
		target: { nodeId: "b", anchor: { kind: "auto" } },
		relation: "related",
		unknown: true,
	}).success, false);
	assert.equal(BoardEffectInputSchema.safeParse({
		id: "pulse",
		target: { type: "board" },
		kind: "effects.pulse",
		kindVersion: 1,
		lifecycle: "manual",
		timeOrigin: "board",
		seed: "seed",
		unknown: true,
	}).success, false);
});
