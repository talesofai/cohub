import type { SpaceActivityResponse } from "@neta-art/cohub";
import { spaceActivityRepo } from "$lib/cache/repositories/space-activity-repo";
import { sdk } from "$lib/sdk";

export type SpaceActivityRange = 7 | 30 | 365;

const RANGES: readonly SpaceActivityRange[] = [7, 30, 365];

export const SPACE_ACTIVITY_RANGES = RANGES;

export function isSpaceActivityRange(days: number): days is SpaceActivityRange {
	return (RANGES as readonly number[]).includes(days);
}

/**
 * Page-level data host for the space Activity view: cached-first loading with
 * silent revalidation, plus the range switch. No realtime — the page is a
 * periodic snapshot, and every mount revalidates against the server.
 */
export function createSpaceActivityController(options: {
	spaceId: () => string;
}) {
	const spaceId = $derived(options.spaceId());

	let selectedDays = $state<SpaceActivityRange>(30);
	let activity = $state<SpaceActivityResponse | null>(null);
	let activityDays = $state<number | null>(null);
	let updatedAt = $state<number | null>(null);
	let loading = $state(true);
	let refreshing = $state(false);
	let loadError = $state("");
	let requestId = 0;

	function applySnapshot(snapshot: {
		activity: SpaceActivityResponse;
		updatedAt: number;
	}) {
		activity = snapshot.activity;
		activityDays = snapshot.activity.days;
		updatedAt = snapshot.updatedAt;
	}

	async function load({ force = false } = {}) {
		const id = ++requestId;
		loadError = "";

		// Cache failures must never block the network path — degrade to a miss.
		const cached = await spaceActivityRepo
			.getCached(spaceId, selectedDays)
			.catch(() => null);
		if (cached) applySnapshot(cached);
		loading = !activity || activityDays !== selectedDays;
		refreshing = Boolean(activity && activityDays === selectedDays);

		try {
			if (!force && cached && spaceActivityRepo.isFresh(cached)) {
				refreshing = false;
				loading = false;
				return;
			}
			const data = await sdk.space(spaceId).activity.get(selectedDays);
			if (id !== requestId) return;
			const snapshot = await spaceActivityRepo.set(spaceId, selectedDays, data);
			applySnapshot(snapshot);
		} catch (error) {
			if (id !== requestId) return;
			// Keep showing cached data on refresh failures.
			loadError =
				error instanceof Error ? error.message : "Failed to load activity";
		} finally {
			if (id === requestId) {
				loading = false;
				refreshing = false;
			}
		}
	}

	function selectRange(days: SpaceActivityRange) {
		if (selectedDays === days) return;
		selectedDays = days;
		void load();
	}

	return {
		get selectedDays() {
			return selectedDays;
		},
		get activity() {
			return activity;
		},
		get updatedAt() {
			return updatedAt;
		},
		get loading() {
			return loading;
		},
		get refreshing() {
			return refreshing;
		},
		get loadError() {
			return loadError;
		},
		load,
		selectRange,
	};
}
