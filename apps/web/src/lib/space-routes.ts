export type SpaceRouteIdentity = {
	id: string;
	slug?: string | null;
	ownerUsername?: string | null;
};

export type SpaceRouteTarget = string | SpaceRouteIdentity;

function encodeRouteSegment(value: string): string {
	return encodeURIComponent(value);
}

function spaceBaseRoute(target: SpaceRouteTarget): string {
	if (typeof target === "string") return `/spaces/${target}`;
	if (target.ownerUsername && target.slug) {
		return `/${encodeRouteSegment(target.ownerUsername)}/${encodeRouteSegment(target.slug)}`;
	}
	return `/spaces/${target.id}`;
}

export const buildSpaceRootRoute = (target: SpaceRouteTarget) =>
	spaceBaseRoute(target);

/** Return the current public Space identity when both URL segments exist. */
export function getSpaceRouteIdentity(input: {
	id: string;
	slug?: string | null;
	ownerUsername?: string | null;
}): SpaceRouteIdentity {
	return {
		id: input.id,
		slug: input.slug ?? null,
		ownerUsername: input.ownerUsername ?? null,
	};
}

/**
 * Convert a resolved workspace URL to the current friendly Space URL.
 * The immutable route identity must match before an outdated friendly prefix
 * can be replaced. Query parameters and hashes are preserved.
 */
export function canonicalizeSpaceRoute(
	url: Pick<URL, "pathname" | "search" | "hash">,
	identity: SpaceRouteIdentity,
	resolvedSpaceId: string | null,
): string | null {
	if (
		resolvedSpaceId !== identity.id ||
		!identity.slug ||
		!identity.ownerUsername
	)
		return null;

	const idPrefix = `/spaces/${identity.id}`;
	let suffix: string | null = null;
	if (url.pathname === idPrefix) {
		suffix = "";
	} else if (url.pathname.startsWith(`${idPrefix}/`)) {
		suffix = url.pathname.slice(idPrefix.length);
	} else if (url.pathname.startsWith("/spaces/")) {
		return null;
	} else {
		const friendlyMatch = url.pathname.match(/^\/[^/]+\/[^/]+(\/.*)?$/);
		if (friendlyMatch) suffix = friendlyMatch[1] ?? "";
	}
	if (suffix === null) return null;

	const friendly = spaceBaseRoute(identity) + suffix;
	return `${friendly}${url.search}${url.hash}`;
}

export const buildSessionsRoute = () => "/sessions";

export const buildUserSessionRoute = (sessionId: string) =>
	`/sessions/${sessionId}`;

/** Cross-space new chat draft on the sessions inbox (not space workspace). */
export const buildUserNewSessionRoute = (spaceId: string) => {
	const params = new URLSearchParams({ space: spaceId });
	return `${buildSessionsRoute()}/new?${params.toString()}`;
};

export const buildUserSessionTurnRoute = (
	sessionId: string,
	sequence: number,
) => {
	const params = new URLSearchParams({ turn: String(sequence) });
	return `${buildUserSessionRoute(sessionId)}?${params.toString()}`;
};

export const buildSpaceSessionRoute = (
	target: SpaceRouteTarget,
	sessionId: string,
) => `${spaceBaseRoute(target)}/sessions/${encodeRouteSegment(sessionId)}`;
export const buildSpaceNewSessionRoute = (target: SpaceRouteTarget) =>
	buildSpaceSessionRoute(target, "new");

export const buildSpaceLandingRoute = (target: SpaceRouteTarget) =>
	buildSpaceNewSessionRoute(target);

export const buildSpaceSettingsRoute = (target: SpaceRouteTarget) =>
	`${spaceBaseRoute(target)}/settings`;

export const buildSpaceCommerceSettingsRoute = (target: SpaceRouteTarget) =>
	`${buildSpaceSettingsRoute(target)}/commerce`;

export const buildSpaceSessionTurnRoute = (
	target: SpaceRouteTarget,
	sessionId: string,
	sequence: number,
) => {
	const params = new URLSearchParams({ turn: String(sequence) });
	return `${buildSpaceSessionRoute(target, sessionId)}?${params.toString()}`;
};

export const buildSpaceCheckpointRoute = (
	target: SpaceRouteTarget,
	checkpointId: string,
) =>
	`${spaceBaseRoute(target)}/checkpoints/${encodeRouteSegment(checkpointId)}`;

export const buildSpaceCheckpointNewRoute = (target: SpaceRouteTarget) =>
	`${spaceBaseRoute(target)}/checkpoints/new`;

/** Legacy deep-link helper. /files/* redirects to Main + ?preview=file:... */
export const buildSpaceFileRoute = (target: SpaceRouteTarget, path: string) =>
	`${spaceBaseRoute(target)}/files/${path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/")}`;

export const buildSpaceCronjobRoute = (
	target: SpaceRouteTarget,
	cronjobId: string,
) => `${spaceBaseRoute(target)}/cronjobs/${encodeRouteSegment(cronjobId)}`;

export const buildSpaceCronjobNewRoute = (target: SpaceRouteTarget) =>
	`${spaceBaseRoute(target)}/cronjobs/new`;

export const buildSpaceWorkRoute = (target: SpaceRouteTarget, workId: string) =>
	`${spaceBaseRoute(target)}/works/${encodeRouteSegment(workId)}`;

export const buildSpaceTaskRoute = (target: SpaceRouteTarget, taskId: string) =>
	`${spaceBaseRoute(target)}/tasks/${encodeRouteSegment(taskId)}`;
