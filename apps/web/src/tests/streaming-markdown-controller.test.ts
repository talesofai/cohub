import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamingMarkdownController } from "../lib/streaming-markdown-controller";

type TimerFn = (...args: unknown[]) => void;

/**
 * Deterministic clock for the controller's timers. The controller uses
 * `setTimeout`, `clearTimeout`, `requestAnimationFrame`, and `performance.now`;
 * we swap them for a manual scheduler and count how often the timer API is
 * touched, since that churn was the dominant main-thread cost in production
 * traces during streaming.
 */
function installFakeTimers() {
	const g = globalThis as Record<string, unknown>;
	const original = {
		setTimeout: g.setTimeout,
		clearTimeout: g.clearTimeout,
		requestAnimationFrame: g.requestAnimationFrame,
		cancelAnimationFrame: g.cancelAnimationFrame,
		performanceNow: performance.now,
	};

	let now = 0;
	let nextId = 1;
	const timers = new Map<number, { at: number; fn: TimerFn }>();
	const frames = new Map<number, TimerFn>();
	const counts = {
		setTimeout: 0,
		clearTimeout: 0,
		requestAnimationFrame: 0,
		cancelAnimationFrame: 0,
	};

	g.setTimeout = ((fn: TimerFn, delay = 0) => {
		counts.setTimeout += 1;
		const id = nextId++;
		timers.set(id, { at: now + Math.max(0, delay), fn });
		return id;
	}) as unknown;
	g.clearTimeout = ((id: number) => {
		counts.clearTimeout += 1;
		timers.delete(id);
	}) as unknown;
	g.requestAnimationFrame = ((fn: TimerFn) => {
		counts.requestAnimationFrame += 1;
		const id = nextId++;
		frames.set(id, fn);
		return id;
	}) as unknown;
	g.cancelAnimationFrame = ((id: number) => {
		counts.cancelAnimationFrame += 1;
		frames.delete(id);
	}) as unknown;
	performance.now = () => now;

	async function flushMicrotasks() {
		for (let i = 0; i < 20; i += 1) await Promise.resolve();
	}

	async function advance(ms: number) {
		const target = now + ms;
		for (;;) {
			const due = [...timers.entries()]
				.filter(([, t]) => t.at <= target)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			now = Math.max(now, due[1].at);
			timers.delete(due[0]);
			due[1].fn();
			await flushMicrotasks();
			// Frames fire right after the timers that requested them.
			for (const [id, fn] of [...frames]) {
				frames.delete(id);
				fn();
				await flushMicrotasks();
			}
		}
		now = target;
		for (const [id, fn] of [...frames]) {
			frames.delete(id);
			fn();
			await flushMicrotasks();
		}
	}

	function restore() {
		g.setTimeout = original.setTimeout;
		g.clearTimeout = original.clearTimeout;
		g.requestAnimationFrame = original.requestAnimationFrame;
		g.cancelAnimationFrame = original.cancelAnimationFrame;
		performance.now = original.performanceNow;
	}

	return { counts, advance, restore, pendingTimers: () => timers.size };
}

test("StreamingMarkdownController does not re-arm timers on every setTarget", async () => {
	const clock = installFakeTimers();
	try {
		const controller = new StreamingMarkdownController();
		const snapshots: string[] = [];
		controller.subscribe((snapshot) => snapshots.push(snapshot.source));

		// Simulate ~30 patches/s for one second while the reveal loop is running.
		let source = "";
		const patches = 30;
		for (let i = 0; i < patches; i += 1) {
			source += `word${i} `;
			controller.setTarget(source);
			await clock.advance(33);
		}

		// Before: every setTarget cleared+re-armed both the text timer and the
		// commit timer (4+ timer ops per patch on top of the reveal ticks).
		// Now the reveal loop is only armed by its own ticks (24ms cadence) and
		// commits are only armed when none is pending (80ms cadence).
		const revealTicks = Math.ceil((patches * 33) / 24) + 1;
		const commitTicks = Math.ceil((patches * 33) / 80) + 1;
		assert.ok(
			clock.counts.setTimeout <= revealTicks + commitTicks + 2,
			`setTimeout called ${clock.counts.setTimeout} times; expected ≤ ${revealTicks + commitTicks + 2}`,
		);
		assert.equal(
			clock.counts.clearTimeout,
			0,
			"steady-state streaming should not clear timers",
		);
		assert.equal(clock.counts.cancelAnimationFrame, 0);

		// Let the reveal loop and the trailing commit drain.
		await clock.advance(1000);
		assert.equal(clock.pendingTimers(), 0, "loop must stop once caught up");
		assert.equal(
			snapshots.at(-1),
			source.trimStart(),
			"final snapshot must show the full target",
		);
		controller.dispose();
	} finally {
		clock.restore();
	}
});

test("StreamingMarkdownController flush renders immediately and drops pending work", async () => {
	const clock = installFakeTimers();
	try {
		const controller = new StreamingMarkdownController();
		const snapshots: string[] = [];
		controller.subscribe((snapshot) => snapshots.push(snapshot.source));

		controller.setTarget("hello streaming world this is a long sentence");
		await clock.advance(10);
		controller.flush("final text");
		await clock.advance(0);

		assert.equal(snapshots.at(-1), "final text");
		await clock.advance(500);
		assert.equal(snapshots.at(-1), "final text");
		assert.equal(clock.pendingTimers(), 0);
		controller.dispose();
	} finally {
		clock.restore();
	}
});

test("StreamingMarkdownController resets when the target diverges", async () => {
	const clock = installFakeTimers();
	try {
		const controller = new StreamingMarkdownController();
		const snapshots: string[] = [];
		controller.subscribe((snapshot) => snapshots.push(snapshot.source));

		controller.setTarget("alpha beta gamma delta");
		await clock.advance(200);
		assert.equal(snapshots.at(-1), "alpha beta gamma delta");

		controller.setTarget("completely different");
		assert.equal(snapshots.at(-1), "", "divergence publishes an empty reset");
		await clock.advance(500);
		assert.equal(snapshots.at(-1), "completely different");
		assert.equal(clock.pendingTimers(), 0);
		controller.dispose();
	} finally {
		clock.restore();
	}
});
