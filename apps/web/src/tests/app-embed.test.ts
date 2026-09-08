import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AppEmbedState,
	connectAppEmbed,
} from "../lib/features/app/app-embed.ts";

const ORIGIN = "https://cohub.run";
const APP_ID = "123e4567-e89b-42d3-a456-426614174000";
const SPACE_ID = "223e4567-e89b-42d3-a456-426614174000";
const envelope = { protocol: "cohub.app.embed", version: 1 };

type Listener = (event: MessageEvent) => void;

function mountPage() {
	const posted: Array<{ message: Record<string, unknown>; origin: string }> =
		[];
	const listeners = new Set<Listener>();
	const parent = {
		postMessage: (message: Record<string, unknown>, origin: string) =>
			posted.push({ message, origin }),
	};
	const previousWindow = globalThis.window;
	globalThis.window = {
		parent,
		addEventListener: (_: string, listener: Listener) =>
			listeners.add(listener),
		removeEventListener: (_: string, listener: Listener) =>
			listeners.delete(listener),
	} as unknown as Window & typeof globalThis;

	const states: AppEmbedState[] = [];
	const connection = connectAppEmbed(ORIGIN, (state) => states.push(state));
	const deliver = (
		data: unknown,
		origin = ORIGIN,
		source: unknown = parent,
	) => {
		for (const listener of listeners)
			listener({ data, origin, source } as MessageEvent);
	};
	const dispose = () => {
		connection.dispose();
		globalThis.window = previousWindow;
	};
	return { connection, posted, states, deliver, dispose };
}

test("requests attachment, then adopts the embedder and its shell", () => {
	const page = mountPage();
	try {
		assert.deepEqual(page.posted[0], {
			message: { ...envelope, type: "attach.request" },
			origin: ORIGIN,
		});

		page.deliver({
			...envelope,
			type: "attach",
			embedId: "embed-1",
			embedder: { appId: APP_ID },
			shell: {
				space: { id: SPACE_ID, name: "Studio" },
				session: null,
				turn: null,
			},
		});
		assert.deepEqual(page.states.at(-1), {
			embedId: "embed-1",
			embedder: { appId: APP_ID },
			shell: {
				space: { id: SPACE_ID, name: "Studio" },
				session: null,
				turn: null,
			},
		});

		page.deliver({
			...envelope,
			type: "shell.changed",
			embedId: "embed-1",
			shell: null,
		});
		assert.equal(page.states.at(-1)?.shell, null);
		assert.equal(page.states.length, 2);
	} finally {
		page.dispose();
	}
});

test("ignores messages from other origins, non-parent frames, or embed ids", () => {
	const page = mountPage();
	try {
		const attach = {
			...envelope,
			type: "attach",
			embedId: "embed-1",
			embedder: { appId: APP_ID },
			shell: null,
		};
		page.deliver(attach, "https://evil.example");
		// A grandparent or sibling frame shares the origin but is not `window.parent`.
		page.deliver(attach, ORIGIN, {});
		assert.equal(page.states.length, 0);

		page.deliver(attach);
		page.deliver({
			...envelope,
			type: "shell.changed",
			embedId: "other",
			shell: null,
		});
		assert.equal(page.states.length, 1);
	} finally {
		page.dispose();
	}
});

test("relays close only once attached", () => {
	const page = mountPage();
	try {
		page.connection.requestClose();
		assert.equal(
			page.posted.filter((entry) => entry.message.type === "close.request")
				.length,
			0,
		);

		page.deliver({
			...envelope,
			type: "attach",
			embedId: "embed-1",
			embedder: { appId: APP_ID },
			shell: null,
		});
		page.connection.requestClose();
		assert.deepEqual(page.posted.at(-1), {
			message: { ...envelope, type: "close.request", embedId: "embed-1" },
			origin: ORIGIN,
		});
	} finally {
		page.dispose();
	}
});
