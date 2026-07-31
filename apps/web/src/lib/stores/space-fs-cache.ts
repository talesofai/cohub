import type { SpaceFsEntry } from "@neta-art/cohub";
import { deleteCacheDatabase } from "$lib/cache/db";
import { canUseUserScopedCache, getCacheUserKeyAsync } from "$lib/cache/keys";
import { spaceFsRepo } from "$lib/cache/repositories/space-fs-repo";

async function resolveCacheUserKey() {
	const userKey = await getCacheUserKeyAsync();
	return canUseUserScopedCache(userKey) ? userKey : null;
}

export async function getCachedSpaceFsDir(
	spaceId: string,
	dirPath: string,
): Promise<SpaceFsEntry[] | null> {
	if (!(await resolveCacheUserKey())) return null;
	const snapshot = await spaceFsRepo.getDir(spaceId, dirPath);
	return snapshot?.entries ?? null;
}

export async function getCachedSpaceFsDirMeta(
	spaceId: string,
	dirPath: string,
) {
	if (!(await resolveCacheUserKey())) return null;
	const snapshot = await spaceFsRepo.getDir(spaceId, dirPath);
	if (!snapshot) return null;
	return { updatedAt: snapshot.updatedAt, isStale: snapshot.stale };
}

export async function patchCachedSpaceFsDir(
	spaceId: string,
	dirPath: string,
	updater: (entries: SpaceFsEntry[]) => SpaceFsEntry[],
): Promise<SpaceFsEntry[] | null> {
	if (!(await resolveCacheUserKey())) return null;
	const snapshot = await spaceFsRepo.patchDir(spaceId, dirPath, updater);
	return snapshot?.entries ?? null;
}

export async function clearCachedSpaceFsDir(spaceId: string, dirPath: string) {
	if (!(await resolveCacheUserKey())) return;
	await spaceFsRepo.clearDir(spaceId, dirPath);
}

export async function clearCachedSpaceFsSubtree(
	spaceId: string,
	dirPath: string,
) {
	if (!(await resolveCacheUserKey())) return;
	await spaceFsRepo.clearSubtree(spaceId, dirPath);
}

export async function clearAllCachedSpaceFsDirs() {
	await deleteCacheDatabase();
}

export function onSpaceFsDirCacheUpdated(
	handler: (event: {
		spaceId: string;
		dirPath: string;
		entries: SpaceFsEntry[];
	}) => void,
) {
	const listener = (event: Event) => {
		const custom = event as CustomEvent<{
			spaceId: string;
			dirPath: string;
			entries: SpaceFsEntry[];
		}>;
		if (!custom.detail?.spaceId) return;
		handler(custom.detail);
	};
	if (typeof window !== "undefined")
		window.addEventListener("cohub:space-fs-dir-cache-updated", listener);
	return () => {
		if (typeof window !== "undefined")
			window.removeEventListener("cohub:space-fs-dir-cache-updated", listener);
	};
}

export async function fetchSpaceFsDirWithCache(
	spaceId: string,
	dirPath: string,
	fetcher: () => Promise<SpaceFsEntry[]>,
	options?: { force?: boolean },
): Promise<SpaceFsEntry[]> {
	await getCacheUserKeyAsync();
	const canCache = Boolean(await resolveCacheUserKey());
	if (canCache && !options?.force) {
		const cached = await spaceFsRepo.getDir(spaceId, dirPath);
		if (cached && !cached.stale) return cached.entries;
	}
	if (!canCache) return fetcher();
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const epoch = await spaceFsRepo.getEpoch(spaceId);
		const entries = await fetcher();
		const result = await spaceFsRepo.setDirIfEpoch(
			spaceId,
			dirPath,
			entries,
			epoch,
		);
		if (result.committed) return result.snapshot?.entries ?? entries;
	}
	// Sustained filesystem churn should not block the UI. Return one uncached,
	// authoritative read and let the next invalidation refresh it again.
	return fetcher();
}
