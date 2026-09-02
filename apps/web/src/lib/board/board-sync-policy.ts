export type BoardIdentity = {
	path: string;
	boardId: string | null;
};

export function mergeChangedRecords<T extends { id: string }>(
	existing: readonly T[],
	incoming: readonly T[],
	changedIds: readonly string[],
): T[] {
	const changed = new Set(changedIds);
	const incomingById = new Map(incoming.map((record) => [record.id, record]));
	const merged = existing
		.filter((record) => !changed.has(record.id) || incomingById.has(record.id))
		.map((record) => incomingById.get(record.id) ?? record);
	const mergedIds = new Set(merged.map((record) => record.id));
	for (const record of incoming) {
		if (!mergedIds.has(record.id)) {
			merged.push(record);
			mergedIds.add(record.id);
		}
	}
	return merged;
}

export function hasBoardIdentity(
	boards: readonly BoardIdentity[],
	boardId: string,
): boolean {
	return boards.some((board) => board.boardId === boardId);
}

export function boardPathMatchesTarget(
	boardPath: string,
	targetPath: string,
	recursive: boolean,
): boolean {
	return (
		boardPath === targetPath ||
		(recursive && boardPath.startsWith(`${targetPath}/`))
	);
}

export function canAdoptBoardVersion(
	currentVersion: number | null,
	incomingVersion: number,
): boolean {
	return currentVersion == null || incomingVersion >= currentVersion;
}
