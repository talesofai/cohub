import "dotenv/config";
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: "apps/api/.env", override: false });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@cohub/db";
import {
  encryptChannelCredentials,
  parseChannelCredentialKeyring,
  resolveChannelCredentials,
  shouldRotateChannelCredentials,
  type ChannelCredentialContext,
} from "../channel-credentials.js";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1_000;

type MigrationMode = "backfill" | "rotate";

type Args = {
  apply: boolean;
  batchSize: number;
  mode: MigrationMode;
};

type ChannelRow = {
  id: string;
  user_uuid: string;
  provider: string;
  credentials: unknown;
  credential_envelope: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readCount = (value: unknown) => {
  if (!isRecord(value)) return 0;
  const count = Number(value.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("database returned an invalid count");
  return count;
};

const parseChannelRow = (value: unknown): ChannelRow => {
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || typeof value.user_uuid !== "string"
    || typeof value.provider !== "string"
  ) {
    throw new Error("database returned an invalid user channel row");
  }
  return {
    id: value.id,
    user_uuid: value.user_uuid,
    provider: value.provider,
    credentials: value.credentials,
    credential_envelope: value.credential_envelope,
  };
};

const readKeyId = (value: unknown) => {
  if (!isRecord(value) || typeof value.key_id !== "string" || !value.key_id) {
    throw new Error("database contains a channel credential envelope without a key id");
  }
  return value.key_id;
};

function parseArgs(rawArgv: string[]): Args {
  const argv = rawArgv.filter((arg) => arg !== "--");
  const readValue = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const mode = readValue("--mode") ?? "backfill";
  if (mode !== "backfill" && mode !== "rotate") {
    throw new Error("--mode must be backfill or rotate");
  }
  const rawBatchSize = Number(readValue("--batch-size") ?? DEFAULT_BATCH_SIZE);
  if (!Number.isInteger(rawBatchSize) || rawBatchSize <= 0) {
    throw new Error("--batch-size must be a positive integer");
  }
  return {
    apply: argv.includes("--apply"),
    batchSize: Math.min(rawBatchSize, MAX_BATCH_SIZE),
    mode,
  };
}

const contextFor = (row: ChannelRow): ChannelCredentialContext => ({
  channelId: row.id,
  userUuid: row.user_uuid,
  provider: row.provider,
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const keysJson = process.env.CHANNEL_CREDENTIAL_KEYS ?? "";
  const primaryKeyId = process.env.CHANNEL_CREDENTIAL_PRIMARY_KEY_ID ?? "";
  const keyring = parseChannelCredentialKeyring(keysJson, primaryKeyId);
  const connectionString = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/cohub";
  const client = postgres(connectionString, { prepare: false, max: 1 });
  const db = drizzle(client, { schema });

  try {
    const where = args.mode === "backfill"
      ? sql`credential_envelope is null and credentials is not null`
      : sql`credential_envelope is not null and credential_envelope ->> 'keyId' is distinct from ${keyring.primaryKeyId}`;
    if (args.mode === "backfill") {
      const invalidRows = await db.execute(sql`
        select count(*)::int as count
        from v2.user_channels
        where ${where} and jsonb_typeof(credentials) is distinct from 'object'
      `);
      const invalidCount = readCount(invalidRows[0]);
      if (invalidCount > 0) {
        throw new Error(`${invalidCount} legacy channel credential rows are not JSON objects`);
      }
    } else {
      const keyRows = await db.execute(sql`
        select distinct credential_envelope ->> 'keyId' as key_id
        from v2.user_channels
        where ${where}
      `);
      const missingKeyIds = keyRows
        .map(readKeyId)
        .filter((keyId) => !keyring.keys.has(keyId));
      if (missingKeyIds.length > 0) {
        throw new Error(`CHANNEL_CREDENTIAL_KEYS is missing: ${missingKeyIds.join(", ")}`);
      }
    }
    const countRows = await db.execute(sql`
      select count(*)::int as count
      from v2.user_channels
      where ${where}
    `);
    const candidateCount = readCount(countRows[0]);
    console.log(
      `[channel-credentials] mode=${args.mode} candidates=${candidateCount} primaryKeyId=${keyring.primaryKeyId} apply=${args.apply}`,
    );
    if (!args.apply || candidateCount === 0) return;

    let processed = 0;
    for (;;) {
      const batchCount = await db.transaction(async (tx) => {
        const result = await tx.execute(sql`
          select id, user_uuid, provider, credentials, credential_envelope
          from v2.user_channels
          where ${where}
          order by id
          for update skip locked
          limit ${args.batchSize}
        `);
        const rows = result.map(parseChannelRow);

        for (const row of rows) {
          const context = contextFor(row);
          const credentials = resolveChannelCredentials({
            ...context,
            credentials: row.credentials,
            credentialEnvelope: row.credential_envelope,
          }, keyring);
          if (
            args.mode === "rotate"
            && !shouldRotateChannelCredentials(row.credential_envelope, keyring)
          ) {
            continue;
          }
          const envelope = encryptChannelCredentials(credentials, context, keyring);
          await tx.execute(sql`
            update v2.user_channels
            set credential_envelope = ${JSON.stringify(envelope)}::jsonb,
                credentials = null
            where id = ${row.id}
          `);
        }
        return rows.length;
      });

      processed += batchCount;
      console.log(`[channel-credentials] processed=${processed}/${candidateCount}`);
      if (batchCount < args.batchSize) break;
    }

    const remainingRows = await db.execute(sql`
      select count(*)::int as count
      from v2.user_channels
      where ${where}
    `);
    const remaining = readCount(remainingRows[0]);
    if (remaining !== 0) throw new Error(`${remaining} channel credentials still require ${args.mode}`);
    console.log(`[channel-credentials] ${args.mode} complete`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[channel-credentials] failed", error);
  process.exit(1);
});
