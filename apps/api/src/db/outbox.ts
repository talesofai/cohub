import type { RealtimeOutboxEnvelope } from "@cohub/db";
import { outboxEvents } from "@cohub/db";
import type { db } from "./index.js";

type OutboxTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function enqueueRealtimeOutboxEvent(
  tx: OutboxTransaction,
  input: {
    deduplicationKey: string;
    aggregateType: string;
    aggregateId: string;
    aggregateSequence?: number | null;
    event: RealtimeOutboxEnvelope;
  },
) {
  const occurredAt = new Date(input.event.timestamp);
  await tx.insert(outboxEvents).values({
    id: input.event.id,
    destination: "realtime",
    deduplicationKey: input.deduplicationKey,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateSequence: input.aggregateSequence ?? null,
    eventType: input.event.type,
    payload: input.event,
    occurredAt,
    availableAt: occurredAt,
    updatedAt: occurredAt,
  });
  return input.event;
}
