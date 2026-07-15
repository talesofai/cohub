import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@cohub/db";
import { canvasDocuments, canvasUpdates, outboxEvents, spaces } from "@cohub/db";
import type { CanvasTransactionAppliedEvent } from "@cohub/protocol/realtime";
import { applyCanvasTransaction } from "../canvas-service.js";
import { dispatchNextOutboxEvent } from "./outbox-dispatcher.js";
import { enqueueRealtimeOutboxEvent } from "./outbox.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

const canvasEvent = (id = randomUUID()): CanvasTransactionAppliedEvent => ({
  id,
  timestamp: Date.now(),
  domain: "space",
  type: "canvas.tx.applied",
  spaceId: randomUUID(),
  sessionId: null,
  payload: {
    documentId: randomUUID(),
    actorId: randomUUID(),
    txId: randomUUID(),
    version: 1,
    ops: [],
  },
});

const withDatabase = async <T>(run: (input: {
  database: ReturnType<typeof drizzle<typeof schema>>;
  client: ReturnType<typeof postgres>;
}) => Promise<T>) => {
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
  const client = postgres(databaseUrl, { prepare: false, max: 20 });
  const database = drizzle(client, { schema });
  try {
    return await run({ database, client });
  } finally {
    await client.end();
  }
};

test("outbox insertion rolls back with its domain transaction", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  const event = canvasEvent();
  await withDatabase(async ({ database }) => {
    await assert.rejects(database.transaction(async (tx) => {
      await enqueueRealtimeOutboxEvent(tx, {
        deduplicationKey: `test.rollback:${event.id}`,
        aggregateType: "test",
        aggregateId: event.payload.documentId,
        event,
      });
      throw new Error("rollback");
    }));
    const rows = await database.select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(eq(outboxEvents.id, event.id));
    assert.equal(rows.length, 0);
  });
});

test("canvas commit creates one durable event and txId replay creates none", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  const spaceId = randomUUID();
  const documentId = randomUUID();
  const txId = randomUUID();
  const actorId = randomUUID();
  const deduplicationKey = `canvas.tx.applied:${documentId}:1`;
  await withDatabase(async ({ database }) => {
    try {
      await database.insert(spaces).values({
        id: spaceId,
        userUuid: actorId,
        name: `outbox-${spaceId}`,
        storageRepoName: `outbox-${spaceId}`,
      });
      await database.insert(canvasDocuments).values({
        id: documentId,
        spaceId,
        filePath: `outbox-${documentId}.canvas`,
        title: "Outbox test",
      });

      const input = {
        spaceId,
        documentId,
        actorId,
        txId,
        baseVersion: 0,
        ops: [{
          version: 2 as const,
          type: "document.meta.patch" as const,
          payload: { patch: { tested: true } },
        }],
      };
      const committed = await applyCanvasTransaction(input, database);
      const replayed = await applyCanvasTransaction(input, database);
      assert.equal(committed.transaction.version, 1);
      assert.equal(committed.transaction.replayed, false);
      assert.equal(replayed.transaction.version, 1);
      assert.equal(replayed.transaction.replayed, true);

      const events = await database.select()
        .from(outboxEvents)
        .where(eq(outboxEvents.deduplicationKey, deduplicationKey));
      assert.equal(events.length, 1);
      assert.equal(events[0]?.id, events[0]?.payload.id);
      assert.equal(events[0]?.eventType, "canvas.tx.applied");
      assert.deepEqual(events[0]?.payload.payload, {
        documentId,
        actorId,
        txId,
        version: 1,
        ops: [{
          version: 2,
          type: "document.meta.patch",
          payload: { patch: { tested: true } },
        }],
      });

      const updates = await database.select({ id: canvasUpdates.id })
        .from(canvasUpdates)
        .where(eq(canvasUpdates.documentId, documentId));
      assert.equal(updates.length, 1);
    } finally {
      await database.delete(outboxEvents).where(eq(outboxEvents.aggregateId, documentId));
      await database.delete(spaces).where(eq(spaces.id, spaceId));
    }
  });
});

test("outbox retries preserve the event id and mark delivery after recovery", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  const event = canvasEvent();
  await withDatabase(async ({ database }) => {
    try {
      await database.transaction((tx) => enqueueRealtimeOutboxEvent(tx, {
        deduplicationKey: `test.retry:${event.id}`,
        aggregateType: "test",
        aggregateId: event.payload.documentId,
        event,
      }));

      const attempts: string[] = [];
      const retry = await dispatchNextOutboxEvent({
        database,
        publish: async (payload) => {
          attempts.push(payload.id);
          throw new Error("redis unavailable");
        },
      });
      assert.equal(retry.status, "retry");

      await database.update(outboxEvents)
        .set({ availableAt: new Date(0) })
        .where(eq(outboxEvents.id, event.id));
      const published = await dispatchNextOutboxEvent({
        database,
        publish: async (payload) => {
          attempts.push(payload.id);
        },
      });
      assert.equal(published.status, "published");
      assert.deepEqual(attempts, [event.id, event.id]);

      const [row] = await database.select().from(outboxEvents).where(eq(outboxEvents.id, event.id));
      assert.equal(row?.attemptCount, 2);
      assert.ok(row?.publishedAt);
      assert.equal(row?.failedAt, null);
      assert.equal(row?.lastError, null);
    } finally {
      await database.delete(outboxEvents).where(eq(outboxEvents.id, event.id));
    }
  });
});

test("outbox marks invalid metadata for operator intervention", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  const event = canvasEvent();
  await withDatabase(async ({ database }) => {
    try {
      await database.transaction((tx) => enqueueRealtimeOutboxEvent(tx, {
        deduplicationKey: `test.invalid:${event.id}`,
        aggregateType: "test",
        aggregateId: event.payload.documentId,
        event,
      }));
      await database.update(outboxEvents)
        .set({ eventType: "canvas.tx.invalid" })
        .where(eq(outboxEvents.id, event.id));

      const result = await dispatchNextOutboxEvent({
        database,
        publish: async () => assert.fail("invalid event must not be published"),
      });
      assert.equal(result.status, "failed");
      const [row] = await database.select().from(outboxEvents).where(eq(outboxEvents.id, event.id));
      assert.ok(row?.failedAt);
      assert.match(row?.lastError ?? "", /metadata does not match/);
    } finally {
      await database.delete(outboxEvents).where(eq(outboxEvents.id, event.id));
    }
  });
});

test("outbox publish timeout releases the claim for a retry", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  const event = canvasEvent();
  await withDatabase(async ({ database }) => {
    try {
      await database.transaction((tx) => enqueueRealtimeOutboxEvent(tx, {
        deduplicationKey: `test.timeout:${event.id}`,
        aggregateType: "test",
        aggregateId: event.payload.documentId,
        event,
      }));

      const result = await dispatchNextOutboxEvent({
        database,
        publish: () => new Promise<void>(() => undefined),
        publishTimeoutMs: 10,
      });
      assert.equal(result.status, "retry");
      const [row] = await database.select().from(outboxEvents).where(eq(outboxEvents.id, event.id));
      assert.equal(row?.attemptCount, 1);
      assert.equal(row?.publishedAt, null);
      assert.match(row?.lastError ?? "", /timed out/);
    } finally {
      await database.delete(outboxEvents).where(eq(outboxEvents.id, event.id));
    }
  });
});

test("ordered aggregates do not publish a later sequence during retry backoff", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  const aggregateId = randomUUID();
  const first = canvasEvent();
  const second = canvasEvent();
  first.payload.documentId = aggregateId;
  first.payload.version = 1;
  second.payload.documentId = aggregateId;
  second.payload.version = 2;
  await withDatabase(async ({ database }) => {
    try {
      await database.transaction(async (tx) => {
        await enqueueRealtimeOutboxEvent(tx, {
          deduplicationKey: `test.ordered:${aggregateId}:1`,
          aggregateType: "test",
          aggregateId,
          aggregateSequence: 1,
          event: first,
        });
        await enqueueRealtimeOutboxEvent(tx, {
          deduplicationKey: `test.ordered:${aggregateId}:2`,
          aggregateType: "test",
          aggregateId,
          aggregateSequence: 2,
          event: second,
        });
      });

      const retry = await dispatchNextOutboxEvent({
        database,
        publish: async () => {
          throw new Error("redis unavailable");
        },
      });
      assert.equal(retry.status, "retry");
      const blocked = await dispatchNextOutboxEvent({
        database,
        publish: async () => assert.fail("later sequence must remain blocked"),
      });
      assert.equal(blocked.status, "empty");

      await database.update(outboxEvents)
        .set({ availableAt: new Date(0) })
        .where(eq(outboxEvents.id, first.id));
      const publishedIds: string[] = [];
      const publish = async (event: { id: string }) => {
        publishedIds.push(event.id);
      };
      assert.equal((await dispatchNextOutboxEvent({ database, publish })).status, "published");
      assert.equal((await dispatchNextOutboxEvent({ database, publish })).status, "published");
      assert.deepEqual(publishedIds, [first.id, second.id]);
    } finally {
      await database.delete(outboxEvents).where(eq(outboxEvents.aggregateId, aggregateId));
    }
  });
});

test("concurrent dispatchers claim each outbox row once", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  const events = Array.from({ length: 16 }, () => canvasEvent());
  await withDatabase(async ({ database }) => {
    try {
      await database.transaction(async (tx) => {
        for (const event of events) {
          await enqueueRealtimeOutboxEvent(tx, {
            deduplicationKey: `test.concurrent:${event.id}`,
            aggregateType: "test",
            aggregateId: event.payload.documentId,
            event,
          });
        }
      });

      const published = new Map<string, number>();
      const results = await Promise.all(events.map(() => dispatchNextOutboxEvent({
        database,
        publish: async (event) => {
          published.set(event.id, (published.get(event.id) ?? 0) + 1);
        },
      })));
      assert.equal(results.filter((result) => result.status === "published").length, events.length);
      assert.equal(published.size, events.length);
      assert.deepEqual([...published.values()], Array(events.length).fill(1));
    } finally {
      await database.delete(outboxEvents).where(inArray(outboxEvents.id, events.map((event) => event.id)));
    }
  });
});
