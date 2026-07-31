import { and, eq, inArray, or } from "drizzle-orm";
import { userProfiles } from "@cohub/db";
import {
  getIdentityKeys,
  resolveLegacyBillingIdentity,
  resolveStoredPrincipalIdentity,
  resolveStoredPrincipalIdentityForRead,
  resolveVerifiedPrincipalIdentityWithPersistence,
  type AuthUserProfile,
  type IdentityMappingRow,
  type PrincipalIdentity,
} from "@cohub/identity";
import { db } from "./db/index.js";

async function loadIdentityMappings(keys: readonly string[]): Promise<IdentityMappingRow[]> {
  const unique = [...new Set(keys.map((value) => value.trim()).filter(Boolean))];
  if (unique.length === 0) return [];
  return db
    .select({ userUuid: userProfiles.userUuid, logtoUserId: userProfiles.logtoUserId })
    .from(userProfiles)
    .where(or(
      inArray(userProfiles.userUuid, unique),
      inArray(userProfiles.logtoUserId, unique),
    ));
}

const stringField = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

async function persistVerifiedIdentityMapping(
  user: AuthUserProfile,
  identity: PrincipalIdentity,
): Promise<void> {
  const source = Object.fromEntries(
    Object.entries(user).filter(([, value]) => value !== undefined),
  );
  const storageUserUuid = identity.legacyUserUuid ?? identity.uuid;
  const displayName = (
    stringField(user.nick_name)
    ?? stringField(user.name)
    ?? stringField(user.email)
    ?? identity.uuid
  ).slice(0, 120);

  if (identity.legacyUserUuid && identity.legacyUserUuid !== identity.uuid) {
    const [updated] = await db.update(userProfiles).set({
      userUuid: identity.legacyUserUuid,
      updatedAt: new Date(),
    }).where(and(
      eq(userProfiles.userUuid, identity.uuid),
      eq(userProfiles.logtoUserId, identity.uuid),
    )).returning({ userUuid: userProfiles.userUuid });
    if (updated) return;
  }

  await db.insert(userProfiles).values({
    userUuid: storageUserUuid,
    logtoUserId: identity.uuid,
    displayName,
    avatarUrl: stringField(user.avatar_url),
    source,
    syncedAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();
}

export async function resolveVerifiedAuthUser(user: AuthUserProfile): Promise<AuthUserProfile> {
  const identity = await resolveVerifiedPrincipalIdentityWithPersistence({
    sub: user.uuid,
    legacyUserUuid: user.legacyUserUuid,
    loadMappings: loadIdentityMappings,
    persistMapping: async (resolved) => {
      await persistVerifiedIdentityMapping(user, resolved);
    },
  });
  return { ...user, ...identity };
}

export async function resolveStoredPrincipalUser(principalId: string): Promise<PrincipalIdentity> {
  const mappings = await loadIdentityMappings([principalId]);
  return resolveStoredPrincipalIdentity({ principalId, mappings });
}

/** Read legacy namespaces first so canonical sub config wins during merges. */
export async function resolveStoredPrincipalReadKeys(principalId: string): Promise<string[]> {
  const mappings = await loadIdentityMappings([principalId]);
  const identity = resolveStoredPrincipalIdentityForRead({ principalId, mappings });
  return [
    ...getIdentityKeys(identity).filter((key) => key !== identity.uuid),
    identity.uuid,
  ];
}

export async function resolveBillingUserId(identity: PrincipalIdentity): Promise<string> {
  const mappings = await loadIdentityMappings(getIdentityKeys(identity));
  return resolveLegacyBillingIdentity({ identity, mappings });
}

export async function resolveBillingUserIdForStoredPrincipal(principalId: string): Promise<string> {
  const mappings = await loadIdentityMappings([principalId]);
  const identity = resolveStoredPrincipalIdentity({ principalId, mappings });
  return resolveLegacyBillingIdentity({ identity, mappings });
}

export { getIdentityKeys, identityEquals } from "@cohub/identity";
