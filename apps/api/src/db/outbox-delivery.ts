import { billingOperations } from "@cohub/billing";
import {
  BillingUsageIntentConflictError,
  BillingUsageIntentNotFoundError,
  deliverBillingUsageIntent,
} from "@cohub/core/billing";
import type { RealtimeOutboxEnvelope } from "@cohub/db";
import { dispatchRealtimeEvent } from "../channels.js";
import {
  PermanentOutboxDeliveryError,
  type OutboxDelivery,
} from "./outbox-dispatcher.js";
import { db } from "./index.js";

export async function deliverOutboxEvent(event: OutboxDelivery) {
  if (event.destination === "realtime") {
    const subscriberCount = await dispatchRealtimeEvent(event.payload as RealtimeOutboxEnvelope);
    if (subscriberCount === 0) throw new Error("no realtime gateway subscribers");
    return;
  }
  if (event.destination === "billing.usage") {
    try {
      await deliverBillingUsageIntent({
        db,
        billing: billingOperations,
        payload: event.payload,
      });
      return;
    } catch (error) {
      if (
        error instanceof BillingUsageIntentConflictError
        || error instanceof BillingUsageIntentNotFoundError
      ) {
        throw new PermanentOutboxDeliveryError(error.message);
      }
      throw error;
    }
  }
  throw new PermanentOutboxDeliveryError(`unsupported outbox destination: ${event.destination}`);
}
