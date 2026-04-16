import type { SpaceListItem, SessionRecord } from "$lib/api";

const STORAGE_KEY = "cohub:sidebar_cache";
const CACHE_VERSION = 1;
const MAX_SPACE_ENTRIES = 50;

interface SidebarCacheData {
  userUuid: string | null;
  version: number;
  spaces: SpaceListItem[] | null;
  sessionsBySpace: Record<string, SessionRecord[]>;
}

class SidebarCache {
  private data: SidebarCacheData = {
    userUuid: null,
    version: CACHE_VERSION,
    spaces: null,
    sessionsBySpace: {},
  };

  constructor() {
    this.restore();
  }

  private restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as SidebarCacheData;
        if (parsed.version === CACHE_VERSION) {
          this.data = parsed;
        }
      }
    } catch {}
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {}
  }

  setUserUuid(uuid: string) {
    if (this.data.userUuid && this.data.userUuid !== uuid) {
      this.data = {
        userUuid: uuid,
        version: CACHE_VERSION,
        spaces: null,
        sessionsBySpace: {},
      };
      this.persist();
      return;
    }
    if (!this.data.userUuid) {
      this.data.userUuid = uuid;
      this.persist();
    }
  }

  getSpaces(): SpaceListItem[] | null {
    return this.data.spaces;
  }

  setSpaces(data: SpaceListItem[]) {
    this.data.spaces = data;
    this.persist();
  }

  getSessions(spaceId: string): SessionRecord[] | null {
    return this.data.sessionsBySpace[spaceId] ?? null;
  }

  setSessions(spaceId: string, sessions: SessionRecord[]) {
    this.data.sessionsBySpace[spaceId] = sessions;
    this.trim();
    this.persist();
  }

  invalidateAll() {
    this.data = {
      userUuid: null,
      version: CACHE_VERSION,
      spaces: null,
      sessionsBySpace: {},
    };
    localStorage.removeItem(STORAGE_KEY);
  }

  private trim() {
    const keys = Object.keys(this.data.sessionsBySpace);
    if (keys.length <= MAX_SPACE_ENTRIES) return;
    const toRemove = keys.slice(0, keys.length - MAX_SPACE_ENTRIES);
    for (const key of toRemove) delete this.data.sessionsBySpace[key];
    this.persist();
  }
}

export const sidebarCache = new SidebarCache();
