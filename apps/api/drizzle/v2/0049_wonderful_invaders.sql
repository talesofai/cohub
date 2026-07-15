CREATE TABLE "v2"."billing_usage_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" varchar(255) NOT NULL,
	"provider" varchar(50) NOT NULL,
	"status" varchar(20) NOT NULL,
	"response" jsonb,
	"error_name" varchar(255),
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v2_chk_billing_usage_attempts_status" CHECK ("v2"."billing_usage_attempts"."status" IN ('recorded', 'overage', 'disabled', 'skipped', 'error')),
	CONSTRAINT "v2_chk_billing_usage_attempts_result" CHECK (("v2"."billing_usage_attempts"."status" = 'error' AND "v2"."billing_usage_attempts"."error_message" IS NOT NULL AND "v2"."billing_usage_attempts"."response" IS NULL) OR ("v2"."billing_usage_attempts"."status" <> 'error' AND "v2"."billing_usage_attempts"."error_name" IS NULL AND "v2"."billing_usage_attempts"."error_message" IS NULL)),
	CONSTRAINT "v2_chk_billing_usage_attempts_provider" CHECK (length(btrim("v2"."billing_usage_attempts"."provider")) > 0)
);
--> statement-breakpoint
CREATE TABLE "v2"."billing_usage_intents" (
	"operation_id" varchar(255) PRIMARY KEY NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"token_type" varchar(100) NOT NULL,
	"amount_usd" numeric(18, 8) NOT NULL,
	"usage_type" varchar(100) NOT NULL,
	"source_id" varchar(255) NOT NULL,
	"reason" text,
	"space_id" uuid,
	"session_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v2_chk_billing_usage_intents_amount" CHECK ("v2"."billing_usage_intents"."amount_usd" > 0),
	CONSTRAINT "v2_chk_billing_usage_intents_identity" CHECK (length(btrim("v2"."billing_usage_intents"."operation_id")) > 0 AND length(btrim("v2"."billing_usage_intents"."user_id")) > 0 AND length(btrim("v2"."billing_usage_intents"."token_type")) > 0 AND length(btrim("v2"."billing_usage_intents"."usage_type")) > 0 AND length(btrim("v2"."billing_usage_intents"."source_id")) > 0),
	CONSTRAINT "v2_chk_billing_usage_intents_request_hash" CHECK ("v2"."billing_usage_intents"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "v2"."billing_usage_attempts" ADD CONSTRAINT "v2_fk_billing_usage_attempts_operation" FOREIGN KEY ("operation_id") REFERENCES "v2"."billing_usage_intents"("operation_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "v2_idx_billing_usage_attempts_operation_created" ON "v2"."billing_usage_attempts" USING btree ("operation_id","created_at","id");--> statement-breakpoint
CREATE INDEX "v2_idx_billing_usage_attempts_status_created" ON "v2"."billing_usage_attempts" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "v2_idx_billing_usage_intents_user_created" ON "v2"."billing_usage_intents" USING btree ("user_id","created_at" DESC NULLS LAST,"operation_id");--> statement-breakpoint
CREATE INDEX "v2_idx_billing_usage_intents_source" ON "v2"."billing_usage_intents" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "v2_idx_billing_usage_intents_space_created" ON "v2"."billing_usage_intents" USING btree ("space_id","created_at" DESC NULLS LAST,"operation_id");--> statement-breakpoint
CREATE FUNCTION "v2"."reject_billing_ledger_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'billing ledger table %.% is immutable', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "billing_usage_intents_immutable_rows"
BEFORE UPDATE OR DELETE ON "v2"."billing_usage_intents"
FOR EACH ROW EXECUTE FUNCTION "v2"."reject_billing_ledger_mutation"();--> statement-breakpoint
CREATE TRIGGER "billing_usage_intents_immutable_truncate"
BEFORE TRUNCATE ON "v2"."billing_usage_intents"
FOR EACH STATEMENT EXECUTE FUNCTION "v2"."reject_billing_ledger_mutation"();--> statement-breakpoint
CREATE TRIGGER "billing_usage_attempts_immutable_rows"
BEFORE UPDATE OR DELETE ON "v2"."billing_usage_attempts"
FOR EACH ROW EXECUTE FUNCTION "v2"."reject_billing_ledger_mutation"();--> statement-breakpoint
CREATE TRIGGER "billing_usage_attempts_immutable_truncate"
BEFORE TRUNCATE ON "v2"."billing_usage_attempts"
FOR EACH STATEMENT EXECUTE FUNCTION "v2"."reject_billing_ledger_mutation"();
