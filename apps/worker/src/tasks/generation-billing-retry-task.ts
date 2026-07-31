import {
  billingOperations,
  COHUB_BILLING_TOKEN_TYPES,
  type CohubBillingUsageType,
} from "@cohub/billing";
import type { Job } from "bullmq";
import { GENERATION_BILLING_RETRY_TASK_TYPE } from "@cohub/protocol/generation";
import type { TaskPayload } from "@cohub/protocol/task";
import { parseGenerationBillingRetryData } from "./generation-billing-retry-data.js";
import { registerTask } from "./registry.js";
import { resolveBillingUserIdForStoredPrincipal } from "../identity-bridge.js";

/**
 * Retry post-success generation charging. Safe to re-run: recordUsage is
 * idempotent via operationId `generation:${taskRunId}`.
 */
registerTask(GENERATION_BILLING_RETRY_TASK_TYPE, async (job: Job) => {
  const payload = job.data as TaskPayload;
  const data = parseGenerationBillingRetryData(payload.data);
  const amountUsd = data.amountUsd;
  if (amountUsd <= 0) {
    return { status: "skipped", reason: "zero_amount", taskRunId: data.taskRunId };
  }
  if (!billingOperations.status.configured) {
    return { status: "skipped", reason: "billing_not_configured", taskRunId: data.taskRunId };
  }

  const billingUserId = await resolveBillingUserIdForStoredPrincipal(data.userId);
  const result = await billingOperations.recordUsage({
    userId: billingUserId,
    amountUsd,
    tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
    usageType: data.usageType as CohubBillingUsageType,
    sourceId: data.taskRunId,
    operationId: `generation:${data.taskRunId}`,
    reason: `Generation ${data.model}`,
  });

  if (result.status === "overage") {
    console.warn("[Billing] generation usage retry recorded as overage", {
      userId: data.userId,
      taskRunId: data.taskRunId,
      officialCostUsd: data.officialCostUsd,
      amountUsd,
      discountMultiplier: data.modelDiscount.multiplier,
      model: data.model,
      usageType: data.usageType,
      adapterType: data.adapterType ?? null,
    });
  }

  return {
    status: result.status,
    officialCostUsd: data.officialCostUsd,
    amountUsd,
    discountMultiplier: data.modelDiscount.multiplier,
    usageType: data.usageType,
    taskRunId: data.taskRunId,
  };
});
