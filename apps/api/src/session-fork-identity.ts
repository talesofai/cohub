import {
  resolveStoredPrincipalIdentity,
  type IdentityMappingRow,
} from "@cohub/identity";

export const resolveCanonicalStoredUserIds = (
  userIds: readonly string[],
  mappings: readonly IdentityMappingRow[],
): Map<string, string> => {
  const resolved = new Map<string, string>();
  for (const rawUserId of userIds) {
    const userId = rawUserId.trim();
    if (!userId || resolved.has(userId)) continue;
    const matches = mappings.filter(
      (mapping) => mapping.userUuid === userId || mapping.logtoUserId === userId,
    );
    resolved.set(
      userId,
      resolveStoredPrincipalIdentity({ principalId: userId, mappings: matches }).uuid,
    );
  }
  return resolved;
};
