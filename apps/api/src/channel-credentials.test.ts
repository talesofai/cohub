import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChannelCredentialError,
  decryptChannelCredentials,
  encryptChannelCredentials,
  parseChannelCredentialKeyring,
  resolveChannelCredentials,
  shouldRotateChannelCredentials,
} from "./channel-credentials.js";

const key = (byte: number) => Buffer.alloc(32, byte).toString("base64url");
const context = { channelId: "channel-1", userUuid: "user-1", provider: "discord" };

test("channel credential envelopes round-trip and bind ciphertext to its row", () => {
  const keyring = parseChannelCredentialKeyring(JSON.stringify({ current: key(1) }), "current");
  const envelope = encryptChannelCredentials({ token: "secret", nested: { enabled: true } }, context, keyring);

  assert.deepEqual(decryptChannelCredentials(envelope, context, keyring), {
    token: "secret",
    nested: { enabled: true },
  });
  assert.throws(
    () => decryptChannelCredentials(envelope, { ...context, channelId: "channel-2" }, keyring),
    ChannelCredentialError,
  );
});

test("legacy plaintext rows remain readable during backfill", () => {
  const keyring = parseChannelCredentialKeyring(JSON.stringify({ current: key(1) }), "current");
  assert.deepEqual(resolveChannelCredentials({
    ...context,
    credentials: { token: "legacy" },
    credentialEnvelope: null,
  }, keyring), { token: "legacy" });
});

test("key rotation decrypts old envelopes and writes with the primary key", () => {
  const oldKeyring = parseChannelCredentialKeyring(JSON.stringify({ old: key(1) }), "old");
  const rotatingKeyring = parseChannelCredentialKeyring(
    JSON.stringify({ old: key(1), current: key(2) }),
    "current",
  );
  const oldEnvelope = encryptChannelCredentials({ token: "secret" }, context, oldKeyring);

  assert.equal(shouldRotateChannelCredentials(oldEnvelope, rotatingKeyring), true);
  const credentials = decryptChannelCredentials(oldEnvelope, context, rotatingKeyring);
  const newEnvelope = encryptChannelCredentials(credentials, context, rotatingKeyring);
  assert.equal(newEnvelope.keyId, "current");
  assert.equal(shouldRotateChannelCredentials(newEnvelope, rotatingKeyring), false);
});

test("keyring rejects malformed and missing primary keys", () => {
  assert.throws(() => parseChannelCredentialKeyring("{}", "current"), ChannelCredentialError);
  assert.throws(
    () => parseChannelCredentialKeyring(JSON.stringify({ old: key(1) }), "current"),
    ChannelCredentialError,
  );
});
