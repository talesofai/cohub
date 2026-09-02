import { getRecentSpaces } from "$lib/stores/recent-space";

export type SpacePickerFilter = "recent" | "all" | "mine" | "pinned";

export type SpacePickerItem = {
	id: string;
	name: string | null;
	ownerUserUuid?: string | null;
	isPinned?: boolean;
};

export function normalizeSpacePickerQuery(value: string): string {
	return value.trim().toLocaleLowerCase();
}

export function orderSpacePickerItems<T extends SpacePickerItem>(
	items: readonly T[],
	viewerUserUuid?: string | null,
): T[] {
	const recentIds = new Map(
		(viewerUserUuid ? getRecentSpaces(viewerUserUuid) : []).map(
			(entry, index) => [entry.spaceId, index],
		),
	);
	return [...items].sort((a, b) => {
		const recentA = recentIds.get(a.id);
		const recentB = recentIds.get(b.id);
		if (recentA !== undefined || recentB !== undefined) {
			if (recentA === undefined) return 1;
			if (recentB === undefined) return -1;
			return recentA - recentB;
		}
		return (a.name ?? a.id).localeCompare(b.name ?? b.id);
	});
}

export function filterSpacePickerItems<T extends SpacePickerItem>(
	items: readonly T[],
	filter: SpacePickerFilter,
	query: string,
	viewerUserUuid?: string | null,
): T[] {
	const normalizedQuery = normalizeSpacePickerQuery(query);
	const recentIds = new Set(
		(viewerUserUuid ? getRecentSpaces(viewerUserUuid) : []).map(
			(entry) => entry.spaceId,
		),
	);
	// Recent is the preferred first view, but a new user must still be able to
	// choose a Space before any local visit has been recorded.
	const effectiveFilter =
		filter === "recent" && recentIds.size === 0 ? "all" : filter;
	return items.filter((item) => {
		if (effectiveFilter === "mine" && item.ownerUserUuid !== viewerUserUuid)
			return false;
		if (effectiveFilter === "pinned" && !item.isPinned) return false;
		if (effectiveFilter === "recent" && !recentIds.has(item.id)) return false;
		if (!normalizedQuery) return true;
		return normalizeSpacePickerQuery(item.name ?? item.id).includes(
			normalizedQuery,
		);
	});
}

export function selectSpacePickerItems<T extends SpacePickerItem>(
	items: readonly T[],
	options: {
		filter: SpacePickerFilter;
		query?: string;
		viewerUserUuid?: string | null;
		limit?: number;
	},
): T[] {
	const filtered = filterSpacePickerItems(
		items,
		options.filter,
		options.query ?? "",
		options.viewerUserUuid,
	);
	const ordered = orderSpacePickerItems(filtered, options.viewerUserUuid);
	return options.limit === undefined
		? ordered
		: ordered.slice(0, options.limit);
}
