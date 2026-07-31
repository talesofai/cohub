ALTER TABLE "v2"."cron_jobs" ADD COLUMN "idempotency_key" varchar(64);--> statement-breakpoint
ALTER TABLE "v2"."cron_jobs" ADD COLUMN "request_fingerprint" varchar(64);--> statement-breakpoint
ALTER TABLE "v2"."task_runs" ADD COLUMN "idempotency_fingerprint" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_cron_jobs_idempotency_key" ON "v2"."cron_jobs" USING btree ("idempotency_key");--> statement-breakpoint
ALTER TABLE "v2"."cron_jobs" ADD CONSTRAINT "v2_chk_cron_jobs_idempotency_pair" CHECK (("v2"."cron_jobs"."idempotency_key" is null) = ("v2"."cron_jobs"."request_fingerprint" is null));