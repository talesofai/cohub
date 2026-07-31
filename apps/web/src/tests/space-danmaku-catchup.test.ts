import assert from "node:assert/strict";
import test from "node:test";
import type { SpaceTurnListItem } from "@neta-art/cohub";
import {
	mergeRecentTurnIds,
	selectSpaceDanmakuCatchupCandidates,
	spaceDanmakuCatchupStateKey,
} from "$lib/features/space/modules/space-danmaku-catchup";

function turn(
	id: string,
	sessionId: string,
	createdAt: string,
): SpaceTurnListItem {
	return {
		id,
		sessionId,
		sequence: 1,
		status: "completed",
		intent: "steer",
		userUuid: "user-a",
		authorProfile: {
			userUuid: "user-a",
			displayName: "Alex",
			avatarUrl: null,
		},
		startedAt: createdAt,
		completedAt: createdAt,
		durationMs: 100,
		createdAt,
		updatedAt: createdAt,
		userPreview: id,
		assistantPreview: null,
		provider: null,
		model: null,
		finalUsage: null,
		totalUsage: null,
		errorMessage: null,
		session: { id: sessionId, title: null, source: "web" },
	};
}

test("danmaku catch-up keeps recent turn ids ordered and deduplicated", () => {
	assert.deepEqual(
		mergeRecentTurnIds(["turn-a", "turn-b"], ["turn-b", "turn-c"]),
		["turn-a", "turn-b", "turn-c"],
	);
});

test("danmaku catch-up filters consumed and active turns, then restores chronological order", () => {
	const candidates = selectSpaceDanmakuCatchupCandidates({
		turns: [
			turn("turn-c", "session-c", "2026-07-31T08:03:00.000Z"),
			turn("turn-b", "session-active", "2026-07-31T08:02:00.000Z"),
			turn("turn-a", "session-a", "2026-07-31T08:01:00.000Z"),
			turn("turn-0", "session-0", "2026-07-31T08:00:00.000Z"),
		],
		recentTurnIds: ["turn-a"],
		activeSessionId: "session-active",
	});

	assert.deepEqual(
		candidates.map((candidate) => candidate.id),
		["turn-0", "turn-c"],
	);
});

test("danmaku catch-up limits playback to the most recent candidates", () => {
	const candidates = selectSpaceDanmakuCatchupCandidates({
		turns: [
			turn("turn-d", "session-d", "2026-07-31T08:04:00.000Z"),
			turn("turn-c", "session-c", "2026-07-31T08:03:00.000Z"),
			turn("turn-b", "session-b", "2026-07-31T08:02:00.000Z"),
			turn("turn-a", "session-a", "2026-07-31T08:01:00.000Z"),
		],
		recentTurnIds: [],
		activeSessionId: null,
		limit: 3,
	});

	assert.deepEqual(
		candidates.map((candidate) => candidate.id),
		["turn-b", "turn-c", "turn-d"],
	);
});

test("danmaku catch-up state is scoped by user and space", () => {
	assert.notEqual(
		spaceDanmakuCatchupStateKey("user-a", "space-a"),
		spaceDanmakuCatchupStateKey("user-b", "space-a"),
	);
	assert.notEqual(
		spaceDanmakuCatchupStateKey("user-a", "space-a"),
		spaceDanmakuCatchupStateKey("user-a", "space-b"),
	);
});
