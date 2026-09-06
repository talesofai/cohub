import type {
  ChannelPromptContext,
  PromptAccessMode,
  PromptSource,
  PromptTemplateUsageMeta,
  PublicApiPromptContext,
  ScheduledTaskPromptContext,
  SubmitSessionPromptContext,
  SubmitSessionPromptError,
  SubmitSessionPromptHooks,
  SubmitSessionPromptInput,
  SubmitSessionPromptOptions,
  SubmitSessionPromptResult,
  WebAppPromptContext,
  WebsocketPromptContext,
} from "@cohub/core/sessions";
import type { ContentBlock } from "@cohub/protocol/core";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { localAgentRuntimes, sessionTurns, spaceLocalAgentPolicies, spaceWorkspacePolicies, workspaceExecutionAttempts, workspaceReplicas, workspaceState } from "@cohub/db";
import { db } from "./db/index.js";
import { isLocalAcpProviderEnabled } from "./local-acp-runtime-service.js";
import { LocalAgentServiceError } from "./local-agent-service.js";
import { getSessionDomainServices } from "./session-services.js";

export type {
  ChannelPromptContext,
  PromptAccessMode,
  PromptSource,
  PromptTemplateUsageMeta,
  PublicApiPromptContext,
  ScheduledTaskPromptContext,
  SubmitSessionPromptContext,
  SubmitSessionPromptError,
  SubmitSessionPromptHooks,
  SubmitSessionPromptInput,
  SubmitSessionPromptOptions,
  SubmitSessionPromptResult,
  WebAppPromptContext,
  WebsocketPromptContext,
};

export const expandPromptContent = async (input: {
  content: ContentBlock[];
  userId: string;
  spaceId: string;
  sessionId?: string | null;
}) => getSessionDomainServices().expandPromptContent(input);

export const buildPromptIdempotencyKey = (clientMessageId: string, runtimeId?: string | null) => {
  const normalizedClientMessageId = clientMessageId.trim();
  const prefix = runtimeId?.trim() ? "local-acp-turn:" : "cloud-turn:";
  const suffix = normalizedClientMessageId.length <= 220
    ? normalizedClientMessageId
    : createHash("sha256").update(normalizedClientMessageId, "utf8").digest("hex");
  return `${prefix}${suffix}`;
};

async function allocateCloudWorkspaceAttempt(input: {
  spaceId: string;
  sessionId: string;
  turnId: string;
  clientMessageId: string;
  userId: string;
  runtimeId?: string | null;
}) {
  const runtimeId = input.runtimeId?.trim() || null;
  return db.transaction(async (tx) => {
    const [state] = await tx.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).for("update").limit(1);
    if (!state) {
      if (runtimeId) throw new LocalAgentServiceError("workspace state is unavailable for local ACP execution", "workspace_state_unavailable", 409);
      return null;
    }
    if (runtimeId && !state.canonicalSnapshotId) {
      throw new LocalAgentServiceError("workspace has no canonical snapshot for local ACP execution", "runtime_replica_not_ready", 409);
    }
    const [turn] = await tx.select({ meta: sessionTurns.meta }).from(sessionTurns).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId), eq(sessionTurns.executionKind, "agent"))).for("update").limit(1);
    if (!turn) throw new Error("cloud turn not found while allocating workspace attempt");
    const meta = turn.meta && typeof turn.meta === "object" && !Array.isArray(turn.meta) ? turn.meta as Record<string, unknown> : {};
    const existingAttemptId = typeof meta.executionAttemptId === "string" ? meta.executionAttemptId : null;
    if (existingAttemptId) {
      const existingRuntimeId = typeof meta.runtimeId === "string" && meta.runtimeId.trim() ? meta.runtimeId.trim() : null;
      if (existingRuntimeId !== runtimeId) throw new LocalAgentServiceError("client message id is already bound to a different executor", "prompt_idempotency_conflict", 409);
      return existingAttemptId;
    }
    const [policy] = await tx.select({ policyVersion: spaceWorkspacePolicies.policyVersion }).from(spaceWorkspacePolicies).where(eq(spaceWorkspacePolicies.spaceId, input.spaceId)).limit(1);
    let runtime: typeof localAgentRuntimes.$inferSelect | null = null;
    let localReplica: typeof workspaceReplicas.$inferSelect | null = null;
    let integrationPolicyVersion: number | null = null;
    if (runtimeId) {
      const [runtimeRow] = await tx.select().from(localAgentRuntimes).where(and(
        eq(localAgentRuntimes.id, runtimeId),
        eq(localAgentRuntimes.spaceId, input.spaceId),
        eq(localAgentRuntimes.userUuid, input.userId),
        or(eq(localAgentRuntimes.status, "ready"), eq(localAgentRuntimes.status, "busy")),
      )).for("update").limit(1);
      if (!runtimeRow) throw new LocalAgentServiceError("local ACP runtime is offline or unavailable", "runtime_unavailable", 409);
      if (!isLocalAcpProviderEnabled(runtimeRow.provider)) throw new LocalAgentServiceError(`${runtimeRow.provider} local ACP runtime is disabled`, "provider_not_enabled", 403);
      const [integrationPolicy] = await tx.select({ workspaceMode: spaceLocalAgentPolicies.workspaceMode, integrationPolicyVersion: spaceLocalAgentPolicies.integrationPolicyVersion }).from(spaceLocalAgentPolicies).where(and(
        eq(spaceLocalAgentPolicies.spaceId, input.spaceId),
        eq(spaceLocalAgentPolicies.deviceId, runtimeRow.deviceId),
      )).limit(1);
      if (!integrationPolicy) throw new LocalAgentServiceError("local agent policy is unavailable for this runtime", "policy_unavailable", 409);
      if (integrationPolicy.workspaceMode === "one_way_to_local") {
        throw new LocalAgentServiceError("local workspace is read-only under the current policy", "workspace_write_disabled", 403);
      }
      integrationPolicyVersion = integrationPolicy.integrationPolicyVersion;
      runtime = runtimeRow;
      const [replicaRow] = await tx.select().from(workspaceReplicas).where(and(
        eq(workspaceReplicas.id, runtimeRow.replicaId as string),
        eq(workspaceReplicas.spaceId, input.spaceId),
        eq(workspaceReplicas.deviceId, runtimeRow.deviceId),
        eq(workspaceReplicas.kind, "local"),
        eq(workspaceReplicas.status, "ready"),
        eq(workspaceReplicas.appliedSnapshotId, state.canonicalSnapshotId as string),
      )).for("update").limit(1);
      if (!replicaRow) throw new LocalAgentServiceError("local workspace replica is not ready for this runtime", "runtime_replica_not_ready", 409);
      localReplica = replicaRow;
    }
    if (runtimeId && !policy) throw new LocalAgentServiceError("workspace policy is unavailable for local ACP execution", "workspace_policy_unavailable", 409);
    const attemptId = randomUUID();
    const idempotencyKey = buildPromptIdempotencyKey(input.clientMessageId, runtimeId);
    const idempotencyKeys = [...new Set([
      idempotencyKey,
      buildPromptIdempotencyKey(input.clientMessageId, null),
    ])];
    const [existingByIdempotency] = await tx.select({ id: workspaceExecutionAttempts.id, turnId: workspaceExecutionAttempts.turnId, runtimeId: workspaceExecutionAttempts.runtimeId }).from(workspaceExecutionAttempts).where(and(
      eq(workspaceExecutionAttempts.spaceId, input.spaceId),
      inArray(workspaceExecutionAttempts.idempotencyKey, idempotencyKeys),
    )).for("update").limit(1);
    if (existingByIdempotency) {
      if (existingByIdempotency.turnId !== input.turnId || (existingByIdempotency.runtimeId ?? null) !== runtimeId) {
        throw new LocalAgentServiceError("client message id is already bound to another execution attempt; retry the original request", "prompt_idempotency_conflict", 409);
      }
      return existingByIdempotency.id;
    }
    const [createdAttempt] = await tx.insert(workspaceExecutionAttempts).values({
      id: attemptId,
      spaceId: input.spaceId,
      runtimeId: runtime?.id ?? null,
      replicaId: localReplica?.id ?? null,
      idempotencyKey,
      executorKind: runtimeId ? "local_acp" : "cloud_agent",
      provider: runtime?.provider ?? null,
      integrationPolicyVersion: runtimeId ? integrationPolicyVersion : null,
      workspaceRequired: true,
      transcriptRequired: true,
      sessionId: input.sessionId,
      turnId: input.turnId,
      baseCanonicalSnapshotId: state.canonicalSnapshotId,
      workspacePolicyVersion: policy?.policyVersion ?? null,
      status: "queued",
    }).onConflictDoNothing({ target: [workspaceExecutionAttempts.spaceId, workspaceExecutionAttempts.idempotencyKey] }).returning({ id: workspaceExecutionAttempts.id, turnId: workspaceExecutionAttempts.turnId, runtimeId: workspaceExecutionAttempts.runtimeId });
    if (!createdAttempt) {
      const [existing] = await tx.select({ id: workspaceExecutionAttempts.id, turnId: workspaceExecutionAttempts.turnId, runtimeId: workspaceExecutionAttempts.runtimeId }).from(workspaceExecutionAttempts).where(and(
        eq(workspaceExecutionAttempts.spaceId, input.spaceId),
        eq(workspaceExecutionAttempts.idempotencyKey, idempotencyKey),
      )).for("update").limit(1);
      if (!existing || existing.turnId !== input.turnId || (existing.runtimeId ?? null) !== runtimeId) {
        throw new LocalAgentServiceError("client message id is already bound to another execution attempt; retry the original request", "prompt_idempotency_conflict", 409);
      }
      return existing.id;
    }
    await tx.update(sessionTurns).set({
      meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify({
        executionAttemptId: attemptId,
        executorKind: runtimeId ? "local_acp" : "cloud_agent",
        ...(runtimeId ? { runtimeId, provider: runtime?.provider ?? null } : {}),
        workspaceExecutionBase: {
          canonicalSnapshotId: state.canonicalSnapshotId,
          generation: state.generation,
          ...(runtimeId ? { replicaId: localReplica?.id ?? null } : {}),
        },
      })}::jsonb`,
      updatedAt: new Date(),
    }).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId)));
    return attemptId;
  });
}

export const submitSessionPrompt = async (
  input: SubmitSessionPromptInput,
  hooks: SubmitSessionPromptHooks = {},
  options: SubmitSessionPromptOptions = {},
): Promise<SubmitSessionPromptResult> => getSessionDomainServices().submitPrompt(input, {
  ...hooks,
  beforeEnqueue: async (hookInput) => {
    await hooks.beforeEnqueue?.(hookInput);
    await allocateCloudWorkspaceAttempt({
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      turnId: hookInput.turnId,
      clientMessageId: input.clientMessageId.trim(),
      userId: input.userId,
      runtimeId: input.runtimeId,
    });
  },
}, options);
