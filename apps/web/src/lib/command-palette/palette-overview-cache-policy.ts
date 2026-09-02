import type { PaletteOverviewResponse } from "@neta-art/cohub";

export function isUsablePaletteOverview(
	data: PaletteOverviewResponse | null,
): data is PaletteOverviewResponse {
	return Boolean(
		data &&
			data.degraded !== true &&
			Array.isArray(data.spaces) &&
			Array.isArray(data.recentSessions),
	);
}

export function canCommitPaletteOverviewRefresh(input: {
	requestUserKey: string;
	currentUserKey: string;
	requestStateIsCurrent: boolean;
	requestId: number;
	latestRequestId: number;
	requestInvalidatedAt: number;
	currentInvalidatedAt: number;
	persistedInvalidatedAt: number;
}) {
	return (
		input.requestStateIsCurrent &&
		input.requestUserKey === input.currentUserKey &&
		input.requestId === input.latestRequestId &&
		input.requestInvalidatedAt === input.currentInvalidatedAt &&
		input.persistedInvalidatedAt <= input.requestInvalidatedAt
	);
}
