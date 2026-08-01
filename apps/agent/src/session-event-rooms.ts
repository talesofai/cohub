import {
  getRealtimeSessionRoom,
  getRealtimeSpaceRoom,
  type RealtimeRoom,
} from "@cohub/protocol/realtime";

export function getSessionEventRooms(
  spaceId: string,
  sessionId: string,
): RealtimeRoom[] {
  return [getRealtimeSpaceRoom(spaceId), getRealtimeSessionRoom(sessionId)];
}
