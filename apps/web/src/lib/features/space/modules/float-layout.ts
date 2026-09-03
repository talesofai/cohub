/**
 * Pure layout geometry helpers shared by SpaceWorkspacePage (production) and
 * workspace-layout-controller.test.ts (tests).  Keeping these in a plain .ts
 * module means tests import the *real* production logic instead of a
 * hand-rolled copy that can silently drift.
 */

/** Minimum usable width for the Preview content area in Float mode. */
export const FLOAT_PREVIEW_MIN_WIDTH = 400;

/** Spacing between Chat / Preview / Files floating panels and viewport edges. */
export const FLOAT_PANEL_GAP = 10;

/** Tighter edge spacing between the left navigation rail and floating Chat. */
export const FLOAT_CHAT_EDGE_GAP = 6;

/**
 * Whether the workspace is wide enough for Chat + Files + Preview to coexist
 * in Float mode without squeezing the Preview below its minimum.
 *
 * @param workspaceWidth  available width (workspace body clientWidth)
 * @param filesWidth      current Files sidebar width (0 when collapsed)
 * @param chatMinWidth    minimum Chat width (IMMERSIVE_CHAT_MIN in production)
 */
export function floatPanelsFit(
	workspaceWidth: number,
	filesWidth: number,
	chatMinWidth: number,
): boolean {
	return (
		workspaceWidth >=
		chatMinWidth + filesWidth + FLOAT_PREVIEW_MIN_WIDTH + FLOAT_PANEL_GAP * 3
	);
}

/**
 * Compute the next layout-snapshot value for a tree toggle.
 *
 * Auto-adjustments (window resize, mutual-exclusion cascade) MUST pass
 * `persist: false` so the snapshot stays pristine and exit-Float restores the
 * original tree state.  User-initiated toggles pass `persist: true` (default)
 * so their preference is remembered.
 */
export function nextTreeSnapshot<
	T extends { rightSidebarCollapsed: boolean; treeVisible: boolean },
>(snapshot: T | null, nextCollapsed: boolean, persist = true): T | null {
	if (!persist || !snapshot) return snapshot;
	return {
		...snapshot,
		rightSidebarCollapsed: nextCollapsed,
		treeVisible: !nextCollapsed,
	};
}

export type FilesChromeVisibility = {
	isCompact: boolean;
	mobileDrawerOpen: boolean;
	filesColumnHidden: boolean;
	treeCollapsed: boolean;
	hasPreview: boolean;
};

export function filesChromeEffectivelyHidden(
	state: FilesChromeVisibility,
): boolean {
	if (state.isCompact) return !state.mobileDrawerOpen;
	if (state.filesColumnHidden) return true;
	return state.treeCollapsed && !state.hasPreview;
}

export function resolveFilesChromeToggle(
	state: FilesChromeVisibility,
): "toggle-mobile" | "reveal" | "hide" {
	if (state.isCompact) return "toggle-mobile";
	return filesChromeEffectivelyHidden(state) ? "reveal" : "hide";
}

/**
 * Chat visibility after leaving focus / float / full-canvas.
 *
 * Regular focus/float never recorded a prior chat flag, so exit always
 * shows chat (legacy). Full-canvas remembers the pre-entry value and
 * restores it, except when the user already re-showed chat — never hide
 * it again.
 */
export function restoreImmersiveChatOnExit(input: {
	rememberedBeforeFullCanvas: boolean | null;
	currentlyVisible: boolean;
}): boolean {
	if (input.rememberedBeforeFullCanvas === null) return true;
	if (input.currentlyVisible) return true;
	return input.rememberedBeforeFullCanvas;
}
