import {
	buildWorkSurfaceRequest,
	parseWorkComposerChipClear,
	parseWorkComposerChipSet,
	parseWorkSurfaceReady,
	parseWorkSurfaceResponse,
	WORK_SURFACE_READY_TIMEOUT_MS,
	WORK_SURFACE_REQUEST_TIMEOUT_MS,
	type WorkComposerChip,
} from "@cohub/protocol/work-surface";

export type WorkSurfaceCallResult =
	| { ok: true }
	| { ok: false; code: string; message: string };

export type WorkSurfaceHostConfig = {
	getFrame: () => HTMLIFrameElement | null;
	getFrameOrigin: () => string | null;
	onComposerChip?: (chip: WorkComposerChip | null) => void;
};

export type WorkSurfaceHost = {
	readonly methods: string[];
	readonly ready: boolean;
	handleMessage: (event: MessageEvent) => boolean;
	call: (input: {
		method: string;
		input?: unknown;
		commandId: string;
		readyTimeoutMs?: number;
		requestTimeoutMs?: number;
	}) => Promise<WorkSurfaceCallResult>;
	reset: () => void;
	dispose: () => void;
};

export function createWorkSurfaceHost(
	config: WorkSurfaceHostConfig,
): WorkSurfaceHost {
	let ready = false;
	let methods: string[] = [];
	let composerChip: WorkComposerChip | null = null;
	const pending = new Map<string, (result: WorkSurfaceCallResult) => void>();
	let readyWaiters: Array<(becameReady: boolean) => void> = [];
	let epoch = 0;

	function isFromSurface(event: MessageEvent) {
		const frame = config.getFrame();
		if (!frame || event.source !== frame.contentWindow) return false;
		const origin = config.getFrameOrigin();
		return Boolean(origin) && event.origin === origin;
	}

	function flushReadyWaiters(becameReady: boolean) {
		const waiters = readyWaiters;
		readyWaiters = [];
		for (const settle of waiters) settle(becameReady);
	}

	function markReady(nextMethods: string[]) {
		ready = true;
		methods = nextMethods;
		flushReadyWaiters(true);
	}

	function handleMessage(event: MessageEvent): boolean {
		if (!isFromSurface(event)) return false;

		const readyMessage = parseWorkSurfaceReady(event.data);
		if (readyMessage) {
			markReady(readyMessage.methods);
			return true;
		}

		const chipSet = parseWorkComposerChipSet(event.data);
		if (chipSet) {
			composerChip = chipSet.chip;
			config.onComposerChip?.(composerChip);
			return true;
		}

		const chipClear = parseWorkComposerChipClear(event.data);
		if (chipClear) {
			if (composerChip?.key === chipClear.key) {
				composerChip = null;
				config.onComposerChip?.(null);
			}
			return true;
		}

		const response = parseWorkSurfaceResponse(event.data);
		if (!response) return false;
		const settle = pending.get(response.requestId);
		if (!settle) return true;
		pending.delete(response.requestId);
		settle(
			response.ok
				? { ok: true }
				: {
						ok: false,
						code: response.error?.code ?? "surface_error",
						message: response.error?.message ?? "Work surface call failed",
					},
		);
		return true;
	}

	function waitForReady(timeoutMs: number): Promise<boolean> {
		if (ready) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				readyWaiters = readyWaiters.filter((waiter) => waiter !== onReady);
				resolve(false);
			}, timeoutMs);
			const onReady = (becameReady: boolean) => {
				clearTimeout(timer);
				resolve(becameReady);
			};
			readyWaiters.push(onReady);
		});
	}

	async function call(input: {
		method: string;
		input?: unknown;
		commandId: string;
		readyTimeoutMs?: number;
		requestTimeoutMs?: number;
	}): Promise<WorkSurfaceCallResult> {
		const frame = config.getFrame();
		const origin = config.getFrameOrigin();
		if (!frame?.contentWindow || !origin) {
			return {
				ok: false,
				code: "surface_unavailable",
				message: "The Work surface is not mounted.",
			};
		}

		const callEpoch = epoch;
		const becameReady = await waitForReady(
			input.readyTimeoutMs ?? WORK_SURFACE_READY_TIMEOUT_MS,
		);
		if (callEpoch !== epoch) {
			return {
				ok: false,
				code: "surface_reset",
				message: "The Work surface reloaded before answering.",
			};
		}
		if (!becameReady) {
			return {
				ok: false,
				code: "surface_not_ready",
				message:
					"This Work did not register any callable methods. Use client.work.surface.handle() inside the Work.",
			};
		}
		if (methods.length > 0 && !methods.includes(input.method)) {
			return {
				ok: false,
				code: "method_not_found",
				message: `This Work exposes: ${methods.join(", ")}.`,
			};
		}

		const requestId =
			globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
		const timeoutMs = input.requestTimeoutMs ?? WORK_SURFACE_REQUEST_TIMEOUT_MS;
		return new Promise<WorkSurfaceCallResult>((resolve) => {
			const timer = setTimeout(() => {
				pending.delete(requestId);
				resolve({
					ok: false,
					code: "surface_timeout",
					message: `The Work did not answer "${input.method}" in time.`,
				});
			}, timeoutMs);
			pending.set(requestId, (result) => {
				clearTimeout(timer);
				resolve(result);
			});
			try {
				frame.contentWindow?.postMessage(
					buildWorkSurfaceRequest({
						requestId,
						method: input.method,
						...(input.input === undefined ? {} : { input: input.input }),
						commandId: input.commandId,
					}),
					origin,
				);
			} catch (error) {
				clearTimeout(timer);
				pending.delete(requestId);
				resolve({
					ok: false,
					code: "surface_unavailable",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		});
	}

	function reset() {
		epoch += 1;
		ready = false;
		methods = [];
		if (composerChip) {
			composerChip = null;
			config.onComposerChip?.(null);
		}
		for (const settle of pending.values()) {
			settle({
				ok: false,
				code: "surface_reset",
				message: "The Work surface reloaded before answering.",
			});
		}
		pending.clear();
		flushReadyWaiters(false);
	}

	return {
		get methods() {
			return methods;
		},
		get ready() {
			return ready;
		},
		handleMessage,
		call,
		reset,
		dispose: reset,
	};
}
