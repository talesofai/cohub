import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreImmersiveChatOnExit } from "../lib/features/space/modules/float-layout.ts";

test("regular focus/float exit always shows chat", () => {
	assert.equal(
		restoreImmersiveChatOnExit({
			rememberedBeforeFullCanvas: null,
			currentlyVisible: false,
		}),
		true,
	);
	assert.equal(
		restoreImmersiveChatOnExit({
			rememberedBeforeFullCanvas: null,
			currentlyVisible: true,
		}),
		true,
	);
});

test("full-canvas exit restores the chat visibility from before entry", () => {
	assert.equal(
		restoreImmersiveChatOnExit({
			rememberedBeforeFullCanvas: true,
			currentlyVisible: false,
		}),
		true,
	);
	assert.equal(
		restoreImmersiveChatOnExit({
			rememberedBeforeFullCanvas: false,
			currentlyVisible: false,
		}),
		false,
	);
});

test("full-canvas exit does not hide chat the user re-showed", () => {
	assert.equal(
		restoreImmersiveChatOnExit({
			rememberedBeforeFullCanvas: false,
			currentlyVisible: true,
		}),
		true,
	);
	assert.equal(
		restoreImmersiveChatOnExit({
			rememberedBeforeFullCanvas: true,
			currentlyVisible: true,
		}),
		true,
	);
});
