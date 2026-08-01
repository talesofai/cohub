import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_REALTIME_ROOMS_PER_CONNECTION,
  type RealtimeRoom,
} from "@cohub/protocol/realtime";
import { hasRealtimeRoomCapacity } from "./realtime-room-admission.js";

test("realtime room admission counts only new unique rooms", () => {
  const current = new Set<RealtimeRoom>(["user:viewer"]);
  assert.equal(hasRealtimeRoomCapacity(current, ["user:viewer", "space:one"]), true);

  const full = new Set<RealtimeRoom>(
    Array.from(
      { length: MAX_REALTIME_ROOMS_PER_CONNECTION },
      (_, index) => `session:${index}` as RealtimeRoom,
    ),
  );
  assert.equal(hasRealtimeRoomCapacity(full, ["session:0"]), true);
  assert.equal(hasRealtimeRoomCapacity(full, ["session:overflow"]), false);
});
