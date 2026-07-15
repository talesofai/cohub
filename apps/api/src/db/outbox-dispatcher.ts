import { and, asc, eq, isNotNull, isNull, lt, lte, notExists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { outboxEvents, type RealtimeOutboxEnvelope } from "@cohub/db";
import { createLogger } from "@cohub/infra/logging";
import { realtimeEnvelopeSchema } from "@cohub/protocol/realtime";
import { db } from "./index.js";

const logger = createLogger({ serviceName: "cohub-api" });
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_ERROR_LENGTH = 4000;

type OutboxDatabase = Pick<typeof db, "transaction">;
export type OutboxPublisher = (event: RealtimeOutboxEnvelope) => Promise<void>;

export type OutboxDispatchResult =
  | { status: "empty" }
  | { status: "published" | "retry" | "failed"; eventId: string; attemptCount: number };

class PermanentOutboxError extends Error {}

const retryDelayMs = (attemptCount: number) =>
  Math.min(1000 * (2 ** Math.min(Math.max(attemptCount - 1, 0), 18)), MAX_RETRY_DELAY_MS);

const errorMessage = (error: unknown) => {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return value.slice(0, MAX_ERROR_LENGTH);
};

const publishWithTimeout = async (
  publish: OutboxPublisher,
  event: RealtimeOutboxEnvelope,
  timeoutMs: number,
) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      publish(event),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`outbox publish timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export async function dispatchNextOutboxEvent(input: {
  publish: OutboxPublisher;
  database?: OutboxDatabase;
  now?: () => Date;
  publishTimeoutMs?: number;
}): Promise<OutboxDispatchResult> {
  const database = input.database ?? db;
  const now = input.now ?? (() => new Date());
  const publishTimeoutMs = input.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;

  return database.transaction(async (tx) => {
    const claimedAt = now();
    const earlierEvent = alias(outboxEvents, "earlier_outbox_event");
    const [event] = await tx
      .select()
      .from(outboxEvents)
      .where(and(
        isNull(outboxEvents.publishedAt),
        isNull(outboxEvents.failedAt),
        lte(outboxEvents.availableAt, claimedAt),
        or(
          isNull(outboxEvents.aggregateSequence),
          notExists(
            tx
              .select({ id: earlierEvent.id })
              .from(earlierEvent)
              .where(and(
                eq(earlierEvent.destination, outboxEvents.destination),
                eq(earlierEvent.aggregateType, outboxEvents.aggregateType),
                eq(earlierEvent.aggregateId, outboxEvents.aggregateId),
                isNotNull(earlierEvent.aggregateSequence),
                lt(earlierEvent.aggregateSequence, outboxEvents.aggregateSequence),
                isNull(earlierEvent.publishedAt),
              )),
          ),
        ),
      ))
      .orderBy(asc(outboxEvents.availableAt), asc(outboxEvents.occurredAt), asc(outboxEvents.id))
      .for("update", { skipLocked: true })
      .limit(1);
    if (!event) return { status: "empty" };

    const attemptCount = event.attemptCount + 1;
    try {
      if (event.destination !== "realtime") {
        throw new PermanentOutboxError(`unsupported destination: ${event.destination}`);
      }
      const parsed = realtimeEnvelopeSchema.safeParse(event.payload);
      if (!parsed.success) {
        throw new PermanentOutboxError(`invalid realtime envelope: ${parsed.error.message}`);
      }
      if (parsed.data.id !== event.id || parsed.data.type !== event.eventType) {
        throw new PermanentOutboxError("outbox metadata does not match its payload");
      }

      await publishWithTimeout(input.publish, event.payload, publishTimeoutMs);
      const publishedAt = now();
      await tx
        .update(outboxEvents)
        .set({
          attemptCount,
          publishedAt,
          lastError: null,
          updatedAt: publishedAt,
        })
        .where(eq(outboxEvents.id, event.id));
      return { status: "published", eventId: event.id, attemptCount };
    } catch (error) {
      const failedAt = error instanceof PermanentOutboxError ? now() : null;
      const availableAt = failedAt
        ? event.availableAt
        : new Date(claimedAt.getTime() + retryDelayMs(attemptCount));
      await tx
        .update(outboxEvents)
        .set({
          attemptCount,
          availableAt,
          failedAt,
          lastError: errorMessage(error),
          updatedAt: now(),
        })
        .where(eq(outboxEvents.id, event.id));
      return {
        status: failedAt ? "failed" : "retry",
        eventId: event.id,
        attemptCount,
      };
    }
  });
}

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function startOutboxDispatcher(input: {
  publish: OutboxPublisher;
  pollIntervalMs?: number;
  batchSize?: number;
  publishTimeoutMs?: number;
}) {
  const pollIntervalMs = input.pollIntervalMs
    ?? positiveInteger(process.env.OUTBOX_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS);
  const batchSize = input.batchSize
    ?? positiveInteger(process.env.OUTBOX_BATCH_SIZE, DEFAULT_BATCH_SIZE);
  const publishTimeoutMs = input.publishTimeoutMs
    ?? positiveInteger(process.env.OUTBOX_PUBLISH_TIMEOUT_MS, DEFAULT_PUBLISH_TIMEOUT_MS);
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const drain = () => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      for (let index = 0; index < batchSize && !stopped; index += 1) {
        const result = await dispatchNextOutboxEvent({
          publish: input.publish,
          publishTimeoutMs,
        });
        if (result.status === "empty") break;
        if (result.status === "retry") {
          logger.warn("[Outbox] realtime delivery deferred", result);
        } else if (result.status === "failed") {
          logger.error("[Outbox] event requires operator intervention", result);
        }
      }
    })()
      .catch((error) => logger.error("[Outbox] dispatcher iteration failed", error))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const timer = setInterval(() => {
    void drain();
  }, pollIntervalMs);
  timer.unref();
  void drain();

  return {
    drain,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
