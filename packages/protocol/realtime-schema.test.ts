import assert from "node:assert/strict";
import { test } from "node:test";
import {
	realtimeEnvelopeSchema,
	wsClientEventSchema,
} from "./src/realtime/schema.js";
import { MAX_REALTIME_ROOMS_PER_REQUEST } from "./src/realtime/types.js";

const sessionRoom = "session:33333333-3333-4333-8333-333333333333";

test("Session rooms are valid subscription targets", () => {
	for (const type of ["subscribe", "unsubscribe"] as const) {
		assert.equal(
			wsClientEventSchema.safeParse({
				type,
				payload: { rooms: [sessionRoom] },
			}).success,
			true,
		);
	}
});

test("subscription messages reject unbounded room lists", () => {
	assert.equal(
		wsClientEventSchema.safeParse({
			type: "subscribe",
			payload: {
				rooms: Array.from(
					{ length: MAX_REALTIME_ROOMS_PER_REQUEST + 1 },
					(_, index) => `session:${index}`,
				),
			},
		}).success,
		false,
	);
});

test("Session rooms are valid realtime envelope targets", () => {
	assert.equal(
		realtimeEnvelopeSchema.safeParse({
			id: "event-1",
			timestamp: Date.now(),
			domain: "session",
			type: "session.updated",
			spaceId: "11111111-1111-4111-8111-111111111111",
			sessionId: "33333333-3333-4333-8333-333333333333",
			rooms: [sessionRoom],
			payload: {},
		}).success,
		true,
	);
});
