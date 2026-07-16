import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import postgres from "postgres";
import {
  decryptChannelCredentials,
  encryptChannelCredentials,
  parseChannelCredentialKeyring,
  resolveChannelCredentials,
} from "../channel-credentials.js";
import {
  parseChannelCredentialRotationArgs,
  rotateChannelCredentials,
} from "./channel-credential-rotation.js";
import { migrateLegacyUserChannels } from "./migrate-legacy-user-channels.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const key = (byte: number) => Buffer.alloc(32, byte).toString("base64url");

const hasSqlState = (error: unknown, code: string) => {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

test("user channel schema stores only non-null credential envelopes", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  if (!databaseUrl) return;

  const connection = postgres(databaseUrl, { prepare: false, max: 2 });
  const channelId = randomUUID();
  const userUuid = randomUUID();
  const provider = "contract-test";
  const credentials = { token: "secret", nested: { enabled: true } };
  const keyring = parseChannelCredentialKeyring(JSON.stringify({ test: key(1) }), "test");
  try {
    const columns = await connection<{ column_name: string; is_nullable: "YES" | "NO" }[]>`
      select column_name, is_nullable
      from information_schema.columns
      where table_schema = 'v2' and table_name = 'user_channels'
    `;
    const columnNullability = new Map(columns.map((column) => [column.column_name, column.is_nullable]));
    assert.equal(columnNullability.has("credentials"), false);
    assert.equal(columnNullability.get("credential_envelope"), "NO");

    await assert.rejects(
      connection`
        insert into v2.user_channels (id, user_uuid, provider)
        values (${channelId}, ${userUuid}, ${provider})
      `,
      (error: unknown) => hasSqlState(error, "23502"),
    );

    const credentialEnvelope = encryptChannelCredentials(
      credentials,
      { channelId, userUuid, provider },
      keyring,
    );
    await connection`
      insert into v2.user_channels (id, user_uuid, provider, credential_envelope)
      values (${channelId}, ${userUuid}, ${provider}, ${connection.json(credentialEnvelope)})
    `;
    const [stored] = await connection<{ credential_envelope: unknown }[]>`
      select credential_envelope
      from v2.user_channels
      where id = ${channelId}
    `;
    assert.ok(stored);
    assert.deepEqual(resolveChannelCredentials({
      channelId,
      userUuid,
      provider,
      credentialEnvelope: stored.credential_envelope,
    }, keyring), credentials);
  } finally {
    await connection`delete from v2.user_channels where id = ${channelId}`;
    await connection.end();
  }
});

test("legacy user channel migration encrypts rows before writing v2 data", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  if (!databaseUrl) return;

  const connection = postgres(databaseUrl, { prepare: false, max: 2 });
  const suffix = randomUUID().replaceAll("-", "");
  const sourceSchema = `test_channel_source_${suffix}`;
  const targetSchema = `test_channel_target_${suffix}`;
  const channelId = randomUUID();
  const userUuid = randomUUID();
  const provider = "legacy-test";
  const credentials = { token: "legacy-secret" };
  const keyring = parseChannelCredentialKeyring(JSON.stringify({ migration: key(2) }), "migration");
  try {
    await connection`create schema ${connection(sourceSchema)}`;
    await connection`create schema ${connection(targetSchema)}`;
    await connection`
      create table ${connection(sourceSchema)}.user_channels (
        id uuid primary key,
        user_uuid varchar(255) not null,
        provider varchar(50) not null,
        name varchar(255),
        credentials jsonb,
        status varchar(20),
        created_at timestamptz,
        updated_at timestamptz
      )
    `;
    await connection`
      create table ${connection(targetSchema)}.user_channels (
        id uuid primary key,
        user_uuid varchar(255) not null,
        provider varchar(50) not null,
        name varchar(255),
        credential_envelope jsonb not null,
        status varchar(20),
        created_at timestamptz,
        updated_at timestamptz
      )
    `;
    await connection`
      insert into ${connection(sourceSchema)}.user_channels (
        id, user_uuid, provider, name, credentials, status
      ) values (
        ${channelId}, ${userUuid}, ${provider}, 'Legacy', ${connection.json(credentials)}, 'active'
      )
    `;

    assert.equal(await migrateLegacyUserChannels(connection, {
      sourceSchema,
      targetSchema,
      keyring,
    }), 1);
    assert.equal(await migrateLegacyUserChannels(connection, {
      sourceSchema,
      targetSchema,
      keyring,
    }), 0);

    const [migrated] = await connection<{
      id: string;
      credential_envelope: unknown;
    }[]>`
      select id, credential_envelope
      from ${connection(targetSchema)}.user_channels
    `;
    assert.equal(migrated?.id, channelId);
    assert.deepEqual(decryptChannelCredentials(
      migrated?.credential_envelope,
      { channelId, userUuid, provider },
      keyring,
    ), credentials);

    await connection`truncate ${connection(targetSchema)}.user_channels`;
    await connection`
      insert into ${connection(sourceSchema)}.user_channels (
        id, user_uuid, provider, credentials
      ) values (
        ${randomUUID()}, ${randomUUID()}, 'invalid', '[]'::jsonb
      )
    `;
    await assert.rejects(
      migrateLegacyUserChannels(connection, { sourceSchema, targetSchema, keyring }),
      /credentials are not a JSON object/,
    );
    const [remaining] = await connection<{ count: number }[]>`
      select count(*)::int as count
      from ${connection(targetSchema)}.user_channels
    `;
    assert.equal(remaining?.count, 0);
  } finally {
    await connection`drop schema if exists ${connection(sourceSchema)} cascade`;
    await connection`drop schema if exists ${connection(targetSchema)} cascade`;
    await connection.end();
  }
});

test("channel credential rotation is dry-run first and preserves logical revision", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  if (!databaseUrl) return;

  const connection = postgres(databaseUrl, { prepare: false, max: 2 });
  const schema = `test_channel_rotation_${randomUUID().replaceAll("-", "")}`;
  const channelId = randomUUID();
  const userUuid = randomUUID();
  const provider = "rotation-test";
  const credentials = { token: "rotate-me" };
  const oldKeyring = parseChannelCredentialKeyring(JSON.stringify({ old: key(3) }), "old");
  const rotatingKeyring = parseChannelCredentialKeyring(
    JSON.stringify({ old: key(3), current: key(4) }),
    "current",
  );
  const oldEnvelope = encryptChannelCredentials(
    credentials,
    { channelId, userUuid, provider },
    oldKeyring,
  );
  try {
    await connection`create schema ${connection(schema)}`;
    await connection`
      create table ${connection(schema)}.user_channels (
        id uuid primary key,
        user_uuid varchar(255) not null,
        provider varchar(50) not null,
        credential_envelope jsonb not null,
        credential_revision integer not null
      )
    `;
    await connection`
      insert into ${connection(schema)}.user_channels (
        id, user_uuid, provider, credential_envelope, credential_revision
      ) values (
        ${channelId},
        ${userUuid},
        ${provider},
        ${connection.json(oldEnvelope)},
        7
      )
    `;

    assert.deepEqual(parseChannelCredentialRotationArgs(["--batch-size", "1"]), {
      apply: false,
      batchSize: 1,
    });
    const preview = await rotateChannelCredentials(connection, rotatingKeyring, {
      apply: false,
      batchSize: 1,
      schema,
    });
    assert.deepEqual(preview, { candidateCount: 1, processed: 0, remaining: 1 });

    const [afterPreview] = await connection<{
      credential_envelope: { keyId?: unknown };
      credential_revision: number;
    }[]>`
      select credential_envelope, credential_revision
      from ${connection(schema)}.user_channels
      where id = ${channelId}
    `;
    assert.equal(afterPreview?.credential_envelope.keyId, "old");
    assert.equal(afterPreview?.credential_revision, 7);

    const applied = await rotateChannelCredentials(connection, rotatingKeyring, {
      apply: true,
      batchSize: 1,
      schema,
    });
    assert.deepEqual(applied, { candidateCount: 1, processed: 1, remaining: 0 });
    const [rotated] = await connection<{
      credential_envelope: unknown;
      credential_revision: number;
    }[]>`
      select credential_envelope, credential_revision
      from ${connection(schema)}.user_channels
      where id = ${channelId}
    `;
    assert.equal(rotated?.credential_revision, 7);
    assert.deepEqual(decryptChannelCredentials(
      rotated?.credential_envelope,
      { channelId, userUuid, provider },
      rotatingKeyring,
    ), credentials);
  } finally {
    await connection`drop schema if exists ${connection(schema)} cascade`;
    await connection.end();
  }
});
