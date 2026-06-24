import type { ContentBlock } from "@cohub/protocol/core";
import type { StoredIntermediateMessage } from "@cohub/protocol/model";
import { and, asc, eq, sql } from "drizzle-orm";
import { redisCommandClient } from "./redis.js";
import { db } from "./db/index.js";
import { sessionMessages } from "@cohub/db";

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

const toSnapshotIntermediateMessage = (row: typeof sessionMessages.$inferSelect, messageOrdinal: number): EnrichedSessionStreamSnapshotMessage => ({
  messageId: row.id,
  messageOrdinal,
  id: row.id,
  sessionId: row.sessionId,
  role: row.role as "user" | "assistant" | "system",
  content: row.content as ContentBlock[],
  text: row.text ?? null,
  provider: row.provider ?? null,
  model: row.model ?? null,
  stopReason: row.stopReason ?? null,
  errorMessage: row.errorMessage ?? null,
  usage: row.usage as StoredIntermediateMessage["usage"],
  toolCallsObjectKey: null,
  meta: normalizeRecord(row.meta),
  createdAt: toIso(row.createdAt),
});

const getSnapshotMessageKey = (message: Pick<EnrichedSessionStreamSnapshotMessage, "messageId" | "messageOrdinal">) => {
  if (message.messageId) return `id:${message.messageId}`;
  if (message.messageOrdinal != null) return `ordinal:${message.messageOrdinal}`;
  return null;
};

const mergeSnapshotMessage = (
  snapshotMessage: EnrichedSessionStreamSnapshotMessage,
  persistedMessage: EnrichedSessionStreamSnapshotMessage,
): EnrichedSessionStreamSnapshotMessage => ({
  ...snapshotMessage,
  ...persistedMessage,
  messageId: snapshotMessage.messageId ?? persistedMessage.messageId,
  messageOrdinal: snapshotMessage.messageOrdinal ?? persistedMessage.messageOrdinal,
  content: persistedMessage.content,
});

const listPersistedIntermediateMessages = async (input: { sessionId: string; turnId: string }) => {
  const rows = await db.select().from(sessionMessages).where(and(
    eq(sessionMessages.sessionId, input.sessionId),
    eq(sessionMessages.role, "assistant"),
    sql`${sessionMessages.meta}->>'turnId' = ${input.turnId}`,
    sql`coalesce(${sessionMessages.meta}->>'messageKind', '') not in ('assistant_final', 'assistant_error')`,
  )).orderBy(asc(sessionMessages.sequence), asc(sessionMessages.createdAt));
  return rows.map(toSnapshotIntermediateMessage);
};

const enrichSessionStreamSnapshot = async (snapshot: SessionStreamSnapshot): Promise<SessionStreamSnapshot> => {
  if (!snapshot.turnId) return snapshot;
  const persisted = await listPersistedIntermediateMessages({ sessionId: snapshot.sessionId, turnId: snapshot.turnId }).catch(() => []);
  if (persisted.length === 0) return snapshot;

  const persistedByKey = new Map(
    persisted
      .map((message) => [getSnapshotMessageKey(message), message] as const)
      .filter((entry): entry is [string, EnrichedSessionStreamSnapshotMessage] => Boolean(entry[0])),
  );
  const usedPersisted = new Set<EnrichedSessionStreamSnapshotMessage>();
  const merged = snapshot.intermediateMessages.map((message, index) => {
    const key = getSnapshotMessageKey(message);
    const persistedMessage = (key ? persistedByKey.get(key) : undefined) ?? persisted[index];
    if (!persistedMessage) return message;
    usedPersisted.add(persistedMessage);
    return mergeSnapshotMessage(message, persistedMessage);
  });
  for (const message of persisted) {
    if (!usedPersisted.has(message)) merged.push(message);
  }
  return { ...snapshot, intermediateMessages: merged };
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
