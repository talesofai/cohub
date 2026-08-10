import { isBoardFile } from "$lib/board/board-file";
import type { PreviewSyncStatus } from "./preview-sync-status";

export type PreviewTab = {
	kind: "file" | "board" | "port" | "work";
	key: string;
	label: string;
	title: string;
	syncStatus?: PreviewSyncStatus;
	active: boolean;
};

export function activePreviewFilePath(
	kind: PreviewTab["kind"] | null,
	filePath: string | null,
	boardPath: string | null,
): string {
	if (kind === "file") return filePath ?? "";
	if (kind === "board") return boardPath ?? "";
	return "";
}

export function workspaceFilePreviewKind(
	path: string,
	readOnly: boolean,
): "file" | "board" {
	return isBoardFile(path) && !readOnly ? "board" : "file";
}
