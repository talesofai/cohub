import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRealtimeEventRooms } from "./realtime-event-rooms.js";

test("Session realtime routing reaches both member aggregates and the scoped Session room", () => {
  assert.deepEqual(resolveRealtimeEventRooms({
    spaceId: "space-1",
    sessionId: "session-1",
  }), ["space:space-1", "session:session-1"]);
  assert.deepEqual(resolveRealtimeEventRooms({
    spaceId: "space-1",
  }), ["space:space-1"]);
});

test("explicit realtime rooms remain authoritative", () => {
  assert.deepEqual(resolveRealtimeEventRooms({
    spaceId: "space-1",
    sessionId: "session-1",
    rooms: ["user:user-1"],
  }), ["user:user-1"]);
  assert.deepEqual(resolveRealtimeEventRooms({
    spaceId: "space-1",
    sessionId: "session-1",
    rooms: [],
  }), []);
});

test("implicit task recipients remain user-only", () => {
  assert.deepEqual(resolveRealtimeEventRooms({
    spaceId: "space-1",
    sessionId: "session-1",
    userIds: ["user-1", "user-1"],
  }), ["user:user-1"]);
});
