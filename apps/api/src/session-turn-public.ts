import type { SessionTurnRecord } from "@cohub/protocol/model";
import type { RealtimeTurnRecord } from "@cohub/protocol/realtime";

export function sanitizeSessionTurnMetaForClient(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const meta = value as Record<string, unknown>;
  if (!Object.hasOwn(meta, "systemInstructions")) return meta;

  const publicMeta = { ...meta };
  delete publicMeta.systemInstructions;
  return Object.keys(publicMeta).length > 0 ? publicMeta : null;
}

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
  meta: sanitizeSessionTurnMetaForClient(turn.meta),
  thinkingLevel: turn.thinkingLevel ?? null,
  startedAt: turn.startedAt,
  completedAt: turn.completedAt,
  durationMs: turn.durationMs,
  createdAt: turn.createdAt,
  updatedAt: turn.updatedAt,
});
