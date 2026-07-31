---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Add authorized per-turn system instructions to Space prompts. Expose scheduled
prompt queue synchronization status so clients can distinguish saved schedules
from schedules that are active in the worker queue. Add caller-scoped idempotency
keys and response-loss recovery for immediate and one-off scheduled prompts,
media generation submissions, and repeat schedules. Reconcile queued turns
from database state after queue handoff failures. Keep repeat-schedule billing
bound to the creator while allowing other Space managers to rename, stop, or
delete it without changing its paid payload, cadence, or activation state.
