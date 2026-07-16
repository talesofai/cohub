import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { UserChannelCredentialEnvelope } from "@cohub/db";

const ALGORITHM = "aes-256-gcm";
const NONCE_LENGTH = 12;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const BASE64URL_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type ChannelCredentialContext = {
  channelId: string;
  userUuid: string;
  provider: string;
};

export type ChannelCredentialKeyring = {
  primaryKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
};

export class ChannelCredentialError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChannelCredentialError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeKey = (keyId: string, encoded: unknown) => {
  if (typeof encoded !== "string" || !BASE64URL_KEY_PATTERN.test(encoded)) {
    throw new ChannelCredentialError(`Channel credential key ${keyId} must be an unpadded base64url 32-byte key`);
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) {
    throw new ChannelCredentialError(`Channel credential key ${keyId} must decode to 32 bytes`);
  }
  return key;
};

export const parseChannelCredentialKeyring = (
  keysJson: string,
  primaryKeyId: string,
): ChannelCredentialKeyring => {
  const normalizedPrimaryKeyId = primaryKeyId.trim();
  if (!KEY_ID_PATTERN.test(normalizedPrimaryKeyId)) {
    throw new ChannelCredentialError("CHANNEL_CREDENTIAL_PRIMARY_KEY_ID is invalid");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(keysJson);
  } catch (cause) {
    throw new ChannelCredentialError("CHANNEL_CREDENTIAL_KEYS must be a JSON object", { cause });
  }
  if (!isRecord(parsed) || Object.keys(parsed).length === 0) {
    throw new ChannelCredentialError("CHANNEL_CREDENTIAL_KEYS must contain at least one key");
  }

  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of Object.entries(parsed)) {
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new ChannelCredentialError(`Channel credential key id ${keyId} is invalid`);
    }
    keys.set(keyId, decodeKey(keyId, encoded));
  }
  if (!keys.has(normalizedPrimaryKeyId)) {
    throw new ChannelCredentialError("CHANNEL_CREDENTIAL_PRIMARY_KEY_ID is not present in CHANNEL_CREDENTIAL_KEYS");
  }
  return { primaryKeyId: normalizedPrimaryKeyId, keys };
};

let configuredKeyring: ChannelCredentialKeyring | null = null;

export const getChannelCredentialKeyring = () => {
  configuredKeyring ??= parseChannelCredentialKeyring(
    process.env.CHANNEL_CREDENTIAL_KEYS ?? "",
    process.env.CHANNEL_CREDENTIAL_PRIMARY_KEY_ID ?? "",
  );
  return configuredKeyring;
};

const buildAdditionalAuthenticatedData = (context: ChannelCredentialContext) =>
  Buffer.from(
    ["cohub", "user-channel-credentials", "v1", context.channelId, context.userUuid, context.provider].join("\0"),
    "utf8",
  );

const parseEnvelope = (value: unknown): UserChannelCredentialEnvelope => {
  if (
    !isRecord(value)
    || value.version !== 1
    || value.algorithm !== ALGORITHM
    || typeof value.keyId !== "string"
    || !KEY_ID_PATTERN.test(value.keyId)
    || typeof value.nonce !== "string"
    || typeof value.authTag !== "string"
    || typeof value.ciphertext !== "string"
  ) {
    throw new ChannelCredentialError("Channel credential envelope is invalid");
  }
  return {
    version: 1,
    keyId: value.keyId,
    algorithm: ALGORITHM,
    nonce: value.nonce,
    authTag: value.authTag,
    ciphertext: value.ciphertext,
  };
};

export const encryptChannelCredentials = (
  credentials: Record<string, unknown>,
  context: ChannelCredentialContext,
  keyring: ChannelCredentialKeyring = getChannelCredentialKeyring(),
): UserChannelCredentialEnvelope => {
  const key = keyring.keys.get(keyring.primaryKeyId);
  if (!key) throw new ChannelCredentialError(`Channel credential key ${keyring.primaryKeyId} is unavailable`);

  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(buildAdditionalAuthenticatedData(context));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);

  return {
    version: 1,
    keyId: keyring.primaryKeyId,
    algorithm: ALGORITHM,
    nonce: nonce.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
};

export const decryptChannelCredentials = (
  value: unknown,
  context: ChannelCredentialContext,
  keyring: ChannelCredentialKeyring = getChannelCredentialKeyring(),
): Record<string, unknown> => {
  const envelope = parseEnvelope(value);
  const key = keyring.keys.get(envelope.keyId);
  if (!key) throw new ChannelCredentialError(`Channel credential key ${envelope.keyId} is unavailable`);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.nonce, "base64url"));
    decipher.setAAD(buildAdditionalAuthenticatedData(context));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    const credentials: unknown = JSON.parse(plaintext);
    if (!isRecord(credentials)) throw new Error("credential payload is not an object");
    return credentials;
  } catch (cause) {
    throw new ChannelCredentialError("Channel credential envelope could not be decrypted", { cause });
  }
};

export const resolveChannelCredentials = (
  channel: ChannelCredentialContext & {
    credentialEnvelope: unknown;
  },
  keyring: ChannelCredentialKeyring = getChannelCredentialKeyring(),
) => decryptChannelCredentials(channel.credentialEnvelope, channel, keyring);

export const shouldRotateChannelCredentials = (
  value: unknown,
  keyring: ChannelCredentialKeyring = getChannelCredentialKeyring(),
) => parseEnvelope(value).keyId !== keyring.primaryKeyId;
