import type { RealtimeRoom } from "@cohub/protocol/realtime";
import {
  getRealtimeSessionRoom,
  getRealtimeSpaceRoom,
  getRealtimeUserRoom,
  normalizeRealtimeRooms,
} from "@cohub/protocol/realtime";

export function resolveRealtimeEventRooms(input: {
  spaceId?: string | null;
  sessionId?: string | null;
  rooms?: RealtimeRoom[];
  userIds?: string[];
}): RealtimeRoom[] {
  if (input.rooms !== undefined) return normalizeRealtimeRooms(input.rooms);

  const userIds = Array.from(new Set(
    (input.userIds ?? [])
      .map((value) => value.trim())
      .filter(Boolean),
  ));
  if (userIds.length > 0) return userIds.map(getRealtimeUserRoom);

  const resourceRooms: RealtimeRoom[] = [];
  const spaceId = input.spaceId?.trim();
  const sessionId = input.sessionId?.trim();
  if (spaceId) resourceRooms.push(getRealtimeSpaceRoom(spaceId));
  if (sessionId) resourceRooms.push(getRealtimeSessionRoom(sessionId));
  return resourceRooms;
}
