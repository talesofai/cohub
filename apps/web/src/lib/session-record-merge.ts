import type { SessionRecord, UserSessionListItem } from "@neta-art/cohub";

type MergeableSession = SessionRecord | UserSessionListItem;

function hasOwn<T extends object, K extends PropertyKey>(
	value: T,
	key: K,
): value is T & Record<K, unknown> {
	return Object.hasOwn(value, key);
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
	existing: SessionRecord | undefined | null,
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
	if (!existing) return incoming;
	return {
		...existing,
		...incoming,
		meta: hasOwn(incoming, "meta") ? incoming.meta : existing.meta,
		userProfile: hasOwn(incoming, "userProfile")
			? incoming.userProfile
			: existing.userProfile,
		participantUserUuids: hasOwn(incoming, "participantUserUuids")
			? incoming.participantUserUuids
			: existing.participantUserUuids,
		participantProfiles: hasOwn(incoming, "participantProfiles")
			? incoming.participantProfiles
			: existing.participantProfiles,
	} as MergeableSession;
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
		const existing = byId.get(session.id);
		byId.set(session.id, {
			...existing,
			...session,
			meta: hasOwn(session, "meta") ? session.meta : existing?.meta,
			userProfile: hasOwn(session, "userProfile")
				? session.userProfile
				: existing?.userProfile,
			participantUserUuids: hasOwn(session, "participantUserUuids")
				? session.participantUserUuids
				: existing?.participantUserUuids,
			participantProfiles: hasOwn(session, "participantProfiles")
				? session.participantProfiles
				: existing?.participantProfiles,
		} as MergeableSession);
	}
	return Array.from(byId.values());
}
