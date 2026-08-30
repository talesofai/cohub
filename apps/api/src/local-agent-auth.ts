import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

export const LOCAL_AGENT_TOKEN_TTL_SECONDS = 15 * 60;
export const LOCAL_AGENT_AUTH_VERSION = 1 as const;

type LocalAgentTokenHeader = { alg: "HS256"; typ: "COHUB_LOCAL_AGENT"; v: 1 };

export type LocalAgentTokenPayload = {
  typ: "local_agent";
  v: 1;
  deviceId: string;
  userUuid: string;
  credentialVersion: number;
  iat: number;
  exp: number;
};

export type LocalAgentAuthPrincipal = LocalAgentTokenPayload & { type: "local_agent" };

const encode = (value: string | object) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const decodeJson = <T>(value: string): T => JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
const signingSecret = (secret?: string) => secret ?? config.appEncryptionKey;
const sign = (input: string, secret?: string) => {
  const key = signingSecret(secret);
  if (!key) throw new Error("APP_ENCRYPTION_KEY is required for local agent credentials");
  return createHmac("sha256", key).update(input).digest();
};

export function createLocalAgentRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashLocalAgentRefreshToken(token: string, secret?: string): string {
  return sign(`cohub-local-agent-refresh-v1\0${token}`, secret).toString("hex");
}

export function createLocalAgentToken(input: {
  deviceId: string;
  userUuid: string;
  credentialVersion: number;
  ttlSeconds?: number;
  secret?: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const header: LocalAgentTokenHeader = { alg: "HS256", typ: "COHUB_LOCAL_AGENT", v: LOCAL_AGENT_AUTH_VERSION };
  const payload: LocalAgentTokenPayload = {
    typ: "local_agent",
    v: LOCAL_AGENT_AUTH_VERSION,
    deviceId: input.deviceId,
    userUuid: input.userUuid,
    credentialVersion: input.credentialVersion,
    iat: now,
    exp: now + (input.ttlSeconds ?? LOCAL_AGENT_TOKEN_TTL_SECONDS),
  };
  const signingInput = `${encode(header)}.${encode(payload)}`;
  return `${signingInput}.${sign(signingInput, input.secret).toString("base64url")}`;
}

export function verifyLocalAgentToken(token: string, secret?: string): LocalAgentAuthPrincipal | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: LocalAgentTokenHeader;
  let payload: LocalAgentTokenPayload;
  try {
    header = decodeJson<LocalAgentTokenHeader>(headerPart);
    payload = decodeJson<LocalAgentTokenPayload>(payloadPart);
  } catch {
    return null;
  }
  if (header.alg !== "HS256" || header.typ !== "COHUB_LOCAL_AGENT" || header.v !== LOCAL_AGENT_AUTH_VERSION) return null;
  if (payload.typ !== "local_agent" || payload.v !== LOCAL_AGENT_AUTH_VERSION) return null;
  if (!payload.deviceId || !payload.userUuid || !Number.isSafeInteger(payload.credentialVersion) || payload.credentialVersion < 1) return null;
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.exp <= payload.iat || payload.exp * 1000 <= Date.now()) return null;
  let expected: Buffer;
  try {
    expected = sign(`${headerPart}.${payloadPart}`, secret);
  } catch {
    return null;
  }
  const actual = Buffer.from(signaturePart, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return { ...payload, type: "local_agent" };
}

export function refreshTokenMatches(input: { token: string; storedHash: string; secret?: string }): boolean {
  let actual: Buffer;
  let expected: Buffer;
  try {
    actual = Buffer.from(hashLocalAgentRefreshToken(input.token, input.secret), "hex");
    expected = Buffer.from(input.storedHash, "hex");
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
