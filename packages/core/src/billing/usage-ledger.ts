import { createHash, randomUUID } from "node:crypto";
import {
  COHUB_BILLING_TOKEN_TYPES,
  type BillingOperations,
  type BillingUsageRecordInput,
  type BillingUsageRecordResult,
} from "@cohub/billing";
import {
  billingUsageAttempts,
  billingUsageIntents,
  outboxEvents,
  type BillingUsageAttemptStatus,
} from "@cohub/db";
import type * as schema from "@cohub/db";
import type { BillingUsageDeliveryPayload } from "@cohub/protocol/billing";
import { and, asc, eq, ne } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

type BillingLedgerDb = PostgresJsDatabase<typeof schema>;

export type BillingUsageIntentInput = BillingUsageRecordInput & {
  spaceId?: string | null;
  sessionId?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type EnqueueBillingUsageResult = {
  operationId: string;
  requestHash: string;
  outboxEventId: string;
  status: Exclude<BillingUsageAttemptStatus, "error"> | "queued";
};

export class BillingUsageIntentConflictError extends Error {}
export class BillingUsageIntentNotFoundError extends Error {}

const normalizeIntent = (input: BillingUsageIntentInput) => {
  if (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0) {
    throw new Error("billing usage amountUsd must be a positive finite number");
  }
  const amountUsd = input.amountUsd.toFixed(8);
  const tokenType = input.tokenType ?? COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
  const reason = input.reason?.trim() || null;
  return {
    operationId: input.operationId,
    userId: input.userId,
    tokenType,
    amountUsd,
    usageType: input.usageType,
    sourceId: input.sourceId,
    reason,
    spaceId: input.spaceId ?? null,
    sessionId: input.sessionId ?? null,
    metadata: input.metadata ?? {},
  };
};

export const billingUsageRequestHash = (input: BillingUsageIntentInput) => {
  const intent = normalizeIntent(input);
  return createHash("sha256")
    .update(JSON.stringify({
      operationId: intent.operationId,
      userId: intent.userId,
      tokenType: intent.tokenType,
      amountUsd: intent.amountUsd,
      usageType: intent.usageType,
      sourceId: intent.sourceId,
      reason: intent.reason,
    }))
    .digest("hex");
};

const readDeliveryPayload = (value: unknown): BillingUsageDeliveryPayload | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (payload.schemaVersion !== 1) return null;
  if (typeof payload.operationId !== "string" || typeof payload.requestHash !== "string") return null;
  return {
    schemaVersion: 1,
    operationId: payload.operationId,
    requestHash: payload.requestHash,
  };
};

export async function enqueueBillingUsage(input: {
  db: BillingLedgerDb;
  intent: BillingUsageIntentInput;
}): Promise<EnqueueBillingUsageResult> {
  const normalized = normalizeIntent(input.intent);
  const requestHash = billingUsageRequestHash(input.intent);
  const payload: BillingUsageDeliveryPayload = {
    schemaVersion: 1,
    operationId: normalized.operationId,
    requestHash,
  };
  const deduplicationKey = `billing.usage:${requestHash}`;
  const now = new Date();

  return input.db.transaction(async (tx) => {
    await tx.insert(billingUsageIntents).values({
      ...normalized,
      requestHash,
      createdAt: now,
    }).onConflictDoNothing();

    const [storedIntent] = await tx
      .select({ requestHash: billingUsageIntents.requestHash })
      .from(billingUsageIntents)
      .where(eq(billingUsageIntents.operationId, normalized.operationId))
      .limit(1);
    if (!storedIntent) {
      throw new BillingUsageIntentNotFoundError(`billing usage intent not found: ${normalized.operationId}`);
    }
    if (storedIntent.requestHash !== requestHash) {
      throw new BillingUsageIntentConflictError(
        `billing operationId was already used with a different request: ${normalized.operationId}`,
      );
    }

    await tx.insert(outboxEvents).values({
      id: randomUUID(),
      destination: "billing.usage",
      deduplicationKey,
      aggregateType: "billing_usage_intent",
      aggregateId: normalized.operationId,
      eventType: "billing.usage.requested",
      payload,
      occurredAt: now,
      availableAt: now,
      updatedAt: now,
    }).onConflictDoNothing({ target: outboxEvents.deduplicationKey });

    const [outboxEvent] = await tx
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.deduplicationKey, deduplicationKey))
      .limit(1);
    const storedPayload = readDeliveryPayload(outboxEvent?.payload);
    if (
      outboxEvent?.destination !== "billing.usage"
      || outboxEvent.eventType !== "billing.usage.requested"
      || outboxEvent.aggregateId !== normalized.operationId
      || storedPayload?.operationId !== normalized.operationId
      || storedPayload.requestHash !== requestHash
    ) {
      throw new BillingUsageIntentConflictError(
        `billing outbox key was already used with a different request: ${normalized.operationId}`,
      );
    }

    const [completedAttempt] = await tx
      .select({ status: billingUsageAttempts.status })
      .from(billingUsageAttempts)
      .where(and(
        eq(billingUsageAttempts.operationId, normalized.operationId),
        ne(billingUsageAttempts.status, "error"),
      ))
      .orderBy(asc(billingUsageAttempts.createdAt), asc(billingUsageAttempts.id))
      .limit(1);
    return {
      operationId: normalized.operationId,
      requestHash,
      outboxEventId: outboxEvent.id,
      status: completedAttempt && completedAttempt.status !== "error"
        ? completedAttempt.status
        : "queued",
    };
  });
}

const resultFromAttempt = (
  intent: typeof billingUsageIntents.$inferSelect,
  attempt: typeof billingUsageAttempts.$inferSelect,
): BillingUsageRecordResult => ({
  tokenType: intent.tokenType,
  amountUsd: Number(intent.amountUsd),
  status: attempt.status === "error" ? "skipped" : attempt.status,
  response: attempt.response,
});

export async function deliverBillingUsageIntent(input: {
  db: BillingLedgerDb;
  billing: Pick<BillingOperations, "status" | "recordUsage">;
  payload: unknown;
}): Promise<BillingUsageRecordResult> {
  const payload = readDeliveryPayload(input.payload);
  if (!payload) throw new BillingUsageIntentConflictError("invalid billing usage delivery payload");

  const [intent] = await input.db
    .select()
    .from(billingUsageIntents)
    .where(eq(billingUsageIntents.operationId, payload.operationId))
    .limit(1);
  if (!intent) {
    throw new BillingUsageIntentNotFoundError(`billing usage intent not found: ${payload.operationId}`);
  }
  if (intent.requestHash !== payload.requestHash) {
    throw new BillingUsageIntentConflictError(
      `billing usage delivery hash mismatch: ${payload.operationId}`,
    );
  }

  const [completedAttempt] = await input.db
    .select()
    .from(billingUsageAttempts)
    .where(and(
      eq(billingUsageAttempts.operationId, payload.operationId),
      ne(billingUsageAttempts.status, "error"),
    ))
    .orderBy(asc(billingUsageAttempts.createdAt), asc(billingUsageAttempts.id))
    .limit(1);
  if (completedAttempt) return resultFromAttempt(intent, completedAttempt);

  try {
    const result = await input.billing.recordUsage({
      operationId: intent.operationId,
      userId: intent.userId,
      tokenType: intent.tokenType,
      amountUsd: Number(intent.amountUsd),
      usageType: intent.usageType,
      sourceId: intent.sourceId,
      reason: intent.reason ?? undefined,
    });
    await input.db.insert(billingUsageAttempts).values({
      operationId: intent.operationId,
      provider: input.billing.status.provider,
      status: result.status,
      response: result.response,
    });
    return result;
  } catch (error) {
    await input.db.insert(billingUsageAttempts).values({
      operationId: intent.operationId,
      provider: input.billing.status.provider,
      status: "error",
      errorName: error instanceof Error ? error.name.slice(0, 255) : "Error",
      errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
    });
    throw error;
  }
}
