import assert from "node:assert/strict";
import { test } from "node:test";
import {
	alignPreviewNavigation,
	beginPreviewNavigation,
	createPreviewNavigationState,
	isCurrentPreviewNavigation,
	previewRefsEqual,
} from "../lib/features/space/modules/preview-navigation.ts";

test("preview navigation records intent source and monotonic transitions", () => {
	const initial = createPreviewNavigationState();
	const first = beginPreviewNavigation(
		initial,
		{ kind: "file", key: "docs/a.md" },
		"user",
	);
	const second = beginPreviewNavigation(
		first,
		{ kind: "file", key: "docs/b.md" },
		"route",
	);

	assert.equal(first.transitionId, 1);
	assert.equal(first.source, "user");
	assert.equal(second.transitionId, 2);
	assert.equal(second.source, "route");
	assert.deepEqual(second.desiredRef, { kind: "file", key: "docs/b.md" });
});

test("a later preview intent invalidates stale async completion", () => {
	const first = beginPreviewNavigation(
		createPreviewNavigationState(),
		{ kind: "file", key: "slow.md" },
		"user",
	);
	const second = beginPreviewNavigation(
		first,
		{ kind: "file", key: "fast.md" },
		"user",
	);

	assert.equal(isCurrentPreviewNavigation(second, first.transitionId), false);
	assert.equal(isCurrentPreviewNavigation(second, second.transitionId), true);
});

test("domain alignment does not create a competing navigation transition", () => {
	const opening = beginPreviewNavigation(
		createPreviewNavigationState(),
		{ kind: "board", key: "plans/main.board" },
		"restore",
	);
	const aligned = alignPreviewNavigation(opening, {
		kind: "board",
		key: "plans/renamed.board",
	});

	assert.equal(aligned.transitionId, opening.transitionId);
	assert.equal(aligned.source, "restore");
	assert.deepEqual(aligned.desiredRef, {
		kind: "board",
		key: "plans/renamed.board",
	});
});

test("preview ref equality compares both kind and key", () => {
	assert.equal(
		previewRefsEqual(
			{ kind: "file", key: "a.md" },
			{ kind: "file", key: "a.md" },
		),
		true,
	);
	assert.equal(
		previewRefsEqual(
			{ kind: "file", key: "a.md" },
			{ kind: "board", key: "a.md" },
		),
		false,
	);
	assert.equal(previewRefsEqual(null, null), true);
});
