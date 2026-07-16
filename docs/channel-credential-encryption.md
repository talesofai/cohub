# Channel credential encryption

`v2.user_channels.credential_envelope` is the only credential storage. The API is the only service with the encryption keyring. Gateway assignments in Redis contain a credential revision, not credentials; a Gateway fetches credentials from the authenticated internal API only when it starts or refreshes a provider.

The credential endpoint uses a dedicated `GATEWAY_INTERNAL_SECRET` and verifies that the requesting Gateway node currently owns the channel route. Do not reuse `WORKER_SECRET`; agents and workers do not need access to channel credentials.

## Keyring

Configure the API and migration job with:

```text
CHANNEL_CREDENTIAL_PRIMARY_KEY_ID=prod-v1
CHANNEL_CREDENTIAL_KEYS={"prod-v1":"<unpadded base64url 32-byte key>"}
```

Generate a key with Node.js 24:

```bash
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'
```

Key ids may contain letters, digits, `.`, `_`, and `-`. Never remove an old key while an envelope still references it.

## Contract rollout

This release removes the legacy `credentials` column and the dual-read path. Complete these prerequisites with the currently deployed expand-version API image before deploying the contract image:

1. Preview and apply the legacy backfill with the expand-version `db:migrate:channel-credentials -- --mode backfill` command or its `run-channel-credential-migration.sh` Kubernetes Job.
2. Verify that no plaintext or missing-envelope rows remain:

   ```sql
   SELECT count(*) AS rows_blocking_contract
   FROM v2.user_channels
   WHERE credentials IS NOT NULL
      OR credential_envelope IS NULL;
   ```

3. Validate the expand-version constraints after the database is quiet enough for the scan:

   ```sql
   ALTER TABLE v2.user_channels
     VALIDATE CONSTRAINT v2_chk_user_channels_credentials_storage;
   ALTER TABLE v2.user_channels
     VALIDATE CONSTRAINT v2_chk_user_channels_credential_envelope;
   ALTER TABLE v2.user_channels
     VALIDATE CONSTRAINT v2_chk_user_channels_credential_revision;
   ```

4. Confirm every key id present in `credential_envelope` remains in `CHANNEL_CREDENTIAL_KEYS`.
5. Deploy the contract migration and API. The migration raises SQLSTATE `55000` before changing the schema if any row still has plaintext credentials, lacks an envelope, or has an invalid envelope. On success it makes `credential_envelope` non-null and drops `credentials`.

After the contract migration, an old expand-version API cannot run because its queries still reference `credentials`. Roll forward. A binary rollback requires restoring the legacy column and compatible constraint before starting the old image; do not assume an application-only rollback is safe.

## Rotation

Add a new key while retaining every old key, set it as primary, deploy the API, then run:

```bash
pnpm --filter @cohub/api db:rotate:channel-credentials
pnpm --filter @cohub/api db:rotate:channel-credentials --apply
```

For production Kubernetes, use `./deploy/api/run-channel-credential-rotation.sh prod` first, then rerun it with `--apply`.

After the apply run reports zero remaining rows and every API pod has the new keyring, remove retired keys in a later deployment. Rolling back across a completed rotation requires retaining the new key; an older keyring cannot decrypt envelopes written by the new primary key.
