import assert from "node:assert/strict";
import test from "node:test";
import { realtimeEnvelopeSchema, wsClientEventSchema } from "./src/realtime/schema.js";

test("accepts desktop command events", () => {
  const event = realtimeEnvelopeSchema.safeParse({
    id: "desktop-event-1",
    timestamp: Date.now(),
    domain: "desktop",
    type: "desktop.command.dispatched",
    rooms: ["user:user-1"],
    payload: {
      commandId: "command-1",
      targetClientId: "client-1",
      command: {
        type: "desktop.open",
        target: {
          kind: "app",
          appId: "123e4567-e89b-42d3-a456-426614174000",
        },
      },
      source: null,
    },
  });
  assert.equal(event.success, true);
});

test("accepts generic realtime room events and room routes", () => {
  const request = wsClientEventSchema.safeParse({
    type: "realtime.room.publish",
    requestId: "request-1",
    payload: {
      roomId: "00000000-0000-4000-8000-000000000001",
      event: "shared.state.updated",
      data: { value: 1 },
    },
  });
  assert.equal(request.success, true);

  const localRuntimePrompt = wsClientEventSchema.safeParse({
    type: "session.message.create",
    payload: {
      spaceId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      runtimeId: "33333333-3333-4333-8333-333333333333",
      content: [{ type: "text", text: "run locally" }],
    },
  });
  assert.equal(localRuntimePrompt.success, true);

  const event = realtimeEnvelopeSchema.safeParse({
    id: "event-1",
    timestamp: Date.now(),
    domain: "room",
    type: "realtime.room.event",
    rooms: ["room:00000000-0000-4000-8000-000000000001"],
    payload: {
      roomId: "00000000-0000-4000-8000-000000000001",
      sequence: 1,
      event: "shared.state.updated",
      data: { value: 1 },
      sender: { participantId: "participant-1" },
      clientEventId: null,
    },
  });
  assert.equal(event.success, true);
});
