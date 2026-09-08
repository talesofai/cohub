import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { attachAppEmbed } from "../src/app-embed.js";
import { AppRuntimeApi, ParentBridgeTransport } from "../src/app-runtime.js";

const originalWindow = globalThis.window;
const APP_ID = "123e4567-e89b-42d3-a456-426614174000";
const FRAME_ORIGIN = "https://cohub.live";
const envelope = { protocol: "cohub.app.embed", version: 1 };

type Listener = (event: MessageEvent) => void;

afterEach(() => {
	globalThis.window = originalWindow;
});

function mountEmbedder() {
	const posted: Array<{ message: Record<string, unknown>; origin: string }> = [];
	const listeners = new Set<Listener>();
	const frameListeners = new Set<() => void>();
	const contentWindow = {
		postMessage: (message: Record<string, unknown>, origin: string) =>
			posted.push({ message, origin }),
	};
	const frame = {
		src: `${FRAME_ORIGIN}/alice/studio/w/notes`,
		contentWindow,
		addEventListener: (_: "load", fn: () => void) => frameListeners.add(fn),
		removeEventListener: (_: "load", fn: () => void) => frameListeners.delete(fn),
	} as unknown as HTMLIFrameElement;
	globalThis.window = {
		location: { href: "https://cohub.live/alice/studio/w/desktop" },
		addEventListener: (_: "message", fn: Listener) => listeners.add(fn),
		removeEventListener: (_: "message", fn: Listener) => listeners.delete(fn),
	} as unknown as Window & typeof globalThis;

	const deliver = (data: unknown, origin = FRAME_ORIGIN, source: unknown = contentWindow) => {
		for (const listener of listeners) listener({ data, origin, source } as MessageEvent);
	};
	const load = () => {
		for (const listener of frameListeners) listener();
	};
	return { frame, posted, deliver, load, listeners, frameListeners };
}

test("embedder announces itself on attach, on request, and on every frame load", () => {
	const host = mountEmbedder();
	let closed = 0;
	const embed = attachAppEmbed(host.frame, {
		appId: APP_ID,
		shell: { space: null, session: null, turn: null },
		onCloseRequest: () => closed++,
	});
	const attach = {
		...envelope,
		type: "attach",
		embedId: embed.embedId,
		embedder: { appId: APP_ID },
		shell: { space: null, session: null, turn: null },
	};
	assert.deepEqual(host.posted, [{ message: attach, origin: FRAME_ORIGIN }]);

	host.deliver({ ...envelope, type: "attach.request" });
	host.load();
	assert.equal(host.posted.length, 3);

	embed.setShell(null);
	assert.deepEqual(host.posted.at(-1)?.message, {
		...envelope,
		type: "shell.changed",
		embedId: embed.embedId,
		shell: null,
	});

	host.deliver({ ...envelope, type: "close.request", embedId: "other" });
	host.deliver({ ...envelope, type: "close.request", embedId: embed.embedId }, "https://evil.example");
	assert.equal(closed, 0);
	host.deliver({ ...envelope, type: "close.request", embedId: embed.embedId });
	assert.equal(closed, 1);

	embed.dispose();
	assert.equal(host.listeners.size, 0);
	assert.equal(host.frameListeners.size, 0);
});

test("requestClose posts a one-way close request to the parent", () => {
	const posted: Array<{ message: Record<string, unknown>; origin: string }> = [];
	const parent = {
		postMessage: (message: Record<string, unknown>, origin: string) =>
			posted.push({ message, origin }),
	};
	globalThis.window = {
		parent,
		location: { ancestorOrigins: [FRAME_ORIGIN] },
	} as unknown as Window & typeof globalThis;

	new AppRuntimeApi(new ParentBridgeTransport()).requestClose();
	assert.deepEqual(posted, [
		{
			message: { protocol: "cohub.app.runtime", version: 1, type: "close.request" },
			origin: FRAME_ORIGIN,
		},
	]);
});
