type SessionActivityRecord = {
	id: string;
	lastMessageAt: string | null;
	updatedAt: string;
	createdAt: string;
};

export function getSessionActivityAt(session: SessionActivityRecord) {
	return (
		session.lastMessageAt ?? session.updatedAt ?? session.createdAt ?? null
	);
}

export function getSessionSortTime(session: SessionActivityRecord) {
	return Date.parse(getSessionActivityAt(session) ?? "") || 0;
}

export function compareSessionsByRecentActivity(
	a: SessionActivityRecord,
	b: SessionActivityRecord,
) {
	const timeDelta = getSessionSortTime(b) - getSessionSortTime(a);
	if (timeDelta !== 0) return timeDelta;
	return b.id.localeCompare(a.id);
}

export function sortSessionsByRecentActivity<T extends SessionActivityRecord>(
	sessions: T[],
): T[] {
	return [...sessions].sort(compareSessionsByRecentActivity);
}
