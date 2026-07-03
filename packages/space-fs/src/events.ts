import { randomUUID } from "node:crypto";
import { createLogger } from "@cohub/infra/logging";
import {
  getRealtimeSpaceRoom,
  getRealtimeUserRoom,
  normalizeRealtimeRooms,
  REALTIME_OUTBOUND_CHANNEL,
  type RealtimeRoom,
  type RealtimeServerEvent,
} from "@cohub/protocol/realtime";
import type { SpaceFsChangedPayload } from "@cohub/protocol/fs";
import type { SpaceFsDeps } from "./types.js";
import type { SpaceFsCdn } from "./cdn.js";

function resolveRealtimeEventRooms(input: {
  spaceId?: string | null;
  rooms?: string[];
  userIds?: string[];
}): RealtimeRoom[] {
  const rooms = normalizeRealtimeRooms(input.rooms ?? []);
  if (rooms.length > 0) return rooms;
  const userIds = Array.from(new Set(
    (input.userIds ?? [])
      .map((value) => value.trim())
      .filter(Boolean),
  ));
  if (userIds.length > 0) return userIds.map(getRealtimeUserRoom);
  return input.spaceId ? [getRealtimeSpaceRoom(input.spaceId)] : [];
}

export function createSpaceEvents(deps: SpaceFsDeps, cdn: SpaceFsCdn) {
  const { redis, serviceName } = deps;
  const logger = createLogger({ serviceName });
  const { enqueueFsCdnWarmForChanges } = cdn;

  async function dispatchRealtimeEvent(input: RealtimeServerEvent & { rooms?: RealtimeRoom[] }) {
    const payload = input.payload as Record<string, unknown>;
    const task = payload.task && typeof payload.task === "object" ? payload.task as { userId?: unknown } : null;
    const userId = typeof payload.userId === "string"
      ? payload.userId
      : typeof task?.userId === "string"
        ? task.userId
        : undefined;
    const rooms = input.rooms?.length ? input.rooms : resolveRealtimeEventRooms({
      spaceId: input.spaceId,
      userIds: userId ? [userId] : undefined,
    });
    if (rooms.length === 0) return;

    await redis.publish(
      REALTIME_OUTBOUND_CHANNEL,
      JSON.stringify({
        ...input,
        rooms,
      }),
    );
  }

  async function dispatchSpaceFsChanged(spaceId: string, payload: SpaceFsChangedPayload) {
    await Promise.all([
      dispatchRealtimeEvent({
        id: randomUUID(),
        timestamp: Date.now(),
        domain: "space",
        type: "space.fs.changed",
        spaceId,
        sessionId: null,
        payload,
      }),
      enqueueFsCdnWarmForChanges(spaceId, payload.changes).catch((error) => {
        logger.error("[SpaceFS] Failed to enqueue CDN prewarm:", error);
      }),
    ]);
  }

  return { dispatchSpaceFsChanged, dispatchRealtimeEvent };
}

export type SpaceEvents = ReturnType<typeof createSpaceEvents>;
