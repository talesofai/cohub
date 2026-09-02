import type { SpaceActivityResponse } from "@neta-art/cohub";
import {
	publishCacheMessage,
	subscribeCacheMessages,
} from "$lib/cache/broadcast";
import { idbGet, idbPut, type StoreName } from "$lib/cache/db";
import { encodeKeyPart, getCacheUserKey } from "$lib/cache/keys";
import { MemoryLru } from "$lib/cache/memory-lru";
import type { CacheSource } from "$lib/cache/types";

/**
 * Space activity snapshots are page-level derived data (hourly rollups +
 * rankings + contributors). They are safe to persist: every field originates
 * from server aggregates, and the page always revalidates on mount.
 */
export type SpaceActivityCacheRecord = {
	key: string;
	userKey: string;
	spaceId: string;
	days: number;
	activity: SpaceActivityResponse;
	updatedAt: number;
	lastAccessedAt: number;
};

const TTL_MS = 30 * 60 * 1000;
const MEMORY_LIMIT = 24;
const STORE: StoreName = "space_activity";
const memory = new MemoryLru<string, SpaceActivityCacheRecord>(MEMORY_LIMIT);
let subscribed = false;

export type SpaceActivitySnapshot = {
	activity: SpaceActivityResponse;
	updatedAt: number;
	stale: boolean;
	source: CacheSource;
};

export function spaceActivityKey(
	userKey: string,
	spaceId: string,
	days: number,
) {
	return `${encodeKeyPart(userKey)}:${encodeKeyPart(spaceId)}:${days}`;
}

function toSnapshot(
	record: SpaceActivityCacheRecord,
	source: CacheSource,
): SpaceActivitySnapshot {
	return {
		activity: record.activity,
		updatedAt: record.updatedAt,
		stale: Date.now() - record.updatedAt >= TTL_MS,
		source,
	};
}

function ensureBroadcastSubscription() {
	if (subscribed) return;
	subscribed = true;
	subscribeCacheMessages((message) => {
		if (message.store !== STORE || !message.spaceId) return;
		if (message.userKey !== getCacheUserKey()) return;
		if (message.key) memory.delete(message.key);
	});
}

export const spaceActivityRepo = {
	async getCached(
		spaceId: string,
		days: number,
	): Promise<SpaceActivitySnapshot | null> {
		ensureBroadcastSubscription();
		const userKey = getCacheUserKey();
		const key = spaceActivityKey(userKey, spaceId, days);
		const cached = memory.get(key);
		if (cached) return toSnapshot(cached, "memory");
		const record = await idbGet<SpaceActivityCacheRecord>(STORE, key);
		if (!record) return null;
		memory.set(key, record);
		return toSnapshot(record, "indexeddb");
	},

	async set(
		spaceId: string,
		days: number,
		activity: SpaceActivityResponse,
		source: CacheSource = "network",
	) {
		ensureBroadcastSubscription();
		const userKey = getCacheUserKey();
		const key = spaceActivityKey(userKey, spaceId, days);
		const now = Date.now();
		const record: SpaceActivityCacheRecord = {
			key,
			userKey,
			spaceId,
			days,
			activity,
			updatedAt: now,
			lastAccessedAt: now,
		};
		memory.set(key, record);
		await idbPut(STORE, record).catch(() => undefined);
		publishCacheMessage({
			type: "cache-updated",
			store: STORE,
			key,
			userKey,
			spaceId,
			updatedAt: now,
		});
		return toSnapshot(record, source);
	},

	isFresh(snapshot: SpaceActivitySnapshot) {
		return Date.now() - snapshot.updatedAt < TTL_MS;
	},
};
