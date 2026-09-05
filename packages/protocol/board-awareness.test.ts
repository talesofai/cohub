import assert from "node:assert/strict";
import { test } from "node:test";
import { BoardAwarenessClientPayloadSchema } from "./src/realtime/board-awareness.js";
import { wsClientEventSchema } from "./src/realtime/schema.js";
import {
	getRealtimeBoardRoom,
	normalizeRealtimeRooms,
	parseRealtimeRoom,
} from "./src/realtime/types.js";

const spaceId = "11111111-1111-4111-8111-111111111111";
const boardId = "22222222-2222-4222-8222-222222222222";

test("Board rooms normalize alongside Space and user rooms", () => {
	assert.equal(getRealtimeBoardRoom(boardId), `board:${boardId}`);
	assert.deepEqual(parseRealtimeRoom(`board:${boardId}`), {
		kind: "board",
		id: boardId,
	});
	assert.deepEqual(
		normalizeRealtimeRooms([
			`board:${boardId}`,
			`space:${spaceId}`,
			`board:${boardId}`,
		]),
		[`board:${boardId}`, `space:${spaceId}`],
	);
});

test("Board awareness validates bounded state and gesture updates", () => {
	const payload = {
		spaceId,
		boardId,
		seq: 1,
		update: {
			type: "state",
			cursor: { x: 10, y: 20, pointerType: "pen" },
			viewport: { x: -100, y: -50, width: 800, height: 600, zoom: 1.5 },
			tool: "draw",
			selection: { ids: [], count: 0, bounds: null },
			editingId: null,
		},
	};
	assert.equal(BoardAwarenessClientPayloadSchema.safeParse(payload).success, true);
	assert.equal(
		wsClientEventSchema.safeParse({
			type: "board.awareness.update",
			payload,
		}).success,
		true,
	);

	const oversized = {
		...payload,
		update: {
			type: "gesture",
			gesture: {
				kind: "draw",
				id: "stroke",
				nodeId: "stroke",
				color: "brand",
				size: 4,
				from: 0,
				points: Array.from({ length: 65 }, (_, index) => ({
					x: index,
					y: index,
					p: 0.5,
				})),
			},
		},
	};
	assert.equal(BoardAwarenessClientPayloadSchema.safeParse(oversized).success, false);
	for (const viewport of [
		{ x: 0, y: 0, width: 0, height: 600, zoom: 1 },
		{ x: Number.MAX_VALUE, y: 0, width: 800, height: 600, zoom: 1 },
		{ x: 0, y: 0, width: 100_000_001, height: 600, zoom: 1 },
		{ x: 0, y: 0, width: 800, height: 600, zoom: 0.01 },
		{ x: 0, y: 0, width: 800, height: 600, zoom: 9 },
	]) {
		assert.equal(
			BoardAwarenessClientPayloadSchema.safeParse({
				...payload,
				update: { ...payload.update, viewport },
			}).success,
			false,
		);
	}
	assert.equal(
		BoardAwarenessClientPayloadSchema.safeParse({
			...payload,
			update: {
				...payload.update,
				cursor: { x: Number.MAX_VALUE, y: 0, pointerType: "mouse" },
			},
		}).success,
		false,
	);

	const arrow = BoardAwarenessClientPayloadSchema.parse({
		...payload,
		update: {
			type: "gesture",
			gesture: {
				kind: "arrow",
				id: "arrow",
				nodeId: "arrow",
				start: { x: 0, y: 0 },
				current: { x: 20, y: 10 },
				color: "brand",
			},
		},
	});
	assert.equal(
		arrow.update.type === "gesture" && arrow.update.gesture.kind === "arrow"
			? arrow.update.gesture.size
			: null,
		2.5,
	);
});
