import {
  calculateContextTokens,
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  prepareCompaction,
  shouldCompact,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { logger } from "../logger.js";
import type { SessionHandle } from "../session.js";
import { persistCompactionTurn } from "../persistence.js";
import { refreshSessionHandleFileSignature } from "../session.js";
import { getAgentTracer } from "@cohub/infra/tracing/agent";
import { db } from "../db.js";
import { sessionTurns } from "@cohub/db";
import { and, eq, sql } from "drizzle-orm";
import { getCurrentToolExecutionContext } from "../tool-context.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createModelsFromCohubRegistry } from "./pi-models-adapter.js";

export type CompactionOutcome =
  | { compacted: true; summary: string; tokensBefore: number; firstKeptEntryId: string; archivePath: string | undefined; compactSequence: number }
  | { compacted: false; reason: string };

/** Thrown when overflow recovery cannot free enough context (no empty LLM retry). */
export class OverflowRecoveryError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Context overflow recovery failed: ${reason}`);
    this.name = "OverflowRecoveryError";
    this.reason = reason;
  }
}

// Cap above pi default (16k). Scaled down for small windows so we never
// reserve more than the whole context (which would compact on every turn).
const RESERVE_TOKENS_CAP = 32_768;
const RESERVE_TOKENS_RATIO = 0.25;

/** Resolve reserveTokens for a model context window (exported for tests). */
export function resolveReserveTokens(contextWindow: number): number {
  if (contextWindow <= 0) return RESERVE_TOKENS_CAP;
  return Math.min(RESERVE_TOKENS_CAP, Math.max(1, Math.floor(contextWindow * RESERVE_TOKENS_RATIO)));
}

function resolveCompactionSettings(contextWindow: number) {
  return {
    ...DEFAULT_COMPACTION_SETTINGS,
    enabled: true,
    reserveTokens: resolveReserveTokens(contextWindow),
  };
}

function getAgentMessageTurnId(message: AgentMessage): string | null {
  const meta = (message as unknown as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const turnId = (meta as Record<string, unknown>).turnId;
  return typeof turnId === "string" && turnId.trim() ? turnId.trim() : null;
}

function getContextTokenBudget(messages: AgentMessage[]): { accurateTokens: number; estimatedTokens: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const assistant = message as unknown as AssistantMessage;
    if (assistant.stopReason === "aborted" || assistant.stopReason === "error" || !assistant.usage) continue;
    const accurateTokens = calculateContextTokens(assistant.usage);
    if (accurateTokens <= 0) continue;

    let trailingTokens = 0;
    for (let j = i + 1; j < messages.length; j++) {
      const trailingMessage = messages[j];
      if (trailingMessage) trailingTokens += estimateTokens(trailingMessage);
    }
    return { accurateTokens, estimatedTokens: accurateTokens + trailingTokens };
  }
  return null;
}

function getCompactableBranchEntries(handle: SessionHandle) {
  const branchEntries = handle.sessionManager.getBranchEntries() as Parameters<typeof prepareCompaction>[0];
  const currentTurnId = handle.currentTurnId?.trim();
  if (!currentTurnId) return branchEntries;

  const currentTurnStartIndex = branchEntries.findIndex((entry) => {
    if (entry.type !== "message") return false;
    return getAgentMessageTurnId(entry.message as AgentMessage) === currentTurnId;
  });

  return currentTurnStartIndex >= 0 ? branchEntries.slice(0, currentTurnStartIndex) : branchEntries;
}

/**
 * Check if the session needs auto-compaction and run it if so.
 * Called before LLM requests while the session lock is held.
 *
 * Order of operations (failures are non-destructive):
 *   1. LLM summarization — if fails, nothing is touched
 *   2. Session file: append compaction entry, archive old file, rewrite trimmed
 *   3. Rebuild agent state from compacted context, measure tokensAfter
 *   4. DB persistence (compact turn + system message, re-sequence) with real tokensAfter + archivePath
 *
 * The caller is responsible for returning the rebuilt session context to the
 * current LLM request after compaction. This keeps the active request aligned
 * with the rewritten session file and refreshed agent state.
 */
export async function maybeAutoCompact(
  handle: SessionHandle,
  input: { actorUserId: string | null; abortSignal?: AbortSignal; force?: boolean },
): Promise<CompactionOutcome> {
  const model = handle.session.agent.state.model;
  const contextWindow = model.contextWindow ?? 0;
  if (!contextWindow) return { compacted: false, reason: "no_context_window" };

  const settings = resolveCompactionSettings(contextWindow);
  if (!settings.enabled) return { compacted: false, reason: "disabled" };

  const force = input.force === true;
  const messages = handle.session.agent.state.messages;
  const tokenBudget = getContextTokenBudget(messages);
  if (!force) {
    if (!tokenBudget) return { compacted: false, reason: "no_usage_data" };
    if (!shouldCompact(tokenBudget.estimatedTokens, contextWindow, settings)) {
      return { compacted: false, reason: "below_threshold" };
    }
  }

  const tokensLabel = tokenBudget?.estimatedTokens ?? "unknown";
  logger.info(
    `[Compaction] ${force ? "overflow-compact" : "auto-compact"} triggered sessionId=${handle.sessionId} contextWindow=${contextWindow} reserve=${settings.reserveTokens} tokens=${tokensLabel}`,
  );

  const tracer = getAgentTracer();
  const outcome = await tracer.startActiveSpan("agent.compaction", async (span): Promise<CompactionOutcome> => {
    span.setAttribute("cohub.session_id", handle.sessionId);
    span.setAttribute("agent.context_window", contextWindow);
    span.setAttribute("agent.compaction.force", force);

    try {
      // ── 1. Prepare & summarize ──
      const branchEntries = getCompactableBranchEntries(handle);
      const preparationResult = prepareCompaction(branchEntries, settings);
      if (!preparationResult.ok) {
        span.setAttribute("agent.compaction.error", preparationResult.error.message);
        return { compacted: false, reason: `prepare_failed: ${preparationResult.error.message}` };
      }
      const preparationValue = preparationResult.value;
      if (!preparationValue) {
        return { compacted: false, reason: "nothing_to_compact" };
      }
      const preparation = {
        ...preparationValue,
        tokensBefore: tokenBudget?.accurateTokens ?? preparationValue.tokensBefore,
      };
      if (preparation.messagesToSummarize.length === 0) {
        // Nothing to summarize — the session is too small to benefit from compaction.
        return { compacted: false, reason: "nothing_to_summarize" };
      }

      span.setAttribute("agent.compaction.tokens_before", preparation.tokensBefore);
      span.setAttribute("agent.compaction.messages_to_summarize", preparation.messagesToSummarize.length);

      const apiKey = handle.session.modelRegistry.getApiKey(model.provider);
      if (!apiKey) return { compacted: false, reason: "no_api_key" };

      const models = createModelsFromCohubRegistry(handle.session.modelRegistry, model);
      const compactResult = await compact(
        preparation,
        models,
        model,
        undefined,
        input.abortSignal,
      );
      if (!compactResult.ok) {
        span.setAttribute("agent.compaction.error", compactResult.error.message);
        logger.warn(`[Compaction] summarization failed sessionId=${handle.sessionId}: ${compactResult.error.message}`);
        return { compacted: false, reason: `compact_failed: ${compactResult.error.message}` };
      }
      const result = compactResult.value;

      // ── Adjust cut point to turn boundary ──
      // Pi's findCutPoint may split a turn (firstKeptEntryId = mid-turn message).
      // We snap to the user message that starts the containing turn, so we always
      // keep complete turns. The split-turn prefix is already included in the
      // summary via pi's turnPrefixMessages mechanism.
      let firstKeptEntryId = result.firstKeptEntryId;
      const turnStartEntryId = handle.sessionManager.findTurnStartEntryId(firstKeptEntryId);
      if (turnStartEntryId && turnStartEntryId !== firstKeptEntryId) {
        logger.debug(`[Compaction] snapping cut from ${firstKeptEntryId} to turn start ${turnStartEntryId}`);
        firstKeptEntryId = turnStartEntryId;
      }

      // ── 2. Session file: append compaction entry, archive, rewrite ──
      const compactionEntryId = handle.sessionManager.appendCompaction(
        result.summary,
        firstKeptEntryId,
        result.tokensBefore,
        result.details,
      );

      const archivePath = await handle.sessionManager.archiveAndRewrite(
        compactionEntryId,
        firstKeptEntryId,
      );

      if (!archivePath) {
        // File archive/rewrite failed before rewriting. The compaction entry
        // was appended but is still at the end of entries. removeLastEntry
        // removes it from memory and rewrites the file.
        logger.error(`[Compaction] archiveAndRewrite failed sessionId=${handle.sessionId}, aborting compaction`);
        span.setAttribute("agent.compaction.error", "archive_rewrite_failed");
        handle.sessionManager.removeLastEntry();
        return { compacted: false, reason: "archive_rewrite_failed" };
      }

      // ── 3. Rebuild agent state ──
      // tokensAfter is not computed here — it would be a rough estimate (char/4)
      // that misleads users. The precise value arrives on the next LLM call's
      // usage. We store null and let the UI show only tokensBefore (accurate).
      const sessionContext = handle.sessionManager.buildSessionContext();
      handle.session.agent.state.messages = sessionContext.messages;
      await refreshSessionHandleFileSignature(handle);

      span.setAttribute("agent.compaction.archive_path", archivePath);

      // ── 4. Resolve DB sequence for the first kept turn ──
      // Try the firstKeptEntryId first, then scan forward through kept entries
      // until we find one with a turnId.
      const firstKeptTurnId = handle.sessionManager.getFirstKeptTurnId(firstKeptEntryId);
      let insertBeforeSequence: number | null = null;
      if (firstKeptTurnId) {
        const [turnRow] = await db.select({ sequence: sessionTurns.sequence })
          .from(sessionTurns)
          .where(and(eq(sessionTurns.id, firstKeptTurnId), eq(sessionTurns.sessionId, handle.sessionId)))
          .limit(1);
        insertBeforeSequence = turnRow?.sequence ?? null;
      }
      if (insertBeforeSequence == null) {
        // Cannot resolve the first kept turn's sequence. Append at the end
        // rather than shifting all existing turns.
        logger.warn(`[Compaction] could not resolve firstKeptTurnId sequence; appending compact turn at end`);
        const [maxRow] = await db.select({ max: sql<number>`coalesce(max(${sessionTurns.sequence}), 0)::int` })
          .from(sessionTurns).where(eq(sessionTurns.sessionId, handle.sessionId));
        insertBeforeSequence = (maxRow?.max ?? 0) + 1;
      }

      // ── 5. DB persistence ──
      const dbResult = await persistCompactionTurn({
        spaceId: handle.spaceId,
        sessionId: handle.sessionId,
        actorUserId: input.actorUserId,
        summary: result.summary,
        tokensBefore: result.tokensBefore,
        tokensAfter: null,
        firstKeptEntryId,
        model: { provider: model.provider, id: model.id },
        contextWindow,
        keepRecentTokens: settings.keepRecentTokens,
        summarizedMessageCount: preparation.messagesToSummarize.length,
        archivePath,
        insertBeforeSequence,
      });

      if (!dbResult) {
        // DB failed. archiveAndRewrite already succeeded, so the compaction
        // entry is root (index 0), not last. Use restoreFromArchive to reload
        // the pre-compaction state from the archive copy.
        logger.error(
          `[Compaction] DB persistence failed; restoring session file from archive sessionId=${handle.sessionId}`,
        );
        span.setAttribute("agent.compaction.error", "db_persistence_failed");
        const restored = await handle.sessionManager.restoreFromArchive(archivePath).catch((restoreError) => {
          logger.error(`[Compaction] restoreFromArchive failed sessionId=${handle.sessionId}:`, restoreError);
          return false;
        });
        if (restored) {
          const restoredContext = handle.sessionManager.buildSessionContext();
          handle.session.agent.state.messages = restoredContext.messages;
          await refreshSessionHandleFileSignature(handle);
        }
        return { compacted: false, reason: "db_persistence_failed" };
      }

      if (handle.currentTurnSeq != null && dbResult.compactSequence <= handle.currentTurnSeq) {
        handle.currentTurnSeq += 1;
        if (handle.activeAssistantContext?.turnSeq != null) {
          handle.activeAssistantContext.turnSeq += 1;
        }
      }
      const toolContext = getCurrentToolExecutionContext();
      if (toolContext?.sessionId === handle.sessionId && toolContext.turnSeq != null && dbResult.compactSequence <= toolContext.turnSeq) {
        toolContext.turnSeq += 1;
      }

      logger.info(
        `[Compaction] done sessionId=${handle.sessionId} tokensBefore=${result.tokensBefore} archive=${archivePath}`,
      );

      return {
        compacted: true,
        summary: result.summary,
        tokensBefore: result.tokensBefore,
        firstKeptEntryId,
        archivePath,
        compactSequence: dbResult.compactSequence,
      };
    } catch (error) {
      span.recordException(error as Error);
      logger.error(`[Compaction] unexpected error sessionId=${handle.sessionId}:`, error);
      // If archiveAndRewrite threw after appending compaction entry but before
      // completing the rewrite, its internal rollback restored savedEntries
      // which still contains the compaction entry at the end. Clean it up.
      try {
        handle.sessionManager.removeLastEntry();
      } catch (cleanupError) {
        logger.error(`[Compaction] cleanup removeLastEntry failed sessionId=${handle.sessionId}:`, cleanupError);
      }
      return { compacted: false, reason: `error: ${error instanceof Error ? error.message : String(error)}` };
    }
  });
  return outcome;
}
