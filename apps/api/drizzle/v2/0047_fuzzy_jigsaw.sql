SET LOCAL lock_timeout = '30s';--> statement-breakpoint
LOCK TABLE "v2"."token_usage_stats_hourly" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
CREATE TEMP TABLE "token_usage_stats_hourly_duplicates" AS
SELECT
  "bucket_start_at",
  "user_id",
  "space_id",
  "session_id",
  "provider",
  "model",
  sum("request_count")::integer AS "request_count",
  sum("success_count")::integer AS "success_count",
  sum("error_count")::integer AS "error_count",
  sum("input_tokens")::integer AS "input_tokens",
  sum("output_tokens")::integer AS "output_tokens",
  sum("cache_read_tokens")::integer AS "cache_read_tokens",
  sum("cache_write_tokens")::integer AS "cache_write_tokens",
  sum("total_tokens")::integer AS "total_tokens",
  sum("cost_input") AS "cost_input",
  sum("cost_output") AS "cost_output",
  sum("cost_cache_read") AS "cost_cache_read",
  sum("cost_cache_write") AS "cost_cache_write",
  sum("cost_total") AS "cost_total",
  min("created_at") AS "created_at",
  max("updated_at") AS "updated_at"
FROM "v2"."token_usage_stats_hourly"
GROUP BY "bucket_start_at", "user_id", "space_id", "session_id", "provider", "model"
HAVING count(*) > 1;--> statement-breakpoint
DELETE FROM "v2"."token_usage_stats_hourly" AS target
USING "token_usage_stats_hourly_duplicates" AS duplicate
WHERE target."bucket_start_at" = duplicate."bucket_start_at"
  AND target."user_id" IS NOT DISTINCT FROM duplicate."user_id"
  AND target."space_id" = duplicate."space_id"
  AND target."session_id" = duplicate."session_id"
  AND target."provider" IS NOT DISTINCT FROM duplicate."provider"
  AND target."model" IS NOT DISTINCT FROM duplicate."model";--> statement-breakpoint
INSERT INTO "v2"."token_usage_stats_hourly" (
  "bucket_start_at",
  "user_id",
  "space_id",
  "session_id",
  "provider",
  "model",
  "request_count",
  "success_count",
  "error_count",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
  "cost_input",
  "cost_output",
  "cost_cache_read",
  "cost_cache_write",
  "cost_total",
  "created_at",
  "updated_at"
)
SELECT
  "bucket_start_at",
  "user_id",
  "space_id",
  "session_id",
  "provider",
  "model",
  "request_count",
  "success_count",
  "error_count",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
  "cost_input",
  "cost_output",
  "cost_cache_read",
  "cost_cache_write",
  "cost_total",
  "created_at",
  "updated_at"
FROM "token_usage_stats_hourly_duplicates";--> statement-breakpoint
DROP TABLE "token_usage_stats_hourly_duplicates";--> statement-breakpoint
DROP INDEX "v2"."v2_uq_token_usage_stats_hourly_bucket_dims";--> statement-breakpoint
ALTER TABLE "v2"."token_usage_stats_hourly" ADD CONSTRAINT "v2_uq_token_usage_stats_hourly_bucket_dims" UNIQUE NULLS NOT DISTINCT("bucket_start_at","user_id","space_id","session_id","provider","model");
