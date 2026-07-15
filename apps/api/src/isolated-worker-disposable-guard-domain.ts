import type { Context } from "hono";

export type IsolatedWorkerDisposableState = "active" | "terminated";

export type IsolatedWorkerDisposableOperation =
  | "generic_mutation"
  | "generic_prompt"
  | "generic_task_dispatch"
  | "cron_schedule"
  | "sandbox_lifecycle"
  | "isolated_worker_dispatch"
  | "isolated_worker_runtime"
  | "isolated_worker_revoke"
  | "isolated_worker_checkpoint"
  | "isolated_worker_receipt_scan"
  | "isolated_worker_reuse_probe";

export type IsolatedWorkerDisposableRecord = {
  spaceMeta: unknown;
  sandboxStatus: string | null;
  sandboxMeta: unknown;
};

const ACTIVE_OPERATIONS = new Set<IsolatedWorkerDisposableOperation>([
  "isolated_worker_dispatch",
  "isolated_worker_runtime",
  "isolated_worker_revoke",
  "isolated_worker_checkpoint",
  "isolated_worker_reuse_probe",
]);

const TERMINATED_OPERATIONS = new Set<IsolatedWorkerDisposableOperation>([
  "isolated_worker_checkpoint",
  "isolated_worker_receipt_scan",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const hasOwn = (value: Record<string, unknown>, key: string) =>
  Object.hasOwn(value, key);

export function classifyIsolatedWorkerDisposable(
  input: IsolatedWorkerDisposableRecord | null,
): IsolatedWorkerDisposableState | null {
  if (!input) return null;
  const spaceMeta = isRecord(input.spaceMeta) ? input.spaceMeta : null;
  const sandboxMeta = isRecord(input.sandboxMeta) ? input.sandboxMeta : null;
  const hasDisposableIdentity = Boolean(
    (spaceMeta && hasOwn(spaceMeta, "isolatedWorkerDisposable"))
    || (sandboxMeta && (
      hasOwn(sandboxMeta, "isolatedWorker")
      || hasOwn(sandboxMeta, "isolatedWorkerPolicy")
      || hasOwn(sandboxMeta, "isolatedWorkerDisposable")
    )),
  );
  if (!hasDisposableIdentity) return null;

  const termination = sandboxMeta && isRecord(sandboxMeta.termination) ? sandboxMeta.termination : null;
  const isolatedWorker = sandboxMeta && isRecord(sandboxMeta.isolatedWorker) ? sandboxMeta.isolatedWorker : null;
  if (
    input.sandboxStatus === "terminated"
    || termination?.sandboxTerminated === true
    || isolatedWorker?.state === "terminated"
  ) return "terminated";
  return "active";
}

export class IsolatedWorkerDisposableOperationError extends Error {
  readonly code = "ISOLATED_WORKER_DISPOSABLE_OPERATION_FORBIDDEN";

  constructor(
    readonly spaceId: string,
    readonly state: IsolatedWorkerDisposableState,
    readonly operation: IsolatedWorkerDisposableOperation,
  ) {
    super(`generic ${operation} is forbidden for ${state} isolated worker disposable space`);
    this.name = "IsolatedWorkerDisposableOperationError";
  }
}

export function createIsolatedWorkerDisposableGuard(
  read: (spaceId: string) => Promise<IsolatedWorkerDisposableRecord | null>,
) {
  return async (spaceId: string, operation: IsolatedWorkerDisposableOperation) => {
    const state = classifyIsolatedWorkerDisposable(await read(spaceId));
    if (!state) return;
    if (state === "active" && ACTIVE_OPERATIONS.has(operation)) return;
    if (state === "terminated" && TERMINATED_OPERATIONS.has(operation)) return;
    throw new IsolatedWorkerDisposableOperationError(spaceId, state, operation);
  };
}

export function createIsolatedWorkerDisposableRouteGuard(
  assertAllowed: (spaceId: string, operation: IsolatedWorkerDisposableOperation) => Promise<void>,
) {
  return async (
    c: Context,
    input: { spaceId: string; operation: IsolatedWorkerDisposableOperation },
  ): Promise<Response | null> => {
    try {
      await assertAllowed(input.spaceId, input.operation);
      return null;
    } catch (error) {
      if (!(error instanceof IsolatedWorkerDisposableOperationError)) throw error;
      return c.json({
        message: "isolated worker disposable spaces only accept dedicated isolated worker lifecycle operations",
        code: error.code,
        state: error.state,
      }, 409);
    }
  };
}
