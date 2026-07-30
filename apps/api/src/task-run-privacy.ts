function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

type TaskRunPricingView = {
  taskType: string;
  userUuid: string | null;
  payload: unknown;
  result: unknown;
};

type ScheduledPromptView = {
  taskType: string;
  payload: unknown;
};

function sanitizeScheduledPromptPayload(payload: unknown) {
  if (!isRecord(payload)) return payload;

  let sanitized = payload;
  if (Object.hasOwn(sanitized, "systemInstructions")) {
    sanitized = { ...sanitized };
    delete sanitized.systemInstructions;
  }
  if (isRecord(sanitized.data) && Object.hasOwn(sanitized.data, "systemInstructions")) {
    const data = { ...sanitized.data };
    delete data.systemInstructions;
    sanitized = { ...sanitized, data };
  }
  return sanitized;
}

/** Keep scheduled prompt instructions in the execution payload, never client projections. */
export function sanitizeScheduledPromptForClient<T extends ScheduledPromptView>(
  value: T,
): T {
  if (value.taskType !== "send_message") return value;
  const payload = sanitizeScheduledPromptPayload(value.payload);
  return payload === value.payload ? value : { ...value, payload };
}

/**
 * Generation pricing reveals the creator's subscription tier. Keep the
 * server-side snapshot intact while removing it from collaborator-visible
 * task responses.
 */
export function sanitizeTaskRunPricingForViewer<T extends TaskRunPricingView>(
  run: T,
  viewerUserId: string | null | undefined,
): T {
  const isGeneration = run.taskType === "generation";
  const isBillingRetry = run.taskType === "generation.billing_retry";
  if ((!isGeneration && !isBillingRetry) || (viewerUserId && run.userUuid === viewerUserId)) return run;

  let payload = run.payload;
  if (isRecord(payload) && isRecord(payload.data)) {
    const data = { ...payload.data };
    let dataChanged = false;
    for (const key of isBillingRetry
      ? ["modelDiscount", "officialCostUsd", "amountUsd"]
      : ["modelDiscount"]) {
      if (Object.hasOwn(data, key)) {
        delete data[key];
        dataChanged = true;
      }
    }
    if (dataChanged) payload = { ...payload, data };
  }

  let result = run.result;
  if (isGeneration && isRecord(result) && Object.hasOwn(result, "billing")) {
    const nextResult = { ...result };
    delete nextResult.billing;
    result = nextResult;
  } else if (isBillingRetry && isRecord(result)) {
    const nextResult = { ...result };
    let resultChanged = false;
    for (const key of ["officialCostUsd", "amountUsd", "discountMultiplier"]) {
      if (Object.hasOwn(nextResult, key)) {
        delete nextResult[key];
        resultChanged = true;
      }
    }
    if (resultChanged) result = nextResult;
  }

  return payload === run.payload && result === run.result ? run : { ...run, payload, result };
}
