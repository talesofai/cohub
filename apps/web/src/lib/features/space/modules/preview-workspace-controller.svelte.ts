import {
	alignPreviewNavigation,
	beginPreviewNavigation,
	createPreviewNavigationState,
	isCurrentPreviewNavigation,
	type PreviewNavigationSource,
	previewRefsEqual,
} from "./preview-navigation";
import type {
	WorkspacePreviewKind,
	WorkspacePreviewRef,
} from "./workspace-preview-route";
import { isValidPortKey } from "./workspace-preview-route";

export type PreviewTabKind = WorkspacePreviewKind;

type FileTabLike = {
	path: string;
	response: unknown;
	draft: string;
};

type BoardTabLike = {
	path: string;
	saving: boolean;
};

type PortTabLike = {
	port: string;
	url: string;
};

type PreviewWorkspaceOptions = {
	getFileTabs: () => FileTabLike[];
	getActiveFilePath: () => string | null;
	getBoardTabs: () => BoardTabLike[];
	getActiveBoardPath: () => string | null;
	getPortTabs: () => PortTabLike[];
	getActivePort: () => string | null;
	openFile: (
		path: string,
		options?: { preserveHistory?: boolean; position?: unknown },
	) => Promise<void>;
	activateFile: (path: string) => void;
	closeFile: (path?: string | null, skipConfirm?: boolean) => void;
	goBackFile: () => Promise<string | null>;
	openBoard: (path: string) => Promise<void>;
	activateBoard: (path: string) => void;
	closeBoard: (path?: string | null) => void;
	openPort: (
		port: string,
		url: string,
		options?: { autoOpened?: boolean },
	) => void;
	activatePort: (port: string) => void;
	closePort: (port?: string | null) => void;
	getPortEndpointUrl: (port: string) => string | null | undefined;
	syncUrl: (ref: WorkspacePreviewRef | null, replace?: boolean) => void;
	onBudgetCleanup?: () => void;
	weightLimit?: number;
};

const DEFAULT_WEIGHT_LIMIT = 16;

function asFileResponse(response: unknown): {
	kind?: string;
	content?: string;
} | null {
	if (!response || typeof response !== "object") return null;
	return response as { kind?: string; content?: string };
}

function isBinaryFileTab(tab: FileTabLike) {
	const response = asFileResponse(tab.response);
	return response?.kind === "binary";
}

function isDirtyFileTab(tab: FileTabLike) {
	const response = asFileResponse(tab.response);
	if (!response || typeof response.content !== "string") return false;
	return tab.draft !== response.content;
}

/**
 * Single active-tab coordinator over file/board/port domain controllers.
 * Owns: active kind, access order, budget, URL sync, open/activate/close.
 * Does not own: file drafts, board docs, port endpoints (domain controllers do).
 */
export function createPreviewWorkspaceController(
	options: PreviewWorkspaceOptions,
) {
	let activeKind = $state<PreviewTabKind | null>(null);
	let accessedAt = $state<Record<string, number>>({});
	let navigation = $state(createPreviewNavigationState());
	const weightLimit = options.weightLimit ?? DEFAULT_WEIGHT_LIMIT;

	function beginNavigation(
		ref: WorkspacePreviewRef | null,
		source: PreviewNavigationSource,
	) {
		navigation = beginPreviewNavigation(navigation, ref, source);
		return navigation.transitionId;
	}

	function tabId(kind: PreviewTabKind, key: string) {
		return `${kind}:${key}`;
	}

	function touch(kind: PreviewTabKind, key: string) {
		accessedAt = { ...accessedAt, [tabId(kind, key)]: Date.now() };
	}

	function currentRef(): WorkspacePreviewRef | null {
		if (activeKind === "file") {
			const path = options.getActiveFilePath();
			return path ? { kind: "file", key: path } : null;
		}
		if (activeKind === "board") {
			const path = options.getActiveBoardPath();
			return path ? { kind: "board", key: path } : null;
		}
		if (activeKind === "port") {
			const port = options.getActivePort();
			return port ? { kind: "port", key: port } : null;
		}
		// Fallback if kind drifted but a surface is still open.
		const filePath = options.getActiveFilePath();
		if (filePath) return { kind: "file", key: filePath };
		const boardPath = options.getActiveBoardPath();
		if (boardPath) return { kind: "board", key: boardPath };
		const port = options.getActivePort();
		if (port) return { kind: "port", key: port };
		return null;
	}

	function resolveKind(): PreviewTabKind | null {
		if (activeKind === "port" && options.getActivePort()) return "port";
		if (activeKind === "board" && options.getActiveBoardPath()) return "board";
		if (activeKind === "file" && options.getActiveFilePath()) return "file";
		if (options.getActiveFilePath()) return "file";
		if (options.getActiveBoardPath()) return "board";
		if (options.getActivePort()) return "port";
		return null;
	}

	function enforceBudget() {
		const candidates = [
			...options.getFileTabs().map((tab) => ({
				kind: "file" as const,
				key: tab.path,
				weight: isBinaryFileTab(tab) ? 2 : 1,
				protected: isDirtyFileTab(tab),
			})),
			...options.getBoardTabs().map((tab) => ({
				kind: "board" as const,
				key: tab.path,
				weight: 2,
				protected: tab.saving,
			})),
			...options.getPortTabs().map((tab) => ({
				kind: "port" as const,
				key: tab.port,
				weight: 3,
				protected: false,
			})),
		];
		let total = candidates.reduce((sum, tab) => sum + tab.weight, 0);
		if (total <= weightLimit) return;
		const removable = candidates
			.filter((tab) => !tab.protected)
			.sort(
				(a, b) =>
					(accessedAt[tabId(a.kind, a.key)] ?? 0) -
					(accessedAt[tabId(b.kind, b.key)] ?? 0),
			);
		let closed = 0;
		for (const tab of removable) {
			if (total <= weightLimit) break;
			if (tab.kind === "file") options.closeFile(tab.key, true);
			else if (tab.kind === "board") options.closeBoard(tab.key);
			else options.closePort(tab.key);
			total -= tab.weight;
			closed += 1;
		}
		if (closed > 0) {
			activeKind = resolveKind();
			const ref = currentRef();
			navigation = alignPreviewNavigation(navigation, ref);
			options.syncUrl(ref, true);
			options.onBudgetCleanup?.();
		}
	}

	async function openFile(
		path: string,
		opts: {
			syncUrl?: boolean;
			preserveHistory?: boolean;
			position?: unknown;
			source?: PreviewNavigationSource;
		} = {},
	) {
		const syncUrl = opts.syncUrl ?? true;
		const hadPreview = Boolean(currentRef());
		const ref = { kind: "file" as const, key: path };
		const transitionId = beginNavigation(
			ref,
			opts.source ?? (syncUrl ? "user" : "route"),
		);
		activeKind = "file";
		touch("file", path);
		// Domain open creates its loading tab synchronously. URL sync follows in
		// the same task, while route reconciliation only observes route changes.
		const pending = options.openFile(path, {
			preserveHistory: opts.preserveHistory,
			position: opts.position,
		});
		if (syncUrl) options.syncUrl(ref, hadPreview);
		await pending;
		enforceBudget();
		if (syncUrl && isCurrentPreviewNavigation(navigation, transitionId)) {
			const current = currentRef();
			if (current) options.syncUrl(current, true);
		}
	}

	async function openBoard(
		path: string,
		opts: {
			syncUrl?: boolean;
			source?: PreviewNavigationSource;
		} = {},
	) {
		const syncUrl = opts.syncUrl ?? true;
		const hadPreview = Boolean(currentRef());
		const ref = { kind: "board" as const, key: path };
		const transitionId = beginNavigation(
			ref,
			opts.source ?? (syncUrl ? "user" : "route"),
		);
		activeKind = "board";
		touch("board", path);
		const pending = options.openBoard(path);
		if (syncUrl) options.syncUrl(ref, hadPreview);
		await pending;
		enforceBudget();
		if (syncUrl && isCurrentPreviewNavigation(navigation, transitionId)) {
			const current = currentRef();
			if (current) options.syncUrl(current, true);
		}
	}

	function openPort(
		port: string,
		url: string,
		opts: {
			autoOpened?: boolean;
			syncUrl?: boolean;
			source?: PreviewNavigationSource;
		} = {},
	) {
		if (!isValidPortKey(port)) return;
		const syncUrl = opts.syncUrl ?? true;
		const hadPreview = Boolean(currentRef());
		const ref = { kind: "port" as const, key: port };
		beginNavigation(ref, opts.source ?? (syncUrl ? "user" : "route"));
		activeKind = "port";
		touch("port", port);
		options.openPort(port, url, { autoOpened: opts.autoOpened });
		if (syncUrl) options.syncUrl(ref, hadPreview);
		enforceBudget();
		if (syncUrl) {
			const current = currentRef();
			if (current) options.syncUrl(current, true);
		}
	}

	function activate(kind: PreviewTabKind, key: string, syncUrl = true) {
		const ref = { kind, key };
		beginNavigation(ref, syncUrl ? "user" : "route");
		activeKind = kind;
		touch(kind, key);
		if (kind === "file") options.activateFile(key);
		else if (kind === "board") options.activateBoard(key);
		else options.activatePort(key);
		if (syncUrl) options.syncUrl(ref, true);
	}

	function close(
		kind: PreviewTabKind,
		key?: string | null,
		skipConfirm = false,
	) {
		if (kind === "file") options.closeFile(key, skipConfirm);
		else if (kind === "board") options.closeBoard(key);
		else options.closePort(key);
		activeKind = resolveKind();
		const ref = currentRef();
		beginNavigation(ref, "user");
		options.syncUrl(ref, true);
	}

	function closeActive() {
		const ref = currentRef();
		if (!ref) return;
		close(ref.kind, ref.key);
	}

	function closeAll(
		opts: { syncUrl?: boolean; source?: PreviewNavigationSource } = {},
	) {
		const syncUrl = opts.syncUrl ?? true;
		beginNavigation(null, opts.source ?? (syncUrl ? "user" : "route"));
		activeKind = null;
		for (const tab of [...options.getFileTabs()]) {
			options.closeFile(tab.path, true);
		}
		for (const tab of [...options.getBoardTabs()]) {
			options.closeBoard(tab.path);
		}
		for (const tab of [...options.getPortTabs()]) {
			options.closePort(tab.port);
		}
		if (syncUrl) options.syncUrl(null, true);
	}

	async function goBackFile() {
		const transitionId = beginNavigation(currentRef(), "user");
		const previous = await options.goBackFile();
		if (!previous || !isCurrentPreviewNavigation(navigation, transitionId))
			return null;
		const ref = { kind: "file" as const, key: previous };
		navigation = alignPreviewNavigation(navigation, ref);
		activeKind = "file";
		touch("file", previous);
		options.syncUrl(ref, true);
		return previous;
	}

	function applyRoute(ref: WorkspacePreviewRef | null) {
		const current = currentRef();
		if (!ref) {
			if (!current && navigation.desiredRef === null)
				return { ok: true as const };
			closeAll({ syncUrl: false, source: "route" });
			return { ok: true as const };
		}
		if (previewRefsEqual(current, ref)) {
			// A shallow-route acknowledgement must not supersede the user transition
			// that produced it; only external route changes begin a new transition.
			if (!previewRefsEqual(navigation.desiredRef, ref))
				beginNavigation(ref, "route");
			activeKind = ref.kind;
			touch(ref.kind, ref.key);
			return { ok: true as const };
		}
		if (ref.kind === "file") {
			void openFile(ref.key, { syncUrl: false, source: "route" });
			return { ok: true as const };
		}
		if (ref.kind === "board") {
			void openBoard(ref.key, { syncUrl: false, source: "route" });
			return { ok: true as const };
		}
		// Port routes wait for a trusted endpoint before activating a surface.
		const url = options.getPortEndpointUrl(ref.key);
		if (!url) {
			beginNavigation(ref, "route");
			return { ok: false as const, reason: "port-endpoint-pending" as const };
		}
		openPort(ref.key, url, { syncUrl: false, source: "route" });
		return { ok: true as const };
	}

	function resetForContext() {
		beginNavigation(null, "restore");
		activeKind = null;
	}

	function syncCurrent() {
		const ref = currentRef();
		beginNavigation(ref, "user");
		options.syncUrl(ref, true);
	}

	return {
		get activeKind() {
			return resolveKind();
		},
		get activeKindState() {
			return activeKind;
		},
		get navigation() {
			return navigation;
		},
		resetForContext,
		syncCurrent,
		currentRef,
		touch,
		openFile,
		openBoard,
		openPort,
		activate,
		close,
		closeActive,
		closeAll,
		goBackFile,
		applyRoute,
		enforceBudget,
	};
}
