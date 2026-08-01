import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePromptSchedule, validateWorkSessionPromptSchedule } from "./prompt-schedule.js";

const now = Date.parse("2026-07-30T00:00:00.000Z");

test("prompt schedules are fully validated before execution", () => {
  assert.deepEqual(validatePromptSchedule(undefined, now), { mode: "immediate" });
  assert.deepEqual(validatePromptSchedule({}, now), { mode: "immediate" });
  assert.deepEqual(validatePromptSchedule({ mode: "delay", delayMs: 60_000 }, now), {
    mode: "delay",
    delayMs: 60_000,
    scheduledAt: new Date(now + 60_000),
  });
  assert.deepEqual(validatePromptSchedule({ mode: "at", sendAt: "2026-07-30T00:02:00Z" }, now), {
    mode: "at",
    scheduledAt: new Date("2026-07-30T00:02:00Z"),
  });
  assert.equal(
    validatePromptSchedule({ mode: "repeat", cronExpression: "0 9 * * *", timezone: "Asia/Shanghai" }, now).mode,
    "repeat",
  );
});

test("invalid schedules fail before callers perform writes", () => {
  assert.throws(() => validatePromptSchedule("delay", now), /must be an object/);
  assert.throws(() => validatePromptSchedule([], now), /must be an object/);
  assert.throws(() => validatePromptSchedule({ delayMs: 60_000 }, now), /delayMs is not allowed/);
  assert.throws(
    () => validatePromptSchedule({ mode: "invalid" } as never, now),
    /schedule.mode/,
  );
  assert.throws(
    () => validatePromptSchedule({ mode: "delay", delayMs: true }, now),
    /positive integer/,
  );
  assert.throws(() => validatePromptSchedule({ mode: "delay", delayMs: 0 }, now), /positive integer/);
  assert.throws(
    () => validatePromptSchedule({ mode: "delay", delayMs: Number.MAX_SAFE_INTEGER }, now),
    /too large/,
  );
  assert.throws(() => validatePromptSchedule({ mode: "at", sendAt: "2026-07-30T00:02:00" }, now), /timezone/);
  assert.throws(() => validatePromptSchedule({ mode: "at", sendAt: "2026-07-29T23:59:00Z" }, now), /future/);
  assert.deepEqual(
    validatePromptSchedule(
      { mode: "at", sendAt: "2026-07-29T23:59:00Z" },
      now,
      { allowPastAt: true },
    ),
    { mode: "at", scheduledAt: new Date("2026-07-29T23:59:00Z") },
  );
  assert.throws(
    () => validatePromptSchedule({ mode: "repeat", cronExpression: "0 9 * *", timezone: "Asia/Shanghai" }, now),
    /5 fields/,
  );
  assert.throws(
    () => validatePromptSchedule({ mode: "repeat", cronExpression: "0 9 * * *", timezone: "Not/AZone" }, now),
    /IANA timezone/,
  );
});

test("work-session schedules cannot outlive their authorization", () => {
  const delay = validatePromptSchedule({ mode: "delay", delayMs: 60_000 }, now);
  assert.doesNotThrow(() => validateWorkSessionPromptSchedule(delay, now + 120_000));
  assert.throws(() => validateWorkSessionPromptSchedule(delay, now + 60_000), /before the work session/);
  const repeat = validatePromptSchedule({ mode: "repeat", cronExpression: "0 9 * * *", timezone: "Asia/Shanghai" }, now);
  assert.throws(() => validateWorkSessionPromptSchedule(repeat, now + 60_000), /repeat schedules/);
});
