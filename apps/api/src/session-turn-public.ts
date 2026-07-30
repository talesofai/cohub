import { sanitizePromptMetaForClient } from "@cohub/core/sessions";
import type { SessionTurnRecord } from "@cohub/protocol/model";
import type { RealtimeTurnRecord } from "@cohub/protocol/realtime";

export const toRealtimeTurnRecord = (
  turn: SessionTurnRecord,
): RealtimeTurnRecord => ({
  id: turn.id,
  sessionId: turn.sessionId,
  sequence: turn.sequence,
  status: turn.status,
  intent: turn.intent,
  userUuid: turn.userUuid,
  authorProfile: turn.authorProfile,
  userContent: turn.userContent,
  userText: turn.userText,
  assistantContent: turn.assistantContent,
  assistantText: turn.assistantText,
  provider: turn.provider,
  model: turn.model,
  stopReason: turn.stopReason,
  errorMessage: turn.errorMessage,
  finalUsage: turn.finalUsage,
  totalUsage: turn.totalUsage,
  summary: turn.summary,
  intermediateIndex: turn.intermediateIndex,
  intermediateSummary: turn.intermediateSummary,
  meta: sanitizePromptMetaForClient(turn.meta),
  thinkingLevel: turn.thinkingLevel ?? null,
  startedAt: turn.startedAt,
  completedAt: turn.completedAt,
  durationMs: turn.durationMs,
  createdAt: turn.createdAt,
  updatedAt: turn.updatedAt,
});
