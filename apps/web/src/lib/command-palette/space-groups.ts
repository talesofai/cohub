import type { UserSpaceGroup } from "@neta-art/cohub";
import type { CommandPaletteItem } from "./types";

export const PINNED_USER_SYSTEM_KEY = "user:pinned";
export const SPACE_ID_MIME = "text/cohub-space-id";

export type IndexedPaletteItem = {
	item: CommandPaletteItem;
	index: number;
};

export type MineSpaceSection = {
	id: string;
	name: string;
	items: IndexedPaletteItem[];
};

export type MineSpaceView = {
	commands: IndexedPaletteItem[];
	sections: MineSpaceSection[];
	ungrouped: IndexedPaletteItem[];
	rows: CommandPaletteItem[];
};

export function visibleUserSpaceGroups(groups: UserSpaceGroup[]) {
	return groups.filter((group) => group.systemKey !== PINNED_USER_SYSTEM_KEY);
}

export function matchesSpaceQuery(item: CommandPaletteItem, query: string) {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	return [item.title, item.spaceName, item.excerpt].some((value) =>
		(value ?? "").toLowerCase().includes(needle),
	);
}

export function sectionMineSpaceItems(input: {
	items: CommandPaletteItem[];
	groups: UserSpaceGroup[];
	ownerUuid?: string | null;
	query?: string;
	collapsedGroupIds?: Set<string>;
}): MineSpaceView {
	const query = input.query ?? "";
	const hasQuery = query.trim().length > 0;
	const collapsedGroupIds = input.collapsedGroupIds ?? new Set<string>();
	const owned = input.items.filter((item) => {
		if (item.type === "command") return true;
		if (item.type !== "space") return false;
		if (
			input.ownerUuid &&
			item.ownerProfile?.userUuid &&
			item.ownerProfile.userUuid !== input.ownerUuid
		) {
			return false;
		}
		return matchesSpaceQuery(item, query);
	});

	const commands = owned.filter((item) => item.type === "command");
	const spaces = owned.filter((item) => item.type === "space");
	const spacesById = new Map(spaces.map((item) => [item.spaceId, item]));
	const visibleGroups = visibleUserSpaceGroups(input.groups);
	const assignedIds = new Set<string>();
	const sections: MineSpaceSection[] = [];
	let index = 0;

	const commandRows = commands.map((item) => ({ item, index: index++ }));

	for (const group of visibleGroups) {
		const items = group.spaceIds
			.map((spaceId) => spacesById.get(spaceId))
			.filter((item): item is CommandPaletteItem => Boolean(item));
		for (const item of items) assignedIds.add(item.spaceId);
		if (hasQuery && items.length === 0) continue;
		const collapsed = collapsedGroupIds.has(group.id);
		sections.push({
			id: group.id,
			name: group.name,
			items: items.map((item) => ({
				item,
				index: collapsed ? -1 : index++,
			})),
		});
	}

	const ungrouped = spaces
		.filter((item) => !assignedIds.has(item.spaceId))
		.map((item) => ({ item, index: index++ }));

	return {
		commands: commandRows,
		sections,
		ungrouped,
		rows: [
			...commandRows,
			...sections.flatMap((section) =>
				collapsedGroupIds.has(section.id) ? [] : section.items,
			),
			...ungrouped,
		].map((row) => row.item),
	};
}
