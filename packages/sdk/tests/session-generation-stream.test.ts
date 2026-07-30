import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { ChannelEnvelope } from "@cohub/protocol/realtime";
import type { MessageRecord } from "@cohub/protocol/model";
import {
	parseAssistantMessageCommit,
	SessionGenerationStreamClient,
} from "../src/session-generation-stream.js";
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

test("generation subscriptions compact duplicate keyless snapshot intermediates", async () => {
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
	const snapshot = createSnapshot().snapshot;
	snapshot.intermediateMessages = [
		{
			messageId: null,
			messageOrdinal: null,
			content: [{ type: "text", text: "same" }],
		},
		{
			messageId: null,
			messageOrdinal: null,
			content: [{ type: "text", text: "same" }],
		},
	];

	let intermediateCount = 0;
	const stop = generation.subscribe(
		{
			state: (event) => {
				intermediateCount = event.intermediateMessages.length;
			},
		},
		{ initialSnapshot: snapshot },
	);
	await delay(0);
	stop();

	assert.equal(intermediateCount, 1);
});

test("generation subscriptions compact snapshot intermediates by ordinal", async () => {
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
	const snapshot = createSnapshot().snapshot;
	snapshot.intermediateMessages = [
		{
			messageId: "turn:turn-1:assistant:0",
			messageOrdinal: 0,
			content: [{ type: "text", text: "synthetic" }],
		},
		{
			messageId: "db-message-1",
			messageOrdinal: 0,
			content: [{ type: "text", text: "db" }],
		},
	];

	let intermediateMessages: Array<{ content: unknown[] }> = [];
	const stop = generation.subscribe(
		{
			state: (event) => {
				intermediateMessages = event.intermediateMessages;
			},
		},
		{ initialSnapshot: snapshot },
	);
	await delay(0);
	stop();

	assert.equal(intermediateMessages.length, 1);
	assert.deepEqual(intermediateMessages[0]?.content, [
		{ type: "text", text: "db" },
	]);
});

test("compacted system messages are intermediate generation commits", () => {
	const message = {
		id: "compact-message",
		sessionId: "session-1",
		role: "system",
		content: [{ type: "system_note", note_type: "compacted", text: "Summary" }],
		meta: { messageKind: "compacted", turnId: "turn-1" },
	} as MessageRecord;

	const commit = parseAssistantMessageCommit(message);
	assert.equal(commit.kind, "intermediate");
	assert.equal(commit.isFinal, false);
});

test("snapshot compaction messages are placed before their retained message", async () => {
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
	const snapshot = {
		...createSnapshot().snapshot,
		intermediateMessages: [
			{
				id: "retained-message",
				sequence: 10,
				messageId: "retained-message",
				messageOrdinal: 1,
				content: [{ type: "text", text: "retained" }],
			},
			{
				id: "compact-message",
				sequence: 10,
				role: "system" as const,
				messageId: "compact-message",
				messageOrdinal: null,
				content: [{ type: "system_note" as const, note_type: "compacted" as const, text: "summary" }],
				meta: {
					messageKind: "compacted",
					compaction: { placement: { beforeMessageId: "retained-message" } },
				},
			},
		],
	};

	let messageIds: Array<string | null> = [];
	const stop = generation.subscribe(
		{
			state: (event) => {
				messageIds = event.intermediateMessages.map((message) => message.messageId);
			},
		},
		{ initialSnapshot: snapshot },
	);
	await delay(0);
	stop();

	assert.deepEqual(messageIds, ["compact-message", "retained-message"]);
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
