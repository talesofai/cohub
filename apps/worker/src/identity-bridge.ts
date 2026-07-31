import { inArray, or } from "drizzle-orm";
import { userProfiles } from "@cohub/db";
import {
  getIdentityKeys,
  resolveLegacyBillingIdentity,
  resolveStoredPrincipalIdentity,
  resolveStoredPrincipalIdentityForRead,
  type IdentityMappingRow,
} from "@cohub/identity";
import { db } from "./db.js";

async function loadIdentityMappings(principalId: string): Promise<IdentityMappingRow[]> {
  const normalized = principalId.trim();
  if (!normalized) return [];
  return db
    .select({ userUuid: userProfiles.userUuid, logtoUserId: userProfiles.logtoUserId })
    .from(userProfiles)
    .where(or(
      inArray(userProfiles.userUuid, [normalized]),
      inArray(userProfiles.logtoUserId, [normalized]),
    ));
}

export async function resolveStoredPrincipalIdentityForWorker(principalId: string) {
  const mappings = await loadIdentityMappings(principalId);
  return resolveStoredPrincipalIdentity({ principalId, mappings });
}

/** Read legacy namespaces first so canonical sub config wins during merges. */
export async function resolveStoredPrincipalReadKeysForWorker(principalId: string): Promise<string[]> {
  const mappings = await loadIdentityMappings(principalId);
  const identity = resolveStoredPrincipalIdentityForRead({ principalId, mappings });
  return [
    ...getIdentityKeys(identity).filter((key) => key !== identity.uuid),
    identity.uuid,
  ];
}

export async function resolveBillingUserIdForStoredPrincipal(principalId: string): Promise<string> {
  const mappings = await loadIdentityMappings(principalId);
  const identity = resolveStoredPrincipalIdentity({ principalId, mappings });
  return resolveLegacyBillingIdentity({ identity, mappings });
}
