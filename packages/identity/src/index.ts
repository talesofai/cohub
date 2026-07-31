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
  uuid: string;
  nick_name?: string;
  phone_num?: string;
  avatar_url?: string;
  sub?: string;
  clientId?: string;
  organizationId?: string;
  scopes?: string[];
  audience?: string[];
  /** Verified JWT `exp` claim, in epoch seconds. */
  tokenExpiresAt?: number;
  [key: string]: unknown;
};

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

  const uuid = stringClaim(payload, "talesofai_uuid");
  if (!uuid) {
    throw new AuthorizationError("Jwt talesofai_uuid is missing", 401);
  }

  const nickName = stringClaim(payload, "nick_name") ?? stringClaim(payload, "name") ?? stringClaim(payload, "username");
  const avatarUrl = stringClaim(payload, "avatar_url") ?? stringClaim(payload, "picture");
  const phoneNumber = stringClaim(payload, "phone_num") ?? stringClaim(payload, "phone_number");

  return {
    id: numberIdClaim(payload, "talesofai_id"),
    uuid,
    nick_name: nickName,
    phone_num: phoneNumber,
    avatar_url: avatarUrl,
    sub: payload.sub,
    clientId,
    organizationId: stringClaim(payload, "organization_id"),
    scopes: scopeClaims(payload),
    audience: audienceClaims(payload.aud),
    email: stringClaim(payload, "email"),
    tokenExpiresAt: payload.exp,
  };
}
