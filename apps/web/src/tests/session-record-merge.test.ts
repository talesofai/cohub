import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionRecord, UserSessionSummary } from "@neta-art/cohub";
import {
	getUserSessionLastMessageId,
	isFullUserSessionListItem,
	isUserSessionSummary,
	mergeSessionRecord,
} from "$lib/session-record-merge";

const full: SessionRecord = {
	id: "session-1",
	spaceId: "space-1",
	userUuid: "viewer-1",
	title: "Session",
	source: "web",
	status: "active",
	externalSessionId: "external-secret",
	meta: { secret: true },
	latestMessageText: "private prompt",
	lastMessageAt: "2026-07-31T00:00:00.000Z",
	lastMessageId: "message-1",
	totalMessages: 3,
	totalCost: "1.25",
	bindings: [
		{
			id: "binding-1",
			spaceId: "space-1",
			spaceSessionId: "session-1",
			spaceChannelId: "channel-1",
			provider: "private-provider",
			bindingKey: "private-binding",
			externalChatId: "external-chat-1",
			status: "active",
			meta: null,
			createdAt: "2026-07-31T00:00:00.000Z",
			updatedAt: "2026-07-31T00:00:00.000Z",
			lastMessageAt: null,
		},
	],
	createdAt: "2026-07-31T00:00:00.000Z",
	updatedAt: "2026-07-31T00:00:00.000Z",
};

const summary: UserSessionSummary = {
	accessLevel: "summary",
	id: full.id,
	spaceId: full.spaceId,
	userUuid: full.userUuid,
	title: full.title,
	source: full.source,
	status: full.status,
	lastMessageAt: full.lastMessageAt,
	createdAt: full.createdAt,
	updatedAt: full.updatedAt,
};

test("a summary response clears private fields cached from earlier full access", () => {
	const merged = mergeSessionRecord(full, summary);
	assert.equal(merged.accessLevel, "summary");
	assert.equal("externalSessionId" in merged, false);
	assert.equal("meta" in merged, false);
	assert.equal("latestMessageText" in merged, false);
	assert.equal("lastMessageId" in merged, false);
	assert.equal("totalMessages" in merged, false);
	assert.equal("totalCost" in merged, false);
	assert.equal("bindings" in merged, false);
});

test("a full response upgrades a cached summary without retaining its discriminator", () => {
	const merged = mergeSessionRecord(summary, full);
	assert.equal("accessLevel" in merged, false);
	assert.equal(merged.externalSessionId, full.externalSessionId);
	assert.deepEqual(merged.meta, full.meta);
});

test("summary rows stay read-safe while full rows retain message identity", () => {
	assert.equal(isUserSessionSummary(summary), true);
	assert.equal(isFullUserSessionListItem(summary), false);
	assert.equal(getUserSessionLastMessageId(summary), null);
	assert.equal(isUserSessionSummary(full), false);
	assert.equal(isFullUserSessionListItem(full), true);
	assert.equal(getUserSessionLastMessageId(full), "message-1");
});
