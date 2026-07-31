import assert from "node:assert/strict";
import { test } from "node:test";
import type { RepeatableJob } from "bullmq";
import {
  findCronJobQueueEntries,
  isCronJobQueueStateCurrent,
  type CronJobQueueExpectation,
} from "./cron-job-queue-state.js";

const cronJob: CronJobQueueExpectation = {
  id: "cron-id",
  taskType: "send_message",
  cronExpression: "0 9 * * *",
  timezone: "Asia/Shanghai",
  bullJobKey: "repeat-key",
  enabled: true,
  deletedAt: null,
};

const queueEntry: RepeatableJob = {
  key: "repeat-key",
  name: "send_message",
  id: "cron-cron-id",
  endDate: null,
  tz: "Asia/Shanghai",
  pattern: "0 9 * * *",
};

test("cron queue state requires one exact live repeat job", () => {
  assert.equal(isCronJobQueueStateCurrent(cronJob, [queueEntry]), true);
  assert.equal(isCronJobQueueStateCurrent(cronJob, []), false);
  assert.equal(isCronJobQueueStateCurrent(cronJob, [{ ...queueEntry, pattern: "30 9 * * *" }]), false);
  assert.equal(isCronJobQueueStateCurrent(cronJob, [{ ...queueEntry, tz: "UTC" }]), false);
  assert.equal(isCronJobQueueStateCurrent(cronJob, [{ ...queueEntry, name: "run_command" }]), false);
  assert.equal(
    isCronJobQueueStateCurrent(cronJob, [queueEntry, { ...queueEntry, key: "orphan-key" }]),
    false,
  );
});

test("disabled cron jobs are current only after queue metadata is cleared", () => {
  assert.equal(isCronJobQueueStateCurrent({ ...cronJob, enabled: false }, [queueEntry]), false);
  assert.equal(
    isCronJobQueueStateCurrent({ ...cronJob, enabled: false, bullJobKey: "" }, []),
    true,
  );
});

test("cron queue entry lookup includes stored and orphaned repeat keys", () => {
  const orphan = { ...queueEntry, key: "orphan-key" };
  const unrelated = { ...queueEntry, key: "other-key", id: "cron-other-id" };
  assert.deepEqual(findCronJobQueueEntries(cronJob, [queueEntry, orphan, unrelated]), [queueEntry, orphan]);
});
