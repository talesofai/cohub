import { parseArgs as parseNodeArgs } from "node:util";
import type { Sql } from "postgres";
import {
  encryptChannelCredentials,
  resolveChannelCredentials,
  type ChannelCredentialKeyring,
} from "../channel-credentials.js";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1_000;

export type ChannelCredentialRotationOptions = {
  apply: boolean;
  batchSize: number;
  schema?: string;
};

type ChannelRow = {
  id: string;
  user_uuid: string;
  provider: string;
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

const readKeyId = (value: unknown) => {
  if (!isRecord(value) || typeof value.key_id !== "string" || !value.key_id) {
    throw new Error("database contains a channel credential envelope without a key id");
  }
  return value.key_id;
};

export function parseChannelCredentialRotationArgs(rawArgv: string[]): ChannelCredentialRotationOptions {
  const options = parseNodeArgs({
    args: rawArgv.filter((arg) => arg !== "--"),
    options: {
      apply: { type: "boolean", default: false },
      "batch-size": { type: "string", default: String(DEFAULT_BATCH_SIZE) },
    },
    strict: true,
  }).values;
  const rawBatchSize = Number(options["batch-size"]);
  if (!Number.isInteger(rawBatchSize) || rawBatchSize <= 0) {
    throw new Error("--batch-size must be a positive integer");
  }
  return {
    apply: options.apply,
    batchSize: Math.min(rawBatchSize, MAX_BATCH_SIZE),
  };
}

export async function rotateChannelCredentials(
  connection: Sql,
  keyring: ChannelCredentialKeyring,
  options: ChannelCredentialRotationOptions,
  log: (message: string) => void = () => undefined,
) {
  const schema = options.schema ?? "v2";
  const keyRows = await connection`
    select distinct credential_envelope ->> 'keyId' as key_id
    from ${connection(schema)}.user_channels
    where credential_envelope ->> 'keyId' is distinct from ${keyring.primaryKeyId}
  `;
  const missingKeyIds = keyRows
    .map(readKeyId)
    .filter((keyId) => !keyring.keys.has(keyId));
  if (missingKeyIds.length > 0) {
    throw new Error(`CHANNEL_CREDENTIAL_KEYS is missing: ${missingKeyIds.join(", ")}`);
  }

  const countRows = await connection`
    select count(*)::int as count
    from ${connection(schema)}.user_channels
    where credential_envelope ->> 'keyId' is distinct from ${keyring.primaryKeyId}
  `;
  const candidateCount = readCount(countRows[0]);
  if (!options.apply || candidateCount === 0) {
    return { candidateCount, processed: 0, remaining: candidateCount };
  }

  let processed = 0;
  for (;;) {
    const batchCount = await connection.begin(async (transaction) => {
      const rows = await transaction<ChannelRow[]>`
        select id, user_uuid, provider, credential_envelope
        from ${transaction(schema)}.user_channels
        where credential_envelope ->> 'keyId' is distinct from ${keyring.primaryKeyId}
        order by id
        for update skip locked
        limit ${options.batchSize}
      `;
      for (const row of rows) {
        const context = {
          channelId: row.id,
          userUuid: row.user_uuid,
          provider: row.provider,
        };
        const credentials = resolveChannelCredentials({
          ...context,
          credentialEnvelope: row.credential_envelope,
        }, keyring);
        const credentialEnvelope = encryptChannelCredentials(credentials, context, keyring);
        await transaction`
          update ${transaction(schema)}.user_channels
          set credential_envelope = ${transaction.json(credentialEnvelope)}
          where id = ${row.id}
        `;
      }
      return rows.length;
    });

    processed += batchCount;
    log(`[channel-credentials] processed=${processed}/${candidateCount}`);
    if (batchCount < options.batchSize) break;
  }

  const remainingRows = await connection`
    select count(*)::int as count
    from ${connection(schema)}.user_channels
    where credential_envelope ->> 'keyId' is distinct from ${keyring.primaryKeyId}
  `;
  return {
    candidateCount,
    processed,
    remaining: readCount(remainingRows[0]),
  };
}
