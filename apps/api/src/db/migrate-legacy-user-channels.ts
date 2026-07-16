import type { ChannelCredentialKeyring } from "../channel-credentials.js";
import { encryptChannelCredentials } from "../channel-credentials.js";
import type { Sql } from "postgres";

type LegacyUserChannelRow = {
  id: string;
  user_uuid: string;
  provider: string;
  name: string | null;
  credentials: unknown;
  status: string | null;
  created_at: Date | null;
  updated_at: Date | null;
};

type MigratedUserChannelRow = Omit<LegacyUserChannelRow, "credentials"> & {
  credential_envelope: ReturnType<typeof encryptChannelCredentials>;
};

type MigrationOptions = {
  sourceSchema?: string;
  targetSchema?: string;
  keyring?: ChannelCredentialKeyring;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

export async function migrateLegacyUserChannels(
  connection: Sql,
  options: MigrationOptions = {},
) {
  const sourceSchema = options.sourceSchema ?? "public";
  const targetSchema = options.targetSchema ?? "v2";
  const legacyChannels = await connection<LegacyUserChannelRow[]>`
    SELECT
      id,
      user_uuid,
      provider,
      name,
      credentials,
      status,
      created_at,
      updated_at
    FROM ${connection(sourceSchema)}.user_channels
    ORDER BY id
  `;

  const migratedChannels: MigratedUserChannelRow[] = legacyChannels.map((channel) => {
    if (!isRecord(channel.credentials)) {
      throw new Error(`Legacy user channel ${channel.id} credentials are not a JSON object`);
    }
    return {
      id: channel.id,
      user_uuid: channel.user_uuid,
      provider: channel.provider,
      name: channel.name,
      credential_envelope: encryptChannelCredentials(
        channel.credentials,
        {
          channelId: channel.id,
          userUuid: channel.user_uuid,
          provider: channel.provider,
        },
        options.keyring,
      ),
      status: channel.status,
      created_at: channel.created_at,
      updated_at: channel.updated_at,
    };
  });
  if (migratedChannels.length === 0) return 0;

  return connection.begin(async (transaction) => {
    let insertedCount = 0;
    for (const channel of migratedChannels) {
      const inserted = await transaction<{ id: string }[]>`
        INSERT INTO ${transaction(targetSchema)}.user_channels (
          id,
          user_uuid,
          provider,
          name,
          credential_envelope,
          status,
          created_at,
          updated_at
        ) VALUES (
          ${channel.id},
          ${channel.user_uuid},
          ${channel.provider},
          ${channel.name},
          ${transaction.json(channel.credential_envelope)},
          ${channel.status},
          ${channel.created_at},
          ${channel.updated_at}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      insertedCount += inserted.length;
    }
    return insertedCount;
  });
}
