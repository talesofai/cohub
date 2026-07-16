# Relational integrity

PostgreSQL owns the integrity of Cohub domain relationships. Application checks remain useful for clear HTTP errors, but they are not a substitute for foreign keys because concurrent writers can bypass a read-then-write check.

Migration `0050` adds foreign keys for owned space, session, channel, work, label, referral, task, and reference rows, plus the cron session-context check. Every new constraint is installed as `NOT VALID`: PostgreSQL rejects new invalid writes immediately, while deployment is not blocked by historical rows that predate the contract.

The deletion policy follows ownership:

- `CASCADE` removes rows that have no meaning without their canonical parent, such as a binding without its space channel or a work version without its work.
- `SET NULL` preserves historical rows when only an optional context pointer disappears, such as a provider message reference after a space channel is unbound.
- `RESTRICT` protects relationships that require explicit application cleanup, such as mounted mod spaces, referrals, bound user channels, and cron jobs.

Lineage `NO ACTION` constraints are `DEFERRABLE INITIALLY DEFERRED`. They still reject a standalone parent deletion when its transaction commits, but they allow a whole-space deletion to finish all cascades and pointer updates before checking parent references. Non-deferrable `RESTRICT` would inspect an intermediate row state and incorrectly block that valid deletion.

External identity IDs, immutable billing audit context, analytics dimensions, polymorphic resource references, and outbox aggregate pointers intentionally do not reference `user_profiles` or a single domain table. `user_profiles` is a cache of the external identity authority, and audit/analytics identifiers must remain stable after operational data is removed.

## Rollout

After migration and application deployment, run the validator in dry-run mode. It attempts each unvalidated foreign-key and check constraint inside a transaction and rolls back, so it changes no rows or constraint state:

```bash
pnpm --filter @cohub/api db:validate:relational-integrity
```

The command returns `validatable` for clean foreign-key and check constraints and `blocked` with PostgreSQL's first violation for dirty constraints. Repair blocked legacy rows deliberately; do not run blanket deletes. Then validate clean constraints:

```bash
pnpm --filter @cohub/api db:validate:relational-integrity --apply
```

`--apply` only executes `ALTER TABLE ... VALIDATE CONSTRAINT`; it never updates or deletes application rows. It validates constraints independently, so clean relationships can advance even when another relationship still needs repair. Re-run dry-run until `blocked` is zero and `validatable` is zero.
