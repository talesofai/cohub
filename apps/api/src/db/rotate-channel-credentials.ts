import "dotenv/config";
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";
import { parseChannelCredentialKeyring } from "../channel-credentials.js";
import {
  parseChannelCredentialRotationArgs,
  rotateChannelCredentials,
} from "./channel-credential-rotation.js";

loadDotenv({ path: "apps/api/.env", override: false });

async function main() {
  const options = parseChannelCredentialRotationArgs(process.argv.slice(2));
  const keyring = parseChannelCredentialKeyring(
    process.env.CHANNEL_CREDENTIAL_KEYS ?? "",
    process.env.CHANNEL_CREDENTIAL_PRIMARY_KEY_ID ?? "",
  );
  const connectionString = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/cohub";
  const connection = postgres(connectionString, { prepare: false, max: 1 });

  try {
    const result = await rotateChannelCredentials(connection, keyring, options, console.log);
    console.log(
      `[channel-credentials] rotate candidates=${result.candidateCount} primaryKeyId=${keyring.primaryKeyId} apply=${options.apply}`,
    );
    if (!options.apply || result.candidateCount === 0) return;
    if (result.remaining !== 0) {
      throw new Error(`${result.remaining} channel credentials still require rotation`);
    }
    console.log("[channel-credentials] rotation complete");
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error("[channel-credentials] failed", error);
  process.exit(1);
});
