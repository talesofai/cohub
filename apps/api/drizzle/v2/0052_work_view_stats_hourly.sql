CREATE TABLE "v2"."work_view_stats_hourly" (
	"work_id" uuid NOT NULL,
	"work_version_id" uuid NOT NULL,
	"bucket_start_at" timestamp with time zone NOT NULL,
	"source" varchar(20) NOT NULL,
	"view_count" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_work_view_stats_hourly_bucket_dims" ON "v2"."work_view_stats_hourly" USING btree ("work_id","work_version_id","bucket_start_at","source");--> statement-breakpoint
CREATE INDEX "v2_idx_work_view_stats_hourly_work_bucket" ON "v2"."work_view_stats_hourly" USING btree ("work_id","bucket_start_at");--> statement-breakpoint
CREATE INDEX "v2_idx_work_view_stats_hourly_work_version" ON "v2"."work_view_stats_hourly" USING btree ("work_id","work_version_id");