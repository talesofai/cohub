# Channel credential encryption

`v2.user_channels.credential_envelope` is the source of truth for new channel credentials. The API is the only service with the encryption keyring. Gateway assignments in Redis contain a credential revision, not credentials; a Gateway fetches credentials from the authenticated internal API only when it starts or refreshes a provider.

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

## Rollout

1. Create the API-only `private-secrets.yaml` from `deploy/api/<env>/private-secrets.template.yaml`. The Worker must not mount this Secret. Add the same `GATEWAY_INTERNAL_SECRET` to the Gateway Secret before deploying either new image.
2. Run database migrations. The expand migration keeps legacy `credentials` rows readable.
3. Roll out API, then Gateway. Avoid channel create/update requests while old and new API pods overlap because old code cannot read newly encrypted rows.
4. Preview the legacy backfill:

   ```bash
   pnpm --filter @cohub/api db:migrate:channel-credentials -- --mode backfill
   ```

   In Kubernetes, run the equivalent isolated Job:

   ```bash
   ./deploy/api/run-channel-credential-migration.sh prod backfill
   ```

5. Apply the backfill after every API pod is on the new version:

   ```bash
   pnpm --filter @cohub/api db:migrate:channel-credentials -- --mode backfill --apply
   ```

   ```bash
   ./deploy/api/run-channel-credential-migration.sh prod backfill --apply
   ```

6. Verify that no plaintext rows remain:

   ```sql
   SELECT count(*) AS plaintext_rows
   FROM v2.user_channels
   WHERE credentials IS NOT NULL;
   ```

7. Validate the online constraints after the database is quiet enough for the scan:

   ```sql
   ALTER TABLE v2.user_channels
     VALIDATE CONSTRAINT v2_chk_user_channels_credentials_storage;
   ALTER TABLE v2.user_channels
     VALIDATE CONSTRAINT v2_chk_user_channels_credential_envelope;
   ALTER TABLE v2.user_channels
     VALIDATE CONSTRAINT v2_chk_user_channels_credential_revision;
   ```

The script locks small batches with `FOR UPDATE SKIP LOCKED`, is safe to rerun, and never changes the logical credential revision during a storage-only backfill.

The nullable legacy `credentials` column is deliberately retained for this expand release. After the backfill, constraint validation, and rollback window are complete, remove the dual-read path and drop the legacy column in a separate contract release. Combining expand, data rewrite, and contract into one deployment would make rollback unsafe.

## Rotation

Add a new key while retaining every old key, set it as primary, deploy the API, then run:

```bash
pnpm --filter @cohub/api db:migrate:channel-credentials -- --mode rotate
pnpm --filter @cohub/api db:migrate:channel-credentials -- --mode rotate --apply
```

For production Kubernetes, use `./deploy/api/run-channel-credential-migration.sh prod rotate` first, then rerun it with `--apply`.

After the apply run reports zero remaining rows and every API pod has the new keyring, remove retired keys in a later deployment. A rollback across a completed backfill requires the new API code and the old keys; the legacy application cannot read encrypted-only rows.
