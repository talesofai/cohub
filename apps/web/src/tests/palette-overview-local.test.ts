import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionRecord, SpaceRecord } from "@neta-art/cohub";
import {
	buildLocalPaletteOverview,
	mergeLocalOverviewIntoSnapshot,
} from "../lib/command-palette/palette-overview-local.ts";

let nextId = 0;

function makeSpace(input: {
	id?: string;
	name: string;
	isPinned?: boolean;
	updatedAt?: string;
	lastActivityAt?: string | null;
	ownerUserUuid?: string | null;
}): SpaceRecord {
	nextId += 1;
	return {
		id: input.id ?? `space-${nextId}`,
		userUuid: input.ownerUserUuid ?? "owner",
		name: input.name,
		slug: null,
		description: null,
		title: null,
		status: null,
		meta: null,
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: input.updatedAt ?? "2026-08-01T00:00:00.000Z",
		lastActivityAt: input.lastActivityAt ?? null,
		isPinned: input.isPinned ?? false,
	};
}

function makeSession(input: {
	id?: string;
	spaceId: string;
	creatorUserUuid?: string | null;
	participantUserUuids?: string[];
	updatedAt?: string;
	lastMessageAt?: string | null;
}): SessionRecord {
	nextId += 1;
	return {
		id: input.id ?? `session-${nextId}`,
		spaceId: input.spaceId,
		userUuid: input.creatorUserUuid ?? null,
		title: null,
		source: null,
		status: null,
		externalSessionId: null,
		meta: null,
		latestMessageText: null,
		lastMessageAt: input.lastMessageAt ?? null,
		lastMessageId: null,
		createdAt: "2026-08-20T00:00:00.000Z",
		updatedAt: input.updatedAt ?? "2026-08-20T00:00:00.000Z",
		...(input.participantUserUuids
			? { participantUserUuids: input.participantUserUuids }
			: {}),
	};
}

test("orders spaces by viewer-authored turn activity, ignoring foreign space activity", () => {
	// Foreign hot space: very recent space-level activity, no viewer turns.
	const foreignHot = makeSpace({
		id: "foreign-hot",
		name: "foreign hot",
		updatedAt: "2026-08-27T12:00:00.000Z",
		lastActivityAt: "2026-08-27T12:00:00.000Z",
	});
	// Viewer's own space: older space activity, recent viewer turns.
	const mine = makeSpace({
		id: "mine",
		name: "mine",
		updatedAt: "2026-08-25T00:00:00.000Z",
		lastActivityAt: "2026-08-25T00:00:00.000Z",
	});
	const overview = buildLocalPaletteOverview({
		spaces: [foreignHot, mine],
		sessionLists: [],
		turnRecords: [
			{
				spaceId: "mine",
				turns: [
					{
						userUuid: "viewer",
						createdAt: "2026-08-26T10:00:00.000Z",
						updatedAt: "2026-08-26T10:05:00.000Z",
					},
				],
			},
		],
		viewerUserUuid: "viewer",
	});
	// The "all"-ordered fallback would put foreign-hot first; the overview
	// semantics keep the viewer's own recent work on top.
	assert.equal(overview.spaces[0]?.id, "mine");
	assert.equal(overview.spaces[1]?.id, "foreign-hot");
});

test("pinned spaces do not outrank newer activity in the Recent ordering", () => {
	const pinned = makeSpace({ id: "pinned", name: "pinned", isPinned: true });
	const active = makeSpace({
		id: "active",
		name: "active",
		updatedAt: "2026-08-27T00:00:00.000Z",
		lastActivityAt: "2026-08-27T00:00:00.000Z",
	});
	const overview = buildLocalPaletteOverview({
		spaces: [pinned, active],
		sessionLists: [],
		turnRecords: [],
		viewerUserUuid: "viewer",
	});
	// Ordering is strictly by activity time; pinning only marks the item.
	assert.equal(overview.spaces[0]?.id, "active");
	assert.equal(overview.spaces[1]?.id, "pinned");
	assert.equal(overview.spaces[1]?.isPinned, true);
});

test("recent sessions keep only viewer creator/participant sessions ordered by activity", () => {
	const spaceA = makeSpace({ id: "space-a", name: "A" });
	const mine = makeSession({
		id: "mine",
		spaceId: "space-a",
		creatorUserUuid: "viewer",
		updatedAt: "2026-08-26T08:00:00.000Z",
	});
	const participated = makeSession({
		id: "participated",
		spaceId: "space-a",
		creatorUserUuid: "someone-else",
		participantUserUuids: ["viewer", "other"],
		updatedAt: "2026-08-27T09:00:00.000Z",
	});
	const foreign = makeSession({
		id: "foreign",
		spaceId: "space-a",
		creatorUserUuid: "someone-else",
		updatedAt: "2026-08-27T10:00:00.000Z",
	});
	const overview = buildLocalPaletteOverview({
		spaces: [spaceA],
		sessionLists: [
			{ spaceId: "space-a", sessions: [foreign, mine, participated] },
		],
		turnRecords: [],
		viewerUserUuid: "viewer",
	});
	assert.deepEqual(
		overview.recentSessions.map((session) => session.id),
		["participated", "mine"],
	);
	assert.equal(overview.recentSessions[0]?.viewerRelation, "participant");
	assert.equal(overview.recentSessions[1]?.viewerRelation, "creator");
	assert.equal(overview.recentSessions[0]?.spaceName, "A");
});

test("participation only counts turns authored by the viewer", () => {
	const space = makeSpace({ id: "space-a", name: "A" });
	const overview = buildLocalPaletteOverview({
		spaces: [space],
		sessionLists: [],
		turnRecords: [
			{
				spaceId: "space-a",
				turns: [
					{
						userUuid: "other-user",
						createdAt: "2026-08-27T12:00:00.000Z",
						updatedAt: "2026-08-27T12:05:00.000Z",
					},
				],
			},
		],
		viewerUserUuid: "viewer",
	});
	assert.equal(overview.spaces[0]?.lastParticipatedAt, null);
});

test("limits are applied and relation reflects ownership", () => {
	const spaces = Array.from({ length: 12 }, (_, index) =>
		makeSpace({
			id: `space-${index}`,
			name: `space-${index}`,
			ownerUserUuid: index < 3 ? "viewer" : "owner",
		}),
	);
	const overview = buildLocalPaletteOverview({
		spaces,
		sessionLists: [],
		turnRecords: [],
		viewerUserUuid: "viewer",
		spaceLimit: 5,
	});
	assert.equal(overview.spaces.length, 5);
	// Ownership is derived locally (no server relation in cached records).
	const ownerSpaces = overview.spaces.filter((s) => s.relation === "owner");
	const memberSpaces = overview.spaces.filter((s) => s.relation === "member");
	assert.equal(ownerSpaces.length, 3);
	assert.equal(memberSpaces.length, 2);
});

test("merge keeps server fields, folds newer local participation and new spaces", () => {
	const snapshot = {
		generatedAt: "2026-08-27T08:00:00.000Z",
		spaces: [
			{
				id: "served-a",
				name: "served a",
				description: null,
				ownerProfile: null,
				spaceProfile: null,
				isPinned: false,
				relation: "member" as const,
				// Cross-device participation the local cache cannot know.
				lastParticipatedAt: "2026-08-27T09:30:00.000Z",
				updatedAt: "2026-08-27T09:00:00.000Z",
			},
		],
		recentSessions: [
			{
				id: "served-session",
				spaceId: "served-a",
				spaceName: "served a",
				title: "server session",
				viewerRelation: "creator" as const,
				lastMessageAt: null,
				updatedAt: "2026-08-27T09:30:00.000Z",
			},
		],
	};
	// Local pass: newer viewer activity on a cached space + a brand-new space.
	const local = buildLocalPaletteOverview({
		spaces: [
			makeSpace({
				id: "cached-space",
				name: "cached",
				updatedAt: "2026-08-27T10:00:00.000Z",
				lastActivityAt: "2026-08-27T10:00:00.000Z",
			}),
		],
		sessionLists: [],
		turnRecords: [
			{
				spaceId: "cached-space",
				turns: [
					{
						userUuid: "viewer",
						createdAt: "2026-08-27T10:30:00.000Z",
						updatedAt: "2026-08-27T10:31:00.000Z",
					},
				],
			},
		],
		viewerUserUuid: "viewer",
	});
	const merged = mergeLocalOverviewIntoSnapshot(snapshot, local);
	const mergedIds = merged.spaces.map((space) => space.id);
	assert.ok(mergedIds.includes("served-a"));
	assert.ok(mergedIds.includes("cached-space"));
	// Spaces carry the fresher participation time (ordering itself is applied
	// by the overview item build, which sorts by personal activity).
	const mergedCached = merged.spaces.find((s) => s.id === "cached-space");
	assert.equal(mergedCached?.lastParticipatedAt, "2026-08-27T10:31:00.000Z");
	// Server-known sessions are preserved alongside local ones.
	assert.ok(merged.recentSessions.some((s) => s.id === "served-session"));
});

test("merge keeps the pin marker when the snapshot is stale and the local cache is not", () => {
	const snapshot = {
		generatedAt: "2026-08-27T08:00:00.000Z",
		spaces: [
			{
				id: "space-a",
				name: "a",
				description: null,
				ownerProfile: null,
				spaceProfile: null,
				isPinned: true,
				relation: "member" as const,
				lastParticipatedAt: null,
				updatedAt: "2026-08-26T00:00:00.000Z",
			},
		],
		recentSessions: [],
	};
	const local = buildLocalPaletteOverview({
		spaces: [makeSpace({ id: "space-a", name: "a" })],
		sessionLists: [],
		turnRecords: [],
		viewerUserUuid: "viewer",
	});
	const merged = mergeLocalOverviewIntoSnapshot(snapshot, local);
	const mergedA = merged.spaces.find((space) => space.id === "space-a");
	assert.equal(mergedA?.isPinned, true);
});
