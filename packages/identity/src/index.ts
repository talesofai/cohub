import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/** API resource / audience used when verifying access tokens. */
export const AUTH_RESOURCE =
  process.env.AUTH_RESOURCE?.trim() ||
  process.env.LOGTO_API_RESOURCE?.trim() ||
  "https://api.talesofai";

const DEFAULT_LOGTO_ENDPOINT_BY_ENV = {
  dev: "https://dev-auth.neta.art",
  prod: "https://auth.neta.art",
} as const;

export type AuthEnv = keyof typeof DEFAULT_LOGTO_ENDPOINT_BY_ENV;

export type AuthUserProfile = {
  id?: number;
  /** Canonical verified Logto subject for the current issuer. */
  uuid: string;
  /** Legacy Cohub/TalesofAI UUID accepted only for migration reads. */
  legacyUserUuid?: string;
  nick_name?: string;
  phone_num?: string;
  avatar_url?: string;
  sub?: string;
  clientId?: string;
  organizationId?: string;
  scopes?: string[];
  audience?: string[];
  [key: string]: unknown;
};

export type PrincipalIdentity = Pick<AuthUserProfile, "uuid" | "legacyUserUuid">;

export type IdentityMappingRow = {
  userUuid: string;
  logtoUserId: string;
};

export class IdentityMappingConflictError extends Error {
  override name = "IdentityMappingConflictError";
}

export class UnresolvedLegacyIdentityError extends Error {
  override name = "UnresolvedLegacyIdentityError";
}

export class BillingIdentityUnavailableError extends Error {
  override name = "BillingIdentityUnavailableError";
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHORT_UUID_REGEX = /^[0-9a-f]{32}$/i;
const STORAGE_SAFE_PRINCIPAL_ID_REGEX = /^[A-Za-z0-9_-]{1,255}$/;

const normalizeIdentityValue = (value: string | null | undefined) => value?.trim() || null;

export const isLegacyUserUuid = (value: string | null | undefined): value is string => {
  const normalized = normalizeIdentityValue(value);
  return Boolean(normalized && (UUID_REGEX.test(normalized) || SHORT_UUID_REGEX.test(normalized)));
};

export const isStorageSafePrincipalId = (value: string | null | undefined): value is string => {
  const normalized = normalizeIdentityValue(value);
  return Boolean(normalized && STORAGE_SAFE_PRINCIPAL_ID_REGEX.test(normalized));
};

export const getIdentityKeys = (
  identity: { uuid?: string | null; legacyUserUuid?: string | null } | null | undefined,
): string[] => {
  if (!identity) return [];
  return [...new Set([identity.uuid, identity.legacyUserUuid]
    .map(normalizeIdentityValue)
    .filter((value): value is string => Boolean(value)))];
};

export const identityEquals = (
  identity: { uuid?: string | null; legacyUserUuid?: string | null } | null | undefined,
  storedId: string | null | undefined,
) => {
  const normalized = normalizeIdentityValue(storedId);
  return Boolean(normalized && getIdentityKeys(identity).includes(normalized));
};

const singleMapping = (rows: readonly IdentityMappingRow[]): IdentityMappingRow | null => {
  const unique = new Map<string, IdentityMappingRow>();
  for (const row of rows) {
    const userUuid = normalizeIdentityValue(row.userUuid);
    const logtoUserId = normalizeIdentityValue(row.logtoUserId);
    if (!userUuid || !logtoUserId) continue;
    unique.set(`${userUuid}\u0000${logtoUserId}`, { userUuid, logtoUserId });
  }
  if (unique.size > 1) {
    throw new IdentityMappingConflictError("identity aliases resolve to different profile rows");
  }
  return unique.values().next().value ?? null;
};

export function resolveVerifiedPrincipalIdentity(input: {
  sub: string;
  legacyUserUuid?: string | null;
  mappings: readonly IdentityMappingRow[];
}): PrincipalIdentity {
  const sub = normalizeIdentityValue(input.sub);
  if (!sub) throw new IdentityMappingConflictError("verified principal sub is empty");
  const claimedLegacyUserUuid = normalizeIdentityValue(input.legacyUserUuid);
  const mapping = singleMapping(input.mappings);
  if (mapping && mapping.logtoUserId !== sub) {
    throw new IdentityMappingConflictError("verified principal conflicts with the stored Logto subject");
  }
  if (
    mapping
    && mapping.userUuid !== sub
    && claimedLegacyUserUuid
    && mapping.userUuid !== claimedLegacyUserUuid
  ) {
    throw new IdentityMappingConflictError("verified principal legacy UUID conflicts with the stored alias");
  }
  const legacyUserUuid = claimedLegacyUserUuid
    ?? (mapping?.userUuid !== sub ? mapping?.userUuid : undefined);
  return legacyUserUuid && legacyUserUuid !== sub
    ? { uuid: sub, legacyUserUuid }
    : { uuid: sub };
}

export async function resolveVerifiedPrincipalIdentityWithPersistence(input: {
  sub: string;
  legacyUserUuid?: string | null;
  loadMappings: (keys: readonly string[]) => Promise<readonly IdentityMappingRow[]>;
  persistMapping: (identity: PrincipalIdentity) => Promise<void>;
}): Promise<PrincipalIdentity> {
  const claimedIdentity = {
    uuid: input.sub,
    legacyUserUuid: input.legacyUserUuid ?? undefined,
  };
  let mappings = await input.loadMappings(getIdentityKeys(claimedIdentity));
  let identity = resolveVerifiedPrincipalIdentity({
    sub: input.sub,
    legacyUserUuid: input.legacyUserUuid,
    mappings,
  });
  const expectedStorageUserId = identity.legacyUserUuid ?? identity.uuid;
  const isPersisted = () => mappings.some((row) =>
    normalizeIdentityValue(row.userUuid) === expectedStorageUserId
    && normalizeIdentityValue(row.logtoUserId) === identity.uuid);
  if (isPersisted()) return identity;

  await input.persistMapping(identity);
  mappings = await input.loadMappings(getIdentityKeys(identity));
  if (!isPersisted()) {
    throw new IdentityMappingConflictError("verified principal mapping was not persisted");
  }
  identity = resolveVerifiedPrincipalIdentity({
    sub: input.sub,
    legacyUserUuid: input.legacyUserUuid,
    mappings,
  });
  return identity;
}

export function resolveStoredPrincipalIdentity(input: {
  principalId: string;
  mappings: readonly IdentityMappingRow[];
  requireLegacyMapping?: boolean;
}): PrincipalIdentity {
  const principalId = normalizeIdentityValue(input.principalId);
  if (!principalId) throw new UnresolvedLegacyIdentityError("signed principal identity is empty");
  const mapping = singleMapping(input.mappings);
  if (mapping) {
    return mapping.userUuid !== mapping.logtoUserId
      ? { uuid: mapping.logtoUserId, legacyUserUuid: mapping.userUuid }
      : { uuid: mapping.logtoUserId };
  }
  if (input.requireLegacyMapping !== false && isLegacyUserUuid(principalId)) {
    throw new UnresolvedLegacyIdentityError("legacy UUID has no canonical Logto subject mapping");
  }
  return { uuid: principalId };
}

/**
 * Read-only compatibility for legacy namespaces. A UUID with no mapping may
 * still name an existing UUID-backed directory/cache, but mapping conflicts
 * and invalid principals remain hard failures.
 */
export function resolveStoredPrincipalIdentityForRead(input: {
  principalId: string;
  mappings: readonly IdentityMappingRow[];
}): PrincipalIdentity {
  try {
    return resolveStoredPrincipalIdentity(input);
  } catch (error) {
    if (error instanceof UnresolvedLegacyIdentityError && isLegacyUserUuid(input.principalId)) {
      return { uuid: input.principalId.trim() };
    }
    throw error;
  }
}

export function resolveLegacyBillingIdentity(input: {
  identity: PrincipalIdentity;
  mappings: readonly IdentityMappingRow[];
}): string {
  const mapping = singleMapping(input.mappings);
  if (mapping && mapping.logtoUserId !== input.identity.uuid) {
    throw new IdentityMappingConflictError("billing identity conflicts with the stored Logto subject");
  }
  const claimed = isLegacyUserUuid(input.identity.legacyUserUuid)
    ? input.identity.legacyUserUuid.trim()
    : null;
  const stored = mapping
    && mapping.userUuid !== mapping.logtoUserId
    && isLegacyUserUuid(mapping.userUuid)
    ? mapping.userUuid
    : null;
  if (claimed && stored && claimed !== stored) {
    throw new IdentityMappingConflictError("billing UUID conflicts with the stored legacy alias");
  }
  const resolved = claimed ?? stored;
  if (!resolved) {
    throw new BillingIdentityUnavailableError("legacy billing UUID is unavailable");
  }
  return resolved;
}

export class AuthorizationError extends Error {
  override name = "AuthorizationError";

  constructor(
    message: string,
    public readonly status: 401 | 403 = 401,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/, "");

export const getDefaultLogtoEndpoint = (env: AuthEnv) => DEFAULT_LOGTO_ENDPOINT_BY_ENV[env];

export const resolveLogtoEndpoint = (input?: { endpoint?: string | null; env?: string | null }) => {
  const endpoint = input?.endpoint?.trim();
  if (endpoint) return normalizeBaseUrl(endpoint);
  return getDefaultLogtoEndpoint(input?.env === "prod" ? "prod" : "dev");
};

const jwksByEndpoint = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const getJwks = (logtoEndpoint: string) => {
  const normalized = normalizeBaseUrl(logtoEndpoint);
  const existing = jwksByEndpoint.get(normalized);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(`${normalized}/oidc/jwks`));
  jwksByEndpoint.set(normalized, jwks);
  return jwks;
};

const stringClaim = (payload: JWTPayload, key: string) => {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const booleanClaim = (payload: JWTPayload, key: string) => payload[key] === true;

const audienceClaims = (audience: JWTPayload["aud"]) => {
  if (!audience) return [];
  return Array.isArray(audience) ? audience.filter((value): value is string => typeof value === "string") : [audience];
};

const scopeClaims = (payload: JWTPayload) => {
  const value = payload.scope;
  return typeof value === "string" ? value.split(" ").filter(Boolean) : [];
};

const numberIdClaim = (payload: JWTPayload, key: string) => {
  const value = payload[key];
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

export async function verifyUserAccessToken(input: {
  token: string;
  logtoEndpoint: string;
}): Promise<AuthUserProfile> {
  const logtoEndpoint = normalizeBaseUrl(input.logtoEndpoint);
  const issuer = `${logtoEndpoint}/oidc`;

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(input.token, getJwks(logtoEndpoint), {
      issuer,
      audience: AUTH_RESOURCE,
    }));
  } catch (error) {
    throw new AuthorizationError("Jwt is invalid", 401, error);
  }

  if (!payload.sub) {
    throw new AuthorizationError("Jwt sub is missing", 401);
  }

  if (booleanClaim(payload, "is_third_party")) {
    throw new AuthorizationError("Current service does not allow third-party access", 403);
  }

  const clientId = stringClaim(payload, "client_id");
  if (!clientId) {
    throw new AuthorizationError("Jwt client_id is missing", 401);
  }

  const legacyUserUuid = stringClaim(payload, "talesofai_uuid");

  const nickName = stringClaim(payload, "nick_name") ?? stringClaim(payload, "name") ?? stringClaim(payload, "username");
  const avatarUrl = stringClaim(payload, "avatar_url") ?? stringClaim(payload, "picture");
  const phoneNumber = stringClaim(payload, "phone_num") ?? stringClaim(payload, "phone_number");

  return {
    id: numberIdClaim(payload, "talesofai_id"),
    uuid: payload.sub,
    legacyUserUuid,
    nick_name: nickName,
    phone_num: phoneNumber,
    avatar_url: avatarUrl,
    sub: payload.sub,
    clientId,
    organizationId: stringClaim(payload, "organization_id"),
    scopes: scopeClaims(payload),
    audience: audienceClaims(payload.aud),
    email: stringClaim(payload, "email"),
  };
}
