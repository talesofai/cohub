import { parsePromptSystemInstructions } from "@cohub/core/sessions";

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

type TaskRunInternalView = ScheduledPromptView & {
  idempotencyFingerprint?: unknown;
};

type CronJobInternalView = ScheduledPromptView & {
  idempotencyKey?: unknown;
  requestFingerprint?: unknown;
  scheduleVersion?: unknown;
  queueSyncedVersion?: unknown;
};

function sanitizeScheduledPromptPayload(payload: unknown) {
  if (!isRecord(payload)) return { payload, hasSystemInstructions: false };

  let sanitized = payload;
  let hasSystemInstructions = false;
  const privateKeys = ["systemInstructions", "auth", "env"] as const;
  for (const key of privateKeys) {
    if (!Object.hasOwn(sanitized, key)) continue;
    if (key === "systemInstructions") hasSystemInstructions = true;
    sanitized = sanitized === payload ? { ...sanitized } : sanitized;
    delete sanitized[key];
  }
  if (isRecord(sanitized.data)) {
    const data = { ...sanitized.data };
    let changed = false;
    for (const key of privateKeys) {
      if (!Object.hasOwn(data, key)) continue;
      if (key === "systemInstructions") hasSystemInstructions = true;
      delete data[key];
      changed = true;
    }
    if (changed) sanitized = { ...sanitized, data };
  }
  return { payload: sanitized, hasSystemInstructions };
}

/** Keep scheduled prompt instructions in the execution payload, never client projections. */
export function sanitizeScheduledPromptForClient<T extends ScheduledPromptView>(
  value: T,
): T & { hasSystemInstructions?: boolean } {
  if (value.taskType !== "send_message") return value;
  const { payload, hasSystemInstructions } = sanitizeScheduledPromptPayload(value.payload);
  return { ...value, payload, hasSystemInstructions };
}

/** Drop internal request identity from task-run projections. */
export function sanitizeTaskRunForClient<T extends TaskRunInternalView>(
  value: T,
): Omit<T, "idempotencyFingerprint"> & { hasSystemInstructions?: boolean } {
  const { idempotencyFingerprint: _idempotencyFingerprint, ...publicValue } = value;
  return sanitizeScheduledPromptForClient(publicValue);
}

/** Keep queue synchronization observable without exposing its implementation state. */
export function sanitizeCronJobForClient<T extends CronJobInternalView>(
  value: T,
): Omit<T, "idempotencyKey" | "requestFingerprint" | "scheduleVersion" | "queueSyncedVersion"> & {
  hasSystemInstructions?: boolean;
} {
  const {
    idempotencyKey: _idempotencyKey,
    requestFingerprint: _requestFingerprint,
    scheduleVersion: _scheduleVersion,
    queueSyncedVersion: _queueSyncedVersion,
    ...publicValue
  } = value;
  return sanitizeScheduledPromptForClient(publicValue);
}

/** Preserve hidden instructions on ordinary cron edits; explicit values replace or clear them. */
export function prepareScheduledPromptPayloadUpdate(input: {
  taskType: string;
  currentPayload: unknown;
  nextPayload: Record<string, unknown>;
}) {
  if (input.taskType !== "send_message") return input.nextPayload;

  const next = { ...input.nextPayload };
  delete next.auth;
  if (Object.hasOwn(next, "systemInstructions")) {
    const systemInstructions = parsePromptSystemInstructions(next.systemInstructions);
    if (systemInstructions) next.systemInstructions = systemInstructions;
    else delete next.systemInstructions;
  } else if (isRecord(input.currentPayload) && Object.hasOwn(input.currentPayload, "systemInstructions")) {
    next.systemInstructions = input.currentPayload.systemInstructions;
  }
  if (isRecord(input.currentPayload) && Object.hasOwn(input.currentPayload, "auth")) {
    next.auth = input.currentPayload.auth;
  }
  if (
    !Object.hasOwn(next, "env")
    && isRecord(input.currentPayload)
    && Object.hasOwn(input.currentPayload, "env")
  ) {
    next.env = input.currentPayload.env;
  }
  return next;
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
