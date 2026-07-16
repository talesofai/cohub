import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LabelListItem } from "@neta-art/cohub";
import {
	findSessionUserLabel,
	getSessionUserLabelSystemKey,
	SESSION_USER_ROOT_LABEL_SYSTEM_KEY,
} from "../lib/stores/sidebar-source-labels";

function makeLabel(
	partial: Partial<LabelListItem> &
		Pick<LabelListItem, "id" | "name" | "systemKey">,
): LabelListItem {
	return {
		id: partial.id,
		spaceId: partial.spaceId ?? "space-1",
		name: partial.name,
		slug: partial.slug ?? partial.name.toLowerCase(),
		parentId: partial.parentId ?? null,
		depth: partial.depth ?? 0,
		rank: partial.rank ?? 0,
		source: partial.source ?? "system",
		systemKey: partial.systemKey,
		createdBy: partial.createdBy ?? null,
		createdAt: partial.createdAt ?? "2026-01-01T00:00:00.000Z",
		updatedAt: partial.updatedAt ?? "2026-01-01T00:00:00.000Z",
		children: partial.children ?? [],
	};
}

describe("findSessionUserLabel", () => {
	const mine = makeLabel({
		id: "user-me",
		name: "me-uuid",
		parentId: "user-root",
		depth: 1,
		systemKey: getSessionUserLabelSystemKey("me-uuid"),
	});
	const other = makeLabel({
		id: "user-other",
		name: "other-uuid",
		parentId: "user-root",
		depth: 1,
		systemKey: getSessionUserLabelSystemKey("other-uuid"),
	});
	const root = makeLabel({
		id: "user-root",
		name: "User",
		systemKey: SESSION_USER_ROOT_LABEL_SYSTEM_KEY,
		children: [mine, other],
	});

	test("returns the current user child under User root", () => {
		assert.equal(findSessionUserLabel([root], "me-uuid")?.id, "user-me");
	});

	test("returns null for missing user, blank uuid, or empty tree", () => {
		assert.equal(findSessionUserLabel([root], "missing-uuid"), null);
		assert.equal(findSessionUserLabel([root], "  "), null);
		assert.equal(findSessionUserLabel([root], null), null);
		assert.equal(findSessionUserLabel([], "me-uuid"), null);
	});

	test("ignores non-system children with the same systemKey shape", () => {
		const custom = makeLabel({
			id: "custom",
			name: "Custom",
			parentId: "user-root",
			depth: 1,
			source: "user",
			systemKey: getSessionUserLabelSystemKey("me-uuid"),
		});
		const onlyCustom = makeLabel({
			...root,
			children: [custom],
		});
		assert.equal(findSessionUserLabel([onlyCustom], "me-uuid"), null);
	});
});
