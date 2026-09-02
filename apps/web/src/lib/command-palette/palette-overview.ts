import type { PaletteOverviewResponse } from "@neta-art/cohub";
import { getCacheUserKey } from "$lib/cache/keys";
import {
	canCommitPaletteOverviewRefresh,
	isUsablePaletteOverview,
} from "$lib/command-palette/palette-overview-cache-policy";
import {
	isOverviewSnapshotExpired,
	isOverviewSnapshotStale,
} from "$lib/command-palette/palette-overview-staleness";
import { sdk } from "$lib/sdk";
import { getRecentSpaces } from "$lib/stores/recent-space";

/**
 * Client cache for /api/palette/overview — the empty-query default list data.
 *
 * Memory + localStorage snapshot with a 60s freshness window. Stale data is
 * revalidated when the palette opens; failures retain the last-known-good
 * snapshot and let the UI use its local fallback path.
 *
 * Freshness is not purely time-based: sending a message (or otherwise touching
 * viewer activity) records a user-scoped invalidation marker so this and other
 * tabs revalidate instead of serving pre-send data.
 */

const STORAGE_PREFIX = "cohub:palette-overview";
const INVALIDATION_STORAGE_PREFIX = "cohub:palette-overview-invalidated";
const CACHE_VERSION = 1;

type StoredOverview = PaletteOverviewResponse & { cachedAt: number };

type MemoryState = {
	userKey: string;
	snapshot: StoredOverview | null;
	/** Persisted so this and other tabs can observe viewer activity. */
	invalidatedAt: number;
	latestRequestId: number;
	inFlight: Promise<PaletteOverviewResponse | null> | null;
};

let memoryState: MemoryState | null = null;
let nextRequestId = 0;

function isBrowser() {
	return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function storageKey(userKey: string) {
	return `${STORAGE_PREFIX}:${encodeURIComponent(userKey)}:v${CACHE_VERSION}`;
}

function invalidationStorageKey(userKey: string) {
	return `${INVALIDATION_STORAGE_PREFIX}:${encodeURIComponent(userKey)}:v${CACHE_VERSION}`;
}

function readInvalidatedAt(userKey: string) {
	if (!isBrowser()) return 0;
	try {
		const value = Number(
			localStorage.getItem(invalidationStorageKey(userKey)) ?? 0,
		);
		return Number.isFinite(value) && value > 0 ? value : 0;
	} catch {
		return 0;
	}
}

function safeParse(value: string | null): StoredOverview | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as StoredOverview;
		if (
			!parsed ||
			!Number.isFinite(parsed.cachedAt) ||
			!Array.isArray(parsed.spaces) ||
			!Array.isArray(parsed.recentSessions) ||
			parsed.degraded === true
		)
			return null;
		return parsed;
	} catch {
		return null;
	}
}

function readCached(userKey: string): StoredOverview | null {
	if (!isBrowser()) return null;
	try {
		const stored = safeParse(localStorage.getItem(storageKey(userKey)));
		if (!stored) return null;
		if (
			isOverviewSnapshotExpired({ cachedAt: stored.cachedAt, now: Date.now() })
		)
			return null;
		return stored;
	} catch {
		return null;
	}
}

function getMemoryState(userKey = getCacheUserKey()): MemoryState {
	if (memoryState?.userKey === userKey) return memoryState;
	const snapshot = readCached(userKey);
	const invalidatedAt = readInvalidatedAt(userKey);
	memoryState = {
		userKey,
		snapshot,
		invalidatedAt,
		latestRequestId: 0,
		inFlight: null,
	};
	return memoryState;
}

function syncPersistedInvalidation(state: MemoryState) {
	const persisted = readInvalidatedAt(state.userKey);
	if (persisted <= state.invalidatedAt) return;
	state.invalidatedAt = persisted;
}

export type PaletteOverviewSnapshot = {
	data: PaletteOverviewResponse | null;
	/** True when the next palette open must refetch before/at first render. */
	isStale: boolean;
};

export function getPaletteOverviewSnapshot(): PaletteOverviewSnapshot {
	const state = getMemoryState();
	syncPersistedInvalidation(state);
	const snapshot = state.snapshot;
	if (!snapshot) return { data: null, isStale: true };
	return {
		data: snapshot,
		isStale: isOverviewSnapshotStale({
			cachedAt: snapshot.cachedAt,
			invalidatedAt: state.invalidatedAt,
			now: Date.now(),
		}),
	};
}

/**
 * Mark the overview cache as outdated after viewer activity (message sent,
 * session created, ...). Fetching is deferred until the palette needs the
 * data, so chat sends do not create an unrelated network/DB read.
 */
export function invalidatePaletteOverview() {
	const state = getMemoryState();
	syncPersistedInvalidation(state);
	state.invalidatedAt = Math.max(Date.now(), state.invalidatedAt + 1);
	if (!isBrowser()) return;
	try {
		localStorage.setItem(
			invalidationStorageKey(state.userKey),
			String(state.invalidatedAt),
		);
	} catch {
		// The in-memory timestamp still protects this tab.
	}
}

export function clearCachedPaletteOverview() {
	const userKey = getCacheUserKey();
	if (memoryState?.userKey === userKey) {
		// Invalidate in-flight writers before dropping the snapshot.
		memoryState.latestRequestId = ++nextRequestId;
		memoryState.inFlight = null;
		memoryState.snapshot = null;
		memoryState.invalidatedAt = 0;
	}
	if (!isBrowser()) return;
	try {
		localStorage.removeItem(storageKey(userKey));
		localStorage.removeItem(invalidationStorageKey(userKey));
	} catch {
		// Storage is best-effort.
	}
}

export function refreshPaletteOverview(options?: {
	signal?: AbortSignal;
}): Promise<PaletteOverviewResponse | null> {
	if (options?.signal?.aborted) return Promise.resolve(null);
	const userKey = getCacheUserKey();
	const state = getMemoryState(userKey);
	syncPersistedInvalidation(state);
	if (state.inFlight) return state.inFlight;

	const requestId = ++nextRequestId;
	state.latestRequestId = requestId;
	const requestInvalidatedAt = state.invalidatedAt;
	const promise = (async (): Promise<PaletteOverviewResponse | null> => {
		try {
			const fetcher: typeof fetch = (input, init) =>
				fetch(input, { ...init, signal: options?.signal });
			const recentSpaceIds = getRecentSpaces(userKey)
				.slice(0, 10)
				.map((entry) => entry.spaceId);
			const data = await sdk.search.overview(
				{ spaceLimit: 50, sessionLimit: 20, recentSpaceIds },
				fetcher,
			);
			// A response from another account, an older request, or before newer
			// viewer activity must never write memory or persistent storage.
			if (
				!canCommitPaletteOverviewRefresh({
					requestUserKey: userKey,
					currentUserKey: getCacheUserKey(),
					requestStateIsCurrent: memoryState === state,
					requestId,
					latestRequestId: state.latestRequestId,
					requestInvalidatedAt,
					currentInvalidatedAt: state.invalidatedAt,
					persistedInvalidatedAt: readInvalidatedAt(userKey),
				})
			)
				return null;
			if (!isUsablePaletteOverview(data)) return null;

			const stored: StoredOverview = { ...data, cachedAt: Date.now() };
			state.snapshot = stored;
			if (isBrowser()) {
				try {
					localStorage.setItem(storageKey(userKey), JSON.stringify(stored));
				} catch {
					// Quota failures are non-fatal; memory cache still applies.
				}
			}
			return data;
		} catch (error) {
			if ((error as { name?: string })?.name !== "AbortError")
				console.warn("[palette-overview] refresh failed", error);
			return null;
		}
	})();
	state.inFlight = promise;
	options?.signal?.addEventListener(
		"abort",
		() => {
			if (state.inFlight === promise) state.inFlight = null;
		},
		{ once: true },
	);
	void promise.then(
		() => {
			if (state.inFlight === promise) state.inFlight = null;
		},
		() => {
			if (state.inFlight === promise) state.inFlight = null;
		},
	);
	return promise;
}

/** Mark viewer activity; the next palette open will revalidate lazily. */
export function noteViewerActivity() {
	invalidatePaletteOverview();
}
