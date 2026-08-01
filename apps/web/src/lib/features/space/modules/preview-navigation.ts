import type { WorkspacePreviewRef } from "./workspace-preview-route";

export type PreviewNavigationSource = "user" | "route" | "restore";

export type PreviewNavigationState = {
	desiredRef: WorkspacePreviewRef | null;
	source: PreviewNavigationSource;
	transitionId: number;
};

export function createPreviewNavigationState(): PreviewNavigationState {
	return {
		desiredRef: null,
		source: "restore",
		transitionId: 0,
	};
}

export function beginPreviewNavigation(
	state: PreviewNavigationState,
	desiredRef: WorkspacePreviewRef | null,
	source: PreviewNavigationSource,
): PreviewNavigationState {
	return {
		desiredRef,
		source,
		transitionId: state.transitionId + 1,
	};
}

export function alignPreviewNavigation(
	state: PreviewNavigationState,
	desiredRef: WorkspacePreviewRef | null,
): PreviewNavigationState {
	return { ...state, desiredRef };
}

export function isCurrentPreviewNavigation(
	state: PreviewNavigationState,
	transitionId: number,
): boolean {
	return state.transitionId === transitionId;
}

export function previewRefsEqual(
	a: WorkspacePreviewRef | null,
	b: WorkspacePreviewRef | null,
): boolean {
	return a?.kind === b?.kind && a?.key === b?.key;
}
