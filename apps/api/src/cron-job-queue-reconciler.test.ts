import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepeatableJob } from "bullmq";
import {
  reconcileCronJobQueueRecord,
  type CronJobQueueRecord,
} from "./cron-job-queue-reconciler.js";
import { cronJobRepeatVersionedId } from "./cron-job-queue-state.js";

const baseRecord: CronJobQueueRecord = {
  id: "cron-id",
  taskType: "send_message",
  cronExpression: "0 9 * * *",
  timezone: "Asia/Shanghai",
  bullJobKey: cronJobRepeatVersionedId("cron-id", 1),
  enabled: true,
  deletedAt: null,
  scheduleVersion: 2,
  queueSyncedVersion: 1,
};

const repeatEntry = (record: CronJobQueueRecord, version: number): RepeatableJob => ({
  key: cronJobRepeatVersionedId(record.id, version),
  name: record.taskType,
  endDate: null,
  tz: record.timezone,
  pattern: record.cronExpression,
});

function createHarness(
  initial: CronJobQueueRecord,
  entries: RepeatableJob[] = [],
) {
  let stored = { ...initial };
  const queue = new Map(entries.map((entry) => [entry.key, entry]));
  const removed: string[] = [];
  const scheduled: string[] = [];
  const cleanupFailures: string[] = [];
  const failRemoveOnce = new Set<string>();
  let failSchedule: Error | null = null;
  let afterSchedule: (() => void) | null = null;

  const port = {
    load: async () => ({ ...stored }),
    list: async () => [...queue.values()],
    remove: async (key: string) => {
      removed.push(key);
      if (failRemoveOnce.delete(key)) throw new Error(`remove failed: ${key}`);
      queue.delete(key);
    },
    schedule: async (record: CronJobQueueRecord) => {
      if (failSchedule) throw failSchedule;
      const key = cronJobRepeatVersionedId(record.id, record.scheduleVersion);
      scheduled.push(key);
      queue.set(key, repeatEntry(record, record.scheduleVersion));
      afterSchedule?.();
      return key;
    },
    markSynced: async (record: CronJobQueueRecord, key: string) => {
      if (stored.scheduleVersion !== record.scheduleVersion) return null;
      stored = {
        ...stored,
        bullJobKey: key,
        queueSyncedVersion: record.scheduleVersion,
      };
      return { ...stored };
    },
    createConflictError: () => new Error("cron version conflict"),
    onConflictCleanupFailure: (_error: unknown, key: string) => {
      cleanupFailures.push(key);
    },
  };

  return {
    port,
    queue,
    removed,
    scheduled,
    cleanupFailures,
    failRemoveOnce,
    get stored() {
      return stored;
    },
    set stored(value: CronJobQueueRecord) {
      stored = { ...value };
    },
    set failSchedule(value: Error | null) {
      failSchedule = value;
    },
    set afterSchedule(value: (() => void) | null) {
      afterSchedule = value;
    },
  };
}

test("queue add is compensated when the database version CAS loses", async () => {
  const harness = createHarness(baseRecord, [repeatEntry(baseRecord, 1)]);
  harness.afterSchedule = () => {
    harness.stored = {
      ...harness.stored,
      scheduleVersion: 3,
      queueSyncedVersion: 2,
    };
  };

  await assert.rejects(
    reconcileCronJobQueueRecord(baseRecord.id, harness.port),
    /cron version conflict/,
  );

  assert.deepEqual(harness.removed, [
    cronJobRepeatVersionedId(baseRecord.id, 1),
    cronJobRepeatVersionedId(baseRecord.id, 2),
  ]);
  assert.equal(harness.queue.size, 0);
  assert.equal(harness.stored.queueSyncedVersion, 2);
  assert.equal(harness.stored.scheduleVersion, 3);
});

test("queue failures preserve pending state and a later reconciliation recovers it", async () => {
  const harness = createHarness(baseRecord, [repeatEntry(baseRecord, 1)]);
  const oldKey = cronJobRepeatVersionedId(baseRecord.id, 1);
  harness.failRemoveOnce.add(oldKey);

  await assert.rejects(
    reconcileCronJobQueueRecord(baseRecord.id, harness.port),
    /remove failed/,
  );
  assert.equal(harness.stored.queueSyncedVersion, 1);

  const recovered = await reconcileCronJobQueueRecord(baseRecord.id, harness.port);
  assert.equal(recovered?.queueSyncedVersion, 2);
  assert.equal(recovered?.bullJobKey, cronJobRepeatVersionedId(baseRecord.id, 2));
});

test("queue scheduling failure never advances the persisted sync version", async () => {
  const harness = createHarness({ ...baseRecord, bullJobKey: "" });
  harness.failSchedule = new Error("schedule unavailable");

  await assert.rejects(
    reconcileCronJobQueueRecord(baseRecord.id, harness.port),
    /schedule unavailable/,
  );

  assert.equal(harness.stored.queueSyncedVersion, 1);
  assert.equal(harness.stored.bullJobKey, "");
  assert.equal(harness.queue.size, 0);
});

test("a concurrent delete survives failed conflict cleanup and removes the orphan on retry", async () => {
  const harness = createHarness(baseRecord, [repeatEntry(baseRecord, 1)]);
  const addedKey = cronJobRepeatVersionedId(baseRecord.id, 2);
  harness.failRemoveOnce.add(addedKey);
  harness.afterSchedule = () => {
    harness.afterSchedule = null;
    harness.stored = {
      ...harness.stored,
      enabled: false,
      deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      scheduleVersion: 3,
      queueSyncedVersion: 2,
    };
  };

  await assert.rejects(
    reconcileCronJobQueueRecord(baseRecord.id, harness.port),
    /cron version conflict/,
  );
  assert.equal(harness.queue.has(addedKey), true);
  assert.deepEqual(harness.cleanupFailures, [addedKey]);

  const recovered = await reconcileCronJobQueueRecord(baseRecord.id, harness.port);
  assert.equal(recovered?.enabled, false);
  assert.equal(recovered?.bullJobKey, "");
  assert.equal(recovered?.queueSyncedVersion, 3);
  assert.equal(harness.queue.size, 0);
});

test("verified inactive drift removes every orphaned repeat key", async () => {
  const inactive = {
    ...baseRecord,
    bullJobKey: "",
    enabled: false,
    deletedAt: new Date("2026-01-01T00:00:00.000Z"),
    scheduleVersion: 3,
    queueSyncedVersion: 3,
  };
  const harness = createHarness(inactive, [
    repeatEntry(inactive, 1),
    repeatEntry(inactive, 2),
  ]);

  const recovered = await reconcileCronJobQueueRecord(inactive.id, harness.port, {
    verifyQueueState: true,
  });

  assert.equal(recovered?.bullJobKey, "");
  assert.equal(harness.scheduled.length, 0);
  assert.deepEqual(harness.removed.sort(), [
    cronJobRepeatVersionedId(inactive.id, 1),
    cronJobRepeatVersionedId(inactive.id, 2),
  ]);
});
