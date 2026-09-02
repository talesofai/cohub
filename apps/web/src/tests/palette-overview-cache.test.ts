import assert from "node:assert/strict";
import { test } from "node:test";
import {
	canCommitPaletteOverviewRefresh,
	isUsablePaletteOverview,
} from "../lib/command-palette/palette-overview-cache-policy";
import {
	isOverviewSnapshotExpired,
	isOverviewSnapshotStale,
} from "../lib/command-palette/palette-overview-staleness";

const NOW = 1_800_000_000_000;

test("fresh snapshot with no invalidation is not stale", () => {
	assert.equal(
		isOverviewSnapshotStale({
			cachedAt: NOW - 10_000,
			invalidatedAt: 0,
			now: NOW,
		}),
		false,
	);
});

test("snapshot older than the freshness window is stale", () => {
	assert.equal(
		isOverviewSnapshotStale({
			cachedAt: NOW - 61_000,
			invalidatedAt: 0,
			now: NOW,
		}),
		true,
	);
});

test("viewer activity after caching marks the snapshot stale (the hi-in-foreign-space bug)", () => {
	const cachedAt = NOW - 5_000;
	// Before sending: fresh.
	assert.equal(
		isOverviewSnapshotStale({ cachedAt, invalidatedAt: 0, now: NOW }),
		false,
	);
	// After sending a message (invalidation timestamped later): stale even
	// though the TTL window has not elapsed.
	assert.equal(
		isOverviewSnapshotStale({
			cachedAt,
			invalidatedAt: NOW - 1_000,
			now: NOW,
		}),
		true,
	);
});

test("invalidation older than the snapshot does not mark it stale (refetch won)", () => {
	assert.equal(
		isOverviewSnapshotStale({
			cachedAt: NOW - 1_000,
			invalidatedAt: NOW - 5_000,
			now: NOW,
		}),
		false,
	);
});

test("refresh commit rejects cross-user, superseded, and invalidated responses", () => {
	const base = {
		requestUserKey: "user-a",
		currentUserKey: "user-a",
		requestStateIsCurrent: true,
		requestId: 4,
		latestRequestId: 4,
		requestInvalidatedAt: NOW - 5_000,
		currentInvalidatedAt: NOW - 5_000,
		persistedInvalidatedAt: NOW - 5_000,
	};
	assert.equal(canCommitPaletteOverviewRefresh(base), true);
	assert.equal(
		canCommitPaletteOverviewRefresh({ ...base, currentUserKey: "user-b" }),
		false,
	);
	assert.equal(
		canCommitPaletteOverviewRefresh({ ...base, latestRequestId: 5 }),
		false,
	);
	assert.equal(
		canCommitPaletteOverviewRefresh({
			...base,
			currentInvalidatedAt: NOW - 1_000,
		}),
		false,
	);
	assert.equal(
		canCommitPaletteOverviewRefresh({
			...base,
			persistedInvalidatedAt: NOW - 1_000,
		}),
		false,
	);
});

test("legitimate empty overview is cacheable but degraded payload is not", () => {
	const empty = {
		generatedAt: "2026-08-27T00:00:00.000Z",
		spaces: [],
		recentSessions: [],
	};
	assert.equal(isUsablePaletteOverview(empty), true);
	assert.equal(isUsablePaletteOverview({ ...empty, degraded: true }), false);
});

test("hard expiry drops the snapshot entirely", () => {
	assert.equal(
		isOverviewSnapshotExpired({ cachedAt: NOW - 11 * 60_000, now: NOW }),
		true,
	);
	assert.equal(
		isOverviewSnapshotExpired({ cachedAt: NOW - 60_000, now: NOW }),
		false,
	);
});
