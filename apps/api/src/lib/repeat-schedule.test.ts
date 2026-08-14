import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRepeatSchedule } from "./repeat-schedule.js";

test("repeat schedules normalize whitespace and return the next run", () => {
  const result = validateRepeatSchedule({
    cronExpression: "  */5  * * * *  ",
    timezone: "UTC",
  });
  assert.equal(result.cronExpression, "*/5 * * * *");
  assert.equal(result.timezone, "UTC");
  assert.ok(result.nextRun instanceof Date);
});

test("repeat schedules accept the minimum one-minute interval", () => {
  assert.doesNotThrow(() =>
    validateRepeatSchedule({
      cronExpression: "* * * * *",
      timezone: "UTC",
    }),
  );
});

test("repeat schedules reject invalid timezones", () => {
  assert.throws(
    () =>
      validateRepeatSchedule({
        cronExpression: "0 * * * *",
        timezone: "Mars/Olympus",
      }),
    /IANA timezone/,
  );
});
