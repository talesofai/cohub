import { billingOperations } from "@cohub/billing";
import {
  retryQualifiedReferralRewards,
  startReferralRewardRetryLoop,
} from "@cohub/core/referrals";
import { createLogger } from "@cohub/infra/logging";
import { db } from "../db.js";
import { resolveBillingUserIdForStoredPrincipal } from "../identity-bridge.js";

const logger = createLogger({ serviceName: "cohub-worker" });

/** Periodic recovery for qualified referrals whose grant failed mid-flight. */
export function startSystemReferralRewardRetryLoop(intervalMs = 60_000) {
  return startReferralRewardRetryLoop({
    intervalMs,
    isEnabled: () => billingOperations.status.configured,
    logger: {
      info: (message, meta) => logger.info(message, meta),
      warn: (message, meta) => logger.warn(message, meta),
    },
    run: () =>
      retryQualifiedReferralRewards({
        db,
        billing: billingOperations,
        resolveBillingUserId: resolveBillingUserIdForStoredPrincipal,
        logger: {
          info: (message, meta) => logger.info(message, meta),
          warn: (message, meta) => logger.warn(message, meta),
        },
      }),
  });
}
