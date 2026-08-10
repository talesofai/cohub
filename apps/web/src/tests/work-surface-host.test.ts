import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkSurfaceHost } from "../lib/features/work/surface-host.ts";

const ORIGIN = "https://cohub.run";

/** A call awaits readiness before posting. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function mountHost(options: { frameOrigin?: string | null } = {}) {
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
	const host = createWorkSurfaceHost({
		getFrame: () => ({ contentWindow }) as unknown as HTMLIFrameElement,
		getFrameOrigin: () =>
			options.frameOrigin === undefined ? ORIGIN : options.frameOrigin,
		onComposerChip: (chip) => composerChips.push(chip),
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
			data: { protocol: "cohub.surface", version: 1, type, ...extra },
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

test("trusted Work composer context updates, clears, and resets", () => {
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

test("spoofed Work composer context is ignored", () => {
	const { composerChips, contentWindow, setComposerChip } = mountHost();
	const chip = { key: "selection", label: "Selected", content: "customer_123" };

	assert.equal(setComposerChip(chip, {}, ORIGIN), false);
	assert.equal(
		setComposerChip(chip, contentWindow, "https://evil.example"),
		false,
	);
	assert.deepEqual(composerChips, []);
});

test("a call waits for a newly mounted Work to announce readiness", async () => {
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

test("a call resolves when the Work acknowledges it", async () => {
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

test("a Work that never registers methods reports not-ready", async () => {
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
