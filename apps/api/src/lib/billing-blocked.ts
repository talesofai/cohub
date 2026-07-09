import type { Context } from "hono";
import { serializeBillingBlocked, type BillingAccessBlockedError } from "@cohub/billing";

/** Standard 402 response for a blocked usage gate (negative balance limit). */
export function billingBlockedResponse(c: Context, error: BillingAccessBlockedError) {
  return c.json(serializeBillingBlocked(error), 402);
}
