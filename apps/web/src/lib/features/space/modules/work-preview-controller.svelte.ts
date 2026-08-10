import {
	WORK_SURFACE_READY_TIMEOUT_MS,
	WORK_SURFACE_REQUEST_TIMEOUT_MS,
	type WorkComposerChip,
} from "@cohub/protocol/work-surface";
import type { WorkDetailResponse } from "@neta-art/cohub";
import { workDisplayTitle } from "$lib/work-page-meta";
import { createRequestDedupe } from "./request-dedupe";

export type WorkPreviewLaunchState = { search?: string; hash?: string };

export type InlineWorkPreview = {
	workId: string;
	mountKey: number;
	label: string;
	detail: WorkDetailResponse | null;
	loading: boolean;
	error: string | null;
	launch: WorkPreviewLaunchState | null;
	composerChip: WorkComposerChip | null;
};

export type WorkSurfaceInvoker = (input: {
	method: string;
	input?: unknown;
	commandId: string;
	readyTimeoutMs?: number;
	requestTimeoutMs?: number;
}) => Promise<
	{ ok: true; result?: unknown } | { ok: false; code: string; message: string }
>;

type WorkPreviewControllerOptions = {
	getSpaceId: () => string;
	onOpenPanel?: () => void;
	onClosePanel?: () => void;
	loadWork?: (workId: string) => Promise<WorkDetailResponse>;
	loadPublicWork?: (workId: string) => Promise<WorkDetailResponse>;
};

export function createWorkPreviewController(
	options: WorkPreviewControllerOptions,
) {
	let previews = $state<InlineWorkPreview[]>([]);
	let activeWorkId = $state<string | null>(null);
	let nextMountKey = 0;
	const requests = createRequestDedupe();
	const invokers = new Map<string, WorkSurfaceInvoker>();
	const detailSettled = new Map<string, Promise<void>>();

	const loadWork =
		options.loadWork ??
		(async (workId: string) =>
			(await import("$lib/sdk")).sdk.works.get(workId));
	const loadPublicWork =
		options.loadPublicWork ??
		(async (workId: string) =>
			(await import("$lib/sdk")).sdk.works.getPublicById(workId));

	/**
	 * A public Work in a Space we cannot view is still previewable, and
	 * `cohub ui preview` accepts public references, so a denied member read falls
	 * back to the public one rather than showing a permission error.
	 */
	async function loadDetailFor(workId: string): Promise<WorkDetailResponse> {
		try {
			return await loadWork(workId);
		} catch (cause) {
			// Read structurally: importing the SDK error class here would pull the
			// client into this module, which the lazy import above avoids.
			const status = (cause as { status?: unknown } | null)?.status;
			if (status !== 401 && status !== 403) throw cause;
			return await loadPublicWork(workId);
		}
	}

	function patch(workId: string, next: Partial<InlineWorkPreview>) {
		previews = previews.map((item) =>
			item.workId === workId ? { ...item, ...next } : item,
		);
	}

	async function loadDetail(workId: string) {
		const requestSpaceId = options.getSpaceId();
		patch(workId, { loading: true, error: null });
		const settle = (async () => {
			try {
				const detail = await requests.run(`work:${workId}`, () =>
					loadDetailFor(workId),
				);
				if (options.getSpaceId() !== requestSpaceId) return;
				if (!previews.some((item) => item.workId === workId)) return;
				patch(workId, {
					detail,
					loading: false,
					error: null,
					label: workDisplayTitle(detail.work.meta, detail.work.slug),
				});
			} catch (cause) {
				if (options.getSpaceId() !== requestSpaceId) return;
				patch(workId, {
					loading: false,
					error:
						cause instanceof Error
							? cause.message
							: "Failed to load this Work.",
				});
			}
		})();
		detailSettled.set(workId, settle);
		await settle;
	}

	function openWork(input: {
		workId: string;
		label?: string;
		launch?: WorkPreviewLaunchState | null;
	}) {
		const existing = previews.find((item) => item.workId === input.workId);
		options.onOpenPanel?.();
		if (existing) {
			const launch = input.launch ?? null;
			const launchChanged =
				(existing.launch?.search ?? "") !== (launch?.search ?? "") ||
				(existing.launch?.hash ?? "") !== (launch?.hash ?? "");
			if (launchChanged) patch(input.workId, { launch });
			activeWorkId = input.workId;
			if (!existing.detail && !existing.loading) void loadDetail(input.workId);
			return;
		}
		previews = [
			...previews,
			{
				workId: input.workId,
				mountKey: ++nextMountKey,
				label: input.label?.trim() || "Work",
				detail: null,
				loading: true,
				error: null,
				launch: input.launch ?? null,
				composerChip: null,
			},
		];
		activeWorkId = input.workId;
		void loadDetail(input.workId);
	}

	function activateWork(workId: string) {
		if (!previews.some((item) => item.workId === workId)) return;
		activeWorkId = workId;
		options.onOpenPanel?.();
	}

	function closeWork(workId = activeWorkId) {
		if (!workId) return;
		const index = previews.findIndex((item) => item.workId === workId);
		if (index < 0) return;
		const nextPreviews = previews.filter((item) => item.workId !== workId);
		previews = nextPreviews;
		invokers.delete(workId);
		detailSettled.delete(workId);
		if (activeWorkId === workId) {
			activeWorkId =
				nextPreviews[Math.max(0, index - 1)]?.workId ??
				nextPreviews[0]?.workId ??
				null;
		}
		if (nextPreviews.length === 0) options.onClosePanel?.();
	}

	function closeAll() {
		for (const item of [...previews]) closeWork(item.workId);
	}

	function retry(workId: string) {
		if (!previews.some((item) => item.workId === workId)) return;
		void loadDetail(workId);
	}

	function setComposerChip(workId: string, chip: WorkComposerChip | null) {
		if (!previews.some((item) => item.workId === workId)) return;
		patch(workId, { composerChip: chip });
	}

	function registerSurface(workId: string, invoker: WorkSurfaceInvoker) {
		invokers.set(workId, invoker);
		return () => {
			if (invokers.get(workId) === invoker) invokers.delete(workId);
		};
	}

	const EMBEDDED_KINDS = new Set(["web", "port"]);
	const INVOKER_WAIT_MS = 5_000;
	const INVOKER_POLL_MS = 50;

	async function waitForInvoker(workId: string) {
		const deadline = Date.now() + INVOKER_WAIT_MS;
		while (Date.now() < deadline) {
			const invoker = invokers.get(workId);
			if (invoker) return invoker;
			if (!previews.some((item) => item.workId === workId)) return null;
			await new Promise((resolve) => setTimeout(resolve, INVOKER_POLL_MS));
		}
		return invokers.get(workId) ?? null;
	}

	async function callSurface(input: {
		workId: string;
		method: string;
		input?: unknown;
		commandId: string;
	}) {
		if (!previews.some((item) => item.workId === input.workId)) {
			return {
				ok: false as const,
				code: "preview_not_open",
				message: "The Work preview is not open.",
			};
		}
		// A call right after showing races the fetch and the iframe mount.
		await detailSettled.get(input.workId);
		const preview = previews.find((item) => item.workId === input.workId);
		if (!preview) {
			return {
				ok: false as const,
				code: "preview_not_open",
				message: "The Work preview was closed before the call ran.",
			};
		}
		if (preview.error) {
			return {
				ok: false as const,
				code: "preview_failed",
				message: preview.error,
			};
		}
		const kind = preview.detail?.content?.kind;
		if (!kind) {
			return {
				ok: false as const,
				code: "surface_not_supported",
				message: "This Work has no published content to call into.",
			};
		}
		if (!EMBEDDED_KINDS.has(kind)) {
			return {
				ok: false as const,
				code: "surface_not_supported",
				message: `A ${kind} Work renders natively and exposes no callable methods.`,
			};
		}

		const invoker = await waitForInvoker(input.workId);
		if (!invoker) {
			return {
				ok: false as const,
				code: "surface_unavailable",
				message: "The Work surface did not mount.",
			};
		}
		return invoker({
			method: input.method,
			input: input.input,
			commandId: input.commandId,
			readyTimeoutMs: WORK_SURFACE_READY_TIMEOUT_MS,
			requestTimeoutMs: WORK_SURFACE_REQUEST_TIMEOUT_MS,
		});
	}

	function dispose() {
		requests.clear();
		invokers.clear();
		detailSettled.clear();
	}

	return {
		get previews() {
			return previews;
		},
		get preview() {
			return previews.find((item) => item.workId === activeWorkId) ?? null;
		},
		get activeWorkId() {
			return activeWorkId;
		},
		openWork,
		activateWork,
		closeWork,
		closeAll,
		retry,
		registerSurface,
		setComposerChip,
		callSurface,
		dispose,
	};
}

export type WorkPreviewController = ReturnType<
	typeof createWorkPreviewController
>;
