import type {
	SessionRecord,
	UserSessionListItem,
	UserSessionSummary,
} from "@neta-art/cohub";

type MergeableSession = SessionRecord | UserSessionListItem;
export type FullUserSessionListItem = Exclude<
	UserSessionListItem,
	UserSessionSummary
>;

export function isUserSessionSummary(
	session: UserSessionListItem,
): session is UserSessionSummary {
	return "accessLevel" in session && session.accessLevel === "summary";
}

export function isFullUserSessionListItem(
	session: UserSessionListItem,
): session is FullUserSessionListItem {
	return !isUserSessionSummary(session);
}

/** Summary rows cannot infer unread state without exposing message identity. */
export function getUserSessionLastMessageId(
	session: UserSessionListItem,
): string | null {
	return isFullUserSessionListItem(session)
		? (session.lastMessageId ?? null)
		: null;
}

function mergeSessionValue(
	existing: MergeableSession | undefined | null,
	incoming: MergeableSession,
): MergeableSession {
	if (!existing) return incoming;
	if (isUserSessionSummary(incoming)) {
		return incoming;
	}
	const merged: Record<string, unknown> = { ...existing, ...incoming };
	delete merged.accessLevel;
	return merged as MergeableSession;
}

/**
 * Merge a possibly partial realtime session patch into a cached full session.
 *
 * Realtime session records intentionally omit hydrated profile fields. Treat
 * missing optional fields as "unknown / unchanged" rather than clearing local
 * cache, while still allowing explicit null / array values from list responses
 * to replace stale data.
 */
export function mergeSessionRecord(
	existing: MergeableSession | undefined | null,
	incoming: SessionRecord,
): SessionRecord;
export function mergeSessionRecord(
	existing: UserSessionListItem | undefined | null,
	incoming: UserSessionListItem,
): UserSessionListItem;
export function mergeSessionRecord(
	existing: MergeableSession | undefined | null,
	incoming: MergeableSession,
): MergeableSession {
	return mergeSessionValue(existing, incoming);
}

export function mergeSessionRecords(sessions: SessionRecord[]): SessionRecord[];
export function mergeSessionRecords(
	sessions: UserSessionListItem[],
): UserSessionListItem[];
export function mergeSessionRecords(
	sessions: MergeableSession[],
): MergeableSession[] {
	const byId = new Map<string, MergeableSession>();
	for (const session of sessions) {
		byId.set(session.id, mergeSessionValue(byId.get(session.id), session));
	}
	return Array.from(byId.values());
}
