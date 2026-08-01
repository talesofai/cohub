import assert from "node:assert/strict";
import { test } from "node:test";
import { BoardClient, BoardTransactionError } from "../src/apis/spaces.js";
import { CohubHttpClient } from "../src/http.js";
import { HttpTransport, type Fetch } from "../src/transport.js";
import type { WebsocketClient, WebsocketEventPayload } from "../src/websocket.js";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

test("space.board and boards.byId bind the Board identity", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetch: Fetch = async (input, init) => {
		requests.push({ url: String(input), init });
		return jsonResponse({});
	};
	const client = new CohubHttpClient({ baseUrl: "https://api.example.test", fetch });
	const space = client.space("space-1");
	const board = space.board("board-1");

	assert.equal(board.id, "board-1");
	assert.equal(board.spaceId, "space-1");
	assert.equal(space.boards.byId("board-2").id, "board-2");

	await board.inspect({ include: ["nodes"], viewport: { x: 1, y: 2, width: 3, height: 4 } });
	assert.match(requests[0]?.url ?? "", /^https:\/\/api\.example\.test\/api\/spaces\/space-1\/boards\/board-1\?/);
	const inspectUrl = new URL(requests[0]?.url ?? "");
	assert.deepEqual(inspectUrl.searchParams.getAll("include"), ["nodes"]);
	assert.deepEqual(JSON.parse(inspectUrl.searchParams.get("viewport") ?? "null"), {
		x: 1,
		y: 2,
		width: 3,
		height: 4,
	});

	await board.apply({
		txId: "tx-1",
		baseVersion: 7,
		operations: [{ type: "board.patch", payload: { patch: { title: "Plan" } } }],
	});
	assert.equal(requests[1]?.url, "https://api.example.test/api/spaces/space-1/boards/board-1/transactions");
	assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
		txId: "tx-1",
		baseVersion: 7,
		operations: [{ type: "board.patch", payload: { patch: { title: "Plan" } } }],
		boardId: "board-1",
	});
});

test("Board apply exposes version conflicts as BoardTransactionError", async () => {
	const fetch: Fetch = async () => new Response(JSON.stringify({
		code: "VERSION_CONFLICT",
		message: "Board version changed",
	}), {
		status: 409,
		headers: { "Content-Type": "application/json" },
	});
	const client = new CohubHttpClient({ baseUrl: "https://api.example.test", fetch });
	const board = client.space("space-1").board("board-1");

	await assert.rejects(
		board.apply({ txId: "tx-1", baseVersion: 2, operations: [] }),
		(error: unknown) => {
			assert.ok(error instanceof BoardTransactionError);
			assert.equal(error.status, 409);
			assert.equal(error.code, "VERSION_CONFLICT");
			assert.equal(error.isVersionConflict, true);
			assert.deepEqual(error.body, {
				code: "VERSION_CONFLICT",
				message: "Board version changed",
			});
			return true;
		},
	);
});

test("Board realtime subscriptions isolate events by space and Board", () => {
	let eventHandler: ((event: WebsocketEventPayload) => void) | undefined;
	let released = 0;
	let unsubscribed = 0;
	const websocket = {
		state: "open",
		connectionId: "connection-self",
		retainRooms(rooms: string[]) {
			assert.deepEqual(rooms, ["board:board-1"]);
			return () => {
				released += 1;
			};
		},
		on(type: string, handler: (event: WebsocketEventPayload) => void) {
			assert.equal(type, "event");
			eventHandler = handler;
			return () => {
				unsubscribed += 1;
			};
		},
	} as unknown as WebsocketClient;
	const transport = new HttpTransport({ baseUrl: "https://api.example.test" });
	const board = new BoardClient("space-1", "board-1", transport, websocket);
	const received: string[] = [];
	const stop = board.subscribe({
		transaction: () => received.push("transaction"),
		awareness: () => received.push("awareness"),
		playback: () => received.push("playback"),
	});

	const emit = eventHandler as (event: WebsocketEventPayload) => void;
	emit({ spaceId: "space-1", type: "board.transaction.applied", payload: { boardId: "board-2" } } as WebsocketEventPayload);
	emit({ spaceId: "space-2", type: "board.transaction.applied", payload: { boardId: "board-1" } } as WebsocketEventPayload);
	emit({ spaceId: "space-1", type: "board.transaction.applied", payload: { boardId: "board-1" } } as WebsocketEventPayload);
	emit({ spaceId: "space-1", type: "board.awareness.updated", payload: { boardId: "board-1", connectionId: "connection-self" } } as WebsocketEventPayload);
	emit({ spaceId: "space-1", type: "board.awareness.updated", payload: { boardId: "board-1", connectionId: "connection-other" } } as WebsocketEventPayload);
	emit({ spaceId: "space-1", type: "board.playback.changed", payload: { boardId: "board-1" } } as WebsocketEventPayload);

	assert.deepEqual(received, ["transaction", "awareness", "playback"]);
	stop();
	assert.equal(unsubscribed, 1);
	assert.equal(released, 1);
});

test("Board awareness publishes with the bound Space and Board identity", async () => {
	let published: unknown = null;
	const websocket = {
		async updateBoardAwareness(input: unknown) {
			published = input;
		},
	} as unknown as WebsocketClient;
	const board = new BoardClient(
		"11111111-1111-4111-8111-111111111111",
		"22222222-2222-4222-8222-222222222222",
		new HttpTransport({ baseUrl: "https://api.example.test" }),
		websocket,
	);
	await board.updateAwareness(7, {
		type: "state",
		cursor: { x: 10, y: 20, pointerType: "mouse" },
		tool: "select",
		selection: { ids: [], count: 0, bounds: null },
		editingId: null,
	});
	assert.deepEqual(published, {
		spaceId: "11111111-1111-4111-8111-111111111111",
		boardId: "22222222-2222-4222-8222-222222222222",
		seq: 7,
		update: {
			type: "state",
			cursor: { x: 10, y: 20, pointerType: "mouse" },
			tool: "select",
			selection: { ids: [], count: 0, bounds: null },
			editingId: null,
		},
	});
});
