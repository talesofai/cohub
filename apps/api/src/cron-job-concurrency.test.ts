import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCronJobUpdateVersion,
  CronJobUpdateConflictError,
  CronJobUpdateVersionError,
  nextCronJobUpdateVersion,
  parseCronJobExpectedUpdatedAt,
} from "./cron-job-concurrency.js";

test("cron updates require the exact version observed by the editor", () => {
  const current = new Date("2026-07-31T12:00:00.000Z");
  assert.doesNotThrow(() => assertCronJobUpdateVersion(current, current));
  assert.throws(
    () =>
      assertCronJobUpdateVersion(
        current,
        new Date("2026-07-31T11:59:59.000Z"),
      ),
    CronJobUpdateConflictError,
  );
});

test("cron update versions are validated and advance monotonically", () => {
  assert.throws(
    () => parseCronJobExpectedUpdatedAt(undefined),
    CronJobUpdateVersionError,
  );
  assert.throws(
    () => parseCronJobExpectedUpdatedAt("not-a-date"),
    CronJobUpdateVersionError,
  );
  assert.equal(
    parseCronJobExpectedUpdatedAt("2026-07-31T12:00:00.000Z").toISOString(),
    "2026-07-31T12:00:00.000Z",
  );

  const future = new Date(Date.now() + 10_000);
  assert.ok(nextCronJobUpdateVersion(future).getTime() > future.getTime());
});
