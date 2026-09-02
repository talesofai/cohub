import {
	APP_SURFACE_READY_TIMEOUT_MS,
	APP_SURFACE_REQUEST_TIMEOUT_MS,
	type AppComposerChip,
} from "@cohub/protocol/app-surface";
import type { AppDetailResponse } from "@neta-art/cohub";
import { appDisplayTitle } from "$lib/app-page-meta";
import { isNewerAppSnapshot } from "$lib/features/app/app-realtime";
import { createRequestDedupe } from "./request-dedupe";
import {
	createWorkspaceAppInvocation,
	type WorkspaceAppInvocation,
	type WorkspaceAppOpenContext,
} from "./workspace-app-context";

export type AppLaunchState = { search?: string; hash?: string };

export type InlineAppPreview = {
	appId: string;
	mountKey: number;
	label: string;
	detail: AppDetailResponse | null;
	loading: boolean;
	error: string | null;
	refreshError: string | null;
	launch: AppLaunchState | null;
	invocation: WorkspaceAppInvocation;
	composerChip: AppComposerChip | null;
};

export type AppSurfaceInvoker = (input: {
	method: string;
	input?: unknown;
	commandId: string;
	invocation: WorkspaceAppInvocation;
	readyTimeoutMs?: number;
	requestTimeoutMs?: number;
}) => Promise<
	{ ok: true; result?: unknown } | { ok: false; code: string; message: string }
>;

type AppPreviewControllerOptions = {
	getSpaceId: () => string;
	onOpenPanel?: () => void;
	onClosePanel?: () => void;
	/** A tab actually went away, so a coordinator can re-derive the active ref. */
	onAppClosed?: (appId: string) => void;
	loadApp?: (appId: string) => Promise<AppDetailResponse>;
	loadPublicApp?: (appId: string) => Promise<AppDetailResponse>;
};

function invocationContextsEqual(
	left: WorkspaceAppInvocation,
	right: WorkspaceAppInvocation,
) {
	return (
		left?.surface === right?.surface &&
		left?.source === right?.source &&
		left?.spaceId === right?.spaceId &&
		left?.sessionId === right?.sessionId &&
		left?.turnId === right?.turnId &&
		left?.toolCallId === right?.toolCallId
	);
}

export function createAppPreviewController(
	options: AppPreviewControllerOptions,
) {
	let previews = $state<InlineAppPreview[]>([]);
	let activeAppId = $state<string | null>(null);
	let nextMountKey = 0;
	const requests = createRequestDedupe();
	const invokers = new Map<string, AppSurfaceInvoker>();
	const detailSettled = new Map<string, Promise<void>>();
	const loadTokens = new Map<string, number>();

	const loadApp =
		options.loadApp ??
		(async (appId: string) => (await import("$lib/sdk")).sdk.apps.get(appId));
	const loadPublicApp =
		options.loadPublicApp ??
		(async (appId: string) =>
			(await import("$lib/sdk")).sdk.apps.getPublicById(appId));

	/**
	 * A public App in a Space we cannot view is still previewable, and
	 * desktop commands accept public references, so a denied member read falls
	 * back to the public one rather than showing a permission error.
	 */
	async function loadDetailFor(appId: string): Promise<AppDetailResponse> {
		try {
			return await loadApp(appId);
		} catch (cause) {
			// Read structurally: importing the SDK error class here would pull the
			// client into this module, which the lazy import above avoids.
			const status = (cause as { status?: unknown } | null)?.status;
			if (status !== 401 && status !== 403) throw cause;
			return await loadPublicApp(appId);
		}
	}

	function patch(appId: string, next: Partial<InlineAppPreview>) {
		previews = previews.map((item) =>
			item.appId === appId ? { ...item, ...next } : item,
		);
	}

	async function loadDetail(
		appId: string,
		loadOptions: { force?: boolean; remount?: boolean } = {},
	) {
		const requestSpaceId = options.getSpaceId();
		const token = (loadTokens.get(appId) ?? 0) + 1;
		loadTokens.set(appId, token);
		patch(appId, { loading: true, error: null, refreshError: null });
		const settle = (async () => {
			try {
				const detail = await requests.run(
					`app:${appId}`,
					() => loadDetailFor(appId),
					{ force: loadOptions.force },
				);
				const current = previews.find((item) => item.appId === appId);
				if (
					options.getSpaceId() !== requestSpaceId ||
					loadTokens.get(appId) !== token ||
					!current
				)
					return;
				const changed = isNewerAppSnapshot(
					current.detail?.app ?? null,
					detail.app,
				);
				if (current.detail && !changed) {
					patch(appId, { loading: false, refreshError: null });
					return;
				}
				patch(appId, {
					detail,
					loading: false,
					error: null,
					refreshError: null,
					label: appDisplayTitle(detail.app.meta, detail.app.slug),
					...(loadOptions.remount && changed
						? { mountKey: ++nextMountKey }
						: {}),
				});
			} catch (cause) {
				if (
					options.getSpaceId() !== requestSpaceId ||
					loadTokens.get(appId) !== token
				)
					return;
				const current = previews.find((item) => item.appId === appId);
				if (current?.detail) {
					patch(appId, {
						loading: false,
						refreshError:
							cause instanceof Error
								? cause.message
								: "Failed to refresh this App.",
					});
					return;
				}
				patch(appId, {
					loading: false,
					error:
						cause instanceof Error ? cause.message : "Failed to load this App.",
				});
			}
		})();
		detailSettled.set(appId, settle);
		await settle;
	}

	function openApp(input: {
		appId: string;
		label?: string;
		launch?: AppLaunchState | null;
		openContext: WorkspaceAppOpenContext;
	}) {
		const invocation = createWorkspaceAppInvocation(
			options.getSpaceId(),
			input.openContext,
		);
		const existing = previews.find((item) => item.appId === input.appId);
		if (existing) {
			const launch = input.launch ?? null;
			const launchChanged =
				input.launch !== undefined &&
				((existing.launch?.search ?? "") !== (launch?.search ?? "") ||
					(existing.launch?.hash ?? "") !== (launch?.hash ?? ""));
			const invocationChanged = !invocationContextsEqual(
				existing.invocation,
				invocation,
			);
			if (launchChanged || invocationChanged) {
				patch(input.appId, {
					...(launchChanged ? { launch } : {}),
					invocation,
				});
			}
			activeAppId = input.appId;
			options.onOpenPanel?.();
			if (!existing.detail && !existing.loading) void loadDetail(input.appId);
			return;
		}
		previews = [
			...previews,
			{
				appId: input.appId,
				mountKey: ++nextMountKey,
				label: input.label?.trim() || "App",
				detail: null,
				loading: true,
				error: null,
				launch: input.launch ?? null,
				invocation,
				composerChip: null,
				refreshError: null,
			},
		];
		activeAppId = input.appId;
		options.onOpenPanel?.();
		void loadDetail(input.appId);
	}

	function activateApp(appId: string) {
		if (!previews.some((item) => item.appId === appId)) return;
		activeAppId = appId;
		options.onOpenPanel?.();
	}

	function closeApp(appId = activeAppId) {
		if (!appId) return;
		const index = previews.findIndex((item) => item.appId === appId);
		if (index < 0) return;
		const nextPreviews = previews.filter((item) => item.appId !== appId);
		previews = nextPreviews;
		invokers.delete(appId);
		detailSettled.delete(appId);
		if (activeAppId === appId) {
			activeAppId =
				nextPreviews[Math.max(0, index - 1)]?.appId ??
				nextPreviews[0]?.appId ??
				null;
		}
		if (nextPreviews.length === 0) options.onClosePanel?.();
		options.onAppClosed?.(appId);
	}

	function closeAll() {
		for (const item of [...previews]) closeApp(item.appId);
	}

	function retry(appId: string) {
		if (!previews.some((item) => item.appId === appId)) return;
		void loadDetail(appId, { force: true, remount: true });
	}

	function refreshIfOpen(appId: string) {
		if (!previews.some((item) => item.appId === appId)) return;
		void loadDetail(appId, { force: true, remount: true });
	}

	function setComposerChip(appId: string, chip: AppComposerChip | null) {
		if (!previews.some((item) => item.appId === appId)) return;
		patch(appId, { composerChip: chip });
	}

	function registerSurface(appId: string, invoker: AppSurfaceInvoker) {
		invokers.set(appId, invoker);
		return () => {
			if (invokers.get(appId) === invoker) invokers.delete(appId);
		};
	}

	const EMBEDDED_KINDS = new Set(["web", "port"]);
	const INVOKER_WAIT_MS = 5_000;
	const INVOKER_POLL_MS = 50;

	async function waitForInvoker(appId: string) {
		const deadline = Date.now() + INVOKER_WAIT_MS;
		while (Date.now() < deadline) {
			const invoker = invokers.get(appId);
			if (invoker) return invoker;
			if (!previews.some((item) => item.appId === appId)) return null;
			await new Promise((resolve) => setTimeout(resolve, INVOKER_POLL_MS));
		}
		return invokers.get(appId) ?? null;
	}

	async function callSurface(input: {
		appId: string;
		method: string;
		input?: unknown;
		commandId: string;
	}) {
		if (!previews.some((item) => item.appId === input.appId)) {
			return {
				ok: false as const,
				code: "preview_not_open",
				message: "The App preview is not open.",
			};
		}
		// A call right after showing races the fetch and the iframe mount.
		await detailSettled.get(input.appId);
		const preview = previews.find((item) => item.appId === input.appId);
		if (!preview) {
			return {
				ok: false as const,
				code: "preview_not_open",
				message: "The App preview was closed before the call ran.",
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
				message: "This App has no published content to call into.",
			};
		}
		if (!EMBEDDED_KINDS.has(kind)) {
			return {
				ok: false as const,
				code: "surface_not_supported",
				message: `A ${kind} App renders natively and exposes no callable methods.`,
			};
		}

		const invoker = await waitForInvoker(input.appId);
		if (!invoker) {
			return {
				ok: false as const,
				code: "surface_unavailable",
				message: "The App surface did not mount.",
			};
		}
		return invoker({
			method: input.method,
			input: input.input,
			commandId: input.commandId,
			invocation: preview.invocation,
			readyTimeoutMs: APP_SURFACE_READY_TIMEOUT_MS,
			requestTimeoutMs: APP_SURFACE_REQUEST_TIMEOUT_MS,
		});
	}

	function dispose() {
		requests.clear();
		invokers.clear();
		detailSettled.clear();
		loadTokens.clear();
	}

	return {
		get previews() {
			return previews;
		},
		get preview() {
			return previews.find((item) => item.appId === activeAppId) ?? null;
		},
		get activeAppId() {
			return activeAppId;
		},
		openApp,
		activateApp,
		closeApp,
		closeAll,
		retry,
		refreshIfOpen,
		registerSurface,
		setComposerChip,
		callSurface,
		dispose,
	};
}

export type AppPreviewController = ReturnType<
	typeof createAppPreviewController
>;
