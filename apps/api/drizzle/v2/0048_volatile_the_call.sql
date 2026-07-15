CREATE TABLE "v2"."outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"destination" varchar(50) NOT NULL,
	"deduplication_key" varchar(255) NOT NULL,
	"aggregate_type" varchar(100) NOT NULL,
	"aggregate_id" varchar(255) NOT NULL,
	"aggregate_sequence" integer,
	"event_type" varchar(255) NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v2_chk_outbox_events_attempt_count" CHECK ("v2"."outbox_events"."attempt_count" >= 0),
	CONSTRAINT "v2_chk_outbox_events_aggregate_sequence" CHECK ("v2"."outbox_events"."aggregate_sequence" IS NULL OR "v2"."outbox_events"."aggregate_sequence" > 0),
	CONSTRAINT "v2_chk_outbox_events_delivery_state" CHECK ("v2"."outbox_events"."published_at" IS NULL OR "v2"."outbox_events"."failed_at" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_outbox_events_deduplication_key" ON "v2"."outbox_events" USING btree ("deduplication_key");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_outbox_events_aggregate_sequence" ON "v2"."outbox_events" USING btree ("destination","aggregate_type","aggregate_id","aggregate_sequence") WHERE "v2"."outbox_events"."aggregate_sequence" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "v2_idx_outbox_events_pending" ON "v2"."outbox_events" USING btree ("available_at","occurred_at","id") WHERE "v2"."outbox_events"."published_at" IS NULL AND "v2"."outbox_events"."failed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "v2_idx_outbox_events_published_at" ON "v2"."outbox_events" USING btree ("published_at") WHERE "v2"."outbox_events"."published_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "v2_idx_outbox_events_failed_at" ON "v2"."outbox_events" USING btree ("failed_at") WHERE "v2"."outbox_events"."failed_at" IS NOT NULL;