import { tick } from "svelte";
import { DESKTOP_SHELL_MIN_WIDTH_PX } from "$lib/layout/breakpoints";
import {
	uiState,
	WORKSPACE_PREVIEW_DEFAULT_WIDTH,
	WORKSPACE_PREVIEW_MIN_WIDTH,
	type WorkspaceLayoutSnapshot,
	type WorkspacePresentation,
} from "$lib/stores/ui.svelte";
import {
	filesChromeEffectivelyHidden,
	nextTreeSnapshot,
	resolveFilesChromeToggle,
} from "./float-layout";

const MAIN_PANEL_MIN_WIDTH = 320;
const PREVIEW_PANEL_MIN_WIDTH = WORKSPACE_PREVIEW_MIN_WIDTH;
const PREVIEW_PANEL_DEFAULT_WIDTH = WORKSPACE_PREVIEW_DEFAULT_WIDTH;

export type { WorkspacePresentation };
export type MobileSurface = "main" | "files" | "preview";

function snapshotPreviewWidth(snapshot: WorkspaceLayoutSnapshot | null) {
	if (!snapshot) return PREVIEW_PANEL_DEFAULT_WIDTH;
	return Number.isFinite(snapshot.previewWidth) && snapshot.previewWidth > 0
		? snapshot.previewWidth
		: PREVIEW_PANEL_DEFAULT_WIDTH;
}

export function createWorkspaceLayoutController(options: {
	getIsCompact: () => boolean;
	getWorkspaceBodyEl: () => HTMLDivElement | null;
	getMainPanelWidth: () => number | null;
	getFilesAvailable: () => boolean;
	getHasPreview: () => boolean;
}) {
	let previewWidth = $state(PREVIEW_PANEL_DEFAULT_WIDTH);
	let mobileSurface = $state<MobileSurface>("main");
	let immersiveMainVisible = $state(true);
	let resizeCleanup: (() => void) | null = null;
	/** Last space id applied via syncFromPrefs (detect space switches). */
	let syncedSpaceId: string | null = null;

	const presentation = $derived(uiState.workspacePresentation);

	const treeVisible = $derived(
		options.getFilesAvailable() && !uiState.rightSidebarCollapsed,
	);

	function getTreeReservedWidth() {
		if (!treeVisible) return 0;
		return uiState.rightSidebarWidth;
	}

	function getMaxPreviewWidth() {
		if (typeof window === "undefined") return previewWidth;
		const layoutWidth =
			options.getWorkspaceBodyEl()?.clientWidth ?? window.innerWidth;
		return Math.max(
			PREVIEW_PANEL_MIN_WIDTH,
			layoutWidth - MAIN_PANEL_MIN_WIDTH - getTreeReservedWidth(),
		);
	}

	function clampPreviewWidth(nextWidth: number) {
		return Math.min(
			Math.max(PREVIEW_PANEL_MIN_WIDTH, nextWidth),
			getMaxPreviewWidth(),
		);
	}

	function getPreviewPaneEls(): HTMLElement[] {
		const body = options.getWorkspaceBodyEl();
		if (!body) return [];
		return Array.from(
			body.querySelectorAll<HTMLElement>(".workspace-preview-pane"),
		);
	}

	/** Live paint without touching Svelte state (avoids iframe remounts). */
	function paintPreviewWidth(nextWidth: number) {
		const px = `${nextWidth}px`;
		for (const pane of getPreviewPaneEls()) {
			// Prefer the same CSS variable the pane already uses so layout stays
			// consistent with focus/immersive modes.
			pane.style.setProperty("--workspace-preview-width", px);
		}
	}

	function setPreviewWidth(
		nextWidth: number,
		setOptions: {
			persistPreference?: boolean;
			persistSnapshot?: boolean;
		} = {},
	) {
		const clamped = clampPreviewWidth(nextWidth);
		if (setOptions.persistPreference) {
			uiState.setWorkspacePreviewWidth(clamped);
		}
		if (previewWidth === clamped) {
			// Drag may have painted a temporary width; snap CSS back to state.
			paintPreviewWidth(clamped);
			if (setOptions.persistSnapshot && uiState.workspaceLayoutSnapshot) {
				uiState.setWorkspaceLayoutSnapshot({
					...uiState.workspaceLayoutSnapshot,
					previewWidth: clamped,
				});
			}
			return;
		}
		// Paint first so the next Svelte style binding update lands on the same
		// value without a one-frame flash back to the previous width.
		paintPreviewWidth(clamped);
		previewWidth = clamped;
		// Only user-driven resizes should rewrite the restore snapshot.
		if (setOptions.persistSnapshot && uiState.workspaceLayoutSnapshot) {
			uiState.setWorkspaceLayoutSnapshot({
				...uiState.workspaceLayoutSnapshot,
				previewWidth,
			});
		}
	}

	function ensurePreviewFits() {
		setPreviewWidth(previewWidth);
	}

	function captureSnapshot() {
		if (uiState.workspaceLayoutSnapshot) return;
		uiState.setWorkspaceLayoutSnapshot({
			leftSidebarCollapsed: uiState.leftSidebarCollapsed,
			rightSidebarCollapsed: uiState.rightSidebarCollapsed,
			filesColumnHidden: uiState.filesColumnHidden,
			previewWidth,
			treeVisible: !uiState.rightSidebarCollapsed,
		});
	}

	function restoreSnapshot() {
		const current = uiState.workspaceLayoutSnapshot;
		uiState.setWorkspaceLayoutSnapshot(null);
		if (!current) return;
		uiState.setLeftSidebarCollapsed(current.leftSidebarCollapsed);
		uiState.setRightSidebarCollapsed(current.rightSidebarCollapsed);
		uiState.setFilesColumnHidden(current.filesColumnHidden);
		previewWidth = current.previewWidth;
		ensurePreviewFits();
	}

	function setPresentation(next: WorkspacePresentation) {
		uiState.setWorkspacePresentation(next);
	}

	function exitPresentation() {
		if (presentation === "default" && !uiState.workspaceLayoutSnapshot) {
			immersiveMainVisible = true;
			return;
		}
		setPresentation("default");
		immersiveMainVisible = true;
		restoreSnapshot();
	}

	async function enterFocus() {
		if (options.getIsCompact()) return;
		if (presentation === "focus") {
			exitPresentation();
			return;
		}
		// Switching from immersive: keep the original restore snapshot.
		captureSnapshot();
		setPresentation("focus");
		immersiveMainVisible = true;
		uiState.setFilesColumnHidden(false);
		uiState.setLeftSidebarCollapsed(true);
		uiState.setRightSidebarCollapsed(true);
		await tick();
		setPreviewWidth(getMaxPreviewWidth());
	}

	async function enterImmersive() {
		if (options.getIsCompact()) return;
		if (presentation === "immersive") {
			exitPresentation();
			return;
		}
		// Capture the current split chat width before changing flex geometry so
		// entering Float does not visibly jump to its stored/default width.
		const currentMainWidth =
			presentation === "default" ? options.getMainPanelWidth() : null;
		// Switching from focus: keep the original restore snapshot.
		captureSnapshot();
		if (currentMainWidth !== null && currentMainWidth > 0) {
			uiState.setImmersiveChatWidth(currentMainWidth);
		}
		setPresentation("immersive");
		immersiveMainVisible = true;
		uiState.setFilesColumnHidden(false);
		uiState.setLeftSidebarCollapsed(true);
		uiState.setRightSidebarCollapsed(true);
		await tick();
	}

	async function toggleFocus() {
		await enterFocus();
	}

	async function toggleImmersive() {
		await enterImmersive();
	}

	/**
	 * Align live geometry with space-scoped presentation prefs.
	 * Call after space changes / loadLayoutPrefs (not on every user toggle).
	 */
	async function syncFromPrefs(spaceId: string) {
		const spaceChanged = syncedSpaceId !== spaceId;
		syncedSpaceId = spaceId;
		// Do NOT unconditionally show chat here — the centralized
		// float-mutual-exclusion effect handles visibility constraints.

		if (options.getIsCompact()) {
			if (uiState.workspacePresentation !== "default") exitPresentation();
			return;
		}

		const nextPresentation = uiState.workspacePresentation;
		const nextSnapshot = uiState.workspaceLayoutSnapshot;

		if (nextPresentation === "focus") {
			// Restore path keeps snapshot; live focus chrome uses max width.
			await tick();
			setPreviewWidth(getMaxPreviewWidth());
			return;
		}

		if (nextPresentation === "immersive") {
			if (spaceChanged && nextSnapshot) {
				previewWidth = snapshotPreviewWidth(nextSnapshot);
			}
			return;
		}

		// Default: restore the space-scoped user width after the workspace DOM has
		// settled. Exit already restores its in-memory snapshot without a reset.
		if (spaceChanged) {
			await tick();
			setPreviewWidth(uiState.workspacePreviewWidth);
		}
	}

	function setMobileSurface(next: MobileSurface) {
		mobileSurface = next;
		if (next === "files" && options.getFilesAvailable()) {
			uiState.mobileRightDrawerOpen = true;
		} else if (next !== "files") {
			uiState.mobileRightDrawerOpen = false;
		}
	}

	function showFilesMobile() {
		if (!options.getFilesAvailable()) return;
		setMobileSurface("files");
	}

	function showPreviewMobile() {
		setMobileSurface("preview");
	}

	function showMainMobile() {
		setMobileSurface("main");
	}

	function handleCompactChange(isCompact: boolean) {
		if (isCompact) {
			if (presentation !== "default") exitPresentation();
			if (options.getHasPreview()) mobileSurface = "preview";
			else if (uiState.mobileRightDrawerOpen) mobileSurface = "files";
			else mobileSurface = "main";
			return;
		}
		if (mobileSurface === "files") {
			uiState.mobileRightDrawerOpen = false;
		}
		mobileSurface = "main";
	}

	function handleWindowResize() {
		if (presentation === "focus") {
			setPreviewWidth(getMaxPreviewWidth());
			return;
		}
		if (presentation === "immersive") return;
		if (options.getHasPreview()) {
			setPreviewWidth(uiState.workspacePreviewWidth);
		}
	}

	function beginPreviewResize(event: PointerEvent) {
		event.preventDefault();
		if (options.getIsCompact()) return;
		// Keep snapshot; paint live width on the pane element during drag so
		// preview iframes are not torn down by Svelte prop thrashing.
		const target = event.currentTarget as HTMLElement | null;
		target?.setPointerCapture?.(event.pointerId);
		resizeCleanup?.();
		const startX = event.clientX;
		const startWidth = previewWidth;
		let liveWidth = startWidth;
		const onPointerMove = (moveEvent: PointerEvent) => {
			const delta = startX - moveEvent.clientX;
			liveWidth = clampPreviewWidth(startWidth + delta);
			paintPreviewWidth(liveWidth);
		};
		const stop = () => {
			document.body.classList.remove("sidebar-resizing");
			window.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("pointerup", stop);
			window.removeEventListener("pointercancel", stop);
			if (resizeCleanup === stop) resizeCleanup = null;
			// Commit once on release so dependent layout state stays in sync and the
			// user's split position survives reloads without persisting live drag IO.
			setPreviewWidth(liveWidth, {
				persistPreference: true,
				persistSnapshot: true,
			});
		};
		resizeCleanup = stop;
		document.body.classList.add("sidebar-resizing");
		window.addEventListener("pointermove", onPointerMove);
		window.addEventListener("pointerup", stop);
		window.addEventListener("pointercancel", stop);
	}

	function isCompactViewport() {
		// Prefer the page's reactive compact signal so header/toggle stay in
		// lockstep with layout; fall back to width when called outside the page.
		if (typeof options.getIsCompact === "function")
			return options.getIsCompact();
		if (typeof window === "undefined") return false;
		return window.innerWidth < DESKTOP_SHELL_MIN_WIDTH_PX;
	}

	/**
	 * Whether the Files chrome is effectively visible to the user.
	 * A collapsed tree with no preview paints as empty (0 width) even when
	 * `filesColumnHidden` is still false — treat that as hidden for header UI.
	 */
	function getFilesChromeVisibility() {
		return {
			isCompact: isCompactViewport(),
			mobileDrawerOpen: uiState.mobileRightDrawerOpen,
			filesColumnHidden: uiState.filesColumnHidden,
			treeCollapsed: uiState.rightSidebarCollapsed,
			hasPreview: options.getHasPreview(),
		};
	}

	function isFilesChromeEffectivelyHidden() {
		return filesChromeEffectivelyHidden(getFilesChromeVisibility());
	}

	/**
	 * Main-header control: show/hide the entire Files column
	 * (preview stage + file tree). Does not discard open tabs.
	 *
	 * Intentionally does not gate on `getFilesAvailable()` — the header button
	 * is only rendered when files are available, and blocking on that signal
	 * caused first-click no-ops while space was still bootstrapping.
	 */
	function toggleFilesColumn() {
		if (isCompactViewport()) {
			// Mobile: drawer for tree; preview is full-screen overlay.
			const nextOpen = !uiState.mobileRightDrawerOpen;
			uiState.mobileRightDrawerOpen = nextOpen;
			mobileSurface = nextOpen
				? "files"
				: options.getHasPreview()
					? "preview"
					: "main";
			return;
		}
		const nextHidden = !uiState.filesColumnHidden;
		uiState.setFilesColumnHidden(nextHidden);
		if (nextHidden) {
			// Keep tree collapsed state as-is; only hide column.
			return;
		}
		// Revealing column: ensure tree fits with preview if present.
		if (options.getHasPreview() && presentation === "default") {
			void tick().then(() => ensurePreviewFits());
		}
	}

	/**
	 * Main-header control with consistent show/hide semantics.
	 * If chrome is already effectively hidden (empty rail / drawer closed),
	 * the first click always reveals something visible (column + tree).
	 */
	async function toggleFilesChrome() {
		const action = resolveFilesChromeToggle(getFilesChromeVisibility());
		if (action === "toggle-mobile" || action === "hide") {
			toggleFilesColumn();
			return;
		}
		if (uiState.filesColumnHidden) uiState.setFilesColumnHidden(false);
		// Empty rail or fully hidden: always open the tree so the click paints.
		if (uiState.rightSidebarCollapsed) {
			await toggleTree();
		} else if (options.getHasPreview() && presentation === "default") {
			void tick().then(() => ensurePreviewFits());
		}
	}

	/** Files-column internal: collapse/expand file tree only.
	 *
	 * `persist` controls whether the layout snapshot is updated.  Auto layout
	 * adjustments (resize, mutual-exclusion cascade) pass `persist: false` so
	 * exit-Float restores the original tree state.  User-initiated toggles keep
	 * the default `true` so their preference is remembered.
	 */
	async function toggleTree(persist = true) {
		if (isCompactViewport()) {
			const nextOpen = !uiState.mobileRightDrawerOpen;
			uiState.mobileRightDrawerOpen = nextOpen;
			mobileSurface = nextOpen
				? "files"
				: options.getHasPreview()
					? "preview"
					: "main";
			return;
		}
		const nextCollapsed = !uiState.rightSidebarCollapsed;
		const treeWidth = uiState.rightSidebarWidth;
		uiState.setRightSidebarCollapsed(nextCollapsed);
		if (uiState.workspaceLayoutSnapshot) {
			const next = nextTreeSnapshot(
				uiState.workspaceLayoutSnapshot,
				nextCollapsed,
				persist,
			);
			if (next !== uiState.workspaceLayoutSnapshot) {
				uiState.setWorkspaceLayoutSnapshot(next);
			}
		}
		// Collapsing the tree with no preview leaves a 0-width empty rail —
		// fold the whole Files column so header state stays consistent.
		if (nextCollapsed && !options.getHasPreview()) {
			uiState.setFilesColumnHidden(true);
			return;
		}
		// Expanding tree while column was folded: reveal it.
		if (!nextCollapsed && uiState.filesColumnHidden) {
			uiState.setFilesColumnHidden(false);
		}
		if (!options.getHasPreview()) return;
		if (presentation === "immersive") return;
		if (presentation === "focus") {
			await tick();
			setPreviewWidth(getMaxPreviewWidth());
			return;
		}
		await tick();
		setPreviewWidth(previewWidth + (nextCollapsed ? treeWidth : -treeWidth));
	}

	function setImmersiveMainVisible(visible: boolean) {
		immersiveMainVisible = visible;
	}

	function dispose() {
		resizeCleanup?.();
		resizeCleanup = null;
	}

	return {
		get previewWidth() {
			return previewWidth;
		},
		get presentation() {
			return presentation;
		},
		get mobileSurface() {
			return mobileSurface;
		},
		get immersiveMainVisible() {
			return immersiveMainVisible;
		},
		get focusMode() {
			return presentation === "focus";
		},
		get immersiveMode() {
			return presentation === "immersive";
		},
		get treeVisible() {
			return treeVisible;
		},
		get filesColumnHidden() {
			return uiState.filesColumnHidden;
		},
		get filesChromeEffectivelyHidden() {
			return isFilesChromeEffectivelyHidden();
		},
		setPreviewWidth,
		ensurePreviewFits,
		syncFromPrefs,
		toggleFocus,
		toggleImmersive,
		exitPresentation,
		handleWindowResize,
		handleCompactChange,
		beginPreviewResize,
		toggleTree,
		toggleFilesColumn,
		toggleFilesChrome,
		setFilesColumnHidden: (hidden: boolean) => {
			uiState.setFilesColumnHidden(hidden);
		},
		setMobileSurface,
		showFilesMobile,
		showPreviewMobile,
		showMainMobile,
		setImmersiveMainVisible,
		dispose,
	};
}
