import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { COHUB_BILLING_TOKEN_TYPES, COHUB_BILLING_USAGE_TYPES } from "@cohub/billing";
import * as schema from "@cohub/db";
import { billingUsageAttempts, billingUsageIntents, outboxEvents } from "@cohub/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  BillingUsageIntentConflictError,
  billingUsageRequestHash,
  deliverBillingUsageIntent,
  enqueueBillingUsage,
  type BillingUsageIntentInput,
} from "./usage-ledger.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

const hasSqlState = (error: unknown, code: string) => {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

const usageIntent = (operationId = `test:${randomUUID()}`): BillingUsageIntentInput => ({
  operationId,
  userId: `user-${randomUUID()}`,
  tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
  amountUsd: 1.25,
  usageType: COHUB_BILLING_USAGE_TYPES.generationLlm,
  sourceId: randomUUID(),
  reason: "Ledger integration test",
  spaceId: randomUUID(),
  sessionId: randomUUID(),
  metadata: { model: "test-model", nested: { value: 1 } },
});

test("billing request hash covers charge fields but not audit metadata", () => {
  const intent = usageIntent();
  assert.equal(
    billingUsageRequestHash(intent),
    billingUsageRequestHash({ ...intent, metadata: { other: true }, spaceId: null }),
  );
  assert.notEqual(
    billingUsageRequestHash(intent),
    billingUsageRequestHash({ ...intent, amountUsd: intent.amountUsd + 0.01 }),
  );
});

test("billing ledger is idempotent, append-only, and caches terminal delivery", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  if (!databaseUrl) return;
  const client = postgres(databaseUrl, { prepare: false, max: 12 });
  const database = drizzle(client, { schema });
  const intent = usageIntent();
  try {
    const queued = await Promise.all(Array.from({ length: 8 }, () => enqueueBillingUsage({
      db: database,
      intent,
    })));
    assert.deepEqual(new Set(queued.map((result) => result.outboxEventId)).size, 1);
    assert.deepEqual(new Set(queued.map((result) => result.requestHash)).size, 1);
    assert.ok(queued.every((result) => result.status === "queued"));

    const intentRows = await database.select()
      .from(billingUsageIntents)
      .where(eq(billingUsageIntents.operationId, intent.operationId));
    const outboxRows = await database.select()
      .from(outboxEvents)
      .where(and(
        eq(outboxEvents.destination, "billing.usage"),
        eq(outboxEvents.aggregateId, intent.operationId),
      ));
    assert.equal(intentRows.length, 1);
    assert.equal(outboxRows.length, 1);

    await assert.rejects(
      enqueueBillingUsage({
        db: database,
        intent: { ...intent, amountUsd: intent.amountUsd + 1 },
      }),
      BillingUsageIntentConflictError,
    );

    let providerCalls = 0;
    const billing = {
      status: { provider: "talesofai" as const, configured: true },
      recordUsage: async () => {
        providerCalls += 1;
        if (providerCalls === 1) throw new Error("provider unavailable");
        return {
          tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
          amountUsd: intent.amountUsd,
          status: "recorded" as const,
          response: { transactionId: "transaction-1" },
        };
      },
    };
    const payload = outboxRows[0]?.payload;
    await assert.rejects(
      deliverBillingUsageIntent({ db: database, billing, payload }),
      /provider unavailable/,
    );
    const delivered = await deliverBillingUsageIntent({ db: database, billing, payload });
    const replayed = await deliverBillingUsageIntent({ db: database, billing, payload });
    assert.equal(delivered.status, "recorded");
    assert.equal(replayed.status, "recorded");
    assert.equal(providerCalls, 2);

    const attempts = await database.select()
      .from(billingUsageAttempts)
      .where(eq(billingUsageAttempts.operationId, intent.operationId))
      .orderBy(asc(billingUsageAttempts.createdAt), asc(billingUsageAttempts.id));
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["error", "recorded"]);
    assert.match(attempts[0]?.errorMessage ?? "", /provider unavailable/);
    assert.deepEqual(attempts[1]?.response, { transactionId: "transaction-1" });

    await assert.rejects(
      database.update(billingUsageIntents)
        .set({ reason: "mutated" })
        .where(eq(billingUsageIntents.operationId, intent.operationId)),
      (error: unknown) => hasSqlState(error, "55000"),
    );
    await assert.rejects(
      database.delete(billingUsageAttempts)
        .where(eq(billingUsageAttempts.operationId, intent.operationId)),
      (error: unknown) => hasSqlState(error, "55000"),
    );
    await assert.rejects(
      database.execute(sql`TRUNCATE TABLE ${billingUsageAttempts}, ${billingUsageIntents}`),
      (error: unknown) => hasSqlState(error, "55000"),
    );
  } finally {
    await client.end();
  }
});
