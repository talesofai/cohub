import { inArray, or } from "drizzle-orm";
import { userProfiles } from "@cohub/db";
import {
  resolveStoredPrincipalIdentity,
  resolveStoredPrincipalIdentityForRead,
  type IdentityMappingRow,
} from "@cohub/identity";
import { db } from "./db.js";

export async function resolveStoredPrincipalIdentityForAgent(principalId: string) {
  const normalized = principalId.trim();
  const mappings: IdentityMappingRow[] = await db
    .select({ userUuid: userProfiles.userUuid, logtoUserId: userProfiles.logtoUserId })
    .from(userProfiles)
    .where(or(
      inArray(userProfiles.userUuid, [normalized]),
      inArray(userProfiles.logtoUserId, [normalized]),
    ));
  return resolveStoredPrincipalIdentity({ principalId: normalized, mappings });
}

export async function resolveStoredPrincipalIdentityForAgentRead(principalId: string) {
  const normalized = principalId.trim();
  const mappings: IdentityMappingRow[] = await db
    .select({ userUuid: userProfiles.userUuid, logtoUserId: userProfiles.logtoUserId })
    .from(userProfiles)
    .where(or(
      inArray(userProfiles.userUuid, [normalized]),
      inArray(userProfiles.logtoUserId, [normalized]),
    ));
  return resolveStoredPrincipalIdentityForRead({ principalId: normalized, mappings });
}
