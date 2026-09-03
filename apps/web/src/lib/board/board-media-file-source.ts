import { matchesSpaceFsVersion } from "@cohub/protocol/fs";
import type {
	SpaceFsFileResponse,
	SpaceFsPreparingFile,
} from "@neta-art/cohub";
import type { BoardMediaSnapshot } from "@neta-art/cohub/board";

export type BoardMediaFileMetadata = Pick<
	SpaceFsFileResponse,
	"mimeType" | "mtimeMs" | "size"
>;

export type BoardMediaFileResolution = {
	metadata: BoardMediaFileMetadata;
	changed: boolean;
};

/**
 * Resolve the authoritative metadata for a Board media reference.
 *
 * A media snapshot is only a cache hint. Reading by path both proves that the
 * workspace file is still available and repairs a stale snapshot after a Board
 * is reopened, when no live filesystem event exists to mark it stale.
 */
export async function resolveBoardMediaFile(
	path: string,
	snapshot: BoardMediaSnapshot | undefined,
	read: (path: string) => Promise<SpaceFsFileResponse | SpaceFsPreparingFile>,
): Promise<BoardMediaFileResolution | null> {
	const file = await read(path);
	if (!("content" in file)) return null;

	const metadata: BoardMediaFileMetadata = {
		mimeType: file.mimeType,
		mtimeMs: file.mtimeMs,
		size: file.size,
	};
	const sameVersion =
		snapshot?.mtimeMs !== undefined &&
		snapshot.size !== undefined &&
		matchesSpaceFsVersion(metadata, {
			mtimeMs: snapshot.mtimeMs,
			size: snapshot.size,
		});
	const sameMimeType =
		snapshot?.mimeType === undefined || snapshot.mimeType === file.mimeType;

	return {
		metadata,
		changed: !sameVersion || !sameMimeType,
	};
}
