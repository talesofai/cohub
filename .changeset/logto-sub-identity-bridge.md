---
"@neta-art/cohub": minor
---

Add migration-safe canonical and legacy user identity support.

- Expose the optional legacy user UUID alongside the canonical Logto subject.
- Let Work Bridge hosts provide canonical and legacy viewer identity keys for
  ownership and persisted-scope checks during the identity migration.
