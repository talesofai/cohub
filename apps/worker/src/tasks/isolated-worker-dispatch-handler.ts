import { createHash } from "node:crypto";
import type { TaskPayload } from "@cohub/protocol/task";
import {
  ISOLATED_WORKER_CREATION_PATH,
  ISOLATED_WORKER_DISPATCH_TASK_TYPE,
  type IsolatedWorkerDispatchTaskData,
} from "@cohub/protocol/isolated-worker";

type Reservation = {
  authoritySpaceId: string;
  disposableSpaceId: string;
  sessionId: string;
  userId: string;
  sandboxStatus: string;
  sandboxPodName: string | null;
  allocation: Record<string, unknown> | null;
};

type DispatchInvocation = { taskRunId: string; payload: TaskPayload };

export class IsolatedWorkerDispatchRejectedError extends Error {
  readonly taskResult: Record<string, unknown>;

  constructor(message: string, taskResult: Record<string, unknown>) {
    super(message);
    this.name = "IsolatedWorkerDispatchRejectedError";
    this.taskResult = taskResult;
  }
}

export type IsolatedWorkerDispatchHandlerDependencies = {
  recoverReservation(input: {
    taskRunId: string;
    authoritySpaceId: string;
    disposableSpaceId: string;
    sessionId: string;
    userId: string;
    data: IsolatedWorkerDispatchTaskData;
  }): Promise<
    | { state: "none" }
    | { state: "submitted"; result: Record<string, unknown> }
    | { state: "staged" | "prepared" | "published"; inputsMaterializedAt: string; preparedWorkspace: string }
  >;
  readReservation(input: {
    taskRunId: string;
    authoritySpaceId: string;
    disposableSpaceId: string;
    sessionId: string;
    userId: string;
    policySha256: string;
    dispatchData: IsolatedWorkerDispatchTaskData;
  }): Promise<Reservation>;
  prepareWorkspace(input: {
    taskRunId: string;
    authoritySpaceId: string;
    disposableSpaceId: string;
    inputBundle: IsolatedWorkerDispatchTaskData["inputBundle"];
  }): Promise<{ inputsMaterializedAt: string; preparedWorkspace: string }>;
  cleanupPreparedWorkspace(input: { preparedWorkspace: string }): Promise<void>;
  allocateReservation(input: {
    taskRunId: string;
    userId: string;
    data: IsolatedWorkerDispatchTaskData;
    inputsMaterializedAt: string;
    preparedWorkspace: string;
  }): Promise<void>;
  publishWorkspace(input: {
    taskRunId: string;
    disposableSpaceId: string;
    preparedWorkspace: string;
    inputsMaterializedAt: string;
    data: IsolatedWorkerDispatchTaskData;
  }): Promise<void>;
  rollbackReservation(input: {
    taskRunId: string;
    disposableSpaceId: string;
    sessionId: string;
    preparedWorkspace: string;
    cause: unknown;
  }): Promise<void>;
  submitInternal(input: {
    dispatchTaskRunId: string;
    authoritySpaceId: string;
    disposableSpaceId: string;
    sessionId: string;
    userId: string;
    clientMessageId: string;
    content: IsolatedWorkerDispatchTaskData["content"];
    source: string;
    model: string | null;
    provider: string | null;
    policySha256: string;
    inputBundle: IsolatedWorkerDispatchTaskData["inputBundle"];
    inputsMaterializedAt: string;
  }): Promise<{ turnId: string; podUid: string; policySha256: string; podCreatedAt: string }>;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function canonicalIsolatedWorkerJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalIsolatedWorkerJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalIsolatedWorkerJson(record[key])}`).join(",")}}`;
}

function parseDispatchData(payload: TaskPayload): IsolatedWorkerDispatchTaskData {
  const data = payload.data;
  if (!isRecord(data)) throw new Error("isolated worker dispatch data is required");
  const exact = {
    creationPath: ISOLATED_WORKER_CREATION_PATH,
    ordinarySandboxProvisioned: false,
    terminatedSpaceReused: false,
    credentialMode: "engine_scoped_dispatch_authority",
    engineInternalSecretIssued: false,
    publicPromptUsed: false,
    checkpointAdapter: "trusted_production",
  } as const;
  for (const [field, expected] of Object.entries(exact)) {
    if (data[field] !== expected) throw new Error(`isolated worker dispatch ${field} mismatch`);
  }
  for (const field of ["authoritySpaceId", "disposableSpaceId", "sessionId", "clientMessageId", "source"] as const) {
    if (typeof data[field] !== "string" || !data[field].trim()) throw new Error(`isolated worker dispatch ${field} is required`);
  }
  if (!Array.isArray(data.content) || data.content.length === 0) throw new Error("isolated worker dispatch content is required");
  if (typeof data.policySha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.policySha256)) {
    throw new Error("isolated worker dispatch policySha256 is malformed");
  }
  if (!isRecord(data.inputBundle) || typeof data.inputManifestSha256 !== "string" || data.inputBundle.inputManifestSha256 !== data.inputManifestSha256) {
    throw new Error("isolated worker dispatch input bundle is invalid");
  }
  if (!Array.isArray(data.inputBundle.items) || data.inputBundle.items.length < 1 || data.inputBundle.items.length > 32) {
    throw new Error("isolated worker dispatch input bundle items are invalid");
  }
  const manifestCanonical = canonicalIsolatedWorkerJson({
    authorityCheckpointId: data.inputBundle.authorityCheckpointId,
    authorityCheckpointCommit: data.inputBundle.authorityCheckpointCommit,
    authorityTreeSha256: data.inputBundle.authorityTreeSha256,
    items: data.inputBundle.items,
  });
  const manifestHash = createHash("sha256").update(manifestCanonical).digest("hex");
  if (manifestHash !== data.inputManifestSha256 || data.inputBundle.runtimeAuthorityReadAllowed !== false) {
    throw new Error("isolated worker dispatch input manifest hash mismatch");
  }
  if (data.model !== null && typeof data.model !== "string") throw new Error("isolated worker dispatch model is invalid");
  if (data.provider !== null && typeof data.provider !== "string") throw new Error("isolated worker dispatch provider is invalid");
  return data as unknown as IsolatedWorkerDispatchTaskData;
}

function classifyMaterializationFailure(message: string) {
  if (message.includes("symlink") || message.includes("regular file")) return "input_symlink_forbidden";
  if (message.includes("hash mismatch")) return "input_hash_mismatch";
  if (message.includes("ENOENT") || message.includes("not found") || message.includes("undeclared")) return "input_undeclared";
  if (message.includes("path") || message.includes("inputs/")) return "input_path_forbidden";
  return "input_materialization_failed";
}

export function createIsolatedWorkerDispatchHandler(deps: IsolatedWorkerDispatchHandlerDependencies) {
  const inFlight = new Map<string, Promise<void>>();
  return async (input: DispatchInvocation) => {
    const previous = inFlight.get(input.taskRunId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    inFlight.set(input.taskRunId, queued);
    await previous;
    try {
    if (input.payload.type !== ISOLATED_WORKER_DISPATCH_TASK_TYPE) throw new Error("isolated worker dispatch task type mismatch");
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.taskRunId)) {
      throw new Error("isolated worker dispatch TaskRun id is malformed");
    }
    const raw = input.payload.data;
    if (isRecord(raw) && raw.reuseRejected === true) {
      if (
        typeof raw.disposableSpaceId !== "string"
        || raw.reason !== "terminated_space_reuse_forbidden"
        || raw.authoritySpaceId !== input.payload.spaceId
      ) {
        throw new Error("isolated worker reuse rejection binding mismatch");
      }
      throw new IsolatedWorkerDispatchRejectedError("terminated space reuse forbidden", {
        disposableSpaceId: raw.disposableSpaceId,
        rejected: true,
        reason: "terminated_space_reuse_forbidden",
      });
    }
    const data = parseDispatchData(input.payload);
    if (
      data.authoritySpaceId !== input.payload.spaceId
      || data.sessionId !== input.payload.sessionId
      || !input.payload.userId
    ) {
      throw new Error("isolated worker TaskRun binding mismatch");
    }
    const recovered = await deps.recoverReservation({
      taskRunId: input.taskRunId,
      authoritySpaceId: data.authoritySpaceId,
      disposableSpaceId: data.disposableSpaceId,
      sessionId: data.sessionId,
      userId: input.payload.userId,
      data,
    });
    if (recovered.state === "submitted") return recovered.result;
    let materialized: { inputsMaterializedAt: string; preparedWorkspace: string };
    if (recovered.state === "none") {
      try {
        materialized = await deps.prepareWorkspace({
          taskRunId: input.taskRunId,
          authoritySpaceId: data.authoritySpaceId,
          disposableSpaceId: data.disposableSpaceId,
          inputBundle: data.inputBundle,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new IsolatedWorkerDispatchRejectedError(message, {
          disposableSpaceId: data.disposableSpaceId,
          rejected: true,
          reason: classifyMaterializationFailure(message),
          podCreated: false,
          disposableSpaceCreated: false,
          authorityExecutionTokenIssued: false,
        });
      }
    } else {
      materialized = recovered;
    }
    if (recovered.state === "none" || recovered.state === "staged") {
      try {
        await deps.allocateReservation({
          taskRunId: input.taskRunId,
          userId: input.payload.userId,
          data,
          inputsMaterializedAt: materialized.inputsMaterializedAt,
          preparedWorkspace: materialized.preparedWorkspace,
        });
      } catch (error) {
        try {
          await deps.cleanupPreparedWorkspace({ preparedWorkspace: materialized.preparedWorkspace });
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "isolated worker reservation and staging cleanup both failed");
        }
        throw error;
      }
    }
    if (recovered.state !== "published") {
      try {
        await deps.publishWorkspace({
          taskRunId: input.taskRunId,
          disposableSpaceId: data.disposableSpaceId,
          preparedWorkspace: materialized.preparedWorkspace,
          inputsMaterializedAt: materialized.inputsMaterializedAt,
          data,
        });
      } catch (error) {
        try {
          await deps.rollbackReservation({
            taskRunId: input.taskRunId,
            disposableSpaceId: data.disposableSpaceId,
            sessionId: data.sessionId,
            preparedWorkspace: materialized.preparedWorkspace,
            cause: error,
          });
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "isolated worker publish and reservation rollback both failed");
        }
        throw error;
      }
    }
    const reservation = await deps.readReservation({
      taskRunId: input.taskRunId,
      authoritySpaceId: data.authoritySpaceId,
      disposableSpaceId: data.disposableSpaceId,
      sessionId: data.sessionId,
      userId: input.payload.userId,
      policySha256: data.policySha256,
      dispatchData: data,
    });
    const allocation = reservation.allocation;
    if (
      reservation.authoritySpaceId !== data.authoritySpaceId
      || reservation.disposableSpaceId !== data.disposableSpaceId
      || reservation.sessionId !== data.sessionId
      || reservation.userId !== input.payload.userId
      || reservation.sandboxStatus !== "allocated"
      || reservation.sandboxPodName !== null
      || allocation?.state !== "allocated"
      || allocation.authoritySpaceId !== data.authoritySpaceId
      || allocation.disposableSpaceId !== data.disposableSpaceId
      || allocation.resumable !== false
      || canonicalIsolatedWorkerJson(allocation.inputBundle) !== canonicalIsolatedWorkerJson(data.inputBundle)
    ) {
      throw new Error("disposable worker reservation is not an unused allocated space");
    }
    const submitted = await deps.submitInternal({
      dispatchTaskRunId: input.taskRunId,
      authoritySpaceId: data.authoritySpaceId,
      disposableSpaceId: data.disposableSpaceId,
      sessionId: data.sessionId,
      userId: input.payload.userId,
      clientMessageId: data.clientMessageId,
      content: data.content,
      source: data.source,
      model: data.model,
      provider: data.provider,
      policySha256: data.policySha256,
      inputBundle: data.inputBundle,
      inputsMaterializedAt: materialized.inputsMaterializedAt,
    });
    if (!submitted.turnId || !submitted.podUid || submitted.policySha256 !== data.policySha256) {
      throw new Error("isolated worker internal prompt response binding mismatch");
    }
    const materializedAt = Date.parse(materialized.inputsMaterializedAt);
    const podCreatedAt = Date.parse(submitted.podCreatedAt);
    if (!Number.isFinite(materializedAt) || !Number.isFinite(podCreatedAt) || materializedAt >= podCreatedAt) {
      throw new Error("isolated worker input materialization did not precede Pod creation");
    }
    return {
      authoritySpaceId: data.authoritySpaceId,
      disposableSpaceId: data.disposableSpaceId,
      sessionId: data.sessionId,
      turnId: submitted.turnId,
      podUid: submitted.podUid,
      policySha256: data.policySha256,
      authorityCheckpointId: data.inputBundle.authorityCheckpointId,
      authorityCheckpointCommit: data.inputBundle.authorityCheckpointCommit,
      authorityTreeSha256: data.inputBundle.authorityTreeSha256,
      inputManifestSha256: data.inputManifestSha256,
      inputCount: data.inputBundle.items.length,
      inputsMaterializedAt: materialized.inputsMaterializedAt,
      podCreatedAt: submitted.podCreatedAt,
      ordinarySandboxProvisioned: false,
      terminatedSpaceReused: false,
      executionTokenIssued: false,
      authorityExecutionTokenIssued: false,
      engineInternalSecretIssued: false,
      publicPromptUsed: false,
      checkpointAdapterReady: true,
    };
    } finally {
      release();
      if (inFlight.get(input.taskRunId) === queued) inFlight.delete(input.taskRunId);
    }
  };
}
