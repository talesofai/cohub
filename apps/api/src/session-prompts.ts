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
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { sessionTurns, spaceWorkspacePolicies, workspaceExecutionAttempts, workspaceState } from "@cohub/db";
import { db } from "./db/index.js";
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

async function allocateCloudWorkspaceAttempt(input: {
  spaceId: string;
  sessionId: string;
  turnId: string;
  clientMessageId: string;
}) {
  return db.transaction(async (tx) => {
    const [state] = await tx.select().from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).for("update").limit(1);
    if (!state) return null;
    const [turn] = await tx.select({ meta: sessionTurns.meta }).from(sessionTurns).where(and(eq(sessionTurns.id, input.turnId), eq(sessionTurns.sessionId, input.sessionId), eq(sessionTurns.executionKind, "agent"))).for("update").limit(1);
    if (!turn) throw new Error("cloud turn not found while allocating workspace attempt");
    const meta = turn.meta && typeof turn.meta === "object" && !Array.isArray(turn.meta) ? turn.meta as Record<string, unknown> : {};
    const existingAttemptId = typeof meta.executionAttemptId === "string" ? meta.executionAttemptId : null;
    if (existingAttemptId) return existingAttemptId;
    const [policy] = await tx.select({ policyVersion: spaceWorkspacePolicies.policyVersion }).from(spaceWorkspacePolicies).where(eq(spaceWorkspacePolicies.spaceId, input.spaceId)).limit(1);
    const attemptId = randomUUID();
    await tx.insert(workspaceExecutionAttempts).values({
      id: attemptId,
      spaceId: input.spaceId,
      idempotencyKey: `cloud-turn:${input.clientMessageId}`,
      executorKind: "cloud_agent",
      workspaceRequired: true,
      transcriptRequired: true,
      sessionId: input.sessionId,
      turnId: input.turnId,
      baseCanonicalSnapshotId: state.canonicalSnapshotId,
      workspacePolicyVersion: policy?.policyVersion ?? null,
      status: "queued",
    });
    await tx.update(sessionTurns).set({
      meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify({
        executionAttemptId: attemptId,
        workspaceExecutionBase: {
          canonicalSnapshotId: state.canonicalSnapshotId,
          generation: state.generation,
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
      clientMessageId: input.clientMessageId,
    });
  },
}, options);
