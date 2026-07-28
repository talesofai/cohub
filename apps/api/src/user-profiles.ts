import { randomInt } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { AuthUser } from "./lib/middleware.js";
import { db } from "./db/index.js";
import { userProfiles } from "@cohub/db";
import { getLogtoUser, updateLogtoUserProfile } from "./logto-management.js";
import { createLogger } from "@cohub/infra/logging";


const logger = createLogger({ serviceName: "cohub-api" });
export type PublicUserProfile = {
  userUuid: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
};

export type UserProfile = PublicUserProfile & {
  logtoUserId: string;
  syncedAt: string;
};

export class UsernameConflictError extends Error {
  override name = "UsernameConflictError";
}

export class UsernameClearError extends Error {
  override name = "UsernameClearError";
}

export class LogtoUserRequiredError extends Error {
  override name = "LogtoUserRequiredError";
}

type UserProfileFields = {
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  source: Record<string, unknown>;
};

type UserProfileRow = typeof userProfiles.$inferSelect;

const USERNAME_REGEX = /^(?!-)(?!.*--)[a-z0-9-]{1,39}(?<!-)$/;
const RESERVED_USERNAMES = new Set([
  "api",
  "auth",
  "admin",
  "assets",
  "callback",
  "docs",
  "explore",
  "favicon.ico",
  "invite",
  "login",
  "logout",
  "new",
  "org",
  "pricing",
  "referrals",
  "settings",
  "sessions",
  "spaces",
  "static",
  "trending",
  "u",
  "user",
  "users",
  "teams",
  "work-auth",
]);

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const stringValue = (source: Record<string, unknown>, key: string) => {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const nestedStringValue = (source: Record<string, unknown>, path: string[]) => {
  let current: unknown = source;
  for (const key of path) current = asRecord(current)[key];
  return typeof current === "string" && current.trim() ? current.trim() : null;
};

const emailLocalPart = (value: string | null) => {
  if (!value) return null;
  const [local] = value.split("@");
  return local?.trim() || null;
};

const fallbackDisplayName = (userUuid: string) => userUuid.replaceAll("-", "").slice(0, 8);

const USERNAME_MAX_LENGTH = 39;
const DEFAULT_USERNAME_REGEX = /^[a-z][a-z0-9]*$/;
const DEFAULT_USERNAME_SUFFIX_ATTEMPTS = 8;
/** Inclusive range for conflict suffixes — wide space so common email locals rarely retry. */
const DEFAULT_USERNAME_SUFFIX_MIN = 1_000;
const DEFAULT_USERNAME_SUFFIX_MAX = 1_000_000; // 1000..999999
const DEFAULT_USERNAME_ALLOCATE_ROUNDS = 3;

/** Slugify a raw string into a base accepted by both Cohub and Logto. */
export function slugifyUsernameBase(value: string): string | null {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, USERNAME_MAX_LENGTH);
  if (!slug || !DEFAULT_USERNAME_REGEX.test(slug)) return null;
  return slug;
}

/** Email local-part → username base. Display name is intentionally not used. */
export function usernameBaseFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const local = emailLocalPart(email);
  if (!local) return null;
  return slugifyUsernameBase(local);
}

function uuidUsernameFallback(userUuid: string): string {
  const compact = userUuid.replaceAll("-", "").toLowerCase();
  // The letter prefix satisfies Logto's first-character requirement.
  return normalizeUsername(`u${compact.slice(0, 12)}`) ?? `u${compact.slice(0, 12)}`.slice(0, USERNAME_MAX_LENGTH);
}

function withRandomSuffix(base: string): string | null {
  const suffix = String(randomInt(DEFAULT_USERNAME_SUFFIX_MIN, DEFAULT_USERNAME_SUFFIX_MAX));
  const maxBaseLen = USERNAME_MAX_LENGTH - suffix.length;
  if (maxBaseLen < 1) return null;
  const trimmed = base.slice(0, maxBaseLen);
  if (!trimmed) return null;
  const candidate = `${trimmed}${suffix}`;
  if (!DEFAULT_USERNAME_REGEX.test(candidate)) return null;
  return normalizeUsername(candidate);
}

/** Build a wide candidate set: bare email base (if allowed), then random suffixes, then uuid fallback. */
export function buildDefaultUsernameCandidates(input: {
  email?: string | null;
  userUuid: string;
  randomSuffixCount?: number;
}): string[] {
  const candidates: string[] = [];
  const base = usernameBaseFromEmail(input.email ?? null);
  if (base) {
    const bare = normalizeUsername(base);
    if (bare) candidates.push(bare);
    const suffixCount = input.randomSuffixCount ?? DEFAULT_USERNAME_SUFFIX_ATTEMPTS;
    for (let i = 0; i < suffixCount; i += 1) {
      const candidate = withRandomSuffix(base);
      if (candidate) candidates.push(candidate);
    }
  }

  candidates.push(uuidUsernameFallback(input.userUuid));
  for (let i = 0; i < 4; i += 1) {
    const candidate = withRandomSuffix(`u${input.userUuid.replaceAll("-", "").toLowerCase().slice(0, 8)}`);
    if (candidate) candidates.push(candidate);
  }

  return [...new Set(candidates)];
}

async function filterLocallyAvailableUsernames(input: {
  candidates: string[];
  userUuid: string;
}): Promise<string[]> {
  if (input.candidates.length === 0) return [];

  const takenRows = await db
    .select({ username: userProfiles.username })
    .from(userProfiles)
    .where(and(
      inArray(userProfiles.username, input.candidates),
      ne(userProfiles.userUuid, input.userUuid),
    ));
  const taken = new Set(takenRows.map((row) => row.username).filter((value): value is string => Boolean(value)));
  return input.candidates.filter((candidate) => !taken.has(candidate));
}

function isLogtoUsernameConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Management client encodes status in the message: "Logto management request failed: 422 ..."
  return /Logto management request failed:\s*(409|422)\b/i.test(message);
}

export function normalizeUsername(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (!USERNAME_REGEX.test(normalized)) return null;
  if (RESERVED_USERNAMES.has(normalized)) return null;
  return normalized;
}

export function validateUsername(value: unknown) {
  if (value === null || value === undefined) {
    return { username: null, error: null };
  }
  if (typeof value !== "string") {
    return { username: null, error: "username must be a string or null" };
  }
  const normalized = normalizeUsername(value);
  if (!normalized) {
    return {
      username: null,
      error: "username must be 1-39 characters, lowercase letters, numbers, or hyphens, and cannot start or end with a hyphen",
    };
  }
  return { username: normalized, error: null };
}

function getUniqueViolationConstraint(error: unknown) {
  const record = error as { code?: string; constraint_name?: string; constraint?: string };
  if (record.code !== "23505") return null;
  return record.constraint_name ?? record.constraint ?? null;
}

export function normalizeUserProfile(input: {
  userUuid: string;
  source: Record<string, unknown>;
}): UserProfileFields {
  const source = input.source;
  const primaryEmail =
    stringValue(source, "primaryEmail") ??
    stringValue(source, "email") ??
    nestedStringValue(source, ["profile", "email"]);
  const username = normalizeUsername(
    stringValue(source, "username") ??
    nestedStringValue(source, ["profile", "username"]),
  );
  const displayName =
    stringValue(source, "name") ??
    nestedStringValue(source, ["profile", "name"]) ??
    stringValue(source, "nickname") ??
    stringValue(source, "nick_name") ??
    username ??
    emailLocalPart(primaryEmail) ??
    fallbackDisplayName(input.userUuid);
  const avatarUrl =
    stringValue(source, "avatar_url") ??
    stringValue(source, "picture") ??
    stringValue(source, "avatar") ??
    nestedStringValue(source, ["profile", "avatar"]) ??
    null;

  return {
    username,
    displayName: displayName.slice(0, 120),
    avatarUrl,
    source,
  };
}

const toUserProfile = (row: UserProfileRow): UserProfile => ({
  userUuid: row.userUuid,
  logtoUserId: row.logtoUserId,
  username: row.username ?? null,
  displayName: row.displayName,
  avatarUrl: row.avatarUrl ?? null,
  syncedAt: row.syncedAt instanceof Date ? row.syncedAt.toISOString() : new Date().toISOString(),
});

const toPublicUserProfile = (row: UserProfileRow): PublicUserProfile => ({
  userUuid: row.userUuid,
  username: row.username ?? null,
  displayName: row.displayName,
  avatarUrl: row.avatarUrl ?? null,
});

async function upsertUserProfile(input: {
  userUuid: string;
  logtoUserId: string;
  fields: UserProfileFields;
}) {
  const now = new Date();
  // Logto is the source of truth: persist fields.username as-is (including null).
  // Never rehydrate a local-only username that Logto does not have.
  const fields = input.fields;
  try {
    const [row] = await db.insert(userProfiles).values({
      userUuid: input.userUuid,
      logtoUserId: input.logtoUserId,
      username: fields.username,
      displayName: fields.displayName,
      avatarUrl: fields.avatarUrl,
      source: fields.source,
      syncedAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: userProfiles.userUuid,
      set: {
        logtoUserId: input.logtoUserId,
        username: fields.username,
        displayName: fields.displayName,
        avatarUrl: fields.avatarUrl,
        source: fields.source,
        syncedAt: now,
        updatedAt: now,
      },
    }).returning();

    if (!row) throw new Error("failed to upsert user profile");
    return toUserProfile(row);
  } catch (error) {
    const constraint = getUniqueViolationConstraint(error);
    if (constraint?.includes("username")) {
      throw new UsernameConflictError("username is already taken");
    }
    throw error;
  }
}

async function getStoredUserProfile(userUuid: string): Promise<UserProfile | null> {
  const [row] = await db.select().from(userProfiles).where(eq(userProfiles.userUuid, userUuid)).limit(1);
  return row ? toUserProfile(row) : null;
}

function sourceFromAuthUser(user: AuthUser): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(user).filter(([, value]) => value !== undefined),
  );
}

function emailFromSource(source: Record<string, unknown>): string | null {
  return (
    stringValue(source, "primaryEmail") ??
    stringValue(source, "email") ??
    nestedStringValue(source, ["profile", "email"])
  );
}

function emailFromAuthUser(user: AuthUser): string | null {
  return typeof user.email === "string" && user.email.trim() ? user.email.trim() : null;
}

/** Prefer JWT email; fall back to the synced profile source (Logto primaryEmail). */
export async function resolveCurrentUserEmail(user: AuthUser): Promise<string | null> {
  const fromAuth = emailFromAuthUser(user);
  if (fromAuth) return fromAuth;

  const [row] = await db
    .select({ source: userProfiles.source })
    .from(userProfiles)
    .where(eq(userProfiles.userUuid, user.uuid))
    .limit(1);
  if (!row) return null;
  return emailFromSource(asRecord(row.source));
}

function mergeAuthEmailIntoFields(user: AuthUser, fields: UserProfileFields): UserProfileFields {
  const authEmail = emailFromAuthUser(user);
  if (!authEmail || emailFromSource(fields.source)) return fields;
  return { ...fields, source: { ...fields.source, email: authEmail } };
}

/** Commit username to Logto first, then re-read so local can mirror SoT. */
async function commitUsernameToLogto(input: {
  userUuid: string;
  logtoUserId: string;
  username: string;
}): Promise<UserProfileFields> {
  await updateLogtoUserProfile(input.logtoUserId, { username: input.username });
  const updated = await getLogtoUser(input.logtoUserId);
  const fields = normalizeUserProfile({ userUuid: input.userUuid, source: updated });
  if (!fields.username) {
    throw new Error("Logto accepted username update but returned empty username");
  }
  return fields;
}

/**
 * Ensure Logto has a username, then return fields from Logto.
 * Never invents a local-only username. Order:
 * 1) Logto already has one (caller hot path)
 * 2) Promote an existing local username into Logto
 * 3) Allocate from email (+ wide random suffix) via Logto write
 */
async function assignDefaultUsernameViaLogto(input: {
  userUuid: string;
  logtoUserId: string;
  fields: UserProfileFields;
}): Promise<UserProfileFields> {
  if (input.fields.username) return input.fields;

  // Prefer promoting a previously cached local username into Logto (still SoT write-first).
  const stored = await getStoredUserProfile(input.userUuid);
  if (stored?.username) {
    try {
      return await commitUsernameToLogto({
        userUuid: input.userUuid,
        logtoUserId: input.logtoUserId,
        username: stored.username,
      });
    } catch (error) {
      if (!isLogtoUsernameConflict(error)) {
        logger.warn("[user-profile] Failed to promote local username to Logto:", {
          userUuid: input.userUuid,
          username: stored.username,
          error,
        });
        throw error;
      }
      // Local handle is taken in Logto globally — fall through to a fresh allocation.
      logger.warn("[user-profile] Local username conflicts in Logto; allocating a new default:", {
        userUuid: input.userUuid,
        username: stored.username,
      });
    }
  }

  const email = emailFromSource(input.fields.source);
  let lastError: unknown = null;

  for (let round = 0; round < DEFAULT_USERNAME_ALLOCATE_ROUNDS; round += 1) {
    let candidates = await filterLocallyAvailableUsernames({
      candidates: buildDefaultUsernameCandidates({
        email,
        userUuid: input.userUuid,
      }),
      userUuid: input.userUuid,
    });

    // Always keep a uuid fallback even if the local filter emptied the list.
    if (candidates.length === 0) {
      candidates = [uuidUsernameFallback(input.userUuid)];
    }

    for (const username of candidates) {
      try {
        return await commitUsernameToLogto({
          userUuid: input.userUuid,
          logtoUserId: input.logtoUserId,
          username,
        });
      } catch (error) {
        lastError = error;
        if (isLogtoUsernameConflict(error)) {
          // Try next candidate in the wide random suffix space.
          continue;
        }
        // Non-conflict Logto failures must not invent a local-only username.
        logger.warn("[user-profile] Failed to assign default username in Logto:", {
          userUuid: input.userUuid,
          username,
          error,
        });
        throw error;
      }
    }
  }

  logger.warn("[user-profile] Exhausted default username candidates for Logto assignment:", {
    userUuid: input.userUuid,
    error: lastError,
  });
  throw lastError instanceof Error
    ? lastError
    : new UsernameConflictError("unable to allocate a default username");
}

export async function ensureCurrentUserProfile(user: AuthUser): Promise<UserProfile> {
  const logtoUserId = typeof user.sub === "string" && user.sub.trim() ? user.sub.trim() : null;

  // No Logto principal → cannot mint a username (Logto is SoT). Mirror stored profile only.
  if (!logtoUserId) {
    const stored = await getStoredUserProfile(user.uuid);
    if (stored) return stored;

    return await upsertUserProfile({
      userUuid: user.uuid,
      logtoUserId: user.uuid,
      fields: normalizeUserProfile({ userUuid: user.uuid, source: sourceFromAuthUser(user) }),
    });
  }

  let logtoUser: Record<string, unknown>;
  try {
    logtoUser = await getLogtoUser(logtoUserId);
  } catch (error) {
    logger.warn("[user-profile] Failed to refresh current user from Logto, using stored profile when available:", error);
    const stored = await getStoredUserProfile(user.uuid);
    if (stored) return stored;

    // No SoT and no cache: store non-username fields only — never invent a username here.
    return await upsertUserProfile({
      userUuid: user.uuid,
      logtoUserId,
      fields: mergeAuthEmailIntoFields(
        user,
        normalizeUserProfile({ userUuid: user.uuid, source: sourceFromAuthUser(user) }),
      ),
    });
  }

  let fields = mergeAuthEmailIntoFields(
    user,
    normalizeUserProfile({ userUuid: user.uuid, source: logtoUser }),
  );

  // Hot path: Logto already has username → just sync local cache, no allocation.
  if (!fields.username) {
    try {
      // Write Logto first; only then mirror into local. Never invent local-only.
      fields = await assignDefaultUsernameViaLogto({
        userUuid: user.uuid,
        logtoUserId,
        fields,
      });
    } catch (error) {
      // Logto write failed → do not invent or keep a diverging local-only handle.
      // Preserve an existing local cache only for this response; do not overwrite
      // it with username=null (that would discard recovery data for a later retry).
      logger.warn("[user-profile] Default username assignment failed; not writing local-only username:", {
        userUuid: user.uuid,
        error,
      });
      const stored = await getStoredUserProfile(user.uuid);
      if (stored) return stored;
      // No cache yet: store non-username fields from Logto so /api/me still works.
    }
  }

  return await upsertUserProfile({
    userUuid: user.uuid,
    logtoUserId,
    fields,
  });
}

export async function updateCurrentUserProfile(user: AuthUser, input: { displayName?: string; avatarUrl?: string | null; username?: string | null }) {
  // Logto access tokens carry `sub`; execution / work / preview principals only have
  // actor uuid, so fall back to the stored profile's logtoUserId for those cases.
  const logtoUserIdFromToken = typeof user.sub === "string" && user.sub.trim() ? user.sub.trim() : null;
  const storedProfile = await getStoredUserProfile(user.uuid);
  const logtoUserId = logtoUserIdFromToken ?? storedProfile?.logtoUserId ?? null;
  if (!logtoUserId) throw new LogtoUserRequiredError("profile updates require user sign-in");

  const username = input.username === undefined ? undefined : normalizeUsername(input.username);
  if (input.username !== undefined && input.username !== null && !username) {
    throw new Error("invalid username");
  }

  const previousLogtoUser = await getLogtoUser(logtoUserId);
  const previousFields = normalizeUserProfile({ userUuid: user.uuid, source: previousLogtoUser });
  const previousUsername = storedProfile?.username ?? previousFields.username;
  if (input.username !== undefined && !username && previousUsername) {
    throw new UsernameClearError("username cannot be cleared once set");
  }

  if (username) {
    const existing = await db.select({ userUuid: userProfiles.userUuid }).from(userProfiles).where(
      and(eq(userProfiles.username, username), ne(userProfiles.userUuid, user.uuid)),
    ).limit(1);
    if (existing.length > 0) {
      throw new UsernameConflictError("username is already taken");
    }
  }

  await updateLogtoUserProfile(logtoUserId, {
    displayName: input.displayName,
    avatarUrl: input.avatarUrl,
    username: username === undefined ? undefined : username,
  });

  try {
    const updated = await getLogtoUser(logtoUserId);
    return await upsertUserProfile({
      userUuid: user.uuid,
      logtoUserId,
      fields: normalizeUserProfile({ userUuid: user.uuid, source: updated }),
    });
  } catch (error) {
    await updateLogtoUserProfile(logtoUserId, {
      displayName: previousFields.displayName,
      avatarUrl: previousFields.avatarUrl,
      username: previousFields.username,
    }).catch((rollbackError) => {
      logger.warn("[user-profile] Failed to roll back Logto profile after local update failure:", rollbackError);
    });
    throw error;
  }
}

export async function getProfilesByUuids(userUuids: string[]): Promise<Map<string, PublicUserProfile>> {
  const unique = [...new Set(userUuids.map((value) => value.trim()).filter(Boolean))];
  if (unique.length === 0) return new Map();

  const rows = await db.select().from(userProfiles).where(inArray(userProfiles.userUuid, unique));
  return new Map(rows.map((row) => [row.userUuid, toPublicUserProfile(row)]));
}

export async function getProfilesByUsernames(usernames: string[]): Promise<Map<string, PublicUserProfile>> {
  const unique = [...new Set(usernames.map((value) => normalizeUsername(value)).filter((value): value is string => Boolean(value)))];
  if (unique.length === 0) return new Map();

  const rows = await db.select().from(userProfiles).where(inArray(userProfiles.username, unique));
  return new Map(rows
    .filter((row): row is typeof row & { username: string } => Boolean(row.username))
    .map((row) => [row.username, toPublicUserProfile(row)]));
}

export async function getProfileByUsername(username: string): Promise<PublicUserProfile | null> {
  const normalized = normalizeUsername(username);
  if (!normalized) return null;
  const [row] = await db.select().from(userProfiles).where(eq(userProfiles.username, normalized)).limit(1);
  return row ? toPublicUserProfile(row) : null;
}

export function fallbackPublicUserProfile(userUuid: string): PublicUserProfile {
  return {
    userUuid,
    username: null,
    displayName: fallbackDisplayName(userUuid),
    avatarUrl: null,
  };
}
