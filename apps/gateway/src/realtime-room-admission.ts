import { MAX_REALTIME_ROOMS_PER_CONNECTION, type RealtimeRoom } from "@cohub/protocol/realtime";

export function hasRealtimeRoomCapacity(
  currentRooms: ReadonlySet<RealtimeRoom>,
  requestedRooms: readonly RealtimeRoom[],
): boolean {
  const combined = new Set(currentRooms);
  for (const room of requestedRooms) combined.add(room);
  return combined.size <= MAX_REALTIME_ROOMS_PER_CONNECTION;
}
