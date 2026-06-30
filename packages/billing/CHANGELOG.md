# @cohub/billing

## 1.2.0

### Minor Changes

- 2a29102: Add credit benefits and consumption to work commerce, closing the monetization loop.

  - Add virtual `cohub_credit` token type and `work.consumption` usage type to billing declarations. Credit amounts are plain integers at business scope — creators never see token types.
  - Add `createBusinessBillingOperations` / `createDisabledBusinessBillingOperations` for business-scoped entitlement lookups, credit status, and credit consumption. Shares the same credit mapping helpers as platform billing so the two never drift.
  - Space commerce now supports `credits` benefit type (amount + optional expiry). Token type, scope, and grant kind are fixed and hidden from creators.
  - Product serialization fills `display.creditBenefits` from bound credit benefits so Works can show "includes 500 credits".
  - Work commerce replaces `POST entitlements/check` with `GET entitlements` — one call returns feature entitlements and credit balance. Adds `POST credits/consume` with idempotent `operationId`.
  - SDK `cohub.work.commerce` gains `getEntitlements()` and `consumeCredits()`, replacing `checkEntitlements()`.
  - CLI `works commerce` gains `entitlements` and `credits consume` commands; `spaces commerce benefits create` gains `--type credits --amount`.
  - Web benefit editor supports both feature and credits types.

## 1.1.0

### Minor Changes

- 5220dc0: Gate space commerce management behind dedicated permissions and a Max/Internal entitlement.

  - Add `space.commerce.view` / `space.commerce.manage` permissions (host only), replacing `space.edit` on commerce routes so commerce access is decoupled from content editing.
  - Add the `space.commerce` billing feature; setup and product/benefit configuration now require an active entitlement (granted by Max and Internal plans). Reads remain permission-gated only.
  - 402 responses carry a `feature_not_entitled` billing conversion intent so the shared upgrade UI can present plan options. Add `createFeatureGateConversionIntent` helper for reuse by future entitlement gates.
