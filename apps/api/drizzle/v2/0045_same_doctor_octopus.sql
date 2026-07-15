ALTER TABLE "v2"."user_channels" ALTER COLUMN "credentials" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "v2"."user_channels" ADD COLUMN "credential_envelope" jsonb;--> statement-breakpoint
ALTER TABLE "v2"."user_channels" ADD COLUMN "credential_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "v2"."user_channels" ADD CONSTRAINT "v2_chk_user_channels_credentials_storage" CHECK (num_nonnulls("v2"."user_channels"."credentials", "v2"."user_channels"."credential_envelope") = 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "v2"."user_channels" ADD CONSTRAINT "v2_chk_user_channels_credential_envelope" CHECK ("v2"."user_channels"."credential_envelope" is null or coalesce(
        jsonb_typeof("v2"."user_channels"."credential_envelope") = 'object'
        and "v2"."user_channels"."credential_envelope"->'version' = '1'::jsonb
        and "v2"."user_channels"."credential_envelope"->>'algorithm' = 'aes-256-gcm'
        and "v2"."user_channels"."credential_envelope"->>'keyId' ~ '^[A-Za-z0-9._-]{1,64}$'
        and "v2"."user_channels"."credential_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
        and "v2"."user_channels"."credential_envelope"->>'authTag' ~ '^[A-Za-z0-9_-]{22}$'
        and "v2"."user_channels"."credential_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]{3,}$',
        false
      )) NOT VALID;--> statement-breakpoint
ALTER TABLE "v2"."user_channels" ADD CONSTRAINT "v2_chk_user_channels_credential_revision" CHECK ("v2"."user_channels"."credential_revision" > 0) NOT VALID;
