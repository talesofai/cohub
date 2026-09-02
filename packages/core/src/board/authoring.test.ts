import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyBoardItemPatch,
	boardAuthoringItemToNode,
	boardNodeToAuthoringItem,
	preserveOpaqueNodeFields,
} from "./authoring.js";

const text = {
	id: "title",
	type: "text" as const,
	position: { x: 10, y: 20 },
	size: { width: 320, height: 48 },
	rotation: 0,
	props: { text: "Launch plan", fontSize: 32 },
	style: { color: "brand" as const },
};

test("authoring Item compiles and round-trips through internal node storage", () => {
	const node = boardAuthoringItemToNode(text, { orderKey: "00000001" });
	assert.equal(node.nodeId, "title");
	assert.equal(node.data.text, "Launch plan");
	assert.equal(node.data.color, "brand");
	assert.deepEqual(boardNodeToAuthoringItem(node), text);
});

test("Item patch recursively merges objects and preserves untouched fields", () => {
	const patched = applyBoardItemPatch(text, {
		position: { x: 160 },
		props: { text: "Updated" },
	});
	assert.equal((patched as { position: { x: number } }).position.x, 160);
	assert.equal((patched as { size?: { width: number } }).size?.width, 320);
	const props = patched.props as { text: string; fontSize: number };
	assert.equal(props.text, "Updated");
	assert.equal(props.fontSize, 32);
});

test("explicit null clearing does not restore opaque source or style", () => {
	const before = boardAuthoringItemToNode({
		id: "extension",
		type: "extension.demo.node",
		kindVersion: 1,
		position: { x: 0, y: 0 },
		size: { width: 100, height: 100 },
		rotation: 0,
		props: {},
		source: { kind: "asset", ref: "asset:one" },
		style: { runtimeStyle: true },
	}, { orderKey: "00000001" });
	const compiled = boardAuthoringItemToNode({
		id: "extension",
		type: "extension.demo.node",
		kindVersion: 1,
		position: { x: 0, y: 0 },
		size: { width: 100, height: 100 },
		rotation: 0,
		props: {},
	}, { orderKey: before.orderKey });
	const cleared = preserveOpaqueNodeFields(before, compiled, {
		preserveSource: false,
		preserveStyle: false,
	});
	assert.equal(cleared.refKind, null);
	assert.equal(cleared.refPath, null);
	assert.deepEqual(cleared.view, {});
	assert.deepEqual(cleared.style, {});
});

test("partial authoring edits preserve opaque storage fields", () => {
	const before = boardAuthoringItemToNode(text, { orderKey: "00000001" });
	before.refKind = "runtime_asset";
	before.refPath = "asset:one";
	before.refUrl = "https://example.com/asset";
	before.view = { runtimeView: true };
	before.style = { runtimeStyle: true };
	before.data.runtimeProps = { opacity: 0.5 };
	const edited = boardAuthoringItemToNode({ ...text, props: { ...text.props, text: "Updated" } }, { orderKey: before.orderKey });
	const next = preserveOpaqueNodeFields(before, edited);
	assert.equal(next.refUrl, before.refUrl);
	assert.deepEqual(next.view, before.view);
	assert.deepEqual(next.style, before.style);
	assert.deepEqual(next.data.runtimeProps, before.data.runtimeProps);
	assert.equal(next.data.text, "Updated");
});

test("Item patch replaces arrays and rejects identity changes", () => {
	const draw = {
		id: "stroke",
		type: "draw" as const,
		rotation: 0,
		props: { points: [{ x: 0, y: 0, p: 0.5 }] },
	} as Parameters<typeof applyBoardItemPatch>[0];
	const patched = applyBoardItemPatch(draw, {
		props: { points: [{ x: 10, y: 10, p: 1 }] },
	});
	assert.deepEqual((patched.props as { points: unknown[] }).points, [{ x: 10, y: 10, p: 1 }]);
	assert.throws(() => applyBoardItemPatch(text, { id: "other" }), /Unrecognized|patch is empty/);
});
