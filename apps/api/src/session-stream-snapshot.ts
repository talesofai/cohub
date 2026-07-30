import type { ContentBlock } from "@cohub/protocol/core";
import type { StoredIntermediateMessage } from "@cohub/protocol/model";
import { and, asc, eq, sql } from "drizzle-orm";
import { redisCommandClient } from "./redis.js";
import { db } from "./db/index.js";
import { sessionMessages } from "@cohub/db";
import {
  mergeSessionStreamSnapshotIntermediates,
  resolvePersistedIntermediateOrdinals,
  resolveSnapshotStreamMessageId,
} from "./session-stream-snapshot-merge.js";

export const getSessionStreamSnapshotKey = (spaceId: string, sessionId: string) =>
  `session:stream:snapshot:${spaceId}:${sessionId}`;

export type SessionStreamSnapshotMessage = {
  messageId: string | null;
  messageOrdinal: number | null;
  content: ContentBlock[];
};

export type EnrichedSessionStreamSnapshotMessage = SessionStreamSnapshotMessage & Partial<StoredIntermediateMessage>;

export type SessionStreamSnapshotLifecycle = {
  phase: "llm_call_started";
  llmRound: number;
  provider: string | null;
  model: string | null;
  at: string;
};

export type SessionStreamSnapshot = {
  version: 2;
  spaceId: string;
  sessionId: string;
  turnId: string | null;
  anchorUserMessageId: string | null;
  seq: number;
  current: SessionStreamSnapshotMessage & { appendPath: string | null };
  intermediateMessages: EnrichedSessionStreamSnapshotMessage[];
  lifecycle?: SessionStreamSnapshotLifecycle | null;
  updatedAt: number;
};

const isSnapshotMessage = (value: unknown, current = false): value is SessionStreamSnapshot["current"] => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.content)) return false;
  if (record.messageId !== null && typeof record.messageId !== "string") return false;
  if (record.messageOrdinal !== null && typeof record.messageOrdinal !== "number") return false;
  if (current && record.appendPath !== null && typeof record.appendPath !== "string") return false;
  return true;
};

const isSnapshotLifecycle = (value: unknown): value is SessionStreamSnapshotLifecycle => {
  if (value == null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.phase === "llm_call_started" &&
    typeof record.llmRound === "number" &&
    Number.isInteger(record.llmRound) &&
    record.llmRound > 0 &&
    (record.provider === null || typeof record.provider === "string") &&
    (record.model === null || typeof record.model === "string") &&
    typeof record.at === "string";
};

export const parseSessionStreamSnapshot = (raw: string | null): SessionStreamSnapshot | null => {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SessionStreamSnapshot>;
    if (value.version !== 2) return null;
    if (!value.spaceId || !value.sessionId) return null;
    if (typeof value.seq !== "number" || value.seq < 0) return null;
    if (!isSnapshotMessage(value.current, true)) return null;
    if (!Array.isArray(value.intermediateMessages) || !value.intermediateMessages.every((message) => isSnapshotMessage(message))) return null;
    if (!isSnapshotLifecycle(value.lifecycle)) return null;
    return value as SessionStreamSnapshot;
  } catch {
    return null;
  }
};

const toIso = (value: Date | string | null | undefined) =>
  value instanceof Date ? value.toISOString() : typeof value === "string" ? value : new Date().toISOString();

const normalizeRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const toSnapshotIntermediateMessage = (
  row: typeof sessionMessages.$inferSelect,
  input: { messageOrdinal: number | null; turnId: string },
): EnrichedSessionStreamSnapshotMessage => {
  const meta = normalizeRecord(row.meta);
  const isCompaction = meta?.messageKind === "compacted";
  const messageOrdinal = row.role === "assistant" ? input.messageOrdinal : null;
  return {
    messageId: isCompaction || messageOrdinal == null ? row.id : resolveSnapshotStreamMessageId({
      sessionId: row.sessionId,
      turnId: input.turnId,
      messageOrdinal,
    }),
    messageOrdinal,
    id: row.id,
    sessionId: row.sessionId,
    sequence: row.sequence,
    role: row.role as "user" | "assistant" | "system",
    content: row.content as ContentBlock[],
    text: row.text ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    stopReason: row.stopReason ?? null,
    errorMessage: row.errorMessage ?? null,
    usage: row.usage as StoredIntermediateMessage["usage"],
    toolCallsObjectKey: null,
    meta,
    createdAt: toIso(row.createdAt),
  };
};

const listPersistedIntermediateMessages = async (input: { sessionId: string; turnId: string }) => {
  const rows = await db.select().from(sessionMessages).where(and(
    eq(sessionMessages.sessionId, input.sessionId),
    sql`${sessionMessages.role} <> 'user'`,
    sql`${sessionMessages.meta}->>'turnId' = ${input.turnId}`,
    sql`coalesce(${sessionMessages.meta}->>'messageKind', '') not in ('assistant_final', 'assistant_error')`,
  )).orderBy(asc(sessionMessages.sequence), asc(sessionMessages.createdAt));
  const ordinals = resolvePersistedIntermediateOrdinals(rows);
  return rows.map((row, index) => toSnapshotIntermediateMessage(row, {
    messageOrdinal: ordinals[index] ?? null,
    turnId: input.turnId,
  }));
};

const enrichSessionStreamSnapshot = async (snapshot: SessionStreamSnapshot): Promise<SessionStreamSnapshot> => {
  if (!snapshot.turnId) return snapshot;
  const persisted = await listPersistedIntermediateMessages({ sessionId: snapshot.sessionId, turnId: snapshot.turnId }).catch(() => []);

  return {
    ...snapshot,
    intermediateMessages: mergeSessionStreamSnapshotIntermediates(
      snapshot.intermediateMessages,
      persisted,
    ),
  };
};

export const getSessionStreamSnapshot = async (input: { spaceId: string; sessionId: string }) => {
  const snapshot = parseSessionStreamSnapshot(
    await redisCommandClient.get(getSessionStreamSnapshotKey(input.spaceId, input.sessionId)).catch(() => null),
  );
  if (!snapshot) return null;
  if (snapshot.spaceId !== input.spaceId || snapshot.sessionId !== input.sessionId) return null;
  return enrichSessionStreamSnapshot(snapshot);
};

export const clearSessionStreamSnapshot = async (input: { spaceId: string; sessionId: string }) => {
  await redisCommandClient.del(getSessionStreamSnapshotKey(input.spaceId, input.sessionId)).catch(() => undefined);
};
