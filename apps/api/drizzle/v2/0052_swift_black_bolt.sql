ALTER TABLE "v2"."cron_jobs" ADD COLUMN "schedule_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "v2"."cron_jobs" ADD COLUMN "queue_synced_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "v2"."cron_jobs"
SET "queue_synced_version" = "schedule_version"
WHERE ("enabled" = false OR "deleted_at" IS NOT NULL) AND "bull_job_key" = '';
