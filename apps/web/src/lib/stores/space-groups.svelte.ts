import type { UserSpaceGroup } from "@neta-art/cohub";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";
import { createLocalListCache } from "$lib/stores/create-local-list-cache";

/**
 * Personal Space group cache — viewer-private user labels with space ids.
 *
 * Reuses the space-list cache helper so Mine can render immediately from
 * localStorage, then silently refresh. Realtime `label.assignments.updated`
 * events (user room) refetch the snapshot.
 */

const GROUPS_SCOPE = "mine";

function normalizeGroups(groups: UserSpaceGroup[]) {
	const byId = new Map<string, UserSpaceGroup>();
	for (const group of groups) {
		byId.set(group.id, {
			...group,
			spaceIds: [...new Set(group.spaceIds)],
		});
	}
	return Array.from(byId.values()).sort((a, b) =>
		a.rank !== b.rank ? a.rank - b.rank : a.name.localeCompare(b.name),
	);
}

const cache = createLocalListCache<UserSpaceGroup>({
	storagePrefix: "cohub:space-groups",
	cacheVersion: 1,
	updatedEventName: "cohub:space-groups-updated",
	ttlMs: 60_000,
	normalize: normalizeGroups,
});

let realtimeBound = false;

export function initSpaceGroupRealtime() {
	if (realtimeBound || typeof window === "undefined") return;
	realtimeBound = true;
	sdk.onUserEvent((event) => {
		if (event.type !== "label.assignments.updated") return;
		void refreshSpaceGroups();
	});
}

export function getCachedSpaceGroups(): UserSpaceGroup[] | null {
	return cache.getCached(GROUPS_SCOPE);
}

export function onSpaceGroupsCacheUpdated(
	handler: (event: { groups: UserSpaceGroup[] }) => void,
) {
	return cache.onUpdated(({ data }) => {
		handler({ groups: data });
	});
}

async function loadSpaceGroups() {
	const result = await sdk.user.labels.listSpaceGroups();
	return result.groups;
}

export async function fetchSpaceGroupsWithCache(options?: { force?: boolean }) {
	await authStore.ensureLoaded();
	return cache.fetchWithCache(GROUPS_SCOPE, loadSpaceGroups, options);
}

async function refreshSpaceGroups() {
	try {
		await fetchSpaceGroupsWithCache({ force: true });
	} catch {
		// Non-critical: the next picker open will reconcile.
	}
}

function setGroups(groups: UserSpaceGroup[]) {
	return cache.setCached(GROUPS_SCOPE, groups);
}

export async function createSpaceGroup(name: string) {
	await authStore.ensureLoaded();
	const result = await sdk.user.labels.create(name);
	const label = result.label;
	cache.patchCached(GROUPS_SCOPE, (groups) => {
		if (groups.some((group) => group.id === label.id)) {
			return groups.map((group) =>
				group.id === label.id
					? { ...group, name: label.name, rank: label.rank }
					: group,
			);
		}
		return [
			...groups,
			{
				id: label.id,
				name: label.name,
				systemKey: label.systemKey,
				rank: label.rank,
				spaceIds: [],
			},
		];
	});
	return label;
}

export async function deleteSpaceGroup(name: string) {
	await authStore.ensureLoaded();
	const previous = getCachedSpaceGroups() ?? [];
	setGroups(
		previous.filter((group) => group.name.toLowerCase() !== name.toLowerCase()),
	);
	try {
		await sdk.user.labels.remove(name);
	} catch (error) {
		setGroups(previous);
		throw error;
	}
}

export async function addSpaceToGroup(spaceId: string, groupName: string) {
	await authStore.ensureLoaded();
	const previous = getCachedSpaceGroups() ?? [];
	setGroups(
		previous.map((group) =>
			group.name.toLowerCase() === groupName.toLowerCase() &&
			!group.spaceIds.includes(spaceId)
				? { ...group, spaceIds: [...group.spaceIds, spaceId] }
				: group,
		),
	);
	try {
		await sdk.user.labels.patchResourceLabels("space", spaceId, {
			addLabelRefs: [groupName],
		});
	} catch (error) {
		setGroups(previous);
		throw error;
	}
}

export async function removeSpaceFromGroup(spaceId: string, groupName: string) {
	await authStore.ensureLoaded();
	const previous = getCachedSpaceGroups() ?? [];
	setGroups(
		previous.map((group) =>
			group.name.toLowerCase() === groupName.toLowerCase()
				? { ...group, spaceIds: group.spaceIds.filter((id) => id !== spaceId) }
				: group,
		),
	);
	try {
		await sdk.user.labels.patchResourceLabels("space", spaceId, {
			removeLabelRefs: [groupName],
		});
	} catch (error) {
		setGroups(previous);
		throw error;
	}
}
