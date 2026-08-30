import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { sessionRealtimeOutbox } from "@cohub/db";
import type { RealtimeEnvelope } from "@cohub/protocol/realtime";
import { db } from "./db.js";
import { logger } from "./logger.js";
import { publishPersistedRealtimeEnvelope } from "./redis.js";

const toEnvelope = (row: typeof sessionRealtimeOutbox.$inferSelect): RealtimeEnvelope => {
  const stored = row.envelope as Record<string, unknown>;
  return {
    id: typeof stored.id === "string" && stored.id ? stored.id : row.id,
    timestamp: typeof stored.timestamp === "number" ? stored.timestamp : row.createdAt.getTime(),
    domain: typeof stored.domain === "string" ? stored.domain as RealtimeEnvelope["domain"] : "session",
    type: typeof stored.type === "string" && stored.type ? stored.type : row.eventType,
    requestId: typeof stored.requestId === "string" ? stored.requestId : null,
    spaceId: row.spaceId,
    sessionId: row.sessionId,
    payload: stored.payload && typeof stored.payload === "object" && !Array.isArray(stored.payload)
      ? stored.payload as Record<string, unknown>
      : {},
  };
};

export async function dispatchSessionRealtimeOutbox(limit = 100) {
  const current = new Date();
  const candidates = await db.select().from(sessionRealtimeOutbox).where(and(
    inArray(sessionRealtimeOutbox.status, ["ready", "failed"]),
    or(isNull(sessionRealtimeOutbox.nextAttemptAt), lte(sessionRealtimeOutbox.nextAttemptAt, current)),
  )).orderBy(asc(sessionRealtimeOutbox.sessionId), asc(sessionRealtimeOutbox.revision), asc(sessionRealtimeOutbox.createdAt)).limit(limit);

  let published = 0;
  for (const candidate of candidates) {
    const [claimed] = await db.update(sessionRealtimeOutbox).set({
      status: "publishing",
      attemptCount: candidate.attemptCount + 1,
      updatedAt: new Date(),
    }).where(and(
      eq(sessionRealtimeOutbox.id, candidate.id),
      inArray(sessionRealtimeOutbox.status, ["ready", "failed"]),
    )).returning();
    if (!claimed) continue;
    try {
      await publishPersistedRealtimeEnvelope(toEnvelope(claimed));
      await db.update(sessionRealtimeOutbox).set({
        status: "published",
        publishedAt: new Date(),
        nextAttemptAt: null,
        updatedAt: new Date(),
      }).where(and(eq(sessionRealtimeOutbox.id, claimed.id), eq(sessionRealtimeOutbox.status, "publishing")));
      published += 1;
    } catch (error) {
      const delayMs = Math.min(60_000, 1000 * 2 ** Math.min(claimed.attemptCount, 6));
      await db.update(sessionRealtimeOutbox).set({
        status: "failed",
        nextAttemptAt: new Date(Date.now() + delayMs),
        updatedAt: new Date(),
      }).where(and(eq(sessionRealtimeOutbox.id, claimed.id), eq(sessionRealtimeOutbox.status, "publishing")));
      logger.warn("[RealtimeOutbox] publish failed", { outboxId: claimed.id, error });
    }
  }
  return { claimed: candidates.length, published };
}

export async function cleanupPublishedSessionRealtimeOutbox(olderThan: Date, limit = 1_000) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("outbox cleanup limit must be a positive integer");
  const rows = await db.execute(sql`
    with candidates as (
      select id
      from v2.session_realtime_outbox
      where status = 'published' and published_at <= ${olderThan}
      order by published_at asc
      limit ${limit}
    )
    delete from v2.session_realtime_outbox outbox
    using candidates
    where outbox.id = candidates.id
    returning outbox.id
  `);
  return rows.length;
}

export async function recoverStaleSessionRealtimeOutbox() {
  const staleBefore = new Date(Date.now() - 60_000);
  const rows = await db.update(sessionRealtimeOutbox).set({
    status: "ready",
    nextAttemptAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(sessionRealtimeOutbox.status, "publishing"),
    lte(sessionRealtimeOutbox.updatedAt, staleBefore),
  )).returning({ id: sessionRealtimeOutbox.id });
  return rows.length;
}
