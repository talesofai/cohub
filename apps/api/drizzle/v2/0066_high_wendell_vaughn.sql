CREATE TABLE "v2"."workspace_blobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"size" bigint NOT NULL,
	"object_key" text NOT NULL,
	"content_type" varchar(255),
	"status" varchar(20) DEFAULT 'uploading' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."workspace_snapshot_blobs" (
	"snapshot_id" uuid NOT NULL,
	"blob_id" uuid NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "v2"."workspace_snapshots" ADD COLUMN "manifest_inline" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_workspace_blobs_space_hash" ON "v2"."workspace_blobs" USING btree ("space_id","sha256");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_blobs_status" ON "v2"."workspace_blobs" USING btree ("space_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_workspace_snapshot_blobs_snapshot_path" ON "v2"."workspace_snapshot_blobs" USING btree ("snapshot_id","path");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_snapshot_blobs_snapshot" ON "v2"."workspace_snapshot_blobs" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "v2_idx_workspace_snapshot_blobs_blob" ON "v2"."workspace_snapshot_blobs" USING btree ("blob_id");