import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppSurfaceHost } from "../lib/features/app/surface-host.ts";

const ORIGIN = "https://cohub.run";

/** A call awaits readiness before posting. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function waitForPosted(
	posted: Array<{ message: Record<string, unknown> }>,
	count: number,
) {
	const deadline = Date.now() + 500;
	while (posted.length < count && Date.now() < deadline) await flush();
	assert.ok(posted.length >= count, `expected ${count} posted messages`);
}

function mountHost(
	options: {
		frameOrigin?: string | null;
		syncContext?: (
			invocation?: import("@neta-art/cohub").AppRuntimeInvocationContext,
		) => Promise<void>;
	} = {},
) {
	const posted: Array<{ message: Record<string, unknown>; origin: string }> =
		[];
	const composerChips: Array<{
		key: string;
		label: string;
		content: string;
	} | null> = [];
	const contentWindow = {
		postMessage: (message: Record<string, unknown>, origin: string) =>
			posted.push({ message, origin }),
	};
	const host = createAppSurfaceHost({
		getFrame: () => ({ contentWindow }) as unknown as HTMLIFrameElement,
		getFrameOrigin: () =>
			options.frameOrigin === undefined ? ORIGIN : options.frameOrigin,
		onComposerChip: (chip) => composerChips.push(chip),
		syncContext: options.syncContext,
	});

	const event = (
		type: string,
		extra: Record<string, unknown>,
		source: unknown = contentWindow,
		origin = ORIGIN,
	) =>
		({
			source,
			origin,
			data: { protocol: "cohub.app.surface", version: 1, type, ...extra },
		}) as MessageEvent;

	return {
		host,
		posted,
		composerChips,
		contentWindow,
		ready: (methods: string[], source?: unknown, origin?: string) =>
			host.handleMessage(event("ready", { methods }, source, origin)),
		respond: (
			payload: Record<string, unknown>,
			source?: unknown,
			origin?: string,
		) => host.handleMessage(event("response", payload, source, origin)),
		setComposerChip: (
			chip: { key: string; label: string; content: string },
			source?: unknown,
			origin?: string,
		) =>
			host.handleMessage(event("composer.chip.set", { chip }, source, origin)),
		clearComposerChip: (key: string, source?: unknown, origin?: string) =>
			host.handleMessage(event("composer.chip.clear", { key }, source, origin)),
	};
}

test("trusted App composer context updates, clears, and resets", () => {
	const { host, composerChips, setComposerChip, clearComposerChip } =
		mountHost();
	const chip = {
		key: "selection",
		label: "3 selected",
		content: "Selected records:\n- customer_123",
	};

	assert.equal(setComposerChip(chip), true);
	assert.deepEqual(composerChips, [chip]);
	assert.equal(clearComposerChip("other"), true);
	assert.deepEqual(composerChips, [chip]);
	assert.equal(clearComposerChip(chip.key), true);
	assert.deepEqual(composerChips, [chip, null]);

	setComposerChip(chip);
	host.reset();
	assert.deepEqual(composerChips, [chip, null, chip, null]);
});

test("spoofed App composer context is ignored", () => {
	const { composerChips, contentWindow, setComposerChip } = mountHost();
	const chip = { key: "selection", label: "Selected", content: "customer_123" };

	assert.equal(setComposerChip(chip, {}, ORIGIN), false);
	assert.equal(
		setComposerChip(chip, contentWindow, "https://evil.example"),
		false,
	);
	assert.deepEqual(composerChips, []);
});

test("context updates and calls share one ordered surface queue", async () => {
	const operations: string[] = [];
	const mounted = mountHost({
		syncContext: async (invocation) => {
			operations.push(`context:${invocation?.sessionId ?? "current"}`);
			await flush();
		},
	});
	mounted.ready(["first", "second"]);

	const first = mounted.host.call({
		method: "first",
		commandId: "command-1",
		invocation: { surface: "app", sessionId: "session-a" },
	});
	const update = mounted.host.syncContext({
		surface: "app",
		sessionId: "session-between",
	});
	const second = mounted.host.call({
		method: "second",
		commandId: "command-2",
		invocation: { surface: "app", sessionId: "session-b" },
	});

	await waitForPosted(mounted.posted, 1);
	operations.push(`call:${String(mounted.posted[0]?.message.method)}`);
	mounted.respond({
		requestId: mounted.posted[0]?.message.requestId,
		ok: true,
	});
	await first;
	await update;
	await waitForPosted(mounted.posted, 2);
	operations.push(`call:${String(mounted.posted[1]?.message.method)}`);
	mounted.respond({
		requestId: mounted.posted[1]?.message.requestId,
		ok: true,
	});
	await second;

	assert.deepEqual(operations, [
		"context:session-a",
		"call:first",
		"context:session-between",
		"context:session-b",
		"call:second",
	]);
});

test("a context sync failure is explicit and does not block later calls", async () => {
	let attempts = 0;
	const mounted = mountHost({
		syncContext: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("viewer lookup failed");
		},
	});
	mounted.ready(["ping"]);
	assert.deepEqual(
		await mounted.host.call({ method: "ping", commandId: "command-1" }),
		{
			ok: false,
			code: "context_sync_failed",
			message: "viewer lookup failed",
		},
	);

	const recovered = mounted.host.call({
		method: "ping",
		commandId: "command-2",
	});
	await waitForPosted(mounted.posted, 1);
	mounted.respond({
		requestId: mounted.posted[0]?.message.requestId,
		ok: true,
	});
	assert.deepEqual(await recovered, { ok: true });
});

test("a call waits for a newly mounted App to announce readiness", async () => {
	const { host, posted, ready, respond } = mountHost();
	const pending = host.call({
		method: "image.open",
		commandId: "command-1",
		readyTimeoutMs: 200,
		requestTimeoutMs: 200,
	});
	await flush();
	assert.equal(posted.length, 0, "the host must not post before surface.ready");

	ready(["image.open"]);
	await flush();
	assert.equal(posted.at(-1)?.message.method, "image.open");
	respond({ requestId: posted.at(-1)?.message.requestId, ok: true });
	assert.deepEqual(await pending, { ok: true });
});

test("a call resolves when the App acknowledges it", async () => {
	const { host, posted, ready, respond } = mountHost();
	ready(["selection.get"]);
	assert.equal(host.ready, true);
	assert.deepEqual(host.methods, ["selection.get"]);

	const pending = host.call({
		method: "selection.get",
		input: { scope: "active" },
		commandId: "command-1",
	});
	await flush();
	assert.equal(posted.at(-1)?.origin, ORIGIN);
	assert.equal(posted.at(-1)?.message.method, "selection.get");
	assert.equal(posted.at(-1)?.message.commandId, "command-1");

	respond({
		requestId: posted.at(-1)?.message.requestId,
		ok: true,
	});
	assert.deepEqual(await pending, { ok: true });
});

test("messages from another origin or window cannot answer for the surface", async () => {
	const { host, posted, contentWindow, ready, respond } = mountHost();
	ready(["ping"]);

	assert.equal(ready(["ping"], contentWindow, "https://evil.example"), false);
	assert.equal(ready(["ping"], {}), false);

	const pending = host.call({
		method: "ping",
		commandId: "command-1",
		requestTimeoutMs: 40,
	});
	await flush();
	const requestId = posted.at(-1)?.message.requestId;
	respond({ requestId, ok: true }, contentWindow, "https://evil.example");
	respond({ requestId, ok: true, result: "spoofed" }, {});

	const result = await pending;
	assert.equal(result.ok === false && result.code, "surface_timeout");
});

test("an unannounced method fails fast instead of hanging", async () => {
	const { host, ready } = mountHost();
	ready(["selection.get"]);

	const result = await host.call({ method: "nope", commandId: "command-1" });
	assert.equal(result.ok === false && result.code, "method_not_found");
});

test("an App that never registers methods reports not-ready", async () => {
	const { host } = mountHost();
	const result = await host.call({
		method: "ping",
		commandId: "command-1",
		readyTimeoutMs: 30,
	});
	assert.equal(result.ok === false && result.code, "surface_not_ready");
});

test("an untrusted frame origin is never posted to", async () => {
	const { host, posted } = mountHost({ frameOrigin: null });

	const result = await host.call({ method: "ping", commandId: "command-1" });
	assert.equal(result.ok === false && result.code, "surface_unavailable");
	assert.equal(posted.length, 0);
});

// A reload must not leave a caller stuck on its timer, in flight or not yet ready.
for (const [name, announce] of [
	["in flight", true],
	["still waiting for readiness", false],
] as const) {
	test(`reset promptly settles a call ${name}`, async () => {
		const { host, ready } = mountHost();
		if (announce) ready(["ping"]);

		const pending = host.call({
			method: "ping",
			commandId: "command-1",
			readyTimeoutMs: 10_000,
			requestTimeoutMs: 10_000,
		});
		await flush();
		const startedAt = Date.now();
		host.reset();

		const result = await pending;
		assert.equal(result.ok === false && result.code, "surface_reset");
		assert.ok(Date.now() - startedAt < 500, "reset should settle promptly");
		assert.equal(host.ready, false);
	});
}
