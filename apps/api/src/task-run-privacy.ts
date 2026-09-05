import { APP_ACTION_EXECUTION_SOURCE } from "@cohub/protocol/task";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

type TaskRunPricingView = {
  taskType: string;
  userUuid: string | null;
  payload: unknown;
  result: unknown;
};

function appActionActorUserId(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.data) || payload.data.source !== APP_ACTION_EXECUTION_SOURCE) return null;
  return typeof payload.data.actorUserId === "string" ? payload.data.actorUserId : null;
}

function sanitizeCommandContent(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((block) => {
    if (!isRecord(block)) return block;
    const next = { ...block };
    if (isRecord(next.input) && Object.hasOwn(next.input, "command")) {
      const input = { ...next.input };
      delete input.command;
      next.input = input;
    }
    if (isRecord(next._meta) && Object.hasOwn(next._meta, "command")) {
      const meta = { ...next._meta };
      delete meta.command;
      next._meta = meta;
    }
    return next;
  });
}

function sanitizeAppActionValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const next = { ...value };
  delete next.command;
  if (Object.hasOwn(next, "content")) next.content = sanitizeCommandContent(next.content);
  return next;
}

function sanitizeAppActionRun<T extends TaskRunPricingView>(run: T, viewerUserId: string | null | undefined): T {
  const actorUserId = appActionActorUserId(run.payload);
  if (!actorUserId || actorUserId === viewerUserId || !isRecord(run.payload) || !isRecord(run.payload.data)) return run;
  const data = run.payload.data;
  const payload = {
    ...run.payload,
    data: {
      source: APP_ACTION_EXECUTION_SOURCE,
      appId: data.appId,
      appVersionId: data.appVersionId,
      action: data.action,
    },
  };
  return { ...run, payload, result: sanitizeAppActionValue(run.result) };
}

export function sanitizeTaskRunProgressForViewer(
  run: Pick<TaskRunPricingView, "payload">,
  progress: unknown,
  viewerUserId: string | null | undefined,
): unknown {
  const actorUserId = appActionActorUserId(run.payload);
  return actorUserId && actorUserId !== viewerUserId
    ? sanitizeAppActionValue(progress)
    : progress;
}

/**
 * Keep server-side task snapshots intact while removing secrets from every
 * response and creator pricing from collaborator-visible responses.
 */
export function sanitizeTaskRunPricingForViewer<T extends TaskRunPricingView>(
  run: T,
  viewerUserId: string | null | undefined,
): T {
  const appActionRun = sanitizeAppActionRun(run, viewerUserId);
  let payload = appActionRun.payload;
  if (run.taskType === "create_space" && isRecord(payload) && isRecord(payload.data)) {
    const data = { ...payload.data };
    if (Object.hasOwn(data, "gitToken")) {
      delete data.gitToken;
      payload = { ...payload, data };
    }
  }

  const isGeneration = appActionRun.taskType === "generation";
  const isBillingRetry = appActionRun.taskType === "generation.billing_retry";
  if ((!isGeneration && !isBillingRetry) || (viewerUserId && appActionRun.userUuid === viewerUserId)) {
    return payload === appActionRun.payload ? appActionRun : { ...appActionRun, payload };
  }

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

  let result = appActionRun.result;
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

  return payload === appActionRun.payload && result === appActionRun.result
    ? appActionRun
    : { ...appActionRun, payload, result };
}
