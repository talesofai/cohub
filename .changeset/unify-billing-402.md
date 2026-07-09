---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": patch
---

Unify billing gate responses. Every billing-gated 402 (negative balance limit and plan entitlement) now returns a flat `{ code, message, billing: { conversion, status?, netUsd?, hardNegativeLimitUsd? } }` body, and soft debt warnings ride the same `billing` payload on success responses. The SDK adds `BILLING_ACCESS_BLOCKED_ERROR_CODE`, `isBillingAccessBlockedError`, `isBillingAccessBlockedCode`, `extractBillingPayload`, and a `BillingResponsePayload` type so clients extract the conversion intent with one call. Websocket `session.request.error` events now carry the same `billing` payload. The CLI surfaces the conversion title/message on 402.
