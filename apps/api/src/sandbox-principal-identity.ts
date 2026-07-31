import type { PrincipalIdentity } from "@cohub/identity";

type StoredPrincipalResolver = (principalId: string) => Promise<PrincipalIdentity>;

export type ResolvedSandboxPrincipalIdentities = {
  actorIdentity: PrincipalIdentity;
  ownerIdentity: PrincipalIdentity;
  userId: string;
  ownerUserId: string;
};

export async function resolveSandboxPrincipalIdentities(
  input: { userUuid: string; ownerUserUuid?: string },
  resolveStoredPrincipal: StoredPrincipalResolver,
): Promise<ResolvedSandboxPrincipalIdentities> {
  const actorIdentity = await resolveStoredPrincipal(input.userUuid);
  const storedOwnerUserId = input.ownerUserUuid ?? input.userUuid;
  const ownerIdentity = storedOwnerUserId.trim() === input.userUuid.trim()
    ? actorIdentity
    : await resolveStoredPrincipal(storedOwnerUserId);
  return {
    actorIdentity,
    ownerIdentity,
    userId: actorIdentity.uuid,
    ownerUserId: ownerIdentity.uuid,
  };
}
