import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepeatableJob } from "bullmq";
import {
  cronJobQueueSyncStatus,
  cronJobRepeatVersionedId,
  findCronJobQueueEntries,
  indexCronJobQueueEntries,
  isCronJobQueueStateCurrent,
  type CronJobQueueExpectation,
} from "./cron-job-queue-state.js";

const cronJob: CronJobQueueExpectation = {
  id: "cron-id",
  taskType: "send_message",
  cronExpression: "0 9 * * *",
  timezone: "Asia/Shanghai",
  bullJobKey: "cron-cron-id-v2",
  enabled: true,
  deletedAt: null,
  scheduleVersion: 2,
};

const queueEntry: RepeatableJob = {
  key: cronJobRepeatVersionedId(cronJob.id, cronJob.scheduleVersion),
  name: "send_message",
  endDate: null,
  tz: "Asia/Shanghai",
  pattern: "0 9 * * *",
};

test("cron queue state requires one exact live repeat job", () => {
  assert.equal(
    isCronJobQueueStateCurrent(
      cronJob,
      indexCronJobQueueEntries([queueEntry]),
    ),
    true,
  );
  assert.equal(isCronJobQueueStateCurrent(cronJob, indexCronJobQueueEntries([])), false);
  assert.equal(
    isCronJobQueueStateCurrent(
      cronJob,
      indexCronJobQueueEntries([{ ...queueEntry, pattern: "30 9 * * *" }]),
    ),
    false,
  );
  assert.equal(
    isCronJobQueueStateCurrent(
      cronJob,
      indexCronJobQueueEntries([{ ...queueEntry, key: cronJobRepeatVersionedId(cronJob.id, 1) }]),
    ),
    false,
  );
  assert.equal(
    isCronJobQueueStateCurrent(cronJob, indexCronJobQueueEntries([{ ...queueEntry, tz: "UTC" }])),
    false,
  );
  assert.equal(
    isCronJobQueueStateCurrent(
      cronJob,
      indexCronJobQueueEntries([{ ...queueEntry, name: "run_command" }]),
    ),
    false,
  );
  assert.equal(
    isCronJobQueueStateCurrent(
      cronJob,
      indexCronJobQueueEntries([
        queueEntry,
        { ...queueEntry, key: cronJobRepeatVersionedId(cronJob.id, 1) },
      ]),
    ),
    false,
  );
});

test("disabled cron jobs are current only after queue metadata is cleared", () => {
  assert.equal(
    isCronJobQueueStateCurrent(
      { ...cronJob, enabled: false },
      indexCronJobQueueEntries([queueEntry]),
    ),
    false,
  );
  assert.equal(
    isCronJobQueueStateCurrent(
      { ...cronJob, enabled: false, bullJobKey: "" },
      indexCronJobQueueEntries([]),
    ),
    true,
  );
});

test("cron queue entry lookup includes stored and orphaned repeat keys", () => {
  const orphan = { ...queueEntry, key: cronJobRepeatVersionedId(cronJob.id, 1) };
  const unrelated = { ...queueEntry, key: cronJobRepeatVersionedId("other-id", 1) };
  const queueIndex = indexCronJobQueueEntries([queueEntry, orphan, unrelated]);
  assert.deepEqual(
    findCronJobQueueEntries(cronJob, queueIndex),
    [queueEntry, orphan],
  );
});

test("legacy hash-backed repeat jobs are found by their stored key and upgraded", () => {
  const legacyEntry: RepeatableJob = { ...queueEntry, key: "legacy-hash" };
  const legacyCronJob = { ...cronJob, bullJobKey: legacyEntry.key };
  const queueIndex = indexCronJobQueueEntries([legacyEntry]);

  assert.deepEqual(findCronJobQueueEntries(legacyCronJob, queueIndex), [legacyEntry]);
  assert.equal(isCronJobQueueStateCurrent(legacyCronJob, queueIndex), false);
});

test("cron queue sync status reflects the persisted desired version", () => {
  assert.equal(
    cronJobQueueSyncStatus({ scheduleVersion: 3, queueSyncedVersion: 3 }),
    "synced",
  );
  assert.equal(
    cronJobQueueSyncStatus({ scheduleVersion: 3, queueSyncedVersion: 2 }),
    "pending",
  );
});
