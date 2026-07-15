import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { and, eq } from "drizzle-orm";
import type { TaskPayload } from "@cohub/protocol/task";
import {
  ISOLATED_WORKER_DISPATCH_TASK_TYPE,
} from "@cohub/protocol/isolated-worker";
import { spaces, spaceMembers, spaceSandboxes, spaceSessions, sessionTurnSegments, sessionTurns, taskRuns } from "@cohub/db";
import { db } from "../db.js";
import { config } from "../config.js";
import { getSpaceWorkspaceDir } from "../git.js";
import { restoreWorkspaceFromCheckpoint } from "../checkpoint/restore.js";
import { ensureWorkerLocalTmpDir, getWorkerLocalTmpDir, removeWorkerLocalTmpDir } from "../local-tmp.js";
import { materializeFrozenInputManifest, verifyFrozenInputMaterialization } from "../isolated-worker-inputs.js";
import { registerTask } from "./registry.js";
import {
  canonicalIsolatedWorkerJson,
  createIsolatedWorkerDispatchHandler,
  isRecord,
  type IsolatedWorkerDispatchHandlerDependencies,
} from "./isolated-worker-dispatch-handler.js";

export {
  createIsolatedWorkerDispatchHandler,
  IsolatedWorkerDispatchRejectedError,
} from "./isolated-worker-dispatch-handler.js";

const preparedWorkspacePath = (taskRunId: string) =>
  `${config.spaceStorageRoot}/.isolated-worker-staging/${taskRunId}`;

class IsolatedWorkerPublishError extends Error {
  readonly spaceBaseCreated: boolean;

  constructor(cause: unknown, spaceBaseCreated: boolean) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "IsolatedWorkerPublishError";
    this.spaceBaseCreated = spaceBaseCreated;
  }
}

async function throwWithCleanup(primary: unknown, cleanups: Array<() => Promise<void>>, message: string): Promise<never> {
  const errors = [primary];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 1) throw new AggregateError(errors, message);
  throw primary;
}

async function pathExists(path: string) {
  return lstat(path).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

const productionDependencies: IsolatedWorkerDispatchHandlerDependencies = {
  async recoverReservation(input) {
    const preparedWorkspace = preparedWorkspacePath(input.taskRunId);
    const finalWorkspace = getSpaceWorkspaceDir(input.disposableSpaceId);
    const [row] = await db.select({ space: spaces, sandbox: spaceSandboxes, session: spaceSessions })
      .from(spaces)
      .innerJoin(spaceSandboxes, eq(spaceSandboxes.spaceId, spaces.id))
      .innerJoin(spaceSessions, and(eq(spaceSessions.id, input.sessionId), eq(spaceSessions.spaceId, spaces.id)))
      .where(eq(spaces.id, input.disposableSpaceId))
      .limit(1);
    const preparedExists = await pathExists(preparedWorkspace);
    const finalExists = await pathExists(finalWorkspace);
    if (!row) {
      if (finalExists) throw new Error("isolated worker final workspace exists without reservation");
      if (!preparedExists) return { state: "none" as const };
      try {
        await verifyFrozenInputMaterialization({ targetRoot: preparedWorkspace, inputBundle: input.data.inputBundle });
      } catch (error) {
        await throwWithCleanup(error, [() => rm(preparedWorkspace, { recursive: true, force: true })], "isolated worker abandoned staging validation and cleanup failed");
      }
      return { state: "staged" as const, inputsMaterializedAt: new Date().toISOString(), preparedWorkspace };
    }
    const meta = isRecord(row.sandbox.meta) ? row.sandbox.meta : null;
    const allocation = meta && isRecord(meta.isolatedWorker) ? meta.isolatedWorker : null;
    const sessionMeta = isRecord(row.session.meta) ? row.session.meta : null;
    if (row.sandbox.status !== "allocated") {
      const policy = meta && isRecord(meta.isolatedWorkerPolicy) ? meta.isolatedWorkerPolicy : null;
      const boundTurnId = typeof meta?.turnId === "string" ? meta.turnId : null;
      const [turn] = boundTurnId
        ? await db.select().from(sessionTurns).where(and(
            eq(sessionTurns.id, boundTurnId),
            eq(sessionTurns.sessionId, input.sessionId),
          )).limit(1)
        : [];
      const turnMeta = isRecord(turn?.meta) ? turn.meta : null;
      const dispatch = turnMeta && isRecord(turnMeta.isolatedWorkerDispatch) ? turnMeta.isolatedWorkerDispatch : null;
      const handle = turnMeta && isRecord(turnMeta.isolatedWorker) ? turnMeta.isolatedWorker : null;
      const handlePolicy = handle && isRecord(handle.isolatedWorkerPolicy) ? handle.isolatedWorkerPolicy : null;
      if (
        !turn
        || sessionMeta?.dispatchTaskRunId !== input.taskRunId
        || sessionMeta.authoritySpaceId !== input.authoritySpaceId
        || meta?.sessionId !== input.sessionId
        || meta.turnId !== turn.id
        || policy?.authoritySpaceId !== input.authoritySpaceId
        || policy.disposableSpaceId !== input.disposableSpaceId
        || policy.policySha256 !== input.data.policySha256
        || handle?.sessionId !== input.sessionId
        || handle.turnId !== turn.id
        || handlePolicy?.podUid !== policy.podUid
        || dispatch?.taskRunId !== input.taskRunId
        || dispatch.authoritySpaceId !== input.authoritySpaceId
        || dispatch.disposableSpaceId !== input.disposableSpaceId
        || dispatch.inputManifestSha256 !== input.data.inputManifestSha256
        || canonicalIsolatedWorkerJson(dispatch.inputBundle) !== canonicalIsolatedWorkerJson(input.data.inputBundle)
        || typeof dispatch.inputsMaterializedAt !== "string"
        || typeof dispatch.podCreatedAt !== "string"
        || Date.parse(dispatch.inputsMaterializedAt) >= Date.parse(dispatch.podCreatedAt)
      ) {
        throw new Error("isolated worker submitted recovery binding mismatch");
      }
      return {
        state: "submitted" as const,
        result: {
          authoritySpaceId: input.data.authoritySpaceId,
          disposableSpaceId: input.data.disposableSpaceId,
          sessionId: input.data.sessionId,
          turnId: turn.id,
          podUid: String(policy.podUid),
          policySha256: input.data.policySha256,
          authorityCheckpointId: input.data.inputBundle.authorityCheckpointId,
          authorityCheckpointCommit: input.data.inputBundle.authorityCheckpointCommit,
          authorityTreeSha256: input.data.inputBundle.authorityTreeSha256,
          inputManifestSha256: input.data.inputManifestSha256,
          inputCount: input.data.inputBundle.items.length,
          inputsMaterializedAt: dispatch.inputsMaterializedAt,
          podCreatedAt: dispatch.podCreatedAt,
          ordinarySandboxProvisioned: false,
          terminatedSpaceReused: false,
          executionTokenIssued: false,
          authorityExecutionTokenIssued: false,
          engineInternalSecretIssued: false,
          publicPromptUsed: false,
          checkpointAdapterReady: true,
        },
      };
    }
    if (
      row.space.userUuid !== input.userId
      || row.session.userUuid !== input.userId
      || row.session.source !== "isolated_worker_dispatch"
      || sessionMeta?.dispatchTaskRunId !== input.taskRunId
      || sessionMeta.authoritySpaceId !== input.authoritySpaceId
      || allocation?.authoritySpaceId !== input.authoritySpaceId
      || allocation.disposableSpaceId !== input.disposableSpaceId
      || allocation.dispatchTaskRunId !== input.taskRunId
      || allocation.policySha256 !== input.data.policySha256
      || allocation.creationPath !== input.data.creationPath
      || allocation.ordinarySandboxProvisioned !== false
      || allocation.terminatedSpaceReused !== false
      || allocation.credentialMode !== input.data.credentialMode
      || allocation.engineInternalSecretIssued !== false
      || allocation.publicPromptUsed !== false
      || allocation.authorityExecutionTokenIssued !== false
      || allocation.runtimeAuthorityReadAllowed !== false
      || allocation.authorityCheckpointId !== input.data.inputBundle.authorityCheckpointId
      || allocation.authorityCheckpointCommit !== input.data.inputBundle.authorityCheckpointCommit
      || allocation.authorityTreeSha256 !== input.data.inputBundle.authorityTreeSha256
      || allocation.inputManifestSha256 !== input.data.inputManifestSha256
      || allocation.inputCount !== input.data.inputBundle.items.length
      || allocation.preparedWorkspace !== preparedWorkspace
      || canonicalIsolatedWorkerJson(allocation.inputBundle) !== canonicalIsolatedWorkerJson(input.data.inputBundle)
      || typeof allocation.inputsMaterializedAt !== "string"
    ) {
      throw new Error("isolated worker recovery reservation binding mismatch");
    }
    if (allocation.state === "prepared") {
      if (preparedExists === finalExists) throw new Error("isolated worker prepared recovery filesystem phase mismatch");
      await verifyFrozenInputMaterialization({
        targetRoot: preparedExists ? preparedWorkspace : finalWorkspace,
        inputBundle: input.data.inputBundle,
      });
      return { state: "prepared" as const, inputsMaterializedAt: allocation.inputsMaterializedAt, preparedWorkspace };
    }
    if (allocation.state === "allocated") {
      if (preparedExists || !finalExists) throw new Error("isolated worker published recovery filesystem phase mismatch");
      await verifyFrozenInputMaterialization({ targetRoot: finalWorkspace, inputBundle: input.data.inputBundle });
      return { state: "published" as const, inputsMaterializedAt: allocation.inputsMaterializedAt, preparedWorkspace };
    }
    throw new Error("isolated worker reservation is not recoverable");
  },
  async readReservation(input) {
    const [row] = await db.select({
      space: spaces,
      sandbox: spaceSandboxes,
      session: spaceSessions,
      task: taskRuns,
    })
      .from(spaces)
      .innerJoin(spaceSandboxes, eq(spaceSandboxes.spaceId, spaces.id))
      .innerJoin(spaceSessions, and(eq(spaceSessions.id, input.sessionId), eq(spaceSessions.spaceId, spaces.id)))
      .innerJoin(taskRuns, eq(taskRuns.id, input.taskRunId))
      .where(and(eq(spaces.id, input.disposableSpaceId), eq(spaces.userUuid, input.userId)))
      .limit(1);
    const meta = isRecord(row?.sandbox.meta) ? row.sandbox.meta : null;
    const allocation = meta && isRecord(meta.isolatedWorker) ? meta.isolatedWorker : null;
    const sessionMeta = isRecord(row?.session.meta) ? row.session.meta : null;
    const persistedData = isRecord(row?.task.payload?.data) ? row.task.payload.data : null;
    if (
      !row
      || row.session.userUuid !== input.userId
      || row.session.source !== "isolated_worker_dispatch"
      || sessionMeta?.authoritySpaceId !== input.authoritySpaceId
      || sessionMeta.dispatchTaskRunId !== input.taskRunId
      || row.task.jobId !== input.taskRunId
      || row.task.taskType !== ISOLATED_WORKER_DISPATCH_TASK_TYPE
      || row.task.status !== "running"
      || row.task.spaceId !== input.authoritySpaceId
      || row.task.sessionId !== input.sessionId
      || row.task.userUuid !== input.userId
      || persistedData?.authoritySpaceId !== input.authoritySpaceId
      || persistedData.disposableSpaceId !== input.disposableSpaceId
      || persistedData.sessionId !== input.sessionId
      || persistedData.policySha256 !== input.policySha256
      || canonicalIsolatedWorkerJson(persistedData) !== canonicalIsolatedWorkerJson(input.dispatchData)
    ) {
      throw new Error("persisted isolated worker dispatch reservation binding mismatch");
    }
    return {
      authoritySpaceId: String(allocation?.authoritySpaceId ?? ""),
      disposableSpaceId: row?.space.id ?? "",
      sessionId: input.sessionId,
      userId: row?.space.userUuid ?? "",
      sandboxStatus: row?.sandbox.status ?? "missing",
      sandboxPodName: row?.sandbox.podName ?? null,
      allocation,
    };
  },
  async prepareWorkspace(input) {
    const evidenceRoot = getWorkerLocalTmpDir("isolated-inputs", input.disposableSpaceId, input.taskRunId);
    const sourceWorkspace = `${evidenceRoot}/source`;
    const archiveDir = `${evidenceRoot}/archive`;
    const preparedWorkspace = preparedWorkspacePath(input.taskRunId);
    await ensureWorkerLocalTmpDir(evidenceRoot);
    try {
      await mkdir(sourceWorkspace, { mode: 0o700 });
      await mkdir(dirname(preparedWorkspace), { recursive: true, mode: 0o700 });
      await mkdir(preparedWorkspace, { mode: 0o700 });
      const restored = await restoreWorkspaceFromCheckpoint({
        checkpointId: input.inputBundle.authorityCheckpointId,
        targetWorkspaceDir: sourceWorkspace,
        restoreTmpDir: archiveDir,
      });
      const checkpointMeta = isRecord(restored.checkpoint.meta) ? restored.checkpoint.meta : null;
      const gitTree = checkpointMeta && isRecord(checkpointMeta.gitTree) ? checkpointMeta.gitTree : null;
      if (
        restored.sourceSpace.id !== input.authoritySpaceId
        || restored.checkpoint.commitHash !== input.inputBundle.authorityCheckpointCommit
        || gitTree?.sha256 !== input.inputBundle.authorityTreeSha256
      ) {
        throw new Error("frozen authority checkpoint readback mismatch");
      }
      await materializeFrozenInputManifest({
        sourceRoot: sourceWorkspace,
        targetRoot: preparedWorkspace,
        inputBundle: input.inputBundle,
      });
      const inputsMaterializedAt = new Date().toISOString();
      try {
        await removeWorkerLocalTmpDir(evidenceRoot);
      } catch (cleanupError) {
        await throwWithCleanup(cleanupError, [() => rm(preparedWorkspace, { recursive: true, force: true })], "isolated worker evidence and staging cleanup failed");
      }
      return { inputsMaterializedAt, preparedWorkspace };
    } catch (error) {
      return throwWithCleanup(error, [
        () => removeWorkerLocalTmpDir(evidenceRoot),
        () => rm(preparedWorkspace, { recursive: true, force: true }),
      ], "isolated worker input preparation and cleanup failed");
    }
  },
  async cleanupPreparedWorkspace(input) {
    await rm(input.preparedWorkspace, { recursive: true, force: true });
  },
  async allocateReservation(input) {
    const data = input.data;
    const now = new Date();
    const creationProof = {
      authoritySpaceId: data.authoritySpaceId,
      disposableSpaceId: data.disposableSpaceId,
      dispatchTaskRunId: input.taskRunId,
      creationPath: data.creationPath,
      ordinarySandboxProvisioned: false,
      terminatedSpaceReused: false,
      credentialMode: data.credentialMode,
      engineInternalSecretIssued: false,
      publicPromptUsed: false,
      checkpointAdapter: data.checkpointAdapter,
      authorityCheckpointId: data.inputBundle.authorityCheckpointId,
      authorityTreeSha256: data.inputBundle.authorityTreeSha256,
      inputManifestSha256: data.inputManifestSha256,
      authorityExecutionTokenIssued: false,
      runtimeAuthorityReadAllowed: false,
    };
    await db.transaction(async (tx) => {
      await tx.insert(spaces).values({
        id: data.disposableSpaceId,
        userUuid: input.userId,
        name: `Isolated worker ${data.disposableSpaceId.slice(0, 8)}`,
        storageRepoName: `space-${data.disposableSpaceId}`,
        lastActivityAt: now,
        meta: {
          isolatedWorkerDisposable: creationProof,
          bootstrap: { status: "ready", source: { type: "isolated_worker_dispatch", authoritySpaceId: data.authoritySpaceId } },
        },
      });
      await tx.insert(spaceMembers).values({
        spaceId: data.disposableSpaceId,
        userId: input.userId,
        role: "host",
        createdBy: input.userId,
        updatedBy: input.userId,
      });
      await tx.insert(spaceSessions).values({
        id: data.sessionId,
        spaceId: data.disposableSpaceId,
        userUuid: input.userId,
        title: "Isolated worker",
        source: "isolated_worker_dispatch",
        status: "active",
        lastMessageAt: now,
        lastMessageId: null,
        meta: {
          createdBy: "isolated_worker_dispatch",
          authoritySpaceId: data.authoritySpaceId,
          dispatchTaskRunId: input.taskRunId,
          participants: { userUuids: [input.userId] },
        },
      });
      await tx.insert(sessionTurnSegments).values({
        sessionId: data.sessionId,
        ordinal: 1,
        sourceSessionId: data.sessionId,
        fromSequence: 1,
        toSequence: null,
      });
      await tx.insert(spaceSandboxes).values({
        spaceId: data.disposableSpaceId,
        provider: "cloud",
        status: "allocated",
        runtimeStatus: "unknown",
        podName: null,
        meta: {
          isolatedWorker: {
            state: "prepared",
            authoritySpaceId: data.authoritySpaceId,
            disposableSpaceId: data.disposableSpaceId,
            dispatchTaskRunId: input.taskRunId,
            policySha256: data.policySha256,
            creationPath: data.creationPath,
            ordinarySandboxProvisioned: false,
            terminatedSpaceReused: false,
            credentialMode: data.credentialMode,
            engineInternalSecretIssued: false,
            publicPromptUsed: false,
            authorityExecutionTokenIssued: false,
            runtimeAuthorityReadAllowed: false,
            authorityCheckpointId: data.inputBundle.authorityCheckpointId,
            authorityCheckpointCommit: data.inputBundle.authorityCheckpointCommit,
            authorityTreeSha256: data.inputBundle.authorityTreeSha256,
            inputManifestSha256: data.inputManifestSha256,
            inputCount: data.inputBundle.items.length,
            inputBundle: data.inputBundle,
            inputsMaterializedAt: input.inputsMaterializedAt,
            preparedWorkspace: input.preparedWorkspace,
            resumable: false,
          },
          resumable: false,
        },
      });
    });
  },
  async publishWorkspace(input) {
    const expectedPrepared = preparedWorkspacePath(input.taskRunId);
    if (input.preparedWorkspace !== expectedPrepared) throw new Error("isolated worker staging path binding mismatch");
    const finalWorkspace = getSpaceWorkspaceDir(input.disposableSpaceId);
    let spaceBaseCreated = false;
    try {
      const preparedExists = await pathExists(input.preparedWorkspace);
      const finalExists = await pathExists(finalWorkspace);
      if (preparedExists && finalExists) throw new Error("isolated worker publish found both staging and final workspace");
      if (!preparedExists && !finalExists) throw new Error("isolated worker publish found no workspace");
      if (preparedExists) {
        const spaceBase = dirname(finalWorkspace);
        if (await pathExists(spaceBase)) {
          const info = await lstat(spaceBase);
          if (info.isSymbolicLink() || !info.isDirectory() || (await readdir(spaceBase)).length !== 0) {
            throw new Error("isolated worker publish base directory is not empty");
          }
          spaceBaseCreated = true;
        } else {
          await mkdir(spaceBase, { mode: 0o775 });
          spaceBaseCreated = true;
        }
        await rename(input.preparedWorkspace, finalWorkspace);
      } else {
        spaceBaseCreated = true;
      }
      await verifyFrozenInputMaterialization({ targetRoot: finalWorkspace, inputBundle: input.data.inputBundle });
      const [updated] = await db.update(spaceSandboxes).set({
        meta: {
          isolatedWorker: {
            state: "allocated",
            authoritySpaceId: input.data.authoritySpaceId,
            disposableSpaceId: input.data.disposableSpaceId,
            dispatchTaskRunId: input.taskRunId,
            policySha256: input.data.policySha256,
            creationPath: input.data.creationPath,
            ordinarySandboxProvisioned: false,
            terminatedSpaceReused: false,
            credentialMode: input.data.credentialMode,
            engineInternalSecretIssued: false,
            publicPromptUsed: false,
            authorityExecutionTokenIssued: false,
            runtimeAuthorityReadAllowed: false,
            authorityCheckpointId: input.data.inputBundle.authorityCheckpointId,
            authorityCheckpointCommit: input.data.inputBundle.authorityCheckpointCommit,
            authorityTreeSha256: input.data.inputBundle.authorityTreeSha256,
            inputManifestSha256: input.data.inputManifestSha256,
            inputCount: input.data.inputBundle.items.length,
            inputBundle: input.data.inputBundle,
            inputsMaterializedAt: input.inputsMaterializedAt,
            preparedWorkspace: input.preparedWorkspace,
            resumable: false,
          },
          resumable: false,
        },
        updatedAt: new Date(),
      }).where(and(
        eq(spaceSandboxes.spaceId, input.disposableSpaceId),
        eq(spaceSandboxes.status, "allocated"),
      )).returning({ spaceId: spaceSandboxes.spaceId });
      if (!updated) throw new Error("isolated worker published workspace reservation CAS failed");
    } catch (error) {
      throw new IsolatedWorkerPublishError(error, spaceBaseCreated);
    }
  },
  async rollbackReservation(input) {
    const expectedPrepared = preparedWorkspacePath(input.taskRunId);
    if (input.preparedWorkspace !== expectedPrepared) throw new Error("isolated worker rollback staging path binding mismatch");
    const spaceBaseDir = dirname(getSpaceWorkspaceDir(input.disposableSpaceId));
    const filesystemErrors: unknown[] = [];
    const cleanupPaths = [input.preparedWorkspace];
    if (input.cause instanceof IsolatedWorkerPublishError && input.cause.spaceBaseCreated) cleanupPaths.push(spaceBaseDir);
    for (const path of cleanupPaths) {
      try {
        await rm(path, { recursive: true, force: true });
      } catch (error) {
        filesystemErrors.push(error);
      }
    }
    if (filesystemErrors.length > 0) {
      const orphanMeta = {
        isolatedWorker: {
          state: "orphan_cleanup_required",
          disposableSpaceId: input.disposableSpaceId,
          resumable: false,
        },
        resumable: false,
      };
      try {
        await db.update(spaceSandboxes).set({ status: "stopping", meta: orphanMeta, updatedAt: new Date() })
          .where(eq(spaceSandboxes.spaceId, input.disposableSpaceId));
      } catch (markError) {
        filesystemErrors.push(markError);
      }
      throw new AggregateError(filesystemErrors, "isolated worker orphan workspace cleanup failed");
    }
    try {
      await db.transaction(async (tx) => {
        await tx.delete(sessionTurnSegments).where(eq(sessionTurnSegments.sessionId, input.sessionId));
        await tx.delete(spaceSessions).where(eq(spaceSessions.id, input.sessionId));
        await tx.delete(spaceSandboxes).where(eq(spaceSandboxes.spaceId, input.disposableSpaceId));
        await tx.delete(spaceMembers).where(eq(spaceMembers.spaceId, input.disposableSpaceId));
        await tx.delete(spaces).where(eq(spaces.id, input.disposableSpaceId));
      });
    } catch (error) {
      try {
        await db.update(spaceSandboxes).set({
          status: "stopping",
          meta: { isolatedWorker: { state: "orphan_cleanup_required", disposableSpaceId: input.disposableSpaceId, resumable: false }, resumable: false },
          updatedAt: new Date(),
        }).where(eq(spaceSandboxes.spaceId, input.disposableSpaceId));
      } catch (markError) {
        throw new AggregateError([error, markError], "isolated worker rollback database cleanup and orphan marking failed");
      }
      throw error;
    }
  },
  async submitInternal(input) {
    const response = await fetch(
      `${config.internalApiBaseUrl}/internal/spaces/${input.disposableSpaceId}/sessions/${input.sessionId}/prompt`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-secret": config.workerSecret },
        body: JSON.stringify({
          content: input.content,
          userId: input.userId,
          clientMessageId: input.clientMessageId,
          source: input.source,
          model: input.model,
          provider: input.provider,
          accessMode: "isolated_worker",
          isolatedWorkerPolicy: {
            authoritySpaceId: input.authoritySpaceId,
            disposableSpaceId: input.disposableSpaceId,
            writableRoot: "/workspace/work",
            workspaceReadOnly: true,
            executionTokenIssued: false,
            policySha256: input.policySha256,
          },
          inputBundle: input.inputBundle,
          inputsMaterializedAt: input.inputsMaterializedAt,
          dispatchTaskRunId: input.dispatchTaskRunId,
          context: { kind: "scheduled_task", taskRunId: input.dispatchTaskRunId },
        }),
      },
    );
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw new Error(`isolated worker internal prompt failed ${response.status}: ${JSON.stringify(body)}`);
    return {
      turnId: typeof body?.turnId === "string" ? body.turnId : "",
      podUid: typeof body?.podUid === "string" ? body.podUid : "",
      policySha256: typeof body?.policySha256 === "string" ? body.policySha256 : "",
      podCreatedAt: typeof body?.podCreatedAt === "string" ? body.podCreatedAt : "",
    };
  },
};

const handler = createIsolatedWorkerDispatchHandler(productionDependencies);

registerTask(ISOLATED_WORKER_DISPATCH_TASK_TYPE, async (job, context) => {
  if (!context?.taskRunId) throw new Error("isolated worker dispatch TaskRun id is required");
  return handler({ taskRunId: context.taskRunId, payload: job.data as TaskPayload });
});
