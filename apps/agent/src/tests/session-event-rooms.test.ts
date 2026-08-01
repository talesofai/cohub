import assert from "node:assert/strict";
import { test } from "node:test";
import { getSessionEventRooms } from "../session-event-rooms.js";

test("Agent session events reach both the Space aggregate and Session subscribers", () => {
  assert.deepEqual(getSessionEventRooms("space-1", "session-1"), [
    "space:space-1",
    "session:session-1",
  ]);
});
