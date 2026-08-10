import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * A duplicated tab inherits the stored id and would run the same command twice.
 * Each "tab" is a separate module instance sharing a fake channel and storage.
 */

const SHARED_ID = "sharedstoredclientid00";
const STORAGE_KEY = "cohub:client-instance-id:v1";

type Tab = typeof import("../lib/client-instance.ts");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A repeated query string would reuse a cached module, carrying stale state. */
let tabSequence = 0;

async function withTabs(
	run: (openTab: () => Promise<Tab>) => Promise<void>,
	options: { storedId?: string; withChannel?: boolean } = {},
) {
	const globals = globalThis as Record<string, unknown>;
	const saved = { ...globals };
	const channels = new Set<FakeChannel>();
	const store = new Map(
		options.storedId ? [[STORAGE_KEY, options.storedId]] : [],
	);

	class FakeChannel {
		onmessage: ((event: MessageEvent) => void) | null = null;
		closed = false;
		constructor() {
			channels.add(this);
		}
		postMessage(data: unknown) {
			// A real BroadcastChannel does not echo to the sender.
			for (const peer of channels) {
				if (peer !== this && !peer.closed)
					peer.onmessage?.({ data } as MessageEvent);
			}
		}
		close() {
			this.closed = true;
		}
	}

	globals.window = {};
	globals.sessionStorage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => store.set(key, value),
	};
	globals.BroadcastChannel =
		options.withChannel === false ? undefined : FakeChannel;

	try {
		await run(async () => {
			tabSequence += 1;
			return (await import(
				`../lib/client-instance.ts?tab=${tabSequence}`
			)) as Tab;
		});
	} finally {
		globals.window = saved.window;
		globals.sessionStorage = saved.sessionStorage;
		globals.BroadcastChannel = saved.BroadcastChannel;
	}
}

test("tabs sharing a stored id converge on distinct, stable ids", async () => {
	// Three, so the tie-breaking rule has to converge rather than merely swap.
	await withTabs(
		async (openTab) => {
			const tabs = [await openTab(), await openTab(), await openTab()];
			for (const tab of tabs) tab.getClientInstanceId();
			for (let i = 0; i < 4; i += 1) await flush();

			const ids = tabs.map((tab) => tab.getClientInstanceId());
			assert.equal(new Set(ids).size, 3, `ids collided: ${ids.join(",")}`);
			assert.ok(
				ids.includes(SHARED_ID),
				"one tab keeps the id, so routing stays valid",
			);
			for (const id of ids) assert.match(id ?? "", /^[A-Za-z0-9_-]{8,64}$/);
			assert.deepEqual(
				tabs.map((tab) => tab.getClientInstanceId()),
				ids,
				"ids are stable",
			);
		},
		{ storedId: SHARED_ID },
	);
});

test("without BroadcastChannel a tab still produces a usable id", async () => {
	await withTabs(
		async (openTab) => {
			assert.ok((await openTab()).getClientInstanceId());
		},
		{ withChannel: false },
	);
});
