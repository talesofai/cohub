import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getCronJobSkipReason,
  type CronJobExecutionState,
} from "../src/tasks/cron-job-execution.js";

const current: CronJobExecutionState = {
  enabled: true,
  deletedAt: null,
  bullJobKey: "repeat:current",
  scheduleVersion: 3,
  queueSyncedVersion: 3,
};

test("cron execution accepts only the current committed schedule version", () => {
  assert.equal(getCronJobSkipReason({ payloadVersion: 3, repeatJobKey: "repeat:current", current }), null);
  assert.equal(
    getCronJobSkipReason({ payloadVersion: 2, repeatJobKey: "repeat:old", current }),
    "stale_cron_schedule",
  );
  assert.equal(
    getCronJobSkipReason({ payloadVersion: 4, repeatJobKey: "repeat:future", current }),
    "stale_cron_schedule",
  );
});

test("legacy repeats run only while their queue key is the synchronized desired state", () => {
  assert.equal(getCronJobSkipReason({ payloadVersion: undefined, repeatJobKey: "repeat:current", current }), null);
  assert.equal(
    getCronJobSkipReason({
      payloadVersion: undefined,
      repeatJobKey: "repeat:current",
      current: { ...current, scheduleVersion: 4 },
    }),
    "stale_cron_schedule",
  );
  assert.equal(
    getCronJobSkipReason({ payloadVersion: undefined, repeatJobKey: "repeat:old", current }),
    "stale_cron_schedule",
  );
});

test("deleted, disabled, and missing cron jobs never execute", () => {
  assert.equal(getCronJobSkipReason({ payloadVersion: 3, repeatJobKey: "repeat:current", current: null }), "cron_job_not_found");
  assert.equal(
    getCronJobSkipReason({ payloadVersion: 3, repeatJobKey: "repeat:current", current: { ...current, enabled: false } }),
    "cron_job_disabled",
  );
  assert.equal(
    getCronJobSkipReason({ payloadVersion: 3, repeatJobKey: "repeat:current", current: { ...current, deletedAt: new Date() } }),
    "cron_job_disabled",
  );
});
