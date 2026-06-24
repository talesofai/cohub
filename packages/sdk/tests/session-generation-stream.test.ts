import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { ChannelEnvelope } from "@cohub/protocol/realtime";
import { SessionGenerationStreamClient } from "../src/session-generation-stream.js";
import { WebsocketClient } from "../src/websocket.js";

function createPatchEnvelope(input: {
	id: string;
	seq: number;
	baseSeq: number;
	text: string;
	messageId?: string;
	messageOrdinal?: number;
}): ChannelEnvelope {
	return {
		id: input.id,
		timestamp: Date.now(),
		domain: "session",
		type: "session.turn.patch",
		spaceId: "space-1",
		sessionId: "session-1",
		payload: {
			turnId: "turn-1",
			messageId: input.messageId ?? "turn:turn-1:assistant:0",
			messageOrdinal: input.messageOrdinal ?? 0,
			sourceMessageId: input.messageId ?? "turn:turn-1:assistant:0",
			anchorUserMessageId: "user-1",
			seq: input.seq,
			baseSeq: input.baseSeq,
			ops: [
				{
					o: "add",
					p: "/message/content/blocks/0",
					v: { type: "text", text: input.text },
				},
			],
		},
	};
}

test("generation subscriptions keep independent stream reducer state", () => {
	const websocket = new WebsocketClient({
		url: "ws://localhost",
		getAccessToken: () => "token",
	});
	websocket.state = "open";
	const generation = new SessionGenerationStreamClient(
		websocket,
		"space-1",
		"session-1",
	);
	const emit = (
		websocket as unknown as { emit(type: "event", event: ChannelEnvelope): void }
	).emit.bind(websocket);

	const firstTexts: string[] = [];
	const stopFirst = generation.subscribe({
		state: (event) => {
			const block = event.state.contentBlocks[0];
			if (block?.type === "text") firstTexts.push(block.text);
		},
	});
	emit("event", createPatchEnvelope({ id: "p1", seq: 1, baseSeq: 0, text: "one" }));
	stopFirst();

	const secondTexts: string[] = [];
	const outOfSyncReasons: string[] = [];
	const stopSecond = generation.subscribe({
		state: (event) => {
			const block = event.state.contentBlocks[0];
			if (block?.type === "text") secondTexts.push(block.text);
		},
		outOfSync: (event) => outOfSyncReasons.push(event.reason),
	});
	emit("event", createPatchEnvelope({ id: "p2", seq: 1, baseSeq: 0, text: "two" }));
	stopSecond();

	assert.deepEqual(firstTexts, ["one"]);
	assert.deepEqual(secondTexts, ["two"]);
	assert.deepEqual(outOfSyncReasons, []);
});

const createSnapshot = () => ({
	snapshot: {
		version: 2 as const,
		spaceId: "space-1",
		sessionId: "session-1",
		turnId: "turn-1",
		anchorUserMessageId: "user-1",
		seq: 12,
		current: {
			messageId: "turn:turn-1:assistant:1",
			messageOrdinal: 1,
			content: [{ type: "text", text: "hello" }],
			appendPath: "/message/content/blocks/0/text",
		},
		intermediateMessages: [
			{
				messageId: "turn:turn-1:assistant:0",
				messageOrdinal: 0,
				content: [{ type: "text", text: "earlier" }],
			},
		],
		lifecycle: null,
		updatedAt: Date.now(),
	},
});

test("generation subscriptions can seed from a snapshot and replay buffered patches", async () => {
	const websocket = new WebsocketClient({
		url: "ws://localhost",
		getAccessToken: () => "token",
	});
	websocket.state = "open";
	const emit = (
		websocket as unknown as { emit(type: "event", event: ChannelEnvelope): void }
	).emit.bind(websocket);
	const fetchStreamSnapshot = async () => createSnapshot();
	const generation = new SessionGenerationStreamClient(
		websocket,
		"space-1",
		"session-1",
		fetchStreamSnapshot,
	);

	const states: Array<{ source: string; text: string; intermediateCount: number }> = [];
	const stop = generation.subscribe(
		{
			state: (event) => {
				const block = event.state.contentBlocks[0];
				states.push({
					source: event.source,
					text: block?.type === "text" ? block.text : "",
					intermediateCount: event.intermediateMessages.length,
				});
			},
		},
		{ recover: true },
	);

	await delay(0);
	emit(
		"event",
		createPatchEnvelope({
			id: "p13",
			seq: 13,
			baseSeq: 12,
			text: "hello world",
			messageId: "turn:turn-1:assistant:1",
			messageOrdinal: 1,
		}),
	);
	await delay(0);
	stop();

	assert.deepEqual(states[0], {
		source: "snapshot",
		text: "hello",
		intermediateCount: 1,
	});
	assert.equal(states.at(-1)?.text, "hello world");
});
