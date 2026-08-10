import { readPreviewFromSearch } from "./workspace-preview-route";

export type WorkspacePageView =
	| "space"
	| "session"
	| "checkpoint"
	| "checkpoint-new"
	| "cronjob"
	| "cronjob-new"
	| "work"
	| "task";

type PreviewFields = {
	previewKind: "file" | "board" | "port" | "work" | null;
	previewKey: string | null;
};

export function withWorkspacePreview(
	searchParams: URLSearchParams,
): PreviewFields {
	const preview = readPreviewFromSearch(searchParams);
	return {
		previewKind: preview?.kind ?? null,
		previewKey: preview?.key ?? null,
	};
}
