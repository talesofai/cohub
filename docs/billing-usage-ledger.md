# Billing usage ledger

The external TalesofAI billing provider remains the authority for credit balances, grants, overage, and provider transaction IDs. Cohub owns the immutable audit trail of what it intended to charge and every completed delivery attempt.

`v2.billing_usage_intents` stores one canonical request per provider `operation_id`. The request hash covers every charge-defining field: operation, user, token type, USD amount, usage type, source, and reason. Reusing an operation ID with different charge fields is a hard conflict. Space, session, and metadata fields are audit context; the first writer wins and context changes cannot alter the charge.

`v2.billing_usage_attempts` appends provider results and errors. Neither ledger table has `updated_at`. Database triggers reject `UPDATE`, `DELETE`, and `TRUNCATE` with SQLSTATE `55000`; corrections are new operations or attempts, never rewrites.

## Delivery

Producers insert an intent and a `billing.usage` outbox row in one PostgreSQL transaction. The API outbox dispatcher loads the immutable intent and calls the configured provider with the same operation ID. Provider calls remain idempotent. If the provider succeeds but the local attempt or outbox acknowledgement fails, retrying returns the provider's original result and appends or reuses a terminal local attempt without charging twice.

Terminal attempt statuses are `recorded`, `overage`, `disabled`, and `skipped`. Errors append an `error` attempt and leave the outbox row pending with exponential backoff. A malformed pointer, missing intent, or request-hash mismatch is a permanent outbox failure for operator repair.

Session-message usage, raw completion usage, multimodal generation, and legacy generation billing retry jobs all enqueue the same intent shape. Generation results report `queued` until a terminal ledger attempt already exists.

## Migration and backfill

Deploy the transactional outbox migration and API first. Then apply migration `0049`, deploy the billing-ledger API, and finally deploy Worker producers.

The backfill tool is dry-run by default and uses bounded keyset batches:

```bash
pnpm --filter @cohub/api db:backfill:billing-ledger --source all --batch-size 200
pnpm --filter @cohub/api db:backfill:billing-ledger --source all --batch-size 200 --apply
```

Use `--max-rows N` for a canary. Re-running is safe because the canonical operation IDs are `llm:{messageId}` and `generation:{taskRunId}`. The tool can recover durable assistant-message and generation-task history. Raw completions were not stored locally before this migration and cannot be honestly reconstructed; no synthetic rows are created for them.

## Verification

```sql
SELECT count(*) AS conflicting_operations
FROM (
  SELECT operation_id
  FROM v2.billing_usage_intents
  GROUP BY operation_id
  HAVING count(DISTINCT request_hash) > 1
) conflicts;

SELECT count(*) AS unresolved,
       min(intent.created_at) AS oldest_intent
FROM v2.billing_usage_intents intent
WHERE NOT EXISTS (
  SELECT 1
  FROM v2.billing_usage_attempts attempt
  WHERE attempt.operation_id = intent.operation_id
    AND attempt.status <> 'error'
);

SELECT intent.operation_id, intent.user_id, intent.amount_usd,
       outbox.attempt_count, outbox.available_at, outbox.last_error
FROM v2.billing_usage_intents intent
JOIN v2.outbox_events outbox
  ON outbox.destination = 'billing.usage'
 AND outbox.aggregate_id = intent.operation_id
WHERE outbox.published_at IS NULL
ORDER BY outbox.available_at, outbox.id
LIMIT 100;

SELECT event_object_table, trigger_name
FROM information_schema.triggers
WHERE trigger_schema = 'v2'
  AND event_object_table IN ('billing_usage_intents', 'billing_usage_attempts')
ORDER BY event_object_table, trigger_name;
```

The conflict count must remain zero. An unresolved intent is expected only while its outbox delivery is pending or backing off. Any `failed_at` billing outbox row requires inspection before manual requeue; never edit or delete ledger rows to hide the failure.
