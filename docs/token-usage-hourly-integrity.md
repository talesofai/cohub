# Token usage hourly integrity

`v2.token_usage_stats_hourly` preserves nullable `user_id`, `provider`, and `model` dimensions. Its unique key uses PostgreSQL `NULLS NOT DISTINCT`, so a missing dimension still participates in `ON CONFLICT` and one logical hourly bucket has exactly one row.

Migration `0047` takes a `SHARE ROW EXCLUSIVE` table lock, aggregates only duplicate dimension groups, replaces those rows without losing counters or costs, then replaces the legacy unique index with the null-aware unique constraint. Reads remain available while the migration holds the lock; token usage writes wait. Lock acquisition has a 30-second timeout, so a busy deployment fails cleanly instead of waiting indefinitely.

## Preflight

Run these read-only queries before scheduling the migration:

```sql
SELECT count(*) AS duplicate_groups,
       coalesce(sum(row_count - 1), 0) AS redundant_rows
FROM (
  SELECT count(*) AS row_count
  FROM v2.token_usage_stats_hourly
  GROUP BY bucket_start_at, user_id, space_id, session_id, provider, model
  HAVING count(*) > 1
) duplicates;

SELECT pg_size_pretty(pg_total_relation_size('v2.token_usage_stats_hourly')) AS total_size;
```

Do not infer lock duration without these production values. Pause the session-message postprocess Worker if the measured table size or duplicate count makes a short write pause unacceptable.

## Verification

```sql
SELECT count(*)
FROM (
  SELECT 1
  FROM v2.token_usage_stats_hourly
  GROUP BY bucket_start_at, user_id, space_id, session_id, provider, model
  HAVING count(*) > 1
) duplicates;

SELECT conname, convalidated
FROM pg_constraint
WHERE conrelid = 'v2.token_usage_stats_hourly'::regclass
  AND conname = 'v2_uq_token_usage_stats_hourly_bucket_dims';
```

Both checks must report one valid constraint and zero duplicate groups. The generation usage table is not part of this migration: its dimensions are already `NOT NULL` and normalized to explicit sentinels before upsert.
