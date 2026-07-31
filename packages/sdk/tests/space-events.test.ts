import assert from "node:assert/strict";
import test from "node:test";
import { SessionClient, SpaceEventsApi } from "../src/apis/spaces.js";
import { HttpTransport } from "../src/transport.js";
import type {
	WebsocketClient,
	WebsocketEventPayload,
} from "../src/websocket.js";

test("SpaceEventsApi routes published Work versions for the selected Space", () => {
	let emit: ((event: WebsocketEventPayload) => void) | null = null;
	let released = 0;
	const websocket = {
		state: "open",
		retainRooms(rooms: string[]) {
			assert.deepEqual(rooms, ["space:space-1"]);
			return () => {
				released += 1;
			};
		},
		on(type: string, handler: (event: WebsocketEventPayload) => void) {
			assert.equal(type, "event");
			emit = handler;
			return () => undefined;
		},
	} as unknown as WebsocketClient;
	const events = new SpaceEventsApi(websocket, "space-1");
	const received: string[] = [];
	const stop = events.on("work.version.published", (event) => {
		received.push(event.type);
	});
	const publish = emit as unknown as (event: WebsocketEventPayload) => void;
	publish({
		spaceId: "space-2",
		type: "work.version.published",
		payload: {},
	} as WebsocketEventPayload);
	publish({
		spaceId: "space-1",
		type: "task.updated",
		payload: {},
	} as WebsocketEventPayload);
	publish({
		spaceId: "space-1",
		type: "work.version.published",
		payload: {},
	} as WebsocketEventPayload);

	assert.deepEqual(received, ["work.version.published"]);
	stop();
	assert.equal(released, 1);
});

test("Session realtime uses an owner-authorized Session room", () => {
	let released = 0;
	const websocket = {
		state: "open",
		retainRooms(rooms: string[]) {
			assert.deepEqual(rooms, ["session:session-1"]);
			return () => {
				released += 1;
			};
		},
		on() {
			return () => undefined;
		},
	} as unknown as WebsocketClient;
	const session = new SessionClient(
		"space-1",
		"session-1",
		new HttpTransport(),
		websocket,
	);
	const stop = session.realtime.subscribe({});
	stop();
	assert.equal(released, 1);
});
