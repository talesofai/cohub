import { createLogger } from "@cohub/infra/logging";
import { Hono } from "hono";
import { BillingAccessBlockedError, serializeBillingBlocked } from "@cohub/billing";
import { attachSandboxPublicEndpoints } from "../../sandbox-public-network.js";
import type {
  PersistMessageInput,
  UpdateSessionInfoInput,
} from "@cohub/protocol/model";
import type { ContentBlock } from "@cohub/protocol/core";
import {
  getSpaceById,
  getSpaceSessionById,
  persistMessageNode,
  updateSpaceSessionInfo,
  updateSpaceStatus,
  SandboxNotReadyError,
} from "../../space-sessions.js";
import { abortSessionTurn, failSessionTurn, interruptSessionTurn } from "../../session-turns.js";
import { getSessionTurnById } from "../../session-turns.js";
import { hasPermission } from "../../permissions.js";
import { dispatchTurnFinalized } from "../../session-output.js";
import { submitSessionPrompt, type AgentPromptAccessMode, type SubmitSessionPromptContext } from "../../session-prompts.js";
import { parsePromptEnv, PromptEnvValidationError } from "@cohub/core/sessions";
import { createWorkSessionToken, verifyWorkSessionToken } from "../../work-sessions.js";
import { mergePromptContextAuth, promptAuthContextFromWorkSession } from "../../prompt-auth-context.js";
import { getSpaceSandboxBySpaceId, updateSpaceSandbox, recoverSpaceSandbox } from "../../space-sandboxes.js";
import { isSandboxReportTokenValid } from "../../crypto.js";
import { normalizeSandboxLifecycleStatus, normalizeSandboxRuntimeStatus } from "@cohub/sandbox-controller";
import {
  ensureInternalRequest,
  getRequestRemoteAddress,
  isPrivateNetworkAddress,
  requireValidId,
} from "../../lib/middleware.js";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { sessionTurns, taskRuns } from "@cohub/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  isolatedWorkerPodLifecycle,
  type IsolatedWorkerPodHandle,
} from "../../isolated-worker-pods.js";
import {
  assertExactIsolatedWorkerPromptBody,
  parseIsolatedWorkerPolicyInput,
  submitIsolatedWorkerPrompt,
  type IsolatedWorkerPolicyInput,
} from "../../isolated-worker-prompt.js";
import {
  computeIsolatedWorkerInputManifestSha256,
  computeIsolatedWorkerPolicySha256,
  canonicalIsolatedWorkerJson,
} from "../../isolated-worker-dispatch.js";
import type { IsolatedWorkerInputBundle } from "@cohub/protocol/isolated-worker";
import type { IsolatedWorkerTerminalStatus } from "@cohub/protocol/isolated-worker";
import {
  readIsolatedWorkerTermination,
  scheduleIsolatedWorkerTermination,
  waitForIsolatedWorkerTermination,
} from "../../isolated-worker-termination.js";
import { rejectIsolatedWorkerDisposableRouteMutation } from "../../isolated-worker-disposable-guard.js";


const logger = createLogger({ serviceName: "cohub-api" });
const ALLOWED_SANDBOX_META_KEYS = new Set([
  "workspaceDir",
  "sandboxId",
  "lastProvisionedAt",
  "lastStatus",
  "lastError",
  "podName",
  "podIp",
  "wsEndpoint",
  "hostname",
  "imageVersion",
  "startedAt",
  "errorClass",
  "requiresPodRecreate",
  "mountPath",
  "recoverySource",
]);

function sanitizeSandboxMeta(input: Record<string, unknown> | null | undefined) {
  if (!input) return null;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_SANDBOX_META_KEYS.has(key)) continue;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      output[key] = value;
    }
  }
  return Object.keys(output).length > 0 ? output : null;
}

const router = new Hono();

// GET /internal/spaces/:id
router.get("/:id", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  return c.json({
    space: {
      id: space.id,
      userUuid: space.userUuid,
      name: space.name,
      meta: space.meta,
    },
  });
});

// POST /internal/spaces/:id/status
router.post("/:id/status", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);
  const rejected = await rejectIsolatedWorkerDisposableRouteMutation(c, { spaceId, operation: "sandbox_lifecycle" });
  if (rejected) return rejected;

  const body = await c.req.json<{ status?: string; meta?: Record<string, unknown> | null }>().catch(() => null);
  if (!body?.status) return c.json({ message: "status is required" }, 400);

  await updateSpaceStatus(spaceId, body.status);

  const safeMeta = sanitizeSandboxMeta(body.meta);
  if (safeMeta) {
    try {
      const sandbox = await getSpaceSandboxBySpaceId(spaceId);
      await updateSpaceSandbox({
        spaceId,
        meta: {
          ...((sandbox?.meta as Record<string, unknown> | null) ?? {}),
          ...safeMeta,
        },
        lastHeartbeatAt: new Date(),
      });
    } catch (error) {
      logger.warn("[SandboxStatus] failed to persist sandbox meta:", error);
    }
  }

  return c.json({ ok: true });
});

// POST /internal/spaces/:id/sandbox-report
router.post("/:id/sandbox-report", async (c) => {
  const remoteAddress = getRequestRemoteAddress(c);
  if (!isPrivateNetworkAddress(remoteAddress)) return c.json({ message: "forbidden" }, 403);

  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  const body = await c
    .req.json<{
      status?: string;
      podName?: string;
      sandboxId?: string;
      meta?: Record<string, unknown> | null;
    }>()
    .catch(() => null);
  if (!body?.status) return c.json({ message: "status is required" }, 400);

  const sandboxReportToken = c.req.header("x-sandbox-report-token")?.trim();
  if (!sandboxReportToken) return c.json({ message: "forbidden" }, 403);

  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  const sandboxMeta = (sandbox?.meta as Record<string, unknown> | null) ?? null;
  const expectedTokenHash = typeof sandboxMeta?.reportTokenHash === "string" ? sandboxMeta.reportTokenHash : null;
  if (!sandbox || !expectedTokenHash || !isSandboxReportTokenValid(sandboxReportToken, expectedTokenHash)) {
    return c.json({ message: "forbidden" }, 403);
  }
  const rejected = await rejectIsolatedWorkerDisposableRouteMutation(c, { spaceId, operation: "sandbox_lifecycle" });
  if (rejected) return rejected;

  const safeMeta = sanitizeSandboxMeta({
    ...(body.meta ?? {}),
    podName: body.podName?.trim() || sandbox.podName || null,
    sandboxId: body.sandboxId?.trim() || null,
  });
  const reportedImageVersion = typeof safeMeta?.imageVersion === "string"
    ? safeMeta.imageVersion.trim() || null
    : null;

  await updateSpaceSandbox({
    spaceId,
    status: normalizeSandboxLifecycleStatus(body.status),
    runtimeStatus: normalizeSandboxRuntimeStatus(body.status),
    podName: body.podName?.trim() || sandbox.podName || `sandbox-${spaceId}`,
    reportedImageVersion,
    reportedAt: new Date(),
    lastHeartbeatAt: new Date(),
    meta: {
      ...(sandboxMeta ?? {}),
      ...(safeMeta ?? {}),
    },
  });

  if (safeMeta?.requiresPodRecreate === true && safeMeta.errorClass === "stale_mount") {
    void recoverSpaceSandbox({
      spaceId,
      userUuid: space.userUuid,
      ownerUserUuid: space.userUuid,
      reason: typeof safeMeta.errorClass === "string" ? safeMeta.errorClass : body.status,
      source: "sandbox",
    }).catch((error) => logger.error(`[SandboxRecovery] auto recovery failed spaceId=${spaceId}`, error));
  }

  return c.json({ ok: true });
});

// POST /internal/spaces/:id/sandbox/recover
router.post("/:id/sandbox/recover", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);
  const rejected = await rejectIsolatedWorkerDisposableRouteMutation(c, { spaceId, operation: "sandbox_lifecycle" });
  if (rejected) return rejected;

  const body = (await c.req.json<{ reason?: string; source?: string }>().catch(() => ({}))) as { reason?: string; source?: string };
  try {
    const result = await recoverSpaceSandbox({
      spaceId,
      userUuid: space.userUuid,
      ownerUserUuid: space.userUuid,
      reason: body.reason ?? "recover",
      source: body.source ?? "internal",
      verify: true,
    });
    return c.json(result);
  } catch (error) {
    logger.error("[sandbox] failed to recover sandbox", error);
    return c.json({ ok: false, status: "error", message: "failed to recover sandbox" }, 500);
  }
});


// GET /internal/spaces/:id/sandbox
router.get("/:id/sandbox", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  return c.json({ sandbox: attachSandboxPublicEndpoints(sandbox) });
});

// POST /internal/spaces/:spaceId/sessions/:sessionId/info
router.post("/:spaceId/sessions/:sessionId/info", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session || session.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);
  const rejected = await rejectIsolatedWorkerDisposableRouteMutation(c, { spaceId, operation: "isolated_worker_runtime" });
  if (rejected) return rejected;

  const body = await c.req.json<UpdateSessionInfoInput>().catch(() => null);
  if (!body) return c.json({ message: "invalid body" }, 400);

  await updateSpaceSessionInfo({
    spaceId,
    sessionId,
    title: body.title,
    updatedAt: body.updatedAt,
    meta: body.meta,
  });

  return c.json({ ok: true });
});

// POST /internal/spaces/:spaceId/sessions/:sessionId/messages
router.post("/:spaceId/sessions/:sessionId/messages", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session || session.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);
  const rejected = await rejectIsolatedWorkerDisposableRouteMutation(c, { spaceId, operation: "isolated_worker_runtime" });
  if (rejected) return rejected;

  const body = await c
    .req.json<{
      previousMessageId?: string | null;
      anchorUserMessageId?: string | null;
      userId?: string | null;
      idempotencyKey?: string;
      message?: PersistMessageInput["message"] & { id?: string | null };
    }>()
    .catch(() => null);
  if (!body?.idempotencyKey?.trim()) return c.json({ message: "idempotencyKey is required" }, 400);
  if (!body.message || !Array.isArray(body.message.content)) return c.json({ message: "message.content is required" }, 400);

  const messageNode = await persistMessageNode({
    spaceId,
    sessionId,
    previousMessageId: body.previousMessageId ?? null,
    anchorUserMessageId: body.anchorUserMessageId ?? null,
    userId: body.userId ?? null,
    idempotencyKey: body.idempotencyKey,
    message: {
      ...(body.message as PersistMessageInput["message"]),
      id: body.message.id ?? undefined,
      content: body.message.content as never,
    } as PersistMessageInput["message"] & { id?: string },
  });

  return c.json({ ok: true, message: messageNode });
});

// POST /internal/spaces/:spaceId/sessions/:sessionId/turns/:turnId/interrupt
router.post("/:spaceId/sessions/:sessionId/turns/:turnId/interrupt", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  const turnId = c.req.param("turnId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId) || !requireValidId(turnId)) return c.json({ message: "turn not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session || session.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);
  const rejected = await rejectIsolatedWorkerDisposableRouteMutation(c, { spaceId, operation: "isolated_worker_revoke" });
  if (rejected) return rejected;

  const body = await c.req.json<{ continuedByTurnId?: string | null; interruptedByTurnId?: string | null }>().catch(() => null);
  const continuedByTurnId = body?.continuedByTurnId?.trim() || body?.interruptedByTurnId?.trim();
  if (!continuedByTurnId || !requireValidId(continuedByTurnId)) return c.json({ message: "continuedByTurnId is required" }, 400);

  const turn = await interruptSessionTurn({ spaceId, sessionId, turnId, continuedByTurnId });
  if (turn) await dispatchTurnFinalized({ spaceId, sessionId, turn }).catch((error) => logger.warn("[SessionTurn] failed to dispatch interrupted turn", error));
  return c.json({ ok: true, turn });
});

// POST /internal/spaces/:spaceId/sessions/:sessionId/turns/:turnId/abort
router.post("/:spaceId/sessions/:sessionId/turns/:turnId/abort", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  const turnId = c.req.param("turnId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId) || !requireValidId(turnId)) return c.json({ message: "turn not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session || session.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);
  const rejected = await rejectIsolatedWorkerDisposableRouteMutation(c, { spaceId, operation: "isolated_worker_revoke" });
  if (rejected) return rejected;

  const body = await c.req.json<{ actorUserId?: string | null }>().catch(() => null);
  const turn = await abortSessionTurn({
    spaceId,
    sessionId,
    turnId,
    actorUserId: body?.actorUserId ?? null,
  });
  if (turn) await dispatchTurnFinalized({ spaceId, sessionId, turn }).catch((error) => logger.warn("[SessionTurn] failed to dispatch aborted turn", error));
  return c.json({ ok: true, turn });
});

// POST /internal/spaces/:spaceId/sessions/:sessionId/turns/:turnId/fail
router.post("/:spaceId/sessions/:sessionId/turns/:turnId/fail", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  const turnId = c.req.param("turnId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId) || !requireValidId(turnId)) return c.json({ message: "turn not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session || session.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);
  const rejected = await rejectIsolatedWorkerDisposableRouteMutation(c, { spaceId, operation: "isolated_worker_revoke" });
  if (rejected) return rejected;

  const body = await c.req.json<{ errorMessage?: string | null }>().catch(() => null);
  const errorMessage = body?.errorMessage?.trim() || "Agent turn failed.";
  const turn = await failSessionTurn({ spaceId, sessionId, turnId, errorMessage });
  if (turn) await dispatchTurnFinalized({ spaceId, sessionId, turn }).catch((error) => logger.warn("[SessionTurn] failed to dispatch failed turn", error));
  return c.json({ ok: true, turn });
});

// POST /internal/spaces/:spaceId/sessions/:sessionId/prompt
router.post("/:spaceId/sessions/:sessionId/prompt", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session || session.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);

  const body = await c
    .req.json<{
      content: ContentBlock[];
      userId?: string | null;
      authToken?: string | null;
      clientMessageId?: string | null;
      source?: string | null;
      model?: string | null;
      provider?: string | null;
      accessMode?: AgentPromptAccessMode | null;
      isolatedWorkerPolicy?: unknown;
      dispatchTaskRunId?: string | null;
      inputsMaterializedAt?: string | null;
      env?: unknown;
      context?: SubmitSessionPromptContext | null;
    }>()
    .catch(() => null);
  if (!body || !Array.isArray(body.content) || body.content.length === 0) {
    return c.json({ message: "content is required" }, 400);
  }
  const userId = body.userId?.trim();
  if (!userId) return c.json({ message: "userId is required" }, 400);
  const accessMode = body.accessMode ?? "full_access";
  if (accessMode !== "read_only" && accessMode !== "full_access" && accessMode !== "isolated_worker") {
    return c.json({ message: "accessMode must be one of: read_only, full_access, isolated_worker" }, 400);
  }
  const rejected = await rejectIsolatedWorkerDisposableRouteMutation(c, {
    spaceId,
    operation: accessMode === "isolated_worker" ? "isolated_worker_dispatch" : "generic_prompt",
  });
  if (rejected) return rejected;
  const promptPermission = accessMode === "read_only" ? "session.prompt.readonly" : "session.prompt.fullaccess";
  let workSession = body.authToken ? verifyWorkSessionToken(body.authToken) : null;
  let isolatedWorkerPolicy: IsolatedWorkerPolicyInput | null = null;
  let isolatedWorkerDispatch: Record<string, unknown> | null = null;
  let isolatedWorkerDispatchTaskRunId: string | null = null;
  let isolatedWorkerInputManifestSha256: string | null = null;
  if (accessMode === "isolated_worker") {
    try {
      assertExactIsolatedWorkerPromptBody(body);
      isolatedWorkerPolicy = parseIsolatedWorkerPolicyInput(body.isolatedWorkerPolicy, spaceId);
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : String(error) }, 400);
    }
    const authoritySpace = await getSpaceById(isolatedWorkerPolicy.authoritySpaceId);
    if (!authoritySpace || authoritySpace.userUuid !== userId) {
      return c.json({ message: "isolated worker authority space not found" }, 404);
    }
    const dispatchTaskRunId = body.dispatchTaskRunId?.trim();
    if (!dispatchTaskRunId || !requireValidId(dispatchTaskRunId)) {
      return c.json({ message: "dispatchTaskRunId is required for isolated_worker" }, 400);
    }
    const [dispatchTask] = await db.select().from(taskRuns).where(eq(taskRuns.id, dispatchTaskRunId)).limit(1);
    const dispatchData = dispatchTask?.payload?.data;
    const dispatchInputBundle = dispatchData?.inputBundle && typeof dispatchData.inputBundle === "object" && !Array.isArray(dispatchData.inputBundle)
      ? dispatchData.inputBundle as Record<string, unknown>
      : null;
    let verifiedInputManifestSha256 = "";
    let verifiedPolicySha256 = "";
    try {
      verifiedInputManifestSha256 = computeIsolatedWorkerInputManifestSha256(dispatchData?.inputBundle as IsolatedWorkerInputBundle);
      verifiedPolicySha256 = computeIsolatedWorkerPolicySha256({
        taskRunId: dispatchTaskRunId,
        authoritySpaceId: isolatedWorkerPolicy.authoritySpaceId,
        disposableSpaceId: spaceId,
        sessionId,
        clientMessageId: body.clientMessageId ?? "",
        content: body.content,
        source: body.source ?? "",
        model: body.model ?? null,
        provider: body.provider ?? null,
        ...(typeof dispatchData?.repairOfDisposableSpaceId === "string"
          ? { repairOfDisposableSpaceId: dispatchData.repairOfDisposableSpaceId }
          : {}),
        inputManifestSha256: verifiedInputManifestSha256,
      });
    } catch {
      return c.json({ message: "isolated worker dispatch input manifest is invalid" }, 409);
    }
    const inputsMaterializedAt = body.inputsMaterializedAt?.trim() ?? "";
    if (!inputsMaterializedAt || !Number.isFinite(Date.parse(inputsMaterializedAt))) {
      return c.json({ message: "inputsMaterializedAt is required for isolated_worker" }, 400);
    }
    if (
      dispatchTask?.taskType !== "isolated_worker_dispatch"
      || dispatchTask.status !== "running"
      || dispatchTask.spaceId !== isolatedWorkerPolicy.authoritySpaceId
      || dispatchTask.sessionId !== sessionId
      || dispatchTask.userUuid !== userId
      || dispatchData?.authoritySpaceId !== isolatedWorkerPolicy.authoritySpaceId
      || dispatchData?.disposableSpaceId !== spaceId
      || dispatchData?.sessionId !== sessionId
      || dispatchData?.clientMessageId !== body.clientMessageId
      || JSON.stringify(dispatchData?.content) !== JSON.stringify(body.content)
      || dispatchData?.source !== body.source
      || (dispatchData?.model ?? null) !== (body.model ?? null)
      || (dispatchData?.provider ?? null) !== (body.provider ?? null)
      || dispatchData?.policySha256 !== isolatedWorkerPolicy.policySha256
      || dispatchData?.inputManifestSha256 !== verifiedInputManifestSha256
      || dispatchInputBundle?.inputManifestSha256 !== verifiedInputManifestSha256
      || dispatchInputBundle.runtimeAuthorityReadAllowed !== false
      || isolatedWorkerPolicy.policySha256 !== verifiedPolicySha256
      || dispatchData?.creationPath !== "dedicated_disposable_space_without_standard_sandbox"
      || dispatchData?.ordinarySandboxProvisioned !== false
      || dispatchData?.terminatedSpaceReused !== false
      || dispatchData?.credentialMode !== "engine_scoped_dispatch_authority"
      || dispatchData?.engineInternalSecretIssued !== false
      || dispatchData?.publicPromptUsed !== false
      || dispatchData?.checkpointAdapter !== "trusted_production"
    ) {
      return c.json({ message: "isolated worker dispatch binding mismatch" }, 409);
    }
    workSession = verifyWorkSessionToken(createWorkSessionToken({
      userUuid: userId,
      workId: dispatchTaskRunId,
      spaceId,
      workScopes: ["session.prompt.fullaccess"],
    }));
    if (!workSession) throw new Error("failed to mint isolated worker prompt authority");
    isolatedWorkerDispatch = {
      taskRunId: dispatchTaskRunId,
      taskType: "isolated_worker_dispatch",
      authoritySpaceId: isolatedWorkerPolicy.authoritySpaceId,
      disposableSpaceId: spaceId,
      creationPath: "dedicated_disposable_space_without_standard_sandbox",
      ordinarySandboxProvisioned: false,
      terminatedSpaceReused: false,
      credentialMode: "engine_scoped_dispatch_authority",
      engineInternalSecretIssued: false,
      publicPromptUsed: false,
      checkpointAdapter: "trusted_production",
      authorityCheckpointId: dispatchInputBundle.authorityCheckpointId,
      authorityCheckpointCommit: dispatchInputBundle.authorityCheckpointCommit,
      authorityTreeSha256: dispatchInputBundle.authorityTreeSha256,
      inputManifestSha256: verifiedInputManifestSha256,
      inputBundle: dispatchData?.inputBundle,
      inputsMaterializedAt,
      authorityExecutionTokenIssued: false,
      runtimeAuthorityReadAllowed: false,
    };
    isolatedWorkerDispatchTaskRunId = dispatchTaskRunId;
    isolatedWorkerInputManifestSha256 = verifiedInputManifestSha256;
    const sandbox = await getSpaceSandboxBySpaceId(spaceId);
    const sandboxMeta = sandbox?.meta && typeof sandbox.meta === "object" && !Array.isArray(sandbox.meta)
      ? sandbox.meta as Record<string, unknown>
      : null;
    const allocation = sandboxMeta?.isolatedWorker && typeof sandboxMeta.isolatedWorker === "object" && !Array.isArray(sandboxMeta.isolatedWorker)
      ? sandboxMeta.isolatedWorker as Record<string, unknown>
      : null;
    if (
      sandbox?.status !== "allocated"
      || sandbox.podName !== null
      || allocation?.state !== "allocated"
      || allocation.authoritySpaceId !== isolatedWorkerPolicy.authoritySpaceId
      || allocation.disposableSpaceId !== spaceId
      || allocation.dispatchTaskRunId !== dispatchTaskRunId
      || allocation.policySha256 !== isolatedWorkerPolicy.policySha256
      || allocation.creationPath !== "dedicated_disposable_space_without_standard_sandbox"
      || allocation.ordinarySandboxProvisioned !== false
      || allocation.terminatedSpaceReused !== false
      || allocation.credentialMode !== "engine_scoped_dispatch_authority"
      || allocation.engineInternalSecretIssued !== false
      || allocation.publicPromptUsed !== false
      || allocation.authorityExecutionTokenIssued !== false
      || allocation.runtimeAuthorityReadAllowed !== false
      || allocation.authorityCheckpointId !== dispatchInputBundle?.authorityCheckpointId
      || allocation.authorityCheckpointCommit !== dispatchInputBundle?.authorityCheckpointCommit
      || allocation.authorityTreeSha256 !== dispatchInputBundle?.authorityTreeSha256
      || allocation.inputManifestSha256 !== verifiedInputManifestSha256
      || allocation.inputCount !== (Array.isArray(dispatchInputBundle?.items) ? dispatchInputBundle.items.length : -1)
      || typeof allocation.preparedWorkspace !== "string"
      || !allocation.preparedWorkspace.endsWith(`/.isolated-worker-staging/${dispatchTaskRunId}`)
      || allocation.inputsMaterializedAt !== inputsMaterializedAt
      || canonicalIsolatedWorkerJson(allocation.inputBundle) !== canonicalIsolatedWorkerJson(dispatchData?.inputBundle)
      || allocation.resumable !== false
    ) {
      return c.json({ message: "disposable worker space is not allocated or has already been used" }, 409);
    }
  } else if (body.isolatedWorkerPolicy !== undefined || body.dispatchTaskRunId !== undefined) {
    return c.json({ message: "isolated worker fields are only allowed for isolated_worker" }, 400);
  }
  const permissionSubject = workSession && workSession.userUuid === userId
    ? ({ uuid: userId, workSession } as { uuid: string; workSession: typeof workSession })
    : { uuid: userId };
  const promptAuth = workSession?.userUuid === userId ? promptAuthContextFromWorkSession(workSession, spaceId) : null;
  if (!(await hasPermission(permissionSubject, promptPermission, { spaceId, sessionId }))) {
    return c.json({ message: "forbidden" }, 403);
  }
  const clientMessageId = body.clientMessageId?.trim();
  if (!clientMessageId) return c.json({ message: "clientMessageId is required" }, 400);

  let promptEnv: Record<string, string> | null = null;
  try {
    promptEnv = parsePromptEnv(body.env);
  } catch (error) {
    if (error instanceof PromptEnvValidationError) return c.json({ message: error.message }, 400);
    throw error;
  }

  try {
    const promptInput = {
      spaceId,
      sessionId,
      userId,
      clientMessageId,
      content: body.content,
      source: body.source?.trim() || "scheduled_task",
      model: body.model ?? null,
      provider: body.provider ?? null,
      accessMode,
      env: promptEnv,
      context: mergePromptContextAuth(body.context ?? null, promptAuth),
    };
    const result = isolatedWorkerPolicy
      ? await submitIsolatedWorkerPrompt({
          policy: isolatedWorkerPolicy,
          sessionId,
          turnMeta: {
            isolatedWorkerDispatch,
            isolatedWorkerInputBundle: isolatedWorkerDispatch?.inputBundle,
          },
          prompt: { ...promptInput, accessMode: "isolated_worker" },
          submitPrompt: submitSessionPrompt,
          createPod: ({ sessionId: workerSessionId, turnId, ...policy }) => isolatedWorkerPodLifecycle.create({
            authoritySpaceId: policy.authoritySpaceId,
            disposableSpaceId: policy.disposableSpaceId,
            sessionId: workerSessionId,
            turnId,
            writableRoot: policy.writableRoot,
            policySha256: policy.policySha256,
            image: config.sandboxImage,
            spaceStoragePvc: config.spaceStoragePvc,
            spaceStorageSubpath: config.spaceStorageSubpath,
          }),
          onPodCreatedBeforeEnqueue: async ({ handle, turnId }) => {
            if (!isolatedWorkerDispatchTaskRunId) throw new Error("isolated worker dispatch task binding is missing");
            if (!isolatedWorkerInputManifestSha256) throw new Error("isolated worker input manifest binding is missing");
            if (!isolatedWorkerDispatch) throw new Error("isolated worker dispatch metadata is missing");
            const inputsMaterializedAt = isolatedWorkerDispatch.inputsMaterializedAt;
            if (typeof inputsMaterializedAt !== "string" || !Number.isFinite(Date.parse(inputsMaterializedAt))) {
              throw new Error("isolated worker input materialization timestamp binding is missing");
            }
            const podCreatedAt = new Date(handle.podCreatedAt);
            if (!Number.isFinite(podCreatedAt.getTime())) throw new Error("isolated worker Pod creation timestamp is invalid");
            if (podCreatedAt.getTime() <= Date.parse(inputsMaterializedAt)) {
              throw new Error("isolated worker pod must be created after inputs are materialized");
            }
            const completedDispatchMeta = {
              ...isolatedWorkerDispatch,
              podCreatedAt: podCreatedAt.toISOString(),
            };
            const [boundTurn] = await db.update(sessionTurns).set({
              meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify({
                isolatedWorkerDispatch: completedDispatchMeta,
                isolatedWorkerInputBundle: isolatedWorkerDispatch.inputBundle,
              })}::jsonb`,
              updatedAt: podCreatedAt,
            }).where(and(eq(sessionTurns.id, turnId), eq(sessionTurns.sessionId, sessionId), eq(sessionTurns.status, "queued"))).returning({ id: sessionTurns.id });
            if (!boundTurn) throw new Error("isolated worker dispatch Turn binding CAS failed");
            return { podCreatedAt: podCreatedAt.toISOString() };
          },
          revokePod: async (handle) => {
            const scheduled = await scheduleIsolatedWorkerTermination({
              spaceId: handle.isolatedWorkerPolicy.disposableSpaceId,
              sessionId: handle.sessionId,
              turnId: handle.turnId,
              terminalStatus: "failed",
            });
            if (scheduled.alreadyTerminated) return scheduled.receipt as never;
            const terminated = await waitForIsolatedWorkerTermination({
              spaceId: handle.isolatedWorkerPolicy.disposableSpaceId,
              sessionId: handle.sessionId,
              turnId: handle.turnId,
              revokeTaskRunId: scheduled.revokeTaskRunId,
            });
            return terminated.receipt as never;
          },
        })
      : await submitSessionPrompt(promptInput);
    return c.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof SandboxNotReadyError) return c.json({ message: "sandbox is not ready" }, 503);
    if (error instanceof BillingAccessBlockedError) return c.json(serializeBillingBlocked(error), 402);
    throw error as Error;
  }
});

// POST /internal/spaces/:spaceId/sessions/:sessionId/turns/:turnId/isolated-worker/termination
router.post("/:spaceId/sessions/:sessionId/turns/:turnId/isolated-worker/termination", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;
  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  const turnId = c.req.param("turnId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId) || !requireValidId(turnId)) {
    return c.json({ message: "isolated worker not found" }, 404);
  }
  const body = await c.req.json<{ terminalStatus?: IsolatedWorkerTerminalStatus }>().catch(() => null);
  if (!body || !["completed", "failed", "interrupted", "cancelled"].includes(body.terminalStatus ?? "")) {
    return c.json({ message: "terminalStatus is invalid" }, 400);
  }
  try {
    const scheduled = await scheduleIsolatedWorkerTermination({
      spaceId,
      sessionId,
      turnId,
      terminalStatus: body.terminalStatus as IsolatedWorkerTerminalStatus,
    });
    return c.json({ ok: true, ...scheduled }, scheduled.alreadyTerminated ? 200 : 202);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) return c.json({ message }, 404);
    if (message.includes("binding mismatch") || message.includes("became terminal")) return c.json({ message }, 409);
    throw error;
  }
});

router.get("/:spaceId/sessions/:sessionId/turns/:turnId/isolated-worker/termination", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;
  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  const turnId = c.req.param("turnId");
  const revokeTaskRunId = c.req.query("revokeTaskRunId") ?? "";
  if (!requireValidId(spaceId) || !requireValidId(sessionId) || !requireValidId(turnId) || !requireValidId(revokeTaskRunId)) {
    return c.json({ message: "isolated worker termination not found" }, 404);
  }
  const state = await readIsolatedWorkerTermination({ spaceId, sessionId, turnId, revokeTaskRunId });
  return c.json({ ok: true, ...state }, state.state === "terminated" ? 200 : 202);
});

// Worker-only execution endpoint for an already-running automatic revoke TaskRun.
router.post("/:spaceId/sessions/:sessionId/turns/:turnId/isolated-worker/revoke", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  const turnId = c.req.param("turnId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId) || !requireValidId(turnId)) {
    return c.json({ message: "isolated worker not found" }, 404);
  }
  const session = await getSpaceSessionById(sessionId);
  if (!session || session.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);
  const turn = await getSessionTurnById(sessionId, turnId);
  if (!turn) return c.json({ message: "turn not found" }, 404);
  const body = await c.req.json<{
    authoritySpaceId?: string;
    disposableSpaceId?: string;
    podUid?: string;
    revokeTaskRunId?: string;
    terminalStatus?: IsolatedWorkerTerminalStatus;
    automaticTrigger?: string;
    manualEndpointInvoked?: boolean;
  }>().catch(() => null);
  if (!body?.authoritySpaceId?.trim() || !body.disposableSpaceId?.trim() || !body.podUid?.trim()) {
    return c.json({ message: "authoritySpaceId, disposableSpaceId, and podUid are required" }, 400);
  }
  const meta = turn.meta && typeof turn.meta === "object" && !Array.isArray(turn.meta)
    ? turn.meta as Record<string, unknown>
    : null;
  const handle = meta?.isolatedWorker as IsolatedWorkerPodHandle | undefined;
  const dispatch = meta?.isolatedWorkerDispatch && typeof meta.isolatedWorkerDispatch === "object" && !Array.isArray(meta.isolatedWorkerDispatch)
    ? meta.isolatedWorkerDispatch as Record<string, unknown>
    : null;
  const dispatchTaskRunId = typeof dispatch?.taskRunId === "string" ? dispatch.taskRunId : null;
  const terminationState = meta?.isolatedWorkerTerminationState && typeof meta.isolatedWorkerTerminationState === "object" && !Array.isArray(meta.isolatedWorkerTerminationState)
    ? meta.isolatedWorkerTerminationState as Record<string, unknown>
    : null;
  const existingReceipt = meta?.isolatedWorkerTermination && typeof meta.isolatedWorkerTermination === "object" && !Array.isArray(meta.isolatedWorkerTermination)
    ? meta.isolatedWorkerTermination as Record<string, unknown>
    : null;
  if (
    handle
    && terminationState?.state === "terminated"
    && terminationState.revokeTaskRunId === body.revokeTaskRunId
    && handle.isolatedWorkerPolicy?.podUid === body.podUid
    && existingReceipt
    && existingReceipt?.revokeTaskRunId === body.revokeTaskRunId
    && existingReceipt.podUid === body.podUid
    && existingReceipt.automaticTrigger === "turn_terminal_event"
    && existingReceipt.manualEndpointInvoked === false
  ) {
    return c.json({ ok: true, receipt: existingReceipt });
  }
  const [revokeTask] = body.revokeTaskRunId
    ? await db.select().from(taskRuns).where(eq(taskRuns.id, body.revokeTaskRunId)).limit(1)
    : [];
  const revokeData = revokeTask?.payload?.data && typeof revokeTask.payload.data === "object" && !Array.isArray(revokeTask.payload.data)
    ? revokeTask.payload.data as Record<string, unknown>
    : null;
  if (
    !handle
    || !dispatchTaskRunId
    || !revokeTask
    || revokeTask.taskType !== "isolated_worker_revoke"
    || revokeTask.status !== "running"
    || revokeTask.spaceId !== spaceId
    || revokeTask.sessionId !== sessionId
    || revokeTask.turnId !== turnId
    || terminationState?.state !== "stopping"
    || terminationState.revokeTaskRunId !== body.revokeTaskRunId
    || terminationState.requestedTerminalStatus !== body.terminalStatus
    || revokeData?.trigger !== "turn_terminal_event"
    || revokeData.terminalStatus !== body.terminalStatus
    || revokeData.authoritySpaceId !== body.authoritySpaceId
    || revokeData.disposableSpaceId !== body.disposableSpaceId
    || revokeData.sessionId !== sessionId
    || revokeData.turnId !== turnId
    || revokeData.podUid !== body.podUid
    || body.automaticTrigger !== "turn_terminal_event"
    || body.manualEndpointInvoked !== false
    || handle.sessionId !== sessionId
    || handle.turnId !== turnId
    || handle.isolatedWorkerPolicy?.disposableSpaceId !== spaceId
    || handle.isolatedWorkerPolicy.authoritySpaceId !== body.authoritySpaceId
    || handle.isolatedWorkerPolicy.disposableSpaceId !== body.disposableSpaceId
    || handle.isolatedWorkerPolicy.podUid !== body.podUid
  ) {
    return c.json({ message: "isolated worker binding mismatch" }, 409);
  }
  const receipt = await isolatedWorkerPodLifecycle.revoke(handle, {
    revokeTaskRunId: body.revokeTaskRunId as string,
    automaticTrigger: "turn_terminal_event",
    manualEndpointInvoked: false,
  });
  const terminatedHandle = { ...handle, status: "terminated", termination: receipt };
  await db.transaction(async (tx) => {
    const [updatedTurn] = await tx.update(sessionTurns).set({
      meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify({
      isolatedWorker: terminatedHandle,
      isolatedWorkerTermination: receipt,
      isolatedWorkerTerminationState: {
        ...terminationState,
        state: "terminated",
        terminatedAt: receipt.terminatedAt,
      },
      })}::jsonb`,
      updatedAt: new Date(),
    }).where(and(
      eq(sessionTurns.id, turnId),
      eq(sessionTurns.sessionId, sessionId),
      inArray(sessionTurns.status, ["queued", "running", "abort_requested"]),
    )).returning({ id: sessionTurns.id });
    if (!updatedTurn) throw new Error("failed to persist isolated worker termination receipt");
  });
  return c.json({ ok: true, receipt });
});

export default router;
