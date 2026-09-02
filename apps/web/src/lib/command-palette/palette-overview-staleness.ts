/**
 * Pure staleness rules for the palette overview cache.
 *
 * Extracted so the semantics are testable without the browser/SDK import
 * chain: a snapshot is stale when it is older than the freshness window OR
 * when viewer activity invalidated it after it was cached.
 */

export const OVERVIEW_FRESH_MS = 60_000;
export const OVERVIEW_HARD_EXPIRY_MS = 10 * 60_000;

export function isOverviewSnapshotStale(input: {
	cachedAt: number;
	invalidatedAt: number;
	now: number;
	freshMs?: number;
}) {
	const freshMs = input.freshMs ?? OVERVIEW_FRESH_MS;
	if (input.invalidatedAt > input.cachedAt) return true;
	return input.now - input.cachedAt > freshMs;
}

export function isOverviewSnapshotExpired(input: {
	cachedAt: number;
	now: number;
	hardExpiryMs?: number;
}) {
	const hardExpiryMs = input.hardExpiryMs ?? OVERVIEW_HARD_EXPIRY_MS;
	return input.now - input.cachedAt > hardExpiryMs;
}
