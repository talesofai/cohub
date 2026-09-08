import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  localAgentRuntimes,
  sessionTurns,
  spaceLocalAgentPolicies,
  workspaceExecutionAttempts,
  workspaceReplicas,
  workspaceState,
  workspaceWriterLeases,
} from "@cohub/db";
import type { LocalRuntimeCommand, LocalRuntimeEvent } from "@cohub/protocol";
import { db } from "../db.js";
import { isLocalRuntimeProviderRolloutEnabled } from "../env.js";
import { normalizeContentBlocksImages } from "../image-normalizer.js";
import { logger } from "../logger.js";
import { abortSessionTurn, interruptSessionTurn, persistAssistantMessage, persistUserMessage, failSessionTurn } from "../persistence.js";
import {
  appendLocalRuntimeAssistantMessages,
  appendLocalRuntimeUserMessage,
  openLocalRuntimeSession,
  type LocalRuntimeAssistantTranscriptInput,
  type LocalRuntimeTranscriptInput,
} from "../local-runtime-transcript.js";
import { registerActiveAbortHandle } from "../active-turns.js";
import { getAbortEvent } from "../abort.js";
import { readPublicAssetImageUrl } from "../public-asset-storage.js";
import { sendOutput } from "../redis.js";
import type { SessionManager } from "../runtime/local-session-manager.js";
import {
  completeCommand,
  failCommand,
  findRuntimeCommand,
  findRuntimeSession,
  loadCommandEvents,
  markCommandSent,
  markReconnectRequired,
  markRuntimeSessionDisconnected,
  prepareCommand,
  rearmCompletedOpenCommand,
  rearmCompletedResumeCommand,
  recordInboundEvent,
  sha256,
  upsertRuntimeSession,
  ProviderRuntimeError,
  type LedgerScope,
} from "./ledger.js";
import {
  applyRuntimeEvent,
  createTurnProjection,
  mapRuntimeStopReason,
  syncToolBlocks,
  toRuntimePrompt,
  type RuntimeTurnProjection,
} from "./projection.js";
import { RUNTIME_BUSY_CLOSE_CODE, openRuntimeChannel, type RuntimeChannel } from "./transport.js";

/** Drive one Cohub turn through a provider-neutral local runtime host. */

const MAX_RUNTIME_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const LEASE_HEARTBEAT_MS = 10_000;
const CANCEL_GRACE_MS = 5_000;
const SESSION_READY_TIMEOUT_MS = 30_000;
const CHANNEL_CLOSE_TIMEOUT_MS = 10_000;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const runtimeAccessMode = (meta: unknown): "read_only" | "full_access" => {
  const value = record(meta).accessMode;
  return value === "full_access" ? "full_access" : "read_only";
};

const deterministicUuid = (seed: string): string => {
  const hex = sha256(seed);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const runtimeErrorCode = (message: string): string =>
  message.startsWith("runtime_reconnect_required") ? "runtime_reconnect_required" : "local_runtime_failed";

type LoadedAttempt = NonNullable<Awaited<ReturnType<typeof loadRuntimeForAttempt>>>;
type LeaseRow = typeof workspaceWriterLeases.$inferSelect;

async function loadRuntimeForAttempt(attemptId: string) {
  const [row] = await db.select({
    attempt: workspaceExecutionAttempts,
    runtime: localAgentRuntimes,
    turn: sessionTurns,
    state: workspaceState,
    replica: workspaceReplicas,
  }).from(workspaceExecutionAttempts)
    .innerJoin(localAgentRuntimes, eq(localAgentRuntimes.id, workspaceExecutionAttempts.runtimeId))
    .innerJoin(sessionTurns, eq(sessionTurns.id, workspaceExecutionAttempts.turnId))
    .innerJoin(workspaceState, eq(workspaceState.spaceId, workspaceExecutionAttempts.spaceId))
    .leftJoin(workspaceReplicas, eq(workspaceReplicas.id, workspaceExecutionAttempts.replicaId))
    .where(eq(workspaceExecutionAttempts.id, attemptId)).limit(1);
  return row ?? null;
}

async function acquireWorkspaceLease(input: {
  attemptId: string;
  spaceId: string;
  replicaId: string;
  deviceId: string;
  userUuid: string;
  baseSnapshotId: string | null;
  integrationPolicyVersion: number | null;
}): Promise<LeaseRow> {
  if (!input.baseSnapshotId) throw new Error("local runtime execution requires a canonical workspace snapshot");
  const baseSnapshotId = input.baseSnapshotId;
  return db.transaction(async (tx) => {
    const [policy] = await tx.select({
      workspaceMode: spaceLocalAgentPolicies.workspaceMode,
      integrationPolicyVersion: spaceLocalAgentPolicies.integrationPolicyVersion,
    }).from(spaceLocalAgentPolicies).where(and(
      eq(spaceLocalAgentPolicies.spaceId, input.spaceId),
      eq(spaceLocalAgentPolicies.deviceId, input.deviceId),
    )).limit(1);
    if (!policy || policy.workspaceMode === "one_way_to_local" || input.integrationPolicyVersion == null || policy.integrationPolicyVersion !== input.integrationPolicyVersion) {
      throw new Error("runtime_reconnect_required: local workspace policy changed; re-authorize the runtime");
    }
    const [workspace] = await tx.select({ canonicalSnapshotId: workspaceState.canonicalSnapshotId, status: workspaceState.status })
      .from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).for("update").limit(1);
    if (workspace?.status !== "ready" || workspace.canonicalSnapshotId !== baseSnapshotId) {
      throw new Error("local workspace changed before execution; synchronize the replica and retry");
    }
    const [replica] = await tx.select({
      id: workspaceReplicas.id,
      deviceId: workspaceReplicas.deviceId,
      status: workspaceReplicas.status,
      appliedSnapshotId: workspaceReplicas.appliedSnapshotId,
    }).from(workspaceReplicas).where(and(
      eq(workspaceReplicas.id, input.replicaId),
      eq(workspaceReplicas.spaceId, input.spaceId),
      eq(workspaceReplicas.kind, "local"),
    )).for("update").limit(1);
    if (replica?.deviceId !== input.deviceId || replica.status !== "ready" || replica.appliedSnapshotId !== baseSnapshotId) {
      throw new Error("local replica is stale or bound to a different device; synchronize it before execution");
    }
    const [existing] = await tx.select().from(workspaceWriterLeases).where(eq(workspaceWriterLeases.spaceId, input.spaceId)).for("update").limit(1);
    const now = new Date();
    const sameHolder = existing?.holderKind === "local_agent" && existing.holderId === input.attemptId;
    if (existing && existing.expiresAt > now && !sameHolder) throw new Error("workspace is held by another writer");
    if (existing && existing.expiresAt <= now && !sameHolder && existing.holderKind === "local_agent") {
      const [unresolved] = await tx.select({ id: workspaceExecutionAttempts.id }).from(workspaceExecutionAttempts).where(and(
        eq(workspaceExecutionAttempts.spaceId, input.spaceId),
        eq(workspaceExecutionAttempts.id, existing.holderId),
        inArray(workspaceExecutionAttempts.status, ["running", "workspace_sealed", "transcript_sealed", "awaiting_recovery"]),
      )).limit(1);
      if (unresolved) throw new Error("workspace is held by an unresolved local execution attempt");
    }
    const same = sameHolder && existing.expiresAt > now;
    const epoch = (existing?.epoch ?? 0) + (same ? 0 : 1);
    const values = {
      holderKind: "local_agent",
      holderId: input.attemptId,
      holderUserUuid: input.userUuid,
      epoch,
      baseSnapshotId,
      expiresAt: new Date(now.getTime() + 30_000),
      lastHeartbeatAt: now,
      updatedAt: now,
    };
    const [lease] = await tx.insert(workspaceWriterLeases).values({ spaceId: input.spaceId, ...values })
      .onConflictDoUpdate({ target: workspaceWriterLeases.spaceId, set: values }).returning();
    if (!lease) throw new Error("local runtime workspace lease unavailable");
    const [activatedAttempt] = await tx.update(workspaceExecutionAttempts).set({
      status: "running",
      workspaceLeaseEpoch: lease.epoch,
      updatedAt: now,
    }).where(and(
      eq(workspaceExecutionAttempts.id, input.attemptId),
      inArray(workspaceExecutionAttempts.status, ["queued", "prepared", "running"]),
    )).returning({ id: workspaceExecutionAttempts.id });
    if (!activatedAttempt) throw new Error("local runtime execution attempt is no longer claimable");
    await tx.update(workspaceState).set({ activeExecutionAttemptId: input.attemptId, updatedAt: now })
      .where(eq(workspaceState.spaceId, input.spaceId));
    const [activatedReplica] = await tx.update(workspaceReplicas).set({ activeExecutionAttemptId: input.attemptId, updatedAt: now }).where(and(
      eq(workspaceReplicas.id, input.replicaId),
      eq(workspaceReplicas.spaceId, input.spaceId),
      eq(workspaceReplicas.kind, "local"),
      eq(workspaceReplicas.appliedSnapshotId, baseSnapshotId),
    )).returning({ id: workspaceReplicas.id });
    if (!activatedReplica) throw new Error("local replica changed while acquiring the workspace lease");
    return lease;
  });
}

async function heartbeatWorkspaceLease(spaceId: string, attemptId: string, epoch: number): Promise<void> {
  const current = new Date();
  const [updated] = await db.update(workspaceWriterLeases).set({
    expiresAt: new Date(current.getTime() + 30_000),
    lastHeartbeatAt: current,
    updatedAt: current,
  }).where(and(
    eq(workspaceWriterLeases.spaceId, spaceId),
    eq(workspaceWriterLeases.holderKind, "local_agent"),
    eq(workspaceWriterLeases.holderId, attemptId),
    eq(workspaceWriterLeases.epoch, epoch),
    sql`${workspaceWriterLeases.expiresAt} > now()`,
  )).returning({ epoch: workspaceWriterLeases.epoch });
  if (!updated) throw new Error("local runtime workspace lease was lost");
}

async function markTranscriptSealed(attemptId: string, leaseEpoch: number): Promise<void> {
  const now = new Date();
  const [updated] = await db.update(workspaceExecutionAttempts).set({ status: "transcript_sealed", updatedAt: now }).where(and(
    eq(workspaceExecutionAttempts.id, attemptId),
    eq(workspaceExecutionAttempts.workspaceLeaseEpoch, leaseEpoch),
    inArray(workspaceExecutionAttempts.status, ["running", "workspace_sealed"]),
  )).returning({ id: workspaceExecutionAttempts.id });
  if (updated) return;
  const [current] = await db.select({ status: workspaceExecutionAttempts.status, workspaceLeaseEpoch: workspaceExecutionAttempts.workspaceLeaseEpoch })
    .from(workspaceExecutionAttempts).where(eq(workspaceExecutionAttempts.id, attemptId)).limit(1);
  if (current?.status === "transcript_sealed" && current.workspaceLeaseEpoch === leaseEpoch) return;
  throw new Error("local runtime execution attempt lease epoch is stale while sealing transcript");
}

async function setRuntimeStatus(input: {
  runtimeId: string;
  connectionEpoch: number;
  status: "busy" | "ready" | "error";
  error?: string | null;
}): Promise<void> {
  const now = new Date();
  const [updated] = await db.update(localAgentRuntimes).set({
    status: input.status,
    lastSeenAt: now,
    lastError: input.error ?? null,
    updatedAt: now,
  }).where(and(
    eq(localAgentRuntimes.id, input.runtimeId),
    eq(localAgentRuntimes.connectionEpoch, input.connectionEpoch),
    ne(localAgentRuntimes.status, "revoked"),
  )).returning({ id: localAgentRuntimes.id });
  if (!updated) throw new Error("local runtime connection epoch is stale or revoked");
}

async function failAttempt(input: { attemptId: string; spaceId: string; sessionId: string; turnId: string; message: string; workspaceLeaseEpoch?: number | null }): Promise<void> {
  const leaseEpoch = input.workspaceLeaseEpoch ?? null;
  let claimed = false;
  await db.transaction(async (tx) => {
    const now = new Date();
    const [failedAttempt] = await tx.update(workspaceExecutionAttempts).set({
      status: "failed",
      errorCode: runtimeErrorCode(input.message),
      errorMessage: input.message,
      completedAt: now,
      updatedAt: now,
    }).where(and(
      eq(workspaceExecutionAttempts.id, input.attemptId),
      ...(leaseEpoch === null
        ? [inArray(workspaceExecutionAttempts.status, ["queued", "prepared"]), isNull(workspaceExecutionAttempts.workspaceLeaseEpoch)]
        : [eq(workspaceExecutionAttempts.workspaceLeaseEpoch, leaseEpoch), inArray(workspaceExecutionAttempts.status, ["queued", "prepared", "running", "workspace_sealed", "transcript_sealed", "awaiting_recovery"])]),
    )).returning({ id: workspaceExecutionAttempts.id });
    if (!failedAttempt) return;
    claimed = true;
    if (leaseEpoch !== null) {
      await tx.update(workspaceWriterLeases).set({ expiresAt: now, lastHeartbeatAt: now, updatedAt: now }).where(and(
        eq(workspaceWriterLeases.spaceId, input.spaceId),
        eq(workspaceWriterLeases.holderKind, "local_agent"),
        eq(workspaceWriterLeases.holderId, input.attemptId),
        eq(workspaceWriterLeases.epoch, leaseEpoch),
      ));
    }
    await tx.update(workspaceState).set({ activeExecutionAttemptId: null, updatedAt: now }).where(and(
      eq(workspaceState.spaceId, input.spaceId),
      eq(workspaceState.activeExecutionAttemptId, input.attemptId),
    ));
    await tx.update(workspaceReplicas).set({ activeExecutionAttemptId: null, updatedAt: now }).where(and(
      eq(workspaceReplicas.spaceId, input.spaceId),
      eq(workspaceReplicas.activeExecutionAttemptId, input.attemptId),
    ));
  });
  if (claimed) {
    await failSessionTurn({ spaceId: input.spaceId, sessionId: input.sessionId, turnId: input.turnId, errorMessage: input.message }).catch(() => undefined);
  }
}

async function abortAttempt(input: {
  attemptId: string;
  spaceId: string;
  sessionId: string;
  turnId: string;
  workspaceLeaseEpoch?: number | null;
  reason: "abort" | "interrupt";
  continuedByTurnId?: string | null;
}): Promise<void> {
  const leaseEpoch = input.workspaceLeaseEpoch ?? null;
  await db.transaction(async (tx) => {
    const now = new Date();
    const [abortedAttempt] = await tx.update(workspaceExecutionAttempts).set({
      status: "aborted",
      errorCode: input.reason === "interrupt" ? "turn_interrupted_before_start" : "turn_aborted_before_start",
      errorMessage: input.reason === "interrupt" ? "local runtime turn interrupted before provider start" : "local runtime turn aborted before provider start",
      completedAt: now,
      updatedAt: now,
    }).where(and(
      eq(workspaceExecutionAttempts.id, input.attemptId),
      ...(leaseEpoch === null
        ? [inArray(workspaceExecutionAttempts.status, ["queued", "prepared"]), isNull(workspaceExecutionAttempts.workspaceLeaseEpoch)]
        : [eq(workspaceExecutionAttempts.workspaceLeaseEpoch, leaseEpoch), inArray(workspaceExecutionAttempts.status, ["queued", "prepared", "running"])]),
    )).returning({ id: workspaceExecutionAttempts.id });
    if (!abortedAttempt) return;
    if (leaseEpoch !== null) {
      await tx.update(workspaceWriterLeases).set({ expiresAt: now, lastHeartbeatAt: now, updatedAt: now }).where(and(
        eq(workspaceWriterLeases.spaceId, input.spaceId),
        eq(workspaceWriterLeases.holderKind, "local_agent"),
        eq(workspaceWriterLeases.holderId, input.attemptId),
        eq(workspaceWriterLeases.epoch, leaseEpoch),
      ));
    }
    await tx.update(workspaceState).set({ activeExecutionAttemptId: null, updatedAt: now }).where(and(
      eq(workspaceState.spaceId, input.spaceId),
      eq(workspaceState.activeExecutionAttemptId, input.attemptId),
    ));
    await tx.update(workspaceReplicas).set({ activeExecutionAttemptId: null, updatedAt: now }).where(and(
      eq(workspaceReplicas.spaceId, input.spaceId),
      eq(workspaceReplicas.activeExecutionAttemptId, input.attemptId),
    ));
  });
  if (input.reason === "interrupt" && input.continuedByTurnId) {
    await interruptSessionTurn({
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      continuedByTurnId: input.continuedByTurnId,
    });
  } else {
    await abortSessionTurn({
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
    });
  }
}

type TurnContext = {
  loaded: LoadedAttempt;
  lease: LeaseRow;
  userMessageId: string;
  commandId: string;
  assistantMessageId: string;
  startedAt: string;
  projection: RuntimeTurnProjection;
  patchSeq: number;
  cancelRequested: boolean;
};

async function publishProjection(turn: TurnContext): Promise<void> {
  syncToolBlocks(turn.projection);
  const contentBytes = Buffer.byteLength(JSON.stringify(turn.projection.content), "utf8");
  if (contentBytes > MAX_RUNTIME_TRANSCRIPT_BYTES) throw new Error("local runtime transcript exceeds the persistence size limit");
  turn.patchSeq += 1;
  await sendOutput({
    type: "stream_update",
    spaceId: turn.loaded.attempt.spaceId,
    sessionId: turn.loaded.turn.sessionId,
    turnId: turn.loaded.turn.id,
    seq: turn.patchSeq,
    baseSeq: turn.patchSeq - 1,
    content: structuredClone(turn.projection.content),
    snapshotContent: structuredClone(turn.projection.content),
    messageId: turn.assistantMessageId,
    messageOrdinal: 0,
    sourceMessageId: turn.userMessageId,
    anchorUserMessageId: turn.userMessageId,
    timestamp: Date.now(),
  });
}

function commandEnvelope(input: {
  commandId: string;
  runtimeId: string;
  spaceId: string;
  runtimeSessionId: string;
  cohubSessionId: string;
  executionAttemptId: string | null;
  turnId: string | null;
  provider: "pi" | "codex" | "claude_code";
  providerSessionId: string | null;
  operation: LocalRuntimeCommand["operation"];
  cwd: string;
  model: string | null;
  accessMode: "read_only" | "full_access";
  payload: Record<string, unknown>;
  connectionEpoch: number;
  lease?: LeaseRow;
}): LocalRuntimeCommand {
  return {
    version: 1,
    type: "command",
    commandId: input.commandId,
    runtimeId: input.runtimeId,
    spaceId: input.spaceId,
    runtimeSessionId: input.runtimeSessionId,
    cohubSessionId: input.cohubSessionId,
    executionAttemptId: input.executionAttemptId,
    turnId: input.turnId,
    provider: input.provider,
    providerSessionId: input.providerSessionId,
    operation: input.operation,
    cwd: input.cwd,
    model: input.model,
    accessMode: input.accessMode,
    ...(input.lease ? { leaseEpoch: input.lease.epoch, leaseExpiresAt: input.lease.expiresAt.toISOString() } : {}),
    payload: input.payload,
    connectionEpoch: input.connectionEpoch,
  };
}

function eventMatches(event: LocalRuntimeEvent, input: {
  runtimeId: string;
  runtimeSessionId: string;
  cohubSessionId: string;
  executionAttemptId: string | null;
  provider: string;
  providerSessionId?: string;
  connectionEpoch: number;
  turnId?: string | null;
}): boolean {
  return event.runtimeId === input.runtimeId
    && event.runtimeSessionId === input.runtimeSessionId
    && event.cohubSessionId === input.cohubSessionId
    && event.executionAttemptId === input.executionAttemptId
    && event.provider === input.provider
    && event.connectionEpoch === input.connectionEpoch
    && (input.providerSessionId === undefined || event.providerSessionId === input.providerSessionId)
    && (input.turnId === undefined || event.turnId === input.turnId);
}

const isProvisionalProviderSessionId = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("pending:");

/**
 * Codex assigns a thread id after the first stream event. The runtime emits a
 * single explicit session.ready transition for that case; accept it while the
 * command still carries the scoped provisional id, then require the native id
 * for every later event.
 */
function isProviderSessionTransition(
  event: LocalRuntimeEvent,
  providerSessionId: string | null,
  expectedProvisionalProviderSessionId?: string,
): boolean {
  if (!providerSessionId || !isProvisionalProviderSessionId(providerSessionId) || event.kind !== "session.ready") return false;
  if (expectedProvisionalProviderSessionId && providerSessionId !== expectedProvisionalProviderSessionId) return false;
  if (event.providerSessionId === providerSessionId) return false;
  if (event.providerSessionId.startsWith("pending:")) return false;
  const metadata = record(event.payload.metadata);
  return metadata.providerSessionTransition === true
    && event.payload.provisional === false
    && event.providerSessionId.length > 0;
}

async function nextEventWithTimeout(channel: RuntimeChannel, timeoutMs: number): Promise<LocalRuntimeEvent> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("local runtime event wait timed out")), timeoutMs);
  timer.unref?.();
  try {
    return await channel.nextEvent(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function establishRuntimeSession(input: {
  channel: RuntimeChannel;
  runtime: LoadedAttempt["runtime"];
  turn: LoadedAttempt["turn"];
  attempt: LoadedAttempt["attempt"];
  priorSession: Awaited<ReturnType<typeof findRuntimeSession>>;
  lease: LeaseRow;
}): Promise<{ runtimeSessionId: string; providerSessionId: string; scope: LedgerScope; readyEvent: LocalRuntimeEvent }> {
  const runtimeSessionId = input.priorSession?.id ?? randomUUID();
  const openCommandId = `session:${runtimeSessionId}:open`;
  let persistedProviderSessionId = stringValue(input.priorSession?.providerSessionId);
  // A completed open may have durable readiness evidence that is newer than
  // the session row (for example, a worker crashed after recording the event).
  // Recover that native identity before deciding between open and resume.
  if (input.priorSession) {
    const openCommand = await findRuntimeCommand(runtimeSessionId, openCommandId);
    if (openCommand && openCommand.operation !== "session.open") {
      throw new Error("runtime_reconnect_required: local runtime open command identity is invalid");
    }
    const openEvents = openCommand
      ? await loadCommandEvents(runtimeSessionId, openCommandId)
      : [];
    const ready = openEvents.find((entry) => entry.kind === "session.ready");
    const evidenceProviderSessionId = stringValue(ready?.payload.providerSessionId);
    if (evidenceProviderSessionId && !isProvisionalProviderSessionId(evidenceProviderSessionId)) {
      if (persistedProviderSessionId
        && !isProvisionalProviderSessionId(persistedProviderSessionId)
        && persistedProviderSessionId !== evidenceProviderSessionId) {
        throw new Error("runtime_reconnect_required: local runtime open evidence has a different native provider session id");
      }
      persistedProviderSessionId = evidenceProviderSessionId;
      await upsertRuntimeSession({
        id: runtimeSessionId,
        runtimeId: input.runtime.id,
        spaceId: input.attempt.spaceId,
        cohubSessionId: input.turn.sessionId,
        providerSessionId: evidenceProviderSessionId,
        connectionEpoch: input.runtime.connectionEpoch,
      });
    } else if (!persistedProviderSessionId && evidenceProviderSessionId) {
      persistedProviderSessionId = evidenceProviderSessionId;
    }
    if (!persistedProviderSessionId && !openCommand) {
      throw new Error("runtime_reconnect_required: local runtime session has no provider session id");
    }
  }
  const priorProviderSessionId = persistedProviderSessionId
    && !isProvisionalProviderSessionId(persistedProviderSessionId)
    ? persistedProviderSessionId
    : null;
  const operation: LocalRuntimeCommand["operation"] = priorProviderSessionId ? "session.resume" : "session.open";
  // Opening a provider session is a one-time side effect for this durable
  // runtime session, so its command identity must survive attempt retries.
  // Resume is a fresh host activation and is scoped to the execution attempt.
  const commandId = operation === "session.open"
    ? openCommandId
    : `session:${input.attempt.id}:${runtimeSessionId}:resume`;
  // A newly opened provider session may not have a native id yet (Codex only
  // learns it from the first stream event). Persist a scoped placeholder so
  // the lifecycle command can be fenced before anything crosses the relay.
  const provisionalProviderSessionId = `pending:${runtimeSessionId}`;
  const ledgerProviderSessionId = priorProviderSessionId ?? provisionalProviderSessionId;
  if (isProvisionalProviderSessionId(ledgerProviderSessionId)
    && ledgerProviderSessionId !== provisionalProviderSessionId) {
    throw new Error("runtime_reconnect_required: local runtime provisional session id is not bound to the durable session");
  }
  const runtimeSession = await upsertRuntimeSession({
    id: runtimeSessionId,
    runtimeId: input.runtime.id,
    spaceId: input.attempt.spaceId,
    cohubSessionId: input.turn.sessionId,
    providerSessionId: ledgerProviderSessionId,
    connectionEpoch: input.runtime.connectionEpoch,
  });
  const scope: LedgerScope = {
    runtimeId: input.runtime.id,
    runtimeSessionId: runtimeSession.id,
    connectionEpoch: input.runtime.connectionEpoch,
    providerSessionId: ledgerProviderSessionId,
  };
  const prepared = await prepareCommand({
    scope,
    commandId,
    executionAttemptId: input.attempt.id,
    cohubSessionId: input.turn.sessionId,
    operation,
    payload: {},
  });

  const replayReadyEvent = async (): Promise<LocalRuntimeEvent | null> => {
    const row = (await loadCommandEvents(scope.runtimeSessionId, commandId)).find((entry) => entry.kind === "session.ready");
    if (!row) return null;
    const eventProviderSessionId = stringValue(row.payload.providerSessionId) ?? scope.providerSessionId;
    return {
      version: 1,
      type: "event",
      runtimeId: input.runtime.id,
      runtimeSessionId: scope.runtimeSessionId,
      cohubSessionId: input.turn.sessionId,
      executionAttemptId: input.attempt.id,
      turnId: null,
      provider: input.runtime.provider,
      providerSessionId: eventProviderSessionId,
      eventId: `ledger:${commandId}`,
      sequence: 1,
      kind: "session.ready",
      payload: row.payload,
      connectionEpoch: input.runtime.connectionEpoch,
    };
  };

  const bindReadyEvent = async (event: LocalRuntimeEvent): Promise<{ providerSessionId: string; scope: LedgerScope }> => {
    const envelopeProviderSessionId = stringValue(event.providerSessionId);
    const announcedProviderSessionId = stringValue(event.payload.providerSessionId);
    if (envelopeProviderSessionId && announcedProviderSessionId && envelopeProviderSessionId !== announcedProviderSessionId) {
      throw new Error("local runtime session.ready has inconsistent provider ids");
    }
    const providerSessionId = announcedProviderSessionId ?? envelopeProviderSessionId;
    if (!providerSessionId) throw new Error("local runtime returned an empty provider session id");
    if (isProvisionalProviderSessionId(providerSessionId) && providerSessionId !== provisionalProviderSessionId) {
      throw new Error("runtime_reconnect_required: local runtime returned an unbound provisional provider session id");
    }
    if (operation === "session.resume" && providerSessionId !== ledgerProviderSessionId) {
      throw new Error("local runtime resumed a different provider session");
    }
    const rebound = providerSessionId === scope.providerSessionId
      ? runtimeSession
      : await upsertRuntimeSession({
          id: runtimeSessionId,
          runtimeId: input.runtime.id,
          spaceId: input.attempt.spaceId,
          cohubSessionId: input.turn.sessionId,
          providerSessionId,
          connectionEpoch: input.runtime.connectionEpoch,
        });
    if (rebound.id !== scope.runtimeSessionId) throw new Error("local runtime session transition changed the durable session");
    return {
      providerSessionId,
      scope: { ...scope, providerSessionId },
    };
  };

  let claimedForSend: Awaited<ReturnType<typeof markCommandSent>> | null = null;
  if (prepared.status === "completed") {
    const readyEvent = await replayReadyEvent();
    if (!readyEvent) throw new Error("runtime_reconnect_required: completed session command has no ready event");
    const bound = await bindReadyEvent(readyEvent);
    if (operation === "session.open" && !isProvisionalProviderSessionId(bound.providerSessionId)) {
      throw new Error("runtime_reconnect_required: completed open has a native provider session id; resume is required");
    }
    claimedForSend = operation === "session.open"
      ? await rearmCompletedOpenCommand(scope.runtimeSessionId, commandId)
      : await rearmCompletedResumeCommand(scope.runtimeSessionId, commandId);
    if (!claimedForSend.claimed) {
      const message = operation === "session.open"
        ? "runtime_reconnect_required: local runtime open is already in flight; reconnect before retrying"
        : "runtime_reconnect_required: local runtime resume is already in flight; reconnect before retrying";
      await markReconnectRequired(scope, message, commandId).catch(() => undefined);
      throw new Error(message);
    }
  }
  if (prepared.status === "failed") {
    throw new ProviderRuntimeError(prepared.errorMessage ?? "local runtime failed to establish the provider session", prepared.errorCode ?? -32001);
  }
  if (prepared.status === "sent" || prepared.status === "unknown") {
    const message = "runtime_reconnect_required: local runtime session outcome is unknown; reconnect before retrying";
    await markReconnectRequired(scope, message, commandId).catch(() => undefined);
    throw new Error(message);
  }
  const claimed = claimedForSend ?? await markCommandSent(scope.runtimeSessionId, commandId);
  if (!claimed.claimed) {
    if (claimed.status === "completed") {
      const readyEvent = await replayReadyEvent();
      if (!readyEvent) throw new Error("runtime_reconnect_required: completed session command has no ready event");
      const bound = await bindReadyEvent(readyEvent);
      if (operation === "session.open") {
        if (!isProvisionalProviderSessionId(bound.providerSessionId)) {
          throw new Error("runtime_reconnect_required: completed open has a native provider session id; resume is required");
        }
        const reopened = await rearmCompletedOpenCommand(scope.runtimeSessionId, commandId);
        if (reopened.claimed) {
          claimedForSend = reopened;
        } else {
          const message = "runtime_reconnect_required: local runtime open is already in flight; reconnect before retrying";
          await markReconnectRequired(scope, message, commandId).catch(() => undefined);
          throw new Error(message);
        }
      } else {
        const resumed = await rearmCompletedResumeCommand(scope.runtimeSessionId, commandId);
        if (resumed.claimed) {
          claimedForSend = resumed;
        } else {
          const message = "runtime_reconnect_required: local runtime resume is already in flight; reconnect before retrying";
          await markReconnectRequired(scope, message, commandId).catch(() => undefined);
          throw new Error(message);
        }
      }
    } else {
      const message = "runtime_reconnect_required: local runtime session is being established by another worker";
      await markReconnectRequired(scope, message, commandId).catch(() => undefined);
      throw new Error(message);
    }
  }
  const command = commandEnvelope({
    commandId,
    runtimeId: input.runtime.id,
    spaceId: input.attempt.spaceId,
    runtimeSessionId,
    cohubSessionId: input.turn.sessionId,
    executionAttemptId: input.attempt.id,
    turnId: null,
    provider: input.runtime.provider,
    providerSessionId: priorProviderSessionId,
    operation,
    cwd: "/workspace",
    model: typeof record(input.turn.meta).model === "string" ? String(record(input.turn.meta).model) : null,
    accessMode: runtimeAccessMode(input.turn.meta),
    payload: {},
    connectionEpoch: input.runtime.connectionEpoch,
    lease: input.lease,
  });
  try {
    await input.channel.send(command);
    let readyEvent: LocalRuntimeEvent | null = null;
    while (!readyEvent) {
      const event = await nextEventWithTimeout(input.channel, SESSION_READY_TIMEOUT_MS);
      if (!eventMatches(event, {
      runtimeId: input.runtime.id,
      runtimeSessionId,
      cohubSessionId: input.turn.sessionId,
        executionAttemptId: input.attempt.id,
        provider: input.runtime.provider,
        connectionEpoch: input.runtime.connectionEpoch,
        turnId: null,
      })) throw new Error("local runtime returned an event for a different session");
      if (event.kind === "turn.failed") {
        const failure = new ProviderRuntimeError(stringValue(event.payload.message) ?? "local runtime failed to open the provider session", -32001);
        await recordInboundEvent({
          scope,
          commandId,
          kind: event.kind,
          payload: event.payload,
          fallbackSequence: event.sequence,
          eventId: event.eventId,
          providerEventId: event.providerEventId,
          sequence: event.sequence,
        });
        await failCommand(scope.runtimeSessionId, commandId, failure);
        throw failure;
      }
      if (event.kind !== "session.ready") continue;
      if (stringValue(event.payload.status) === "error") {
        const failure = new ProviderRuntimeError(stringValue(event.payload.message) ?? "local runtime failed to establish the provider session", -32001);
        await recordInboundEvent({
          scope,
          commandId,
          kind: event.kind,
          payload: event.payload,
          fallbackSequence: event.sequence,
          eventId: event.eventId,
          providerEventId: event.providerEventId,
          sequence: event.sequence,
        });
        await failCommand(scope.runtimeSessionId, commandId, failure);
        throw failure;
      }
      const bound = await bindReadyEvent(event);
      const accepted = await recordInboundEvent({
        scope: bound.scope,
        commandId,
        kind: event.kind,
        payload: event.payload,
        fallbackSequence: event.sequence,
        eventId: event.eventId,
        providerEventId: event.providerEventId,
        sequence: event.sequence,
      });
      if (accepted || !readyEvent) readyEvent = event;
      const completed = await completeCommand(scope.runtimeSessionId, commandId, {
        kind: event.kind,
        ...event.payload,
      });
      if (completed.status !== "completed") throw new Error("local runtime session completion was lost");
    }
    const bound = await bindReadyEvent(readyEvent);
    return { runtimeSessionId, providerSessionId: bound.providerSessionId, scope: bound.scope, readyEvent };
  } catch (error) {
    if (error instanceof ProviderRuntimeError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await markReconnectRequired(scope, `runtime_reconnect_required: ${message}`, commandId).catch(() => undefined);
    throw error;
  }
}

/**
 * Ask the local host to close the native provider session before the transport
 * is torn down. A WebSocket close only tells the relay to stop forwarding; it
 * does not prove that locald has waited for the provider process. Keeping this
 * acknowledgement in the normal command ledger makes a retry deterministic
 * and lets callers retain the workspace lease when the outcome is unknown.
 */
async function closeRuntimeSession(input: {
  channel: RuntimeChannel;
  runtime: LoadedAttempt["runtime"];
  turn: LoadedAttempt["turn"];
  attempt: LoadedAttempt["attempt"];
  runtimeSessionId: string;
  providerSessionId: string;
  scope: LedgerScope;
  lease: LeaseRow;
}): Promise<void> {
  const commandId = `session:${input.attempt.id}:${input.runtimeSessionId}:close`;
  const operation: LocalRuntimeCommand["operation"] = "session.close";
  const meta = record(input.turn.meta);
  const model = typeof meta.model === "string" ? meta.model : null;
  const accessMode = runtimeAccessMode(meta);

  const replayClosedEvent = async (): Promise<boolean> => {
    const rows = await loadCommandEvents(input.scope.runtimeSessionId, commandId);
    const row = rows.find((entry) => entry.kind === "session.ready"
      && stringValue(entry.payload.commandId) === commandId
      && stringValue(entry.payload.status) === "closed"
      && entry.payload.hostReaped === true);
    if (!row) return false;
    const announced = stringValue(row.payload.providerSessionId);
    if (announced && announced !== input.providerSessionId) {
      throw new Error("local runtime closed a different provider session");
    }
    return true;
  };

  const prepared = await prepareCommand({
    scope: input.scope,
    commandId,
    executionAttemptId: input.attempt.id,
    cohubSessionId: input.turn.sessionId,
    operation,
    payload: {},
  });
  if (prepared.status === "completed") {
    if (await replayClosedEvent()) return;
    const message = "runtime_reconnect_required: completed local runtime close has no closed acknowledgement";
    await markReconnectRequired(input.scope, message, commandId).catch(() => undefined);
    throw new Error(message);
  }
  if (prepared.status === "failed") {
    throw new ProviderRuntimeError(prepared.errorMessage ?? "local runtime session close failed", prepared.errorCode ?? -32003);
  }
  if (prepared.status === "sent" || prepared.status === "unknown") {
    const message = "runtime_reconnect_required: local runtime session close outcome is unknown; reconnect before retrying";
    await markReconnectRequired(input.scope, message, commandId).catch(() => undefined);
    throw new Error(message);
  }

  const claimed = await markCommandSent(input.scope.runtimeSessionId, commandId);
  if (!claimed.claimed) {
    if (claimed.status === "completed" && await replayClosedEvent()) return;
    const message = "runtime_reconnect_required: local runtime session close is already in flight; reconnect before retrying";
    await markReconnectRequired(input.scope, message, commandId).catch(() => undefined);
    throw new Error(message);
  }

  const command = commandEnvelope({
    commandId,
    runtimeId: input.runtime.id,
    spaceId: input.attempt.spaceId,
    runtimeSessionId: input.runtimeSessionId,
    cohubSessionId: input.turn.sessionId,
    executionAttemptId: input.attempt.id,
    turnId: null,
    provider: input.runtime.provider,
    providerSessionId: input.providerSessionId,
    operation,
    cwd: "/workspace",
    model,
    accessMode,
    payload: {},
    connectionEpoch: input.runtime.connectionEpoch,
    lease: input.lease,
  });

  try {
    await input.channel.send(command);
    while (true) {
      const event = await nextEventWithTimeout(input.channel, SESSION_READY_TIMEOUT_MS);
      if (!eventMatches(event, {
        runtimeId: input.runtime.id,
        runtimeSessionId: input.runtimeSessionId,
        cohubSessionId: input.turn.sessionId,
        executionAttemptId: input.attempt.id,
        provider: input.runtime.provider,
        providerSessionId: input.providerSessionId,
        connectionEpoch: input.runtime.connectionEpoch,
        turnId: null,
      })) {
        throw new Error("local runtime returned an event for a different session while closing");
      }
      // A late lifecycle event from a previous command can still be queued on
      // the channel. It is not evidence that this close command completed.
      if (stringValue(event.payload.commandId) !== commandId) continue;
      if (event.kind !== "session.ready") continue;
      await recordInboundEvent({
        scope: input.scope,
        commandId,
        kind: event.kind,
        payload: event.payload,
        fallbackSequence: event.sequence,
        eventId: event.eventId,
        providerEventId: event.providerEventId,
        sequence: event.sequence,
      });
      const status = stringValue(event.payload.status);
      if (status !== "closed") {
        const failure = new ProviderRuntimeError(
          stringValue(event.payload.message) ?? "local runtime provider session did not close",
          -32003,
        );
        await failCommand(input.scope.runtimeSessionId, commandId, failure);
        await markReconnectRequired(input.scope, `runtime_reconnect_required: ${failure.message}`, commandId).catch(() => undefined);
        throw failure;
      }
      // locald forwards the provider's close receipt first, then emits a
      // synthetic receipt only after the host process has been reaped. The
      // latter is the actual workspace-release barrier.
      if (event.payload.hostReaped !== true) continue;
      const completed = await completeCommand(input.scope.runtimeSessionId, commandId, {
        kind: event.kind,
        ...event.payload,
      });
      if (completed.status !== "completed") throw new Error("local runtime session close completion was lost");
      return;
    }
  } catch (error) {
    if (error instanceof ProviderRuntimeError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await markReconnectRequired(input.scope, `runtime_reconnect_required: ${message}`, commandId).catch(() => undefined);
    throw error;
  }
}

export async function processLocalRuntimeTurn(input: { attemptId: string }): Promise<Record<string, unknown>> {
  const loaded = await loadRuntimeForAttempt(input.attemptId);
  if (!loaded) throw new Error("local runtime execution attempt not found");
  const { attempt, runtime, turn, state, replica } = loaded;
  if (attempt.executorKind !== "local_runtime" || !attempt.runtimeId || !attempt.turnId || turn.executionKind !== "agent") {
    throw new Error("execution attempt is not a local runtime attempt");
  }
  const fail = async (message: string): Promise<never> => {
    await failAttempt({
      attemptId: attempt.id,
      spaceId: attempt.spaceId,
      sessionId: turn.sessionId,
      turnId: turn.id,
      message,
      workspaceLeaseEpoch: attempt.workspaceLeaseEpoch ?? null,
    }).catch((cleanupError) => {
      logger.error("[LocalRuntime] attempt cleanup failed", { attemptId: attempt.id, error: cleanupError });
    });
    throw new Error(message);
  };
  const abortBeforeProviderStart = async (workspaceLeaseEpoch = attempt.workspaceLeaseEpoch): Promise<Record<string, unknown> | null> => {
    const abortEvent = await getAbortEvent(turn.id);
    if (!abortEvent) return null;
    await abortAttempt({
      attemptId: attempt.id,
      spaceId: attempt.spaceId,
      sessionId: turn.sessionId,
      turnId: turn.id,
      workspaceLeaseEpoch,
      reason: abortEvent.reason,
      continuedByTurnId: abortEvent.continuedByTurnId,
    });
    return { skipped: "abort_requested", turnId: turn.id };
  };
  const abortedBeforeValidation = await abortBeforeProviderStart();
  if (abortedBeforeValidation) return abortedBeforeValidation;
  if (!["queued", "running", "abort_requested"].includes(turn.status)) {
    await abortAttempt({
      attemptId: attempt.id,
      spaceId: attempt.spaceId,
      sessionId: turn.sessionId,
      turnId: turn.id,
      workspaceLeaseEpoch: attempt.workspaceLeaseEpoch,
      reason: "abort",
    });
    return { skipped: "turn_terminal", turnId: turn.id };
  }
  if (runtime.status === "revoked") await fail("local runtime is revoked");
  if (!replica || runtime.spaceId !== attempt.spaceId || runtime.replicaId !== replica.id || attempt.replicaId !== replica.id) await fail("local runtime workspace binding is invalid");
  if (!replica) throw new Error("local runtime replica is unavailable");
  if (!turn.userUuid || runtime.userUuid !== turn.userUuid) await fail("local runtime ownership does not match the turn actor");
  if (!isLocalRuntimeProviderRolloutEnabled(runtime.provider)) await fail(`${runtime.provider} local runtime is disabled`);
  if (!state.canonicalSnapshotId) await fail("local runtime execution requires a canonical workspace snapshot");

  const meta = record(turn.meta);
  const userMessageId = typeof meta.userMessageId === "string" ? meta.userMessageId : randomUUID();
  const normalizedUserContent = await normalizeContentBlocksImages(turn.userContent, { readUrlImage: readPublicAssetImageUrl });
  let lease: LeaseRow;
  try {
    lease = await acquireWorkspaceLease({
      attemptId: attempt.id,
      spaceId: attempt.spaceId,
      replicaId: replica.id,
      deviceId: runtime.deviceId,
      userUuid: turn.userUuid ?? runtime.userUuid,
      baseSnapshotId: attempt.baseCanonicalSnapshotId,
      integrationPolicyVersion: attempt.integrationPolicyVersion,
    });
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error));
    throw error;
  }

  const abortedBeforeChannel = await abortBeforeProviderStart(lease.epoch);
  if (abortedBeforeChannel) return abortedBeforeChannel;

  const priorSession = await findRuntimeSession(runtime.id, turn.sessionId);
  const turnContext: TurnContext = {
    loaded,
    lease,
    userMessageId,
    commandId: `turn:${attempt.id}`,
    assistantMessageId: "",
    startedAt: turn.startedAt?.toISOString() ?? new Date().toISOString(),
    projection: createTurnProjection(),
    patchSeq: 0,
    cancelRequested: false,
  };

  let channel: RuntimeChannel | null = null;
  let sessionManager: SessionManager | null = null;
  let scope: LedgerScope | null = null;
  let runtimeSessionId = priorSession?.id ?? randomUUID();
  let providerSessionId = priorSession?.providerSessionId ?? null;
  let commandStatus: "none" | "prepared" | "sent" | "settled" = "none";
  let leaseLost: Error | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatInFlight: Promise<void> | null = null;
  let cancelTimer: ReturnType<typeof setTimeout> | null = null;
  let unregisterAbort: (() => void) | null = null;
  let channelClosePromise: Promise<boolean> | null = null;
  let channelOpened = false;
  let sessionCloseConfirmed = false;

  const closeChannelBeforeLeaseRelease = async (): Promise<boolean> => {
    if (channelClosePromise) return channelClosePromise;
    const activeChannel = channel;
    if (!activeChannel) return true;
    channelClosePromise = (async () => {
      activeChannel.close();
      let timer: ReturnType<typeof setTimeout> | null = null;
      let closed = false;
      try {
        closed = await Promise.race([
          activeChannel.closed.then(() => true),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, CHANNEL_CLOSE_TIMEOUT_MS);
            timer.unref?.();
          }).then(() => false),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!closed || activeChannel.closeCode === null) {
        logger.warn("[LocalRuntime] runtime channel close timed out before lease release", {
          runtimeId: runtime.id,
          attemptId: attempt.id,
        });
        return false;
      }
      return true;
    })();
    return channelClosePromise;
  };

  const runtimeBusy = () => channel?.closeCode === RUNTIME_BUSY_CLOSE_CODE;

  try {
    const abortedBeforeOpen = await abortBeforeProviderStart(lease.epoch);
    if (abortedBeforeOpen) return abortedBeforeOpen;
    channel = await openRuntimeChannel(runtime, {
      executionAttemptId: attempt.id,
      spaceId: attempt.spaceId,
      replicaId: replica.id,
      connectionEpoch: runtime.connectionEpoch,
      baseSnapshotId: state.canonicalSnapshotId as string,
      leaseEpoch: lease.epoch,
      leaseExpiresAt: lease.expiresAt.toISOString(),
    });
    channelOpened = true;
    const openedChannel = channel;
    const established = await establishRuntimeSession({ channel: openedChannel, runtime, turn, attempt, priorSession, lease });
    runtimeSessionId = established.runtimeSessionId;
    providerSessionId = established.providerSessionId;
    scope = established.scope;
    turnContext.assistantMessageId = deterministicUuid(`cohub-local-runtime-assistant-v1:${runtimeSessionId}:${turn.id}`);
    void openedChannel.closed.then(() => {
      if (scope) void markRuntimeSessionDisconnected(scope.runtimeSessionId, scope.connectionEpoch).catch(() => undefined);
    });
    await setRuntimeStatus({ runtimeId: runtime.id, connectionEpoch: runtime.connectionEpoch, status: "busy" });

    sessionManager = await openLocalRuntimeSession(attempt.spaceId, turn.sessionId);
    const transcriptBase: LocalRuntimeTranscriptInput = {
      spaceId: attempt.spaceId,
      sessionId: turn.sessionId,
      turnId: turn.id,
      executionAttemptId: attempt.id,
      userMessageId,
      startedAt: turnContext.startedAt,
    };
    const userEntryId = appendLocalRuntimeUserMessage(sessionManager, transcriptBase, normalizedUserContent, { ...meta, runtimeId: runtime.id, executorKind: "local_runtime" });
    await sessionManager.flush();
    await persistUserMessage({
      spaceId: attempt.spaceId,
      sessionId: turn.sessionId,
      userMessageId,
      turnId: turn.id,
      agentSessionEntryId: userEntryId,
      content: normalizedUserContent,
      meta: { ...meta, runtimeId: runtime.id, executorKind: "local_runtime" },
    });

    const cancelController = new AbortController();
    const requestCancel = () => {
      if (turnContext.cancelRequested) return;
      turnContext.cancelRequested = true;
      const cancelCommand = commandEnvelope({
        commandId: `cancel:${attempt.id}:${randomUUID()}`,
        runtimeId: runtime.id,
        spaceId: attempt.spaceId,
        runtimeSessionId,
        cohubSessionId: turn.sessionId,
        executionAttemptId: attempt.id,
        turnId: turn.id,
        provider: runtime.provider,
        providerSessionId,
        operation: "turn.cancel",
        cwd: "/workspace",
        model: typeof meta.model === "string" ? meta.model : null,
        accessMode: runtimeAccessMode(meta),
        payload: { reason: "turn cancellation requested" },
        connectionEpoch: runtime.connectionEpoch,
        lease,
      });
      void openedChannel.send(cancelCommand).catch(() => undefined);
      cancelController.abort(new Error("turn cancellation requested"));
      cancelTimer = setTimeout(() => openedChannel.close(), CANCEL_GRACE_MS);
      cancelTimer.unref?.();
    };
    unregisterAbort = registerActiveAbortHandle(turn.id, {
      id: `local-runtime:${runtime.id}:${turn.id}`,
      kind: "turn",
      abort: requestCancel,
    });
    const runHeartbeat = () => {
      if (heartbeatInFlight || leaseLost) return;
      const pending = heartbeatWorkspaceLease(attempt.spaceId, attempt.id, lease.epoch).catch((error) => {
        leaseLost = error instanceof Error ? error : new Error(String(error));
        requestCancel();
      }).finally(() => {
        if (heartbeatInFlight === pending) heartbeatInFlight = null;
      });
      heartbeatInFlight = pending;
    };
    heartbeatTimer = setInterval(runHeartbeat, LEASE_HEARTBEAT_MS);
    heartbeatTimer.unref();

    const prompt = toRuntimePrompt(normalizedUserContent);
    const promptPayload: Record<string, unknown> = {
      text: prompt.text,
      content: prompt.content ?? [],
      options: {
        ...(typeof meta.model === "string" ? { model: meta.model } : {}),
        accessMode: runtimeAccessMode(meta),
        ...(meta.images !== undefined ? { images: meta.images } : {}),
      },
    };
    const command = commandEnvelope({
      commandId: turnContext.commandId,
      runtimeId: runtime.id,
      spaceId: attempt.spaceId,
      runtimeSessionId,
      cohubSessionId: turn.sessionId,
      executionAttemptId: attempt.id,
      turnId: turn.id,
      provider: runtime.provider,
      providerSessionId,
      operation: "turn.start",
      cwd: "/workspace",
      model: typeof meta.model === "string" ? meta.model : null,
      accessMode: runtimeAccessMode(meta),
      payload: promptPayload,
      connectionEpoch: runtime.connectionEpoch,
      lease,
    });
    const prepared = await prepareCommand({
      scope,
      commandId: turnContext.commandId,
      executionAttemptId: attempt.id,
      cohubSessionId: turn.sessionId,
      operation: "turn.start",
      payload: promptPayload,
    });
    let terminalKind: "turn.completed" | "turn.failed" | null = null;
    let terminalPayload: Record<string, unknown> | null = null;
    const replayCommandEvents = async () => {
      if (!scope) throw new Error("local runtime ledger scope is unavailable");
      for (const row of await loadCommandEvents(scope.runtimeSessionId, turnContext.commandId)) {
        const kind = stringValue(row.kind);
        if (!kind) continue;
        const event = { kind, payload: row.payload } as LocalRuntimeEvent;
        if (applyRuntimeEvent(turnContext.projection, event)) await publishProjection(turnContext);
        if (kind === "turn.completed" || kind === "turn.failed") {
          terminalKind = kind;
          terminalPayload = row.payload;
        }
      }
      if (!terminalKind || !terminalPayload) throw new Error("runtime_reconnect_required: completed local runtime command has no terminal event");
    };
    if (prepared.status === "completed") {
      if (!prepared.response) throw new Error("runtime_reconnect_required: completed local runtime command has no response");
      await replayCommandEvents();
      commandStatus = "settled";
    } else if (prepared.status === "sent" || prepared.status === "unknown") {
      const message = "runtime_reconnect_required: local runtime turn outcome is unknown; reconnect before retrying";
      await markReconnectRequired(scope, message, turnContext.commandId).catch(() => undefined);
      throw new Error(message);
    } else if (prepared.status === "failed") {
      throw new ProviderRuntimeError(prepared.errorMessage ?? "local runtime turn failed", prepared.errorCode ?? -32000);
    } else {
      commandStatus = "prepared";
      const sent = await markCommandSent(scope.runtimeSessionId, turnContext.commandId);
      if (sent.status === "completed") {
        await replayCommandEvents();
        commandStatus = "settled";
      } else if (!sent.claimed) {
        const message = "runtime_reconnect_required: local runtime turn is already in flight; reconnect before retrying";
        await markReconnectRequired(scope, message, turnContext.commandId).catch(() => undefined);
        throw new Error(message);
      } else {
        commandStatus = "sent";
        await openedChannel.send(command);
        try {
          while (true) {
            const event = await openedChannel.nextEvent(cancelController.signal);
            const matchesRouting = eventMatches(event, {
              runtimeId: runtime.id,
              runtimeSessionId,
              cohubSessionId: turn.sessionId,
              executionAttemptId: attempt.id,
              provider: runtime.provider,
              connectionEpoch: runtime.connectionEpoch,
              turnId: turn.id,
            });
            if (!matchesRouting) throw new Error("local runtime returned an event for a different turn");
            if (event.providerSessionId !== providerSessionId) {
              if (!isProviderSessionTransition(event, providerSessionId, `pending:${runtimeSessionId}`)) {
                throw new Error("local runtime returned an event for a different provider session");
              }
              const announced = stringValue(event.payload.providerSessionId);
              if (announced && announced !== event.providerSessionId) {
                throw new Error("local runtime session transition has inconsistent provider ids");
              }
              providerSessionId = event.providerSessionId;
              scope = {
                ...scope,
                providerSessionId,
              };
              const rebound = await upsertRuntimeSession({
                id: scope.runtimeSessionId,
                runtimeId: runtime.id,
                spaceId: attempt.spaceId,
                cohubSessionId: turn.sessionId,
                providerSessionId,
                connectionEpoch: runtime.connectionEpoch,
              });
              if (rebound.id !== scope.runtimeSessionId) {
                throw new Error("local runtime session transition changed the durable session");
              }
            }
            const accepted = await recordInboundEvent({
              scope,
              commandId: turnContext.commandId,
              kind: event.kind,
              payload: event.payload,
              fallbackSequence: event.sequence,
              eventId: event.eventId,
              providerEventId: event.providerEventId,
              sequence: event.sequence,
            });
            if (!accepted) continue;
            if (applyRuntimeEvent(turnContext.projection, event)) await publishProjection(turnContext);
            if (event.kind !== "turn.completed" && event.kind !== "turn.failed") continue;
            terminalKind = event.kind;
            terminalPayload = event.payload;
            break;
          }
        } catch (error) {
          if (cancelController.signal.aborted && turnContext.cancelRequested) throw error;
          throw error;
        }
        const completed = await completeCommand(scope.runtimeSessionId, turnContext.commandId, {
          kind: terminalKind,
          ...terminalPayload,
        });
        terminalPayload = completed.response ?? terminalPayload;
        commandStatus = "settled";
      }
    }
    if (leaseLost) throw leaseLost;

    syncToolBlocks(turnContext.projection);
    if (!terminalKind || !terminalPayload) throw new Error("runtime_reconnect_required: local runtime turn has no terminal event");
    const stopReason = mapRuntimeStopReason(terminalPayload.stopReason) ?? (terminalKind === "turn.failed" ? "error" : "stop");
    const isError = terminalKind === "turn.failed" || (stopReason !== "aborted" && turnContext.projection.content.length === 0);
    const errorMessage = isError
      ? stringValue(terminalPayload.message) ?? turnContext.projection.errorMessage ?? "The local provider returned no assistant content."
      : null;
    if (!sessionManager) throw new Error("local runtime session JSONL manager is unavailable");
    const completedAt = new Date().toISOString();
    const transcript: LocalRuntimeAssistantTranscriptInput = {
      ...transcriptBase,
      assistantMessageId: turnContext.assistantMessageId,
      content: turnContext.projection.content,
      provider: runtime.provider,
      model: typeof meta.model === "string" ? meta.model : null,
      stopReason,
      usage: turnContext.projection.usage,
      messageKind: isError ? "assistant_error" : "assistant_final",
      errorMessage,
      completedAt,
    };
    const sessionEntryId = appendLocalRuntimeAssistantMessages(sessionManager, transcript);
    await sessionManager.flush();
    await persistAssistantMessage({
      spaceId: attempt.spaceId,
      spaceSessionId: turn.sessionId,
      userMessageId,
      turnId: turn.id,
      userId: turn.userUuid,
      startedAt: turnContext.startedAt,
      completedAt,
      messageOrdinal: 0,
      event: {
        type: "turn_end",
        toolResults: [],
        message: {
          id: turnContext.assistantMessageId,
          role: "assistant",
          content: turnContext.projection.content,
          provider: runtime.provider,
          model: typeof meta.model === "string" ? meta.model : null,
          stopReason,
          errorMessage,
          usage: turnContext.projection.usage,
          sessionEntryId,
          meta: {
            messageKind: isError ? "assistant_error" : "assistant_final",
            runtimeId: runtime.id,
            providerSessionId,
            executionAttemptId: attempt.id,
            commandId: turnContext.commandId,
          },
        },
      },
    });
    if (leaseLost) throw leaseLost;
    if (!scope || !providerSessionId) throw new Error("local runtime session scope is unavailable while closing");
    await closeRuntimeSession({
      channel: openedChannel,
      runtime,
      turn,
      attempt,
      runtimeSessionId,
      providerSessionId,
      scope,
      lease,
    });
    sessionCloseConfirmed = true;
    if (!(await closeChannelBeforeLeaseRelease())) {
      throw new Error("runtime_reconnect_required: local runtime channel did not close before lease release");
    }
    await markTranscriptSealed(attempt.id, lease.epoch);
    await setRuntimeStatus({ runtimeId: runtime.id, connectionEpoch: runtime.connectionEpoch, status: "ready" }).catch((statusError) => {
      logger.warn("[LocalRuntime] failed to publish runtime ready status", { runtimeId: runtime.id, error: statusError });
    });
    return { attemptId: attempt.id, sessionId: turn.sessionId, turnId: turn.id, stopReason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The local host may still be mutating the replica while the transport is
    // draining. Fence the provider channel first; only then may failAttempt
    // expire the cloud lease and allow another execution to claim the workspace.
    if (channelOpened && scope && providerSessionId && !sessionCloseConfirmed) {
      try {
        await closeRuntimeSession({
          channel: channel as RuntimeChannel,
          runtime,
          turn,
          attempt,
          runtimeSessionId,
          providerSessionId,
          scope,
          lease,
        });
        sessionCloseConfirmed = true;
      } catch (closeError) {
        logger.warn("[LocalRuntime] provider session close was not confirmed", {
          runtimeId: runtime.id,
          attemptId: attempt.id,
          error: closeError,
        });
      }
    }
    if (scope && (commandStatus === "prepared" || commandStatus === "sent")) {
      const reconnectMessage = message.startsWith("runtime_reconnect_required") ? message : `runtime_reconnect_required: ${message}`;
      await markReconnectRequired(scope, reconnectMessage, turnContext.commandId).catch(() => undefined);
    }
    const channelClosed = await closeChannelBeforeLeaseRelease();
    const leaseReleaseSafe = channelClosed && (!channelOpened || sessionCloseConfirmed);
    await failAttempt({
      attemptId: attempt.id,
      spaceId: attempt.spaceId,
      sessionId: turn.sessionId,
      turnId: turn.id,
      message,
      // If the host channel did not close, keep the running attempt/lease
      // fenced and let the sweeper recover it after the stale window.
      workspaceLeaseEpoch: leaseReleaseSafe ? lease.epoch : null,
    }).catch((cleanupError) => {
      logger.error("[LocalRuntime] turn cleanup failed", { attemptId: attempt.id, error: cleanupError });
    });
    if (!runtimeBusy()) {
      const requiresReconnect = message.startsWith("runtime_reconnect_required") || !(error instanceof ProviderRuntimeError);
      await setRuntimeStatus({
        runtimeId: runtime.id,
        connectionEpoch: runtime.connectionEpoch,
        status: requiresReconnect ? "error" : "ready",
        error: requiresReconnect ? message : null,
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (cancelTimer) clearTimeout(cancelTimer);
    await Promise.resolve(heartbeatInFlight).catch(() => undefined);
    unregisterAbort?.();
    if (sessionManager) {
      await sessionManager.close().catch((closeError: unknown) => {
        logger.warn("[LocalRuntime] session JSONL close failed", { sessionId: turn.sessionId, error: closeError });
      });
    }
    await closeChannelBeforeLeaseRelease();
  }
}

export async function findQueuedLocalRuntimeAttempt(sessionId: string): Promise<string | null> {
  const [row] = await db.select({ attemptId: workspaceExecutionAttempts.id }).from(workspaceExecutionAttempts)
    .innerJoin(sessionTurns, eq(sessionTurns.id, workspaceExecutionAttempts.turnId)).where(and(
      eq(sessionTurns.sessionId, sessionId),
      eq(sessionTurns.executionKind, "agent"),
      eq(sessionTurns.status, "queued"),
      eq(workspaceExecutionAttempts.executorKind, "local_runtime"),
      inArray(workspaceExecutionAttempts.status, ["queued", "prepared"]),
    )).orderBy(sessionTurns.sequence).limit(1);
  return row?.attemptId ?? null;
}

const runtimeTails = new Map<string, Promise<unknown>>();

/** One turn at a time per runtime within this worker; the Gateway fences across workers. */
export async function runSerializedLocalRuntimeTurn(attemptId: string): Promise<unknown> {
  const loaded = await loadRuntimeForAttempt(attemptId);
  if (!loaded) throw new Error("local runtime execution attempt not found");
  const previous = runtimeTails.get(loaded.runtime.id) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => processLocalRuntimeTurn({ attemptId }));
  runtimeTails.set(loaded.runtime.id, current);
  try {
    return await current;
  } finally {
    if (runtimeTails.get(loaded.runtime.id) === current) runtimeTails.delete(loaded.runtime.id);
  }
}

export async function closeLocalRuntimeConnections(): Promise<void> {
  runtimeTails.clear();
}
