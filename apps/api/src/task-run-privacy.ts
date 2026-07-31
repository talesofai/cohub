function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

type TaskRunPricingView = {
  taskType: string;
  userUuid: string | null;
  payload: unknown;
  result: unknown;
};

type ViewerIdentity = string | {
  uuid?: string | null;
  legacyUserUuid?: string | null;
};

const viewerIdentityKeys = (viewer: ViewerIdentity | null | undefined) => {
  if (typeof viewer === "string") return [viewer.trim()].filter(Boolean);
  return [...new Set([viewer?.uuid, viewer?.legacyUserUuid]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim()))];
};

/**
 * Generation pricing reveals the creator's subscription tier. Keep the
 * server-side snapshot intact while removing it from collaborator-visible
 * task responses.
 */
export function sanitizeTaskRunPricingForViewer<T extends TaskRunPricingView>(
  run: T,
  viewer: ViewerIdentity | null | undefined,
): T {
  const isGeneration = run.taskType === "generation";
  const isBillingRetry = run.taskType === "generation.billing_retry";
  if ((!isGeneration && !isBillingRetry) || (run.userUuid && viewerIdentityKeys(viewer).includes(run.userUuid))) return run;

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
