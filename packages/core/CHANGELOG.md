# @cohub/core

## 1.1.1

### Patch Changes

- Updated dependencies [2a29102]
  - @cohub/billing@1.2.0

## 1.1.0

### Minor Changes

- 5220dc0: Gate space commerce management behind dedicated permissions and a Max/Internal entitlement.

  - Add `space.commerce.view` / `space.commerce.manage` permissions (host only), replacing `space.edit` on commerce routes so commerce access is decoupled from content editing.
  - Add the `space.commerce` billing feature; setup and product/benefit configuration now require an active entitlement (granted by Max and Internal plans). Reads remain permission-gated only.
  - 402 responses carry a `feature_not_entitled` billing conversion intent so the shared upgrade UI can present plan options. Add `createFeatureGateConversionIntent` helper for reuse by future entitlement gates.

### Patch Changes

- Updated dependencies [5220dc0]
  - @cohub/billing@1.1.0
