import type { SpaceFsEntry } from "@neta-art/cohub";

export type UploadedFileMetadata = {
	path: string;
	name: string;
	size: number;
	mimeType: string | null;
	mtimeMs: number;
};

export function uploadParentDir(path: string) {
	const separator = path.lastIndexOf("/");
	return separator < 0 ? "" : path.slice(0, separator);
}

/** Fold authoritative upload-completion metadata into a cached directory list. */
export function reconcileUploadedFiles(
	entries: SpaceFsEntry[],
	uploaded: UploadedFileMetadata[],
): SpaceFsEntry[] {
	const byPath = new Map(entries.map((entry) => [entry.path, entry]));
	for (const file of uploaded) {
		byPath.set(file.path, {
			path: file.path,
			name: file.name,
			type: "file",
			size: file.size,
			mimeType: file.mimeType,
			mtimeMs: file.mtimeMs,
		});
	}
	return [...byPath.values()];
}
