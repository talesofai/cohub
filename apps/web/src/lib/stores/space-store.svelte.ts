import {
  getSpaces,
  getSpace,
  getSpaceChannels,
  getSpaceSessions,
  listSpacePermissions,
  type SpaceListItem,
  type SpaceRecord,
  type SpaceChannelRecord,
  type SessionRecord,
  type ResourcePermission,
  type ResourcePermissionLevel,
} from "$lib/api";
import { sidebarCache } from "$lib/stores/sidebar-cache";
import { authStore } from "$lib/stores/auth.svelte";

const SPACE_LIST_REFRESH_MS = 60_000;
const SESSION_LIST_REFRESH_MS = 30_000;

type PermissionMap = Record<string, Map<string, ResourcePermissionLevel>>;

function mergeSpaceList(existing: SpaceListItem[], incoming: SpaceListItem[]) {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) {
    byId.set(item.id, {
      ...byId.get(item.id),
      ...item,
    });
  }
  return Array.from(byId.values()).sort((a, b) => {
    const aTime = new Date(a.createdAt).getTime();
    const bTime = new Date(b.createdAt).getTime();
    return bTime - aTime;
  });
}

class SpaceStore {
  spaceList = $state<SpaceListItem[]>([]);
  spaceDetailsById = $state<Record<string, SpaceRecord>>({});
  spaceChannelsById = $state<Record<string, SpaceChannelRecord[]>>({});
  sessionsBySpace = $state<Record<string, SessionRecord[]>>({});
  permissionsBySpace = $state<PermissionMap>({});
  permissionRecordsBySpace = $state<Record<string, ResourcePermission[]>>({});
  loadedSessionSpaceIds = $state(new Set<string>());
  loadedChannelSpaceIds = $state(new Set<string>());
  loadedPermissionSpaceIds = $state(new Set<string>());
  lastSpaceListFetchedAt = $state(0);
  lastSessionListFetchedAt = $state<Record<string, number>>({});
  loadingSpaceList = $state(false);
  loadingSessionsBySpace = $state<Record<string, boolean>>({});

  private injectedSharedSpaceIds = $state(new Set<string>());

  private spaceListPromise: Promise<SpaceListItem[]> | null = null;
  private sessionPromises = new Map<string, Promise<SessionRecord[]>>();
  private permissionPromises = new Map<string, Promise<Map<string, ResourcePermissionLevel>>>();
  private spaceDetailPromises = new Map<string, Promise<SpaceRecord>>();
  private spaceChannelPromises = new Map<string, Promise<SpaceChannelRecord[]>>();
  private permissionRecordPromises = new Map<string, Promise<ResourcePermission[]>>();

  private addLoadedSessionSpace(spaceId: string) {
    const next = new Set(this.loadedSessionSpaceIds);
    next.add(spaceId);
    this.loadedSessionSpaceIds = next;
  }

  private deleteLoadedSessionSpace(spaceId: string) {
    const next = new Set(this.loadedSessionSpaceIds);
    next.delete(spaceId);
    this.loadedSessionSpaceIds = next;
  }

  private addLoadedChannelSpace(spaceId: string) {
    const next = new Set(this.loadedChannelSpaceIds);
    next.add(spaceId);
    this.loadedChannelSpaceIds = next;
  }

  private deleteLoadedChannelSpace(spaceId: string) {
    const next = new Set(this.loadedChannelSpaceIds);
    next.delete(spaceId);
    this.loadedChannelSpaceIds = next;
  }

  private addLoadedPermissionSpace(spaceId: string) {
    const next = new Set(this.loadedPermissionSpaceIds);
    next.add(spaceId);
    this.loadedPermissionSpaceIds = next;
  }

  private deleteLoadedPermissionSpace(spaceId: string) {
    const next = new Set(this.loadedPermissionSpaceIds);
    next.delete(spaceId);
    this.loadedPermissionSpaceIds = next;
  }

  shouldRefreshSpaceList() {
    return Date.now() - this.lastSpaceListFetchedAt > SPACE_LIST_REFRESH_MS;
  }

  async ensureSpaceList(options?: { force?: boolean }) {
    const force = options?.force ?? false;

    if (this.spaceList.length === 0) {
      const cached = sidebarCache.getSpaces();
      if (cached?.length) this.setSpaceList(cached);
    }

    if (!force && !this.shouldRefreshSpaceList() && this.spaceList.length > 0) {
      return this.spaceList;
    }

    if (this.spaceListPromise && !force) return this.spaceListPromise;

    this.loadingSpaceList = true;
    const request = (async () => {
      const data = await getSpaces();
      this.replaceSpaceList(data);
      sidebarCache.setSpaces(data);
      return data;
    })();

    this.spaceListPromise = request;
    try {
      return await request;
    } finally {
      if (this.spaceListPromise === request) this.spaceListPromise = null;
      this.loadingSpaceList = false;
    }
  }

  shouldRefreshSessions(spaceId: string) {
    const last = this.lastSessionListFetchedAt[spaceId] ?? 0;
    return Date.now() - last > SESSION_LIST_REFRESH_MS;
  }

  async ensureSpaceSessions(spaceId: string, options?: { force?: boolean }) {
    const force = options?.force ?? false;

    if (!this.sessionsBySpace[spaceId]) {
      const cached = sidebarCache.getSessions(spaceId);
      if (cached?.length) this.setSessions(spaceId, cached);
    }

    if (!force && this.hasLoadedSessions(spaceId) && !this.shouldRefreshSessions(spaceId)) {
      return this.getSessions(spaceId) ?? [];
    }

    const existing = this.sessionPromises.get(spaceId);
    if (existing && !force) return existing;

    this.setLoadingSessions(spaceId, true);
    const request = (async () => {
      const result = await getSpaceSessions(spaceId);
      const sessions = result.sessions ?? [];
      this.setSessions(spaceId, sessions);
      sidebarCache.setSessions(spaceId, sessions);
      return sessions;
    })();

    this.sessionPromises.set(spaceId, request);
    try {
      return await request;
    } finally {
      if (this.sessionPromises.get(spaceId) === request) this.sessionPromises.delete(spaceId);
      this.setLoadingSessions(spaceId, false);
    }
  }

  async ensureSpacePermissions(spaceId: string, options?: { force?: boolean }) {
    const force = options?.force ?? false;
    if (!authStore.userUuid) return null;

    if (!force && this.hasLoadedPermissions(spaceId)) {
      return this.getPermissions(spaceId) ?? new Map<string, ResourcePermissionLevel>();
    }

    const existing = this.permissionPromises.get(spaceId);
    if (existing && !force) return existing;

    const request = (async () => {
      const perms = await listSpacePermissions(spaceId);
      this.permissionRecordsBySpace = { ...this.permissionRecordsBySpace, [spaceId]: perms };
      const levels = new Map<string, ResourcePermissionLevel>();
      for (const perm of perms) {
        if (perm.resourceType === "session") levels.set(perm.resourceId, perm.level);
      }
      this.setPermissions(spaceId, levels);
      return levels;
    })();

    this.permissionPromises.set(spaceId, request);
    try {
      return await request;
    } finally {
      if (this.permissionPromises.get(spaceId) === request) this.permissionPromises.delete(spaceId);
    }
  }

  async ensureSpaceDetail(spaceId: string, options?: { force?: boolean }) {
    const force = options?.force ?? false;
    if (!force) {
      const existing = this.getSpace(spaceId);
      if (existing && !this.shouldRefreshSpaceList()) return existing as SpaceRecord;
    }

    const existing = this.spaceDetailPromises.get(spaceId);
    if (existing && !force) return existing;

    const request = (async () => {
      const space = await getSpace(spaceId);
      this.upsertSpace(space);
      return space;
    })();
    this.spaceDetailPromises.set(spaceId, request);
    try {
      return await request;
    } finally {
      if (this.spaceDetailPromises.get(spaceId) === request) this.spaceDetailPromises.delete(spaceId);
    }
  }

  async ensureSpaceChannels(spaceId: string, options?: { force?: boolean }) {
    const force = options?.force ?? false;
    if (!force && this.hasLoadedChannels(spaceId)) return this.getSpaceChannels(spaceId) ?? [];

    const existing = this.spaceChannelPromises.get(spaceId);
    if (existing && !force) return existing;

    const request = (async () => {
      const channels = await getSpaceChannels(spaceId);
      this.setSpaceChannels(spaceId, channels);
      return channels;
    })();
    this.spaceChannelPromises.set(spaceId, request);
    try {
      return await request;
    } finally {
      if (this.spaceChannelPromises.get(spaceId) === request) this.spaceChannelPromises.delete(spaceId);
    }
  }

  async ensureSpacePermissionRecords(spaceId: string, options?: { force?: boolean }) {
    const force = options?.force ?? false;
    if (!authStore.userUuid) return [];
    if (!force && this.permissionRecordsBySpace[spaceId]) return this.permissionRecordsBySpace[spaceId];

    const existing = this.permissionRecordPromises.get(spaceId);
    if (existing && !force) return existing;

    const request = (async () => {
      const perms = await listSpacePermissions(spaceId);
      this.permissionRecordsBySpace = { ...this.permissionRecordsBySpace, [spaceId]: perms };
      const levels = new Map<string, ResourcePermissionLevel>();
      for (const perm of perms) {
        if (perm.resourceType === "session") levels.set(perm.resourceId, perm.level);
      }
      this.setPermissions(spaceId, levels);
      return perms;
    })();
    this.permissionRecordPromises.set(spaceId, request);
    try {
      return await request;
    } finally {
      if (this.permissionRecordPromises.get(spaceId) === request) this.permissionRecordPromises.delete(spaceId);
    }
  }

  setSpaceList(items: SpaceListItem[]) {
    this.spaceList = mergeSpaceList(this.spaceList, items);
    this.lastSpaceListFetchedAt = Date.now();
    for (const item of items) this.spaceDetailsById[item.id] = item;
  }

  replaceSpaceList(items: SpaceListItem[]) {
    const sharedToPreserve = [...this.injectedSharedSpaceIds]
      .map((id) => this.spaceDetailsById[id])
      .filter((s) => s && !items.some((item) => item.id === s.id));
    this.spaceList = [...sharedToPreserve, ...items];
    this.lastSpaceListFetchedAt = Date.now();
    for (const item of items) this.spaceDetailsById[item.id] = item;
  }

  injectSharedSpace(space: SpaceRecord | SpaceListItem) {
    this.injectedSharedSpaceIds = new Set(this.injectedSharedSpaceIds).add(space.id);
    this.spaceDetailsById[space.id] = space as SpaceRecord;
    if (!this.spaceList.some((item) => item.id === space.id)) {
      this.spaceList = [{ ...(space as SpaceListItem) }, ...this.spaceList];
    }
  }

  upsertSpace(space: SpaceRecord | SpaceListItem) {
    this.spaceDetailsById[space.id] = space as SpaceRecord;
    const index = this.spaceList.findIndex((item) => item.id === space.id);
    if (index >= 0) {
      const next = [...this.spaceList];
      next[index] = { ...next[index], ...space } as SpaceListItem;
      this.spaceList = next;
    } else {
      this.spaceList = [{ ...(space as SpaceListItem) }, ...this.spaceList];
    }
  }

  removeSpace(spaceId: string) {
    this.spaceList = this.spaceList.filter((item) => item.id !== spaceId);
    delete this.spaceDetailsById[spaceId];
    delete this.spaceChannelsById[spaceId];
    delete this.sessionsBySpace[spaceId];
    delete this.permissionsBySpace[spaceId];
    delete this.permissionRecordsBySpace[spaceId];
    delete this.lastSessionListFetchedAt[spaceId];
    delete this.loadingSessionsBySpace[spaceId];
    this.lastSessionListFetchedAt = { ...this.lastSessionListFetchedAt };
    this.loadingSessionsBySpace = { ...this.loadingSessionsBySpace };
    this.permissionRecordsBySpace = { ...this.permissionRecordsBySpace };
    this.deleteLoadedSessionSpace(spaceId);
    this.deleteLoadedChannelSpace(spaceId);
    this.deleteLoadedPermissionSpace(spaceId);
  }

  getSpace(spaceId: string) {
    return this.spaceDetailsById[spaceId] ?? this.spaceList.find((item) => item.id === spaceId) ?? null;
  }

  setSpaceChannels(spaceId: string, channels: SpaceChannelRecord[]) {
    this.spaceChannelsById[spaceId] = channels;
    this.addLoadedChannelSpace(spaceId);
  }

  getSpaceChannels(spaceId: string) {
    return this.spaceChannelsById[spaceId] ?? null;
  }

  setSessions(spaceId: string, sessions: SessionRecord[]) {
    const permMap = this.permissionsBySpace[spaceId];
    this.sessionsBySpace[spaceId] = sessions.map((session) => ({
      ...session,
      shareLevel: session.shareLevel ?? permMap?.get(session.id) ?? null,
    }));
    this.addLoadedSessionSpace(spaceId);
    this.lastSessionListFetchedAt = { ...this.lastSessionListFetchedAt, [spaceId]: Date.now() };
  }

  patchSession(spaceId: string, session: SessionRecord) {
    const existing = this.sessionsBySpace[spaceId] ?? [];
    const index = existing.findIndex((item) => item.id === session.id);
    const next = [...existing];
    const permMap = this.permissionsBySpace[spaceId];
    const hydrated = { ...session, shareLevel: session.shareLevel ?? permMap?.get(session.id) ?? null };
    if (index >= 0) next[index] = { ...next[index], ...hydrated };
    else next.push(hydrated);
    next.sort((a, b) => {
      const aTime = new Date(a.updatedAt ?? a.createdAt).getTime();
      const bTime = new Date(b.updatedAt ?? b.createdAt).getTime();
      return bTime - aTime;
    });
    this.setSessions(spaceId, next);
  }

  setPermissions(spaceId: string, levels: Map<string, ResourcePermissionLevel>) {
    this.permissionsBySpace = { ...this.permissionsBySpace, [spaceId]: levels };
    this.addLoadedPermissionSpace(spaceId);

    const sessions = this.sessionsBySpace[spaceId];
    if (sessions) {
      this.sessionsBySpace = {
        ...this.sessionsBySpace,
        [spaceId]: sessions.map((session) => ({ ...session, shareLevel: levels.get(session.id) ?? null })),
      };
    }
  }

  getPermissions(spaceId: string) {
    return this.permissionsBySpace[spaceId] ?? null;
  }

  hasLoadedPermissions(spaceId: string) {
    return this.loadedPermissionSpaceIds.has(spaceId);
  }

  getSessions(spaceId: string) {
    return this.sessionsBySpace[spaceId] ?? null;
  }

  hasLoadedSessions(spaceId: string) {
    return this.loadedSessionSpaceIds.has(spaceId);
  }

  hasLoadedChannels(spaceId: string) {
    return this.loadedChannelSpaceIds.has(spaceId);
  }

  setLoadingSessions(spaceId: string, loading: boolean) {
    this.loadingSessionsBySpace = { ...this.loadingSessionsBySpace, [spaceId]: loading };
  }

  isLoadingSessions(spaceId: string) {
    return this.loadingSessionsBySpace[spaceId] ?? false;
  }
}

export const spaceStore = new SpaceStore();
