/**
 * Standard billing payload attached under the `billing` key of any response
 * or realtime event that involves a billing gate. Present on 402 error bodies
 * (blocked / not entitled), on success responses carrying a soft debt warning,
 * and on realtime error events. `conversion` always drives the shared upgrade
 * UI; balance fields appear only for balance-based gates.
 *
 * `conversion` is intentionally `unknown` here to keep the protocol layer free
 * of a billing dependency — clients validate it against `BillingConversionIntent`.
 */
export type BillingPayload = {
  conversion: unknown;
  status?: "blocked" | "allowed_with_debt";
  netUsd?: number;
  hardNegativeLimitUsd?: number;
};
