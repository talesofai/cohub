import type { BoardFileSnapshot } from "@neta-art/cohub/board";
import {
	COHUB_PATH_MIME,
	COHUB_RESOURCE_MIME,
} from "$lib/drag/cohub-resource-drag";
import type { BoardDropItem } from "$lib/drag/pointer-drag-core";
import type {
	SpaceUploadedFile,
	SpaceUploadProgress,
	UploadSpaceEntriesOptions,
} from "$lib/space-upload";
import {
	entriesFromDataTransfer,
	type LocalUploadEntry,
} from "$lib/upload-entries";

export const BOARD_FILE_DROP_TARGET_DIR = "";
export const LOCAL_FILES_MIME = "Files";

export type BoardNativeDropKind = "internal" | "local-files";

export function boardNativeDropKind(
	types: Iterable<string> | null | undefined,
	readonly: boolean,
): BoardNativeDropKind | null {
	if (readonly || !types) return null;
	const available = new Set(types);
	if (available.has(COHUB_PATH_MIME) || available.has(COHUB_RESOURCE_MIME)) {
		return "internal";
	}
	return available.has(LOCAL_FILES_MIME) ? "local-files" : null;
}

export function uploadedFilesToBoardDropItems(
	files: SpaceUploadedFile[],
): BoardDropItem[] {
	return files.map((file) => ({
		path: file.path,
		snapshot: {
			title: file.name,
			mimeType: file.mimeType ?? undefined,
			size: file.size,
			mtimeMs: file.mtimeMs,
		} satisfies BoardFileSnapshot,
	}));
}

type UploadBoardDataTransferOptions = {
	spaceId: string;
	dataTransfer: DataTransfer;
	readonly: boolean;
	onProgress?: (progress: SpaceUploadProgress) => void;
	signal?: AbortSignal;
	upload: (options: UploadSpaceEntriesOptions) => Promise<SpaceUploadedFile[]>;
};

/**
 * Convert an OS file drop into the same upload and Board item shape used by
 * workspace files. The root destination matches the file sidebar's drag-in
 * convention.
 */
export async function uploadBoardDataTransfer({
	spaceId,
	dataTransfer,
	readonly,
	onProgress,
	signal,
	upload,
}: UploadBoardDataTransferOptions): Promise<BoardDropItem[]> {
	if (boardNativeDropKind(dataTransfer.types, readonly) !== "local-files") {
		return [];
	}
	const entries: LocalUploadEntry[] =
		await entriesFromDataTransfer(dataTransfer);
	if (entries.length === 0) return [];
	const uploaded = await upload({
		spaceId,
		targetDir: BOARD_FILE_DROP_TARGET_DIR,
		entries,
		onProgress,
		signal,
	});
	return uploadedFilesToBoardDropItems(uploaded);
}
