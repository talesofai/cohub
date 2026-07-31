import type { SpaceFsChangedPayload } from "@cohub/protocol/fs";

export type SpaceFsInvalidationTargets = {
	dirs: Set<string>;
	subtrees: Set<string>;
};

function normalizePath(path: string) {
	return path.trim().replace(/^\/+|\/+$/g, "");
}

function parentDir(path: string) {
	const normalized = normalizePath(path);
	if (!normalized.includes("/")) return "";
	return normalized.slice(0, normalized.lastIndexOf("/"));
}

export function getFsInvalidationTargets(
	payload: SpaceFsChangedPayload,
): SpaceFsInvalidationTargets {
	if (payload.resync)
		return { dirs: new Set<string>(), subtrees: new Set<string>([""]) };
	const dirs = new Set<string>();
	const subtrees = new Set<string>();
	for (const change of payload.changes) {
		const path = normalizePath(change.path ?? "");
		const oldPath = normalizePath(change.oldPath ?? "");
		if (path) dirs.add(parentDir(path));
		if (oldPath) dirs.add(parentDir(oldPath));
		if (path && (change.nodeType === "dir" || change.kind === "delete"))
			subtrees.add(path);
		if (oldPath && (change.nodeType === "dir" || change.kind === "rename"))
			subtrees.add(oldPath);
	}
	return { dirs, subtrees };
}
