import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { BoardAwarenessUpdate } from "@cohub/protocol/realtime";
import type { BoardAwarenessUpdatedEvent } from "@neta-art/cohub";
import type { BoardItem } from "@neta-art/cohub/board";
import {
	boardAwarenessViewportFromCamera,
	createBoardAwarenessController,
} from "../lib/board/board-awareness.ts";
import type { BoardEditor } from "../lib/board/editor.svelte.ts";

function event(
	seq: number,
	update: BoardAwarenessUpdate,
): BoardAwarenessUpdatedEvent {
	return {
		id: `event-${seq}`,
		timestamp: Date.now(),
		domain: "space",
		type: "board.awareness.updated",
		spaceId: "11111111-1111-4111-8111-111111111111",
		payload: {
			boardId: "22222222-2222-4222-8222-222222222222",
			connectionId: "connection-a",
			actorId: "actor-a",
			actorName: "Ada",
			seq,
			update,
		},
	};
}

test("remote awareness assembles draw chunks and reconciles the final node", () => {
	let changes = 0;
	const controller = createBoardAwarenessController({
		send: async () => {},
		onChange: () => {
			changes += 1;
		},
	});
	controller.receive(
		event(1, {
			type: "state",
			cursor: { x: 10, y: 20, pointerType: "mouse" },
			tool: "draw",
			selection: { ids: [], count: 0, bounds: null },
			editingId: null,
		}),
	);
	controller.receive(
		event(2, {
			type: "gesture",
			gesture: {
				kind: "draw",
				id: "item-stroke",
				nodeId: "item-stroke",
				color: "brand",
				size: 4,
				from: 0,
				points: [
					{ x: 1, y: 2, p: 0.5 },
					{ x: 2, y: 3, p: 0.6 },
				],
			},
		}),
	);
	controller.receive(
		event(3, {
			type: "gesture",
			gesture: {
				kind: "draw",
				id: "item-stroke",
				nodeId: "item-stroke",
				color: "brand",
				size: 4,
				from: 2,
				points: [{ x: 3, y: 4, p: 0.7 }],
			},
		}),
	);
	// A stale update cannot rewind the peer.
	controller.receive(
		event(2, { type: "gesture.cancel", gestureId: "item-stroke" }),
	);

	const peer = controller.peers[0];
	assert.equal(peer?.state?.cursor?.x, 10);
	assert.equal(peer?.gesture?.kind, "draw");
	assert.equal(
		peer?.gesture?.kind === "draw" ? peer.gesture.points.length : 0,
		3,
	);

	controller.receive(
		event(4, {
			type: "gesture.end",
			gestureId: "item-stroke",
			resultingNodeIds: ["item-stroke"],
		}),
	);
	controller.reconcile([
		{
			id: "item-stroke",
			type: "draw",
			points: [],
			color: "brand",
			size: 4,
			frame: { x: 0, y: 0, width: 10, height: 10, rotation: 0 },
		} satisfies BoardItem,
	]);
	assert.equal(controller.peers[0]?.gesture, null);
	assert.ok(changes >= 5);
	controller.destroy();
});

test("local awareness batches raw draw points and flushes before gesture end", async () => {
	const sent: BoardAwarenessUpdate[] = [];
	const controller = createBoardAwarenessController({
		send: async (_seq, update) => {
			sent.push(update);
		},
		onChange: () => {},
	});
	const points = Array.from({ length: 70 }, (_, index) => ({
		x: index,
		y: index * 2,
		p: 0.5,
	}));
	const editor = {
		interaction: {
			type: "drawing",
			id: "item-local",
			pointerId: 1,
			points,
			color: "brand",
			size: 4,
		},
		itemById: () => null,
	} as unknown as BoardEditor;

	controller.syncGesture(editor);
	await delay(50);
	(editor as unknown as { interaction: { type: "idle" } }).interaction = {
		type: "idle",
	};
	controller.syncGesture(editor);
	await delay(20);

	const drawUpdates = sent.filter(
		(update) => update.type === "gesture" && update.gesture.kind === "draw",
	);
	assert.equal(drawUpdates.length, 2);
	assert.deepEqual(
		drawUpdates.map((update) =>
			update.type === "gesture" && update.gesture.kind === "draw"
				? [update.gesture.from, update.gesture.points.length]
				: null,
		),
		[
			[0, 64],
			[64, 6],
		],
	);
	assert.equal(sent.at(-1)?.type, "gesture.end");
	controller.destroy();
});

test("local arrow awareness preserves the active stroke width", async () => {
	const sent: BoardAwarenessUpdate[] = [];
	const controller = createBoardAwarenessController({
		send: async (_seq, update) => {
			sent.push(update);
		},
		onChange: () => {},
	});
	const editor = {
		interaction: {
			type: "creatingArrow",
			id: "arrow-local",
			start: { x: 0, y: 0 },
			current: { x: 40, y: 20 },
			color: "rose",
			size: 4.5,
			startBinding: null,
		},
		itemById: () => null,
	} as unknown as BoardEditor;

	controller.syncGesture(editor);
	await delay(20);
	const update = sent.find(
		(entry) => entry.type === "gesture" && entry.gesture.kind === "arrow",
	);
	assert.equal(
		update?.type === "gesture" && update.gesture.kind === "arrow"
			? update.gesture.size
			: null,
		4.5,
	);
	controller.destroy();
});

test("viewport presence converts the camera to world space", () => {
	assert.deepEqual(
		boardAwarenessViewportFromCamera(
			{ x: -200, y: 100, zoom: 2 },
			{ width: 800, height: 600 },
		),
		{ x: 100, y: -50, width: 400, height: 300, zoom: 2 },
	);
	assert.equal(
		boardAwarenessViewportFromCamera(
			{ x: 0, y: 0, zoom: 1 },
			{ width: 0, height: 600 },
		),
		null,
	);
});

test("viewport presence ignores sub-pixel camera movement", async () => {
	const sent: BoardAwarenessUpdate[] = [];
	const controller = createBoardAwarenessController({
		send: async (_seq, update) => {
			sent.push(update);
		},
		onChange: () => {},
	});
	controller.setViewport({ x: 0, y: 0, width: 800, height: 600, zoom: 1 });
	await delay(120);
	controller.setViewport({ x: 1, y: 0, width: 800, height: 600, zoom: 1 });
	await delay(120);
	controller.setViewport({ x: 3, y: 0, width: 800, height: 600, zoom: 1 });
	await delay(120);

	const states = sent.filter((update) => update.type === "state");
	assert.equal(states.length, 2);
	assert.equal(
		states.at(-1)?.type === "state" ? states.at(-1)?.viewport?.x : null,
		3,
	);
	await controller.destroy();
});

test("local state publishes the client form factor", async () => {
	const sent: BoardAwarenessUpdate[] = [];
	const controller = createBoardAwarenessController({
		send: async (_seq, update) => {
			sent.push(update);
		},
		onChange: () => {},
	});
	controller.updateLocalState({
		client: { formFactor: "mobile" },
		tool: "select",
		selection: [],
		bounds: null,
		editingId: null,
	});
	await delay(20);
	const state = sent.find((update) => update.type === "state");
	assert.equal(
		state?.type === "state" ? state.client?.formFactor : null,
		"mobile",
	);
	controller.destroy();
});

test("remounted controllers keep websocket awareness sequences monotonic", async () => {
	const firstSequences: number[] = [];
	const first = createBoardAwarenessController({
		send: async (seq) => {
			firstSequences.push(seq);
		},
		onChange: () => {},
	});
	first.updateLocalState({
		client: { formFactor: "desktop" },
		tool: "draw",
		selection: [],
		bounds: null,
		editingId: null,
	});
	await delay(20);
	await first.destroy();

	const secondSequences: number[] = [];
	const second = createBoardAwarenessController({
		send: async (seq) => {
			secondSequences.push(seq);
		},
		onChange: () => {},
	});
	second.updateLocalState({
		client: { formFactor: "mobile" },
		tool: "select",
		selection: [],
		bounds: null,
		editingId: null,
	});
	await delay(20);

	assert.ok(firstSequences.length > 0);
	assert.ok(secondSequences.length > 0);
	assert.ok(
		Math.min(...secondSequences) > Math.max(...firstSequences),
		"a remounted controller must not restart its connection sequence",
	);
	await second.destroy();
});

test("a released touch keeps its last contact point for the fade-out", () => {
	const controller = createBoardAwarenessController({
		send: async () => {},
		onChange: () => {},
	});
	controller.receive(
		event(1, {
			type: "state",
			client: { formFactor: "mobile" },
			cursor: { x: 30, y: 60, pointerType: "touch" },
			tool: "select",
			selection: { ids: [], count: 0, bounds: null },
			editingId: null,
		}),
	);
	// pointerup clears the live cursor; the last contact is what the overlay
	// fades out, so it must survive the null update.
	controller.receive(
		event(2, {
			type: "state",
			client: { formFactor: "mobile" },
			cursor: null,
			tool: "select",
			selection: { ids: [], count: 0, bounds: null },
			editingId: null,
		}),
	);
	const peer = controller.peers[0];
	assert.equal(peer?.state?.cursor, null);
	assert.deepEqual(peer?.lastCursor, { x: 30, y: 60, pointerType: "touch" });
	assert.ok(peer?.cursorClearedAt != null);
	controller.destroy();
});
