const normalizeRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};

export const normalizeUserUuids = (userUuids: Array<string | null | undefined>) => {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const value of userUuids) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
};

export const readSessionParticipantUserUuids = (meta: unknown): string[] => {
  const base = normalizeRecord(meta);
  const participants = normalizeRecord(base.participants);
  const userUuids = Array.isArray(participants.userUuids) ? participants.userUuids : [];
  return normalizeUserUuids(userUuids.filter((value): value is string => typeof value === "string"));
};

export const setSessionParticipantsMeta = (
  meta: unknown,
  userUuids: Array<string | null | undefined>,
  now = new Date(),
): Record<string, unknown> => {
  const base = normalizeRecord(meta);
  const participants = normalizeRecord(base.participants);
  return {
    ...base,
    participants: {
      ...participants,
      version: 1,
      userUuids: normalizeUserUuids(userUuids),
      updatedAt: now.toISOString(),
    },
  };
};

export const initializeSessionParticipantsMeta = (
  meta: unknown,
  userUuid: string,
  now = new Date(),
): Record<string, unknown> => setSessionParticipantsMeta(meta, [userUuid], now);

export const addSessionParticipantMeta = (
  meta: unknown,
  userUuid: string | null | undefined,
  replacedUserUuids: Array<string | null | undefined> = [],
  now = new Date(),
): Record<string, unknown> => {
  const replaced = new Set(normalizeUserUuids(replacedUserUuids));
  const current = readSessionParticipantUserUuids(meta).filter((value) => !replaced.has(value));
  return setSessionParticipantsMeta(meta, [...current, userUuid], now);
};
