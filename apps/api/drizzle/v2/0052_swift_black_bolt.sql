ALTER TABLE "v2"."cron_jobs" ADD COLUMN "schedule_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "v2"."cron_jobs" ADD COLUMN "queue_synced_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "v2"."cron_jobs"
SET "queue_synced_version" = "schedule_version"
WHERE
  ("enabled" = true AND "deleted_at" IS NULL AND "bull_job_key" <> '')
  OR (("enabled" = false OR "deleted_at" IS NOT NULL) AND "bull_job_key" = '');--> statement-breakpoint
CREATE INDEX "v2_idx_cron_jobs_queue_sync_pending" ON "v2"."cron_jobs" USING btree ("updated_at","id") WHERE "v2"."cron_jobs"."queue_synced_version" <> "v2"."cron_jobs"."schedule_version";
