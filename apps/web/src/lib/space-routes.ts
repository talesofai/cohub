export const buildSpaceRootRoute = (spaceId: string) => `/spaces/${spaceId}`;

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

export const buildSpaceSessionRoute = (spaceId: string, sessionId: string) =>
	`/spaces/${spaceId}/sessions/${sessionId}`;

/** The Space root is the canonical new-session draft. */
export const buildSpaceNewSessionRoute = buildSpaceRootRoute;
export const buildSpaceLandingRoute = buildSpaceRootRoute;

export const buildSpaceSettingsRoute = (spaceId: string) =>
	`/spaces/${spaceId}/settings`;

export const buildSpaceActivityRoute = (spaceId: string) =>
	`/spaces/${spaceId}/activity`;

export const buildSpaceSessionTurnRoute = (
	spaceId: string,
	sessionId: string,
	sequence: number,
) => {
	const params = new URLSearchParams({ turn: String(sequence) });
	return `${buildSpaceSessionRoute(spaceId, sessionId)}?${params.toString()}`;
};

export const buildSpaceCheckpointRoute = (
	spaceId: string,
	checkpointId: string,
) => `/spaces/${spaceId}/checkpoints/${checkpointId}`;

export const buildSpaceCheckpointNewRoute = (spaceId: string) =>
	`/spaces/${spaceId}/checkpoints/new`;

/** Legacy deep-link helper. /files/* redirects to Main + ?preview=file:... */
export const buildSpaceFileRoute = (spaceId: string, path: string) =>
	`/spaces/${spaceId}/files/${path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/")}`;

export const buildSpaceCronjobRoute = (spaceId: string, cronjobId: string) =>
	`/spaces/${spaceId}/cronjobs/${cronjobId}`;

export const buildSpaceCronjobNewRoute = (spaceId: string) =>
	`/spaces/${spaceId}/cronjobs/new`;

export const buildSpaceAppRoute = (spaceId: string, appId: string) =>
	`/spaces/${spaceId}/apps/${appId}`;

export const buildSpaceTaskRoute = (spaceId: string, taskId: string) =>
	`/spaces/${spaceId}/tasks/${taskId}`;
