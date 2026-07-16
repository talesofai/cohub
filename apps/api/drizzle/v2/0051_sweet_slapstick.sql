DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "v2"."user_channels"
    WHERE "credentials" IS NOT NULL
       OR "credential_envelope" IS NULL
       OR NOT coalesce(
         jsonb_typeof("credential_envelope") = 'object'
         AND "credential_envelope"->'version' = '1'::jsonb
         AND "credential_envelope"->>'algorithm' = 'aes-256-gcm'
         AND "credential_envelope"->>'keyId' ~ '^[A-Za-z0-9._-]{1,64}$'
         AND "credential_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
         AND "credential_envelope"->>'authTag' ~ '^[A-Za-z0-9_-]{22}$'
         AND "credential_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]{3,}$',
         false
       )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'channel credential contract migration is blocked by legacy or invalid credential rows',
      HINT = 'Run the expand-version backfill and constraint validation, verify zero blocking rows, and retry this migration.';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "v2"."user_channels" DROP CONSTRAINT "v2_chk_user_channels_credentials_storage";--> statement-breakpoint
ALTER TABLE "v2"."user_channels" DROP CONSTRAINT "v2_chk_user_channels_credential_envelope";--> statement-breakpoint
ALTER TABLE "v2"."user_channels" ALTER COLUMN "credential_envelope" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "v2"."user_channels" DROP COLUMN "credentials";--> statement-breakpoint
ALTER TABLE "v2"."user_channels" ADD CONSTRAINT "v2_chk_user_channels_credential_envelope" CHECK (coalesce(
        jsonb_typeof("v2"."user_channels"."credential_envelope") = 'object'
        and "v2"."user_channels"."credential_envelope"->'version' = '1'::jsonb
        and "v2"."user_channels"."credential_envelope"->>'algorithm' = 'aes-256-gcm'
        and "v2"."user_channels"."credential_envelope"->>'keyId' ~ '^[A-Za-z0-9._-]{1,64}$'
        and "v2"."user_channels"."credential_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
        and "v2"."user_channels"."credential_envelope"->>'authTag' ~ '^[A-Za-z0-9_-]{22}$'
        and "v2"."user_channels"."credential_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]{3,}$',
        false
      ));
