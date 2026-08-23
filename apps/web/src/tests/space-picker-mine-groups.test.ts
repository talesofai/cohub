import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { UserSpaceGroup } from "@neta-art/cohub";
import {
	PINNED_USER_SYSTEM_KEY,
	sectionMineSpaceItems,
	visibleUserSpaceGroups,
} from "../lib/command-palette/space-groups";
import type { CommandPaletteItem } from "../lib/command-palette/types";

function spaceItem(
	partial: Pick<CommandPaletteItem, "id" | "title"> &
		Partial<CommandPaletteItem> & { ownerUuid?: string },
): CommandPaletteItem {
	return {
		type: "space",
		id: partial.id,
		spaceId: partial.spaceId ?? partial.id,
		sessionId: null,
		turnId: null,
		sequence: null,
		title: partial.title,
		excerpt: partial.excerpt ?? null,
		spaceName: partial.spaceName ?? partial.title,
		ownerProfile: {
			userUuid: partial.ownerUuid ?? "me",
			displayName: "Me",
			avatarUrl: null,
		},
		spaceProfile: null,
		sessionTitle: null,
		matchedField: "name",
		href: `/spaces/${partial.id}`,
		score: 1,
		textScore: 1,
		recencyScore: 1,
		typePriorityScore: 1,
		updatedAt: null,
		source: "default",
		isPinned: partial.isPinned ?? false,
	};
}

function group(
	partial: Pick<UserSpaceGroup, "id" | "name"> & Partial<UserSpaceGroup>,
): UserSpaceGroup {
	return {
		id: partial.id,
		name: partial.name,
		systemKey: partial.systemKey ?? null,
		rank: partial.rank ?? 10,
		spaceIds: partial.spaceIds ?? [],
	};
}

const mine = spaceItem({ id: "owned-1", title: "Alpha", ownerUuid: "me" });
const mineBeta = spaceItem({
	id: "owned-2",
	title: "Beta Lab",
	ownerUuid: "me",
});
const other = spaceItem({ id: "other-1", title: "Shared", ownerUuid: "them" });
const command: CommandPaletteItem = {
	...spaceItem({ id: "new-space", title: "New Space" }),
	type: "command",
	spaceId: "",
	excerpt: "Create a space",
	matchedField: "command",
	href: "/spaces/new",
};

describe("visibleUserSpaceGroups", () => {
	test("hides Pinned from the Mine group list", () => {
		const visible = visibleUserSpaceGroups([
			group({
				id: "pinned",
				name: "Pinned",
				systemKey: PINNED_USER_SYSTEM_KEY,
				spaceIds: ["owned-1"],
			}),
			group({ id: "work", name: "Work", spaceIds: ["owned-1"] }),
		]);
		assert.deepEqual(
			visible.map((item) => item.name),
			["Work"],
		);
	});
});

describe("sectionMineSpaceItems", () => {
	test("keeps owned spaces only and leaves others out", () => {
		const view = sectionMineSpaceItems({
			items: [mine, other, command],
			groups: [],
			ownerUuid: "me",
		});
		assert.deepEqual(
			view.rows.map((item) => item.id),
			["new-space", "owned-1"],
		);
		assert.equal(view.ungrouped[0]?.item.id, "owned-1");
	});

	test("hides Pinned and still shows those spaces as ungrouped", () => {
		const view = sectionMineSpaceItems({
			items: [mine, mineBeta],
			groups: [
				group({
					id: "pinned",
					name: "Pinned",
					systemKey: PINNED_USER_SYSTEM_KEY,
					spaceIds: ["owned-1"],
				}),
			],
			ownerUuid: "me",
		});
		assert.deepEqual(view.sections, []);
		assert.deepEqual(
			view.ungrouped.map((row) => row.item.id),
			["owned-1", "owned-2"],
		);
	});

	test("allows a space to appear in multiple groups", () => {
		const view = sectionMineSpaceItems({
			items: [mine, mineBeta],
			groups: [
				group({
					id: "clients",
					name: "Clients",
					rank: 10,
					spaceIds: ["owned-1"],
				}),
				group({
					id: "urgent",
					name: "Urgent",
					rank: 20,
					spaceIds: ["owned-1", "owned-2"],
				}),
			],
			ownerUuid: "me",
		});
		assert.deepEqual(
			view.sections.map((section) => [
				section.name,
				section.items.map((row) => row.item.id),
			]),
			[
				["Clients", ["owned-1"]],
				["Urgent", ["owned-1", "owned-2"]],
			],
		);
		assert.deepEqual(view.ungrouped, []);
		assert.deepEqual(
			view.rows.map((item) => item.id),
			["owned-1", "owned-1", "owned-2"],
		);
	});

	test("filters spaces by query and hides groups with no match", () => {
		const view = sectionMineSpaceItems({
			items: [mine, mineBeta],
			groups: [
				group({ id: "clients", name: "Clients", spaceIds: ["owned-1"] }),
				group({ id: "labs", name: "Labs", spaceIds: ["owned-2"] }),
				group({ id: "empty", name: "Empty", spaceIds: [] }),
			],
			ownerUuid: "me",
			query: "lab",
		});
		assert.deepEqual(
			view.sections.map((section) => section.name),
			["Labs"],
		);
		assert.deepEqual(
			view.sections[0]?.items.map((row) => row.item.id),
			["owned-2"],
		);
		assert.deepEqual(view.ungrouped, []);
	});

	test("puts remaining owned spaces in the ungrouped remainder", () => {
		const view = sectionMineSpaceItems({
			items: [mine, mineBeta],
			groups: [
				group({ id: "clients", name: "Clients", spaceIds: ["owned-1"] }),
			],
			ownerUuid: "me",
		});
		assert.deepEqual(
			view.sections[0]?.items.map((row) => row.item.id),
			["owned-1"],
		);
		assert.deepEqual(
			view.ungrouped.map((row) => row.item.id),
			["owned-2"],
		);
	});

	test("omits collapsed group spaces from keyboard rows", () => {
		const view = sectionMineSpaceItems({
			items: [mine, mineBeta],
			groups: [
				group({ id: "clients", name: "Clients", spaceIds: ["owned-1"] }),
				group({ id: "labs", name: "Labs", spaceIds: ["owned-2"] }),
			],
			ownerUuid: "me",
			collapsedGroupIds: new Set(["clients"]),
		});
		assert.equal(view.sections[0]?.items[0]?.index, -1);
		assert.deepEqual(
			view.rows.map((item) => item.id),
			["owned-2"],
		);
	});

	test("keeps empty groups when not filtering", () => {
		const view = sectionMineSpaceItems({
			items: [mine],
			groups: [group({ id: "empty", name: "Empty", spaceIds: [] })],
			ownerUuid: "me",
		});
		assert.equal(view.sections[0]?.name, "Empty");
		assert.deepEqual(view.sections[0]?.items, []);
		assert.equal(view.ungrouped[0]?.item.id, "owned-1");
	});
});
