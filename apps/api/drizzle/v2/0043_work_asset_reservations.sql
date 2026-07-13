CREATE TABLE "v2"."work_asset_reservations" (
	"publish_job_id" varchar(160) PRIMARY KEY NOT NULL,
	"asset_key" text NOT NULL,
	"space_id" uuid NOT NULL,
	"slug" varchar(80) NOT NULL,
	"state" varchar(20) DEFAULT 'pending' NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"claimant" varchar(160),
	"writer_id" varchar(160),
	"writer_lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "v2_chk_work_asset_reservations_state" CHECK ("v2"."work_asset_reservations"."state" in ('pending', 'committed', 'abandoned', 'claimed', 'cleaned'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_work_asset_reservations_asset_key" ON "v2"."work_asset_reservations" USING btree ("asset_key");
--> statement-breakpoint
CREATE INDEX "v2_idx_work_asset_reservations_state_lease" ON "v2"."work_asset_reservations" USING btree ("state","lease_expires_at");
--> statement-breakpoint
CREATE INDEX "v2_idx_work_asset_reservations_writer_lease" ON "v2"."work_asset_reservations" USING btree ("writer_lease_expires_at");
