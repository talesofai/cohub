import { and, eq, gt } from "drizzle-orm";
import { sessionTurns, spaceSessions } from "@cohub/db";
import { createLogger } from "@cohub/infra/logging";
import { db } from "./db/index.js";
import { enqueueAgentTurnJob } from "./agent-turn-queue.js";

const logger = createLogger({ serviceName: "cohub-api" });
const DEFAULT_BATCH_SIZE = 100;

type QueuedSession = { sessionId: string; spaceId: string };

type ReconcilerDependencies = {
  listQueuedSessions(input: { afterSessionId: string | null; limit: number }): Promise<QueuedSession[]>;
  enqueue(input: QueuedSession): Promise<unknown>;
};

const defaultDependencies: ReconcilerDependencies = {
  listQueuedSessions: ({ afterSessionId, limit }) => db.select({
    sessionId: sessionTurns.sessionId,
    spaceId: spaceSessions.spaceId,
  }).from(sessionTurns).innerJoin(
    spaceSessions,
    eq(spaceSessions.id, sessionTurns.sessionId),
  ).where(and(
    eq(sessionTurns.status, "queued"),
    afterSessionId ? gt(sessionTurns.sessionId, afterSessionId) : undefined,
  )).groupBy(
    sessionTurns.sessionId,
    spaceSessions.spaceId,
  ).orderBy(sessionTurns.sessionId).limit(limit),
  enqueue: ({ sessionId, spaceId }) => enqueueAgentTurnJob({
    spaceId,
    sessionId,
    reason: "recovery",
  }),
};

export async function reconcileQueuedSessionTurnBatch(
  input: { afterSessionId?: string | null; limit?: number } = {},
  dependencies: ReconcilerDependencies = defaultDependencies,
) {
  const limit = input.limit ?? DEFAULT_BATCH_SIZE;
  const rows = await dependencies.listQueuedSessions({
    afterSessionId: input.afterSessionId ?? null,
    limit,
  });
  const results = await Promise.allSettled(rows.map((row) => dependencies.enqueue(row)));
  return {
    scanned: rows.length,
    failed: results.filter((result) => result.status === "rejected").length,
    nextCursor: rows.length === limit ? rows.at(-1)?.sessionId ?? null : null,
  };
}

export function startSessionTurnQueueReconciler(intervalMs = 30_000) {
  let cursor: string | null = null;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await reconcileQueuedSessionTurnBatch({ afterSessionId: cursor });
      cursor = result.nextCursor;
      if (result.failed > 0) {
        logger.warn(`[SessionTurnQueue] failed to enqueue ${result.failed}/${result.scanned} queued sessions`);
      }
    } catch (error) {
      logger.warn("[SessionTurnQueue] reconciliation failed", error);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
