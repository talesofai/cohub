import type { SessionTurnRecord } from "@cohub/protocol/model";

type ActivityRecord = {
	spaceId: string;
	turns: Array<Pick<SessionTurnRecord, "userUuid" | "createdAt" | "updatedAt">>;
};

function timeValue(value: string | null | undefined) {
	const time = new Date(value ?? 0).getTime();
	return Number.isFinite(time) ? time : 0;
}

/**
 * Return the latest local turn authored by the viewer for each Space.
 * Session-level timestamps are intentionally excluded because another
 * participant can advance them.
 */
export function getViewerTurnActivityBySpace(
	records: ActivityRecord[],
	viewerUserUuid: string | null,
) {
	const activityBySpace = new Map<string, string>();
	if (!viewerUserUuid) return activityBySpace;
	for (const record of records) {
		for (const turn of record.turns) {
			if (turn.userUuid !== viewerUserUuid) continue;
			const candidate = turn.updatedAt ?? turn.createdAt;
			const current = activityBySpace.get(record.spaceId);
			if (timeValue(candidate) > timeValue(current))
				activityBySpace.set(record.spaceId, candidate);
		}
	}
	return activityBySpace;
}
