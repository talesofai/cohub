import type { PrincipalIdentity } from "@cohub/identity";

export type ChannelInboundOwnerIdentity = {
  userId: string;
  legacyUserUuid?: string;
};

type StoredPrincipalResolver = (principalId: string) => Promise<PrincipalIdentity>;

export async function resolveChannelInboundOwnerIdentity(
  storedUserId: string,
  resolveStoredPrincipal: StoredPrincipalResolver,
): Promise<ChannelInboundOwnerIdentity> {
  const identity = await resolveStoredPrincipal(storedUserId);
  return identity.legacyUserUuid
    ? { userId: identity.uuid, legacyUserUuid: identity.legacyUserUuid }
    : { userId: identity.uuid };
}
