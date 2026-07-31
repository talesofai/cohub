import type { SpacePresenceSnapshot } from "@cohub/protocol/realtime";
import { getProfilesByUuids, fallbackPublicUserProfile } from "./user-profiles.js";
import { redisCommandClient } from "./redis.js";

const SPACE_PRESENCE_CONNECTIONS_PREFIX = "gateway:presence:space";
const WS_CONNECTION_PREFIX = "gateway:ws:connection";
const MAX_META_JSON_LENGTH = 4096;

type StoredPresenceConnection = {
  connectionId: string;
  userId: string;
  lastSeenAt: number;
  meta: Record<string, unknown> | null;
};

type StoredWsConnection = {
  connectionId?: string;
  userId?: string | null;
  userIds?: string[];
  rooms?: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const getSpacePresenceConnectionsKey = (spaceId: string) =>
  `${SPACE_PRESENCE_CONNECTIONS_PREFIX}:${spaceId}:connections`;

const getWsConnectionKey = (connectionId: string) =>
  `${WS_CONNECTION_PREFIX}:${connectionId}`;

const parsePresenceMeta = (value: unknown): Record<string, unknown> | null => {
  if (!isRecord(value)) return null;
  try {
    if (JSON.stringify(value).length > MAX_META_JSON_LENGTH) return null;
  } catch {
    return null;
  }
  return value;
};

const parsePresenceConnection = (raw: string): StoredPresenceConnection | null => {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return null;
    const connectionId = typeof value.connectionId === "string" ? value.connectionId : "";
    const userId = typeof value.userId === "string" ? value.userId : null;
    const lastSeenAt = typeof value.lastSeenAt === "number" ? value.lastSeenAt : 0;
    if (!connectionId || !userId || lastSeenAt <= 0) return null;
    return { connectionId, userId, lastSeenAt, meta: parsePresenceMeta(value.meta) };
  } catch {
    return null;
  }
};

const parseWsConnection = (raw: string | null): StoredWsConnection | null => {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return null;
    return {
      connectionId: typeof value.connectionId === "string" ? value.connectionId : undefined,
      userId: typeof value.userId === "string" ? value.userId : null,
      userIds: Array.isArray(value.userIds)
        ? value.userIds.filter((userId): userId is string => typeof userId === "string")
        : [],
      rooms: Array.isArray(value.rooms)
        ? value.rooms.filter((room): room is string => typeof room === "string")
        : [],
    };
  } catch {
    return null;
  }
};

export async function getSpacePresenceSnapshot(spaceId: string): Promise<SpacePresenceSnapshot> {
  const key = getSpacePresenceConnectionsKey(spaceId);
  const rawConnections = await redisCommandClient.hgetall(key);
  const entries = Object.entries(rawConnections)
    .map(([, raw]) => parsePresenceConnection(raw))
    .filter((entry): entry is StoredPresenceConnection => Boolean(entry));

  if (entries.length === 0) {
    return { spaceId, users: [], updatedAt: new Date().toISOString() };
  }

  const pipeline = redisCommandClient.pipeline();
  for (const entry of entries) pipeline.get(getWsConnectionKey(entry.connectionId));
  const connectionRows = await pipeline.exec();
  const staleConnectionIds: string[] = [];
  const users = new Map<string, { connectionCount: number; lastSeenAt: number; meta: Record<string, unknown> | null; metas: Record<string, unknown>[] }>();
  const room = `space:${spaceId}`;

  entries.forEach((entry, index) => {
    const raw = connectionRows?.[index]?.[1];
    const wsConnection = parseWsConnection(typeof raw === "string" ? raw : null);
    const connectionUserIds = wsConnection
      ? [...new Set([wsConnection.userId, ...(wsConnection.userIds ?? [])].filter((value): value is string => Boolean(value)))]
      : [];
    if (!connectionUserIds.includes(entry.userId) || !wsConnection?.rooms?.includes(room)) {
      staleConnectionIds.push(entry.connectionId);
      return;
    }
    const current = users.get(entry.userId) ?? { connectionCount: 0, lastSeenAt: 0, meta: null, metas: [] };
    current.connectionCount += 1;
    if (entry.meta) current.metas.push(entry.meta);
    if (entry.lastSeenAt >= current.lastSeenAt) {
      current.lastSeenAt = entry.lastSeenAt;
      current.meta = entry.meta;
    }
    users.set(entry.userId, current);
  });

  if (staleConnectionIds.length > 0) {
    await redisCommandClient.hdel(key, ...staleConnectionIds).catch(() => undefined);
  }

  const profiles = await getProfilesByUuids([...users.keys()]);
  const canonicalUsers = new Map<string, { connectionCount: number; lastSeenAt: number; meta: Record<string, unknown> | null; metas: Record<string, unknown>[]; profile: ReturnType<typeof fallbackPublicUserProfile> }>();
  for (const [userId, state] of users) {
    const profile = profiles.get(userId) ?? fallbackPublicUserProfile(userId);
    const existing = canonicalUsers.get(profile.userUuid);
    if (!existing) {
      canonicalUsers.set(profile.userUuid, { ...state, profile });
      continue;
    }
    existing.connectionCount += state.connectionCount;
    existing.metas.push(...state.metas);
    if (state.lastSeenAt >= existing.lastSeenAt) {
      existing.lastSeenAt = state.lastSeenAt;
      existing.meta = state.meta;
    }
  }
  const snapshotUsers = [...canonicalUsers.entries()]
    .map(([userId, state]) => ({
      userId,
      connectionCount: state.connectionCount,
      lastSeenAt: new Date(state.lastSeenAt).toISOString(),
      meta: state.meta,
      metas: state.metas,
      profile: state.profile,
    }))
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));

  return {
    spaceId,
    users: snapshotUsers,
    updatedAt: new Date().toISOString(),
  };
}
