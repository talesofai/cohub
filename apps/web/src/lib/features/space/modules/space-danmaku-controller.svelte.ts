// Space danmaku controller — a restrained, lane-based queue for floating
// other users' messages across the workspace.
//
// Design goals:
//   - Zero footprint when idle (the layer unmounts when items is empty).
//   - Bounded concurrency + per-user throttle + dedup, so bursts never flood.
//   - Pure CSS animation (GPU transform), no layout thrash.
//
// Data source: `session.turn.created` realtime events (user messages only),
// already filtered to "other users" + "not the active session" by the caller.

export type DanmakuItem = {
	id: string;
	text: string;
	sessionId: string;
	sequence: number;
	userUuid: string;
	authorName: string;
	avatarUrl: string | null;
	createdAt: string;
	source: "live" | "catchup";
	lane: number;
	durationMs: number;
};

export type DanmakuPushInput = {
	id: string;
	text: string;
	sessionId: string;
	sequence: number;
	userUuid: string;
	authorName: string;
	avatarUrl: string | null;
	createdAt: string;
	source: "live" | "catchup";
};

// ─── Tuning ──────────────────────────────────────────────────────────
// Keep the workspace lively without allowing bursts to become visual noise.
const DESKTOP_LANES = 10;
const MOBILE_LANES = 3;
const DESKTOP_DURATION_MS = 7500;
const MOBILE_DURATION_MS = 7000;
const DESKTOP_MAX_VISIBLE = 14;
const MOBILE_MAX_VISIBLE = 5;
const THROTTLE_MS = 1500; // min gap between shown items per user
const LANE_GAP_MS = 250; // extra spacing before reusing a lane
const DESKTOP_CATCHUP_GAP_MS = 450;
const MOBILE_CATCHUP_GAP_MS = 850;
const CATCHUP_RETRY_MS = 180;
const TEXT_LIMIT = 120;
const DEDUP_MAX = 256;
const CHAR_PX = 9; // rough avg glyph width for lane timing estimation
const AVATAR_PX = 64; // avatar + horizontal padding estimate

function isMobileViewport(): boolean {
	return (
		typeof window !== "undefined" &&
		window.matchMedia("(max-width: 640px)").matches
	);
}

function viewportWidth(): number {
	return (typeof window !== "undefined" ? window.innerWidth : 0) || 1200;
}

function estimateItemWidth(text: string): number {
	return Math.min(text.length, TEXT_LIMIT) * CHAR_PX + AVATAR_PX;
}

function truncate(text: string): string {
	const trimmed = text.replace(/\s+/g, " ").trim();
	if (!trimmed) return "";
	return trimmed.length > TEXT_LIMIT
		? `${trimmed.slice(0, TEXT_LIMIT)}…`
		: trimmed;
}

/**
 * Extract a short, human-readable preview from a `session.turn.created`
 * turn payload. Falls back to neutral labels for non-text content so the
 * danmaku never shows raw URLs or empty pills.
 */
export function extractDanmakuText(turn: unknown): string {
	if (!turn || typeof turn !== "object") return "";
	const t = turn as { userText?: unknown; userContent?: unknown };

	const content = Array.isArray(t.userContent) ? t.userContent : null;
	if (content) {
		const textBlock = content.find(
			(b): b is { type: "text"; text: string } =>
				!!b &&
				typeof b === "object" &&
				(b as { type?: unknown }).type === "text",
		);
		if (
			textBlock &&
			typeof textBlock.text === "string" &&
			textBlock.text.trim()
		) {
			return textBlock.text.trim();
		}
		const typeOf = (b: unknown) =>
			!!b && typeof b === "object" && (b as { type?: unknown }).type;
		if (content.some((b) => typeOf(b) === "image")) return "Sent an image";
		if (content.some((b) => typeOf(b) === "shell_command"))
			return "Sent a command";
	}

	const text = typeof t.userText === "string" ? t.userText.trim() : "";
	if (!text) return "";
	// A bare URL with no surrounding text is usually a media/link attachment.
	if (/^https?:\/\/\S+$/.test(text)) return "Sent a link";
	return text;
}

export function createSpaceDanmakuController() {
	let items = $state<DanmakuItem[]>([]);
	const laneNextAvailable = Array.from(
		{ length: Math.max(DESKTOP_LANES, MOBILE_LANES) },
		() => 0,
	);
	const lastShownPerUser = new Map<string, number>();
	const seenIds: string[] = [];
	const seenSet = new Set<string>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	let catchupQueue: DanmakuPushInput[] = [];
	let catchupTimer: ReturnType<typeof setTimeout> | null = null;

	function dismiss(id: string) {
		items = items.filter((it) => it.id !== id);
		timers.delete(id);
	}

	function clear() {
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
		if (catchupTimer) clearTimeout(catchupTimer);
		catchupTimer = null;
		catchupQueue = [];
		items = [];
	}

	function reserveSeen(id: string) {
		if (seenSet.has(id)) return false;
		seenSet.add(id);
		seenIds.push(id);
		if (seenIds.length > DEDUP_MAX) {
			const oldest = seenIds.shift();
			if (oldest) seenSet.delete(oldest);
		}
		return true;
	}

	function tryShow(
		input: DanmakuPushInput,
		options: { throttle: boolean },
	): "shown" | "busy" | "dropped" {
		const text = truncate(input.text);
		if (!text) return "dropped";

		const now = Date.now();
		const lastShown = lastShownPerUser.get(input.userUuid) ?? 0;
		if (options.throttle && now - lastShown < THROTTLE_MS) return "dropped";

		const mobile = isMobileViewport();
		const maxVisible = mobile ? MOBILE_MAX_VISIBLE : DESKTOP_MAX_VISIBLE;
		if (items.length >= maxVisible) return "busy";
		const laneCount = mobile ? MOBILE_LANES : DESKTOP_LANES;
		const duration = mobile ? MOBILE_DURATION_MS : DESKTOP_DURATION_MS;
		let bestLane = 0;
		let bestTime = laneNextAvailable[0];
		for (let i = 1; i < laneCount; i++) {
			if (laneNextAvailable[i] < bestTime) {
				bestTime = laneNextAvailable[i];
				bestLane = i;
			}
		}
		if (bestTime > now) return "busy";

		const width = viewportWidth();
		const itemWidth = estimateItemWidth(text);
		const speed = (width + itemWidth) / duration;
		const enterTime = itemWidth / speed;
		laneNextAvailable[bestLane] = now + enterTime + LANE_GAP_MS;
		lastShownPerUser.set(input.userUuid, now);

		items = [
			...items,
			{
				...input,
				text,
				lane: bestLane,
				durationMs: duration,
			},
		];
		const timer = setTimeout(() => dismiss(input.id), duration + 200);
		timers.set(input.id, timer);
		return "shown";
	}

	function push(input: DanmakuPushInput) {
		if (!reserveSeen(input.id)) return false;
		return tryShow(input, { throttle: true }) === "shown";
	}

	function scheduleCatchup(delayMs = 0) {
		if (catchupTimer || catchupQueue.length === 0) return;
		catchupTimer = setTimeout(() => {
			catchupTimer = null;
			const next = catchupQueue[0];
			if (!next) return;
			const result = tryShow(next, { throttle: false });
			if (result !== "busy") catchupQueue = catchupQueue.slice(1);
			const gapMs = isMobileViewport()
				? MOBILE_CATCHUP_GAP_MS
				: DESKTOP_CATCHUP_GAP_MS;
			scheduleCatchup(result === "shown" ? gapMs : CATCHUP_RETRY_MS);
		}, delayMs);
	}

	function enqueueCatchup(inputs: DanmakuPushInput[]) {
		const acceptedIds: string[] = [];
		for (const input of inputs) {
			if (input.source !== "catchup" || !truncate(input.text)) continue;
			if (!reserveSeen(input.id)) continue;
			catchupQueue.push(input);
			acceptedIds.push(input.id);
		}
		scheduleCatchup();
		return acceptedIds;
	}

	function dispose() {
		clear();
		seenSet.clear();
		seenIds.length = 0;
		lastShownPerUser.clear();
		laneNextAvailable.fill(0);
	}

	return {
		get items() {
			return items;
		},
		push,
		enqueueCatchup,
		clear,
		dispose,
	};
}

export type SpaceDanmakuController = ReturnType<
	typeof createSpaceDanmakuController
>;
