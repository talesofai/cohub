import { sidebarCache } from "$lib/stores/sidebar-cache";
import { spaceStore } from "$lib/stores/space-store.svelte";

export function hydrateSpaceStoreFromSidebarCache() {
  const spaces = sidebarCache.getSpaces();
  if (spaces?.length) {
    spaceStore.setSpaceList(spaces);
  }
}

export function hydrateSessionCacheToSpaceStore(spaceId: string) {
  const sessions = sidebarCache.getSessions(spaceId);
  if (sessions?.length) {
    spaceStore.setSessions(spaceId, sessions);
  }
}
