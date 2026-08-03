/**
 * Resolve the active workspace route context.
 *
 * Workspace routes support immutable `/spaces/:id/...` ingress and canonical
 * `/:username/:spaceSlug/...` URLs. Friendly page loads expose the immutable id
 * as `page.data.spaceId`.
 *
 * Never treat sessions-inbox draft targets (`newChatSpaceId` / `?space=`) as the
 * workspace space — those must not drive sidebar layout prefs.
 */

export type WorkspaceLabelResource = {
	type: "session" | "checkpoint" | "file";
	ref: string;
};

export type WorkspaceRouteContext = {
	spaceId: string | null;
	sessionId: string | null;
	workId: string | null;
	checkpointId: string | null;
	cronjobId: string | null;
	taskId: string | null;
	filePath: string | null;
	labelResource: WorkspaceLabelResource | null;
};

export type ResolveWorkspaceRouteInput = {
	pathname: string;
	searchParams?: URLSearchParams | { get(name: string): string | null };
	pageData?: {
		spaceId?: unknown;
		sessionId?: unknown;
	};
	params?: {
		id?: string | null;
	};
};

function asNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function decodePathSegment(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function decodeFilePath(value: string): string {
	return value
		.split("/")
		.map((segment) => decodePathSegment(segment))
		.join("/");
}

function parseSpaceIdFromPath(pathname: string): string | null {
	const match = pathname.match(/^\/spaces\/([^/]+)/);
	const id = match?.[1] ? decodePathSegment(match[1]) : null;
	if (!id || id === "new") return null;
	return id;
}

function parseResourceId(
	pathname: string,
	kind: "sessions" | "works" | "checkpoints" | "cronjobs" | "tasks",
): string | null {
	const match = pathname.match(
		new RegExp(`^/(?:spaces/[^/]+|[^/]+/[^/]+)/${kind}/([^/]+)`),
	);
	const id = match?.[1] ? decodePathSegment(match[1]) : null;
	if (!id) return null;
	if ((kind === "checkpoints" || kind === "cronjobs") && id === "new") {
		return null;
	}
	return id;
}

function parseFilePath(pathname: string): string | null {
	const match = pathname.match(
		/^\/(?:spaces\/[^/]+|[^/]+\/[^/]+)\/files\/(.+)$/,
	);
	if (!match?.[1]) return null;
	return decodeFilePath(match[1]);
}

function resolveSpaceId(input: ResolveWorkspaceRouteInput): string | null {
	const fromData = asNonEmptyString(input.pageData?.spaceId);
	if (fromData) return fromData;

	const fromParams = asNonEmptyString(input.params?.id);
	if (fromParams && fromParams !== "new") return fromParams;

	return parseSpaceIdFromPath(input.pathname);
}

function resolveSessionId(input: ResolveWorkspaceRouteInput): string | null {
	const fromData = asNonEmptyString(input.pageData?.sessionId);
	if (fromData) return fromData;

	const fromPath = parseResourceId(input.pathname, "sessions");
	if (fromPath) return fromPath;

	const fromQuery = asNonEmptyString(
		input.searchParams?.get("session") ?? null,
	);
	return fromQuery;
}

/**
 * Active workspace space + resource ids for shell chrome (sidebar, layout prefs,
 * notifications). Page loads remain the authority for pretty-URL id resolution.
 */
export function resolveWorkspaceRouteContext(
	input: ResolveWorkspaceRouteInput,
): WorkspaceRouteContext {
	const spaceId = resolveSpaceId(input);
	const sessionId = resolveSessionId(input);
	const workId = parseResourceId(input.pathname, "works");
	const checkpointId = parseResourceId(input.pathname, "checkpoints");
	const cronjobId = parseResourceId(input.pathname, "cronjobs");
	const taskId = parseResourceId(input.pathname, "tasks");
	const filePath = parseFilePath(input.pathname);

	let labelResource: WorkspaceLabelResource | null = null;
	if (sessionId) {
		labelResource = { type: "session", ref: sessionId };
	} else if (checkpointId) {
		labelResource = { type: "checkpoint", ref: checkpointId };
	} else if (filePath) {
		labelResource = { type: "file", ref: filePath };
	}

	return {
		spaceId,
		sessionId,
		workId,
		checkpointId,
		cronjobId,
		taskId,
		filePath,
		labelResource,
	};
}

/** Convenience: only the workspace spaceId. */
export function resolveWorkspaceSpaceId(
	input: ResolveWorkspaceRouteInput,
): string | null {
	return resolveWorkspaceRouteContext(input).spaceId;
}
