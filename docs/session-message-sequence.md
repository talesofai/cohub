# Session message sequence allocation

`v2.session_messages.sequence` is ordered within one `space_sessions` row. Every runtime append calls `v2.allocate_session_message_sequence(session_id)` instead of calculating `max(sequence) + 1` in application code.

The allocator locks the parent Session row, reads the current maximum after acquiring that lock, and holds the lock until the caller transaction finishes. This gives API, Agent, and compaction one database serialization point without maintaining a second counter that can drift from message data.

Message idempotency remains `(session_id, idempotency_key)`. Concurrent retries use `ON CONFLICT DO NOTHING` and return the committed message. Since allocation has no persistent counter, a rejected retry does not create a sequence gap.

## Rollout

1. Apply migration `0046` before deploying API or Agent.
2. Deploy API and Agent in the same release window. Old instances still calculate sequences in application code and do not participate in the Session row lock.
3. Validate the online constraints after checking for invalid legacy rows:

   ```sql
   SELECT count(*) FROM v2.session_messages WHERE sequence <= 0;
   SELECT count(*) FROM v2.session_turns WHERE sequence <= 0;

   ALTER TABLE v2.session_messages
     VALIDATE CONSTRAINT v2_chk_session_messages_sequence;
   ALTER TABLE v2.session_turns
     VALIDATE CONSTRAINT v2_chk_session_turns_sequence;
   ```

The allocator function is backward-compatible with explicit historical sequence inserts. Data migrations and fork reconstruction may keep supplying their own sequence values; only live append paths use the allocator.
