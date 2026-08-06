export type FriendlySpaceResourceRoute =
	| { kind: "session"; sessionId: string }
	| { kind: "checkpoint"; checkpointId: string | null }
	| { kind: "cronjob"; cronjobId: string | null }
	| { kind: "task"; taskId: string }
	| { kind: "work"; workId: string }
	| { kind: "file"; path: string };

/** Parse the resource suffix after `/:username/:spaceSlug/`. */
export function parseFriendlySpaceResourceRoute(
	value: string | null | undefined,
): FriendlySpaceResourceRoute | null {
	if (!value) return null;
	const segments = value.split("/").filter(Boolean);
	const [resource, id, extra] = segments;

	if (resource === "sessions" && id && !extra) {
		return { kind: "session", sessionId: id };
	}
	if (resource === "checkpoints" && id && !extra) {
		return {
			kind: "checkpoint",
			checkpointId: id === "new" ? null : id,
		};
	}
	if (resource === "cronjobs" && id && !extra) {
		return { kind: "cronjob", cronjobId: id === "new" ? null : id };
	}
	if (resource === "tasks" && id && !extra) {
		return { kind: "task", taskId: id };
	}
	if (resource === "works" && id && !extra) {
		return { kind: "work", workId: id };
	}
	if (resource === "files" && segments.length > 1) {
		const path = segments.slice(1).join("/");
		return path ? { kind: "file", path } : null;
	}
	return null;
}
