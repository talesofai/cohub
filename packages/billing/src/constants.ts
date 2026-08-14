export const COHUB_BILLING_POLICY = {
  hardNegativeLimitUsd: -1,
  minimumBalanceUsdByUsageKind: {
    "generation.video": 0.6,
    // TODO(product/finance): placeholder threshold, not yet priced by product.
    "realtime.voice": 0.1,
  },
  failClosedUsageKinds: ["generation.video", "realtime.voice"],
} as const;

/**
 * Per-heartbeat charge for realtime voice sessions (see apps/api's
 * internal/realtime-voice route). Realtime voice has no natural per-task
 * cost the way generation does, so it's billed as wall-clock connected time
 * at a flat rate rather than off provider-reported usage.
 *
 * TODO(product/finance): usdPerMinute is a placeholder, not a priced rate.
 */
export const REALTIME_VOICE_BILLING = {
  usdPerMinute: 0.06,
  heartbeatIntervalSeconds: 30,
} as const;
