type StreamingMarkdownSnapshot = {
	stableHtml: string;
	tailHtml: string;
	source: string;
};

type StreamingMarkdownSubscriber = (
	snapshot: StreamingMarkdownSnapshot,
) => void;

const STREAM_COMMIT_INTERVAL_MS = 80;
const STREAM_FRAME_MS = 24;
const STREAM_MIN_STEP = 2;
const STREAM_MAX_STEP = 14;
const STREAM_PRESSURE_BACKLOG = 36;

function getVisibleStepSize(remaining: number) {
	const pressure = Math.min(
		1,
		Math.max(0, remaining / STREAM_PRESSURE_BACKLOG),
	);
	return Math.round(
		STREAM_MIN_STEP + (STREAM_MAX_STEP - STREAM_MIN_STEP) * pressure,
	);
}

function isWordBoundary(value: string) {
	return /[\s.,!?;:，。！？；：、）\]}"'`»]/u.test(value);
}

function advanceByWord(source: string, from: number, maxStep: number) {
	const hardTarget = Math.min(source.length, from + maxStep);
	if (hardTarget >= source.length) return source.length;

	let cursor = hardTarget;
	while (cursor < source.length && cursor - from < maxStep + 16) {
		if (isWordBoundary(source[cursor] ?? "")) return cursor + 1;
		cursor += 1;
	}
	return hardTarget;
}

function createEmptySnapshot(): StreamingMarkdownSnapshot {
	return { stableHtml: "", tailHtml: "", source: "" };
}

export class StreamingMarkdownController {
	#targetSource = "";
	#displayedSource = "";
	#snapshot = createEmptySnapshot();
	#subscribers = new Set<StreamingMarkdownSubscriber>();
	#textTimer: ReturnType<typeof setTimeout> | null = null;
	#commitTimer: ReturnType<typeof setTimeout> | null = null;
	#commitRaf = 0;
	#renderSeq = 0;
	#lastCommitAt = 0;
	#disposed = false;

	subscribe(subscriber: StreamingMarkdownSubscriber) {
		this.#subscribers.add(subscriber);
		subscriber(this.#snapshot);
		return () => this.#subscribers.delete(subscriber);
	}

	setTarget(source: string) {
		if (this.#disposed) return;
		const nextSource = source.trimStart();
		if (nextSource === this.#targetSource) return;
		this.#renderSeq += 1;
		if (!nextSource.startsWith(this.#displayedSource)) {
			this.#displayedSource = "";
			this.#publish(createEmptySnapshot());
		}
		this.#targetSource = nextSource;
		this.#scheduleTextAdvance();
	}

	flush(source = this.#targetSource) {
		if (this.#disposed) return;
		this.#renderSeq += 1;
		this.#targetSource = source.trimStart();
		this.#displayedSource = this.#targetSource;
		this.#clearTextTimer();
		this.#scheduleCommit(0);
	}

	dispose() {
		this.#disposed = true;
		this.#clearTextTimer();
		this.#clearCommitTimer();
		this.#subscribers.clear();
	}

	#publish(snapshot: StreamingMarkdownSnapshot) {
		this.#snapshot = snapshot;
		for (const subscriber of this.#subscribers) subscriber(snapshot);
	}

	#clearTextTimer() {
		if (!this.#textTimer) return;
		clearTimeout(this.#textTimer);
		this.#textTimer = null;
	}

	#clearCommitTimer() {
		if (this.#commitTimer) {
			clearTimeout(this.#commitTimer);
			this.#commitTimer = null;
		}
		if (this.#commitRaf) {
			cancelAnimationFrame(this.#commitRaf);
			this.#commitRaf = 0;
		}
	}

	#scheduleTextAdvance() {
		this.#clearTextTimer();
		if (this.#displayedSource === this.#targetSource) {
			this.#scheduleCommit();
			return;
		}

		if (!this.#targetSource.startsWith(this.#displayedSource)) {
			this.#displayedSource = this.#targetSource;
		} else {
			const remaining =
				this.#targetSource.length - this.#displayedSource.length;
			const maxStep = Math.min(remaining, getVisibleStepSize(remaining));
			const nextLength = advanceByWord(
				this.#targetSource,
				this.#displayedSource.length,
				maxStep,
			);
			this.#displayedSource = this.#targetSource.slice(0, nextLength);
		}

		this.#scheduleCommit();
		this.#textTimer = setTimeout(
			() => this.#scheduleTextAdvance(),
			STREAM_FRAME_MS,
		);
	}

	#scheduleCommit(delay?: number) {
		this.#clearCommitTimer();
		const now = performance.now();
		const nextDelay =
			delay ??
			Math.max(0, STREAM_COMMIT_INTERVAL_MS - (now - this.#lastCommitAt));
		this.#commitTimer = setTimeout(() => {
			this.#commitTimer = null;
			this.#commitRaf = requestAnimationFrame(() => {
				this.#commitRaf = 0;
				this.#lastCommitAt = performance.now();
				void this.#commitDisplayedSource();
			});
		}, nextDelay);
	}

	async #commitDisplayedSource() {
		const source = this.#displayedSource;
		const seq = ++this.#renderSeq;
		if (!source.trim()) {
			this.#publish(createEmptySnapshot());
			return;
		}

		try {
			const { renderStreamingMarkdownSplit } = await import("$lib/markdown");
			const { stableHtml, tailHtml } =
				await renderStreamingMarkdownSplit(source);
			if (
				this.#disposed ||
				seq !== this.#renderSeq ||
				source !== this.#displayedSource
			)
				return;
			this.#publish({ stableHtml, tailHtml, source });
		} catch {
			if (
				this.#disposed ||
				seq !== this.#renderSeq ||
				source !== this.#displayedSource
			)
				return;
			this.#publish({ stableHtml: "", tailHtml: "", source });
		}
	}
}
