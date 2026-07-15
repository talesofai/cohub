# Transactional outbox

`v2.outbox_events` is the durability boundary between PostgreSQL domain writes and external delivery. A producer inserts the domain change and its outbox event through the same Drizzle transaction. It must not publish to Redis after commit as a second, best-effort write.

The API dispatcher claims one eligible row at a time with `FOR UPDATE SKIP LOCKED`, so multiple API replicas can drain the same table without assigning one event to two active publishers. Ordered aggregates also store `aggregate_sequence`; an unpublished lower sequence blocks every later sequence for that destination and aggregate, including while the first event is backing off or awaiting operator repair. A publish attempt is bounded to 10 seconds by default (`OUTBOX_PUBLISH_TIMEOUT_MS`) so a disconnected Redis client cannot hold the database lock indefinitely. Delivery is at least once: if Redis accepts an event and PostgreSQL cannot record `published_at`, or a timed-out Redis command completes late, the same stable event ID is retried. Gateway processes retain a bounded TTL cache of event IDs and suppress those retries locally. Clients must still reconcile from server state after reconnecting.

Transient failures never discard an event. They increment `attempt_count` and move `available_at` using exponential backoff capped at five minutes. Invalid destinations, malformed envelopes, and mismatched event metadata set `failed_at` for operator inspection. A failed event remains in PostgreSQL until it is explicitly repaired or retired.

## Producer contract

- Use `enqueueRealtimeOutboxEvent(tx, ...)` inside the transaction that owns the domain mutation.
- Give each logical event a deterministic `deduplication_key` derived from its aggregate and committed version.
- Set `aggregate_sequence` for ordered aggregate streams. A `(destination, aggregate_type, aggregate_id, aggregate_sequence)` tuple is unique.
- Store the event ID in both `outbox_events.id` and the realtime envelope `id`.
- Do not catch an outbox insert failure. The domain mutation must roll back with it.
- Do not enqueue another event when replaying an already committed idempotent request.

Canvas transactions are the first producer. Their key is `canvas.tx.applied:{documentId}:{version}`. A committed canvas version therefore has one durable realtime event, and a replayed `txId` does not create another row.

## Operations

Backlog health:

```sql
SELECT count(*) AS pending,
       min(occurred_at) AS oldest_occurred_at,
       max(attempt_count) AS max_attempt_count
FROM v2.outbox_events
WHERE published_at IS NULL AND failed_at IS NULL;
```

Events requiring intervention:

```sql
SELECT id, destination, event_type, aggregate_type, aggregate_id,
       attempt_count, last_error, failed_at
FROM v2.outbox_events
WHERE failed_at IS NOT NULL
ORDER BY failed_at, id;
```

After repairing a permanent payload or destination problem, clear `failed_at`, set `available_at = now()`, and leave the original `id` unchanged. Published rows are audit evidence; retention is handled separately and must delete only rows with non-null `published_at`.
