import * as cronParser from "cron-parser";

const { CronExpressionParser } = cronParser;

export type SpacePromptSchedule =
  | { mode?: "immediate" }
  | { mode: "delay"; delayMs?: number }
  | { mode: "at"; sendAt?: string }
  | { mode: "repeat"; cronExpression?: string; timezone?: string };

export type ValidatedPromptSchedule =
  | { mode: "immediate" }
  | { mode: "delay"; delayMs: number; scheduledAt: Date }
  | { mode: "at"; scheduledAt: Date }
  | { mode: "repeat"; cronExpression: string; timezone: string; nextRun: Date };

export function validateWorkSessionPromptSchedule(schedule: ValidatedPromptSchedule, authorizationExpiresAtMs: number) {
  if (schedule.mode === "repeat") {
    throw new Error("repeat schedules are not available from a work session");
  }
  if (
    (schedule.mode === "delay" || schedule.mode === "at")
    && schedule.scheduledAt.getTime() >= authorizationExpiresAtMs
  ) {
    throw new Error("scheduled prompt must run before the work session authorization expires");
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertOnlyKeys = (value: Record<string, unknown>, allowedKeys: readonly string[]) => {
  const unexpectedKey = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unexpectedKey) throw new Error(`schedule.${unexpectedKey} is not allowed`);
};

const hasExplicitTimezone = (value: string) => /(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim());

const validateTimezone = (timezone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const parseScheduledAt = (sendAt: string, now: number, allowPast: boolean) => {
  const trimmed = sendAt.trim();
  if (!hasExplicitTimezone(trimmed)) {
    throw new Error("sendAt must include timezone, e.g. 2026-05-09T10:00:00+08:00 or 2026-05-09T02:00:00Z");
  }
  const scheduledAt = new Date(trimmed);
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new Error("sendAt must be a valid ISO 8601 datetime, e.g. 2026-05-09T10:00:00+08:00");
  }
  if (!allowPast && scheduledAt.getTime() <= now) throw new Error("sendAt must be in the future");
  return scheduledAt;
};

const validateRepeatSchedule = (input: { cronExpression: string; timezone: string }) => {
  const cronExpression = input.cronExpression.trim();
  const timezone = input.timezone.trim();
  if (cronExpression.split(/\s+/).length !== 5) {
    throw new Error("cronExpression must have 5 fields, e.g. 0 9 * * *");
  }
  if (!validateTimezone(timezone)) {
    throw new Error("timezone must be an IANA timezone, e.g. Asia/Shanghai or UTC");
  }
  const interval = CronExpressionParser.parse(cronExpression, { tz: timezone });
  const nextRun = interval.next().toDate();
  const secondRun = interval.next().toDate();
  if (secondRun.getTime() - nextRun.getTime() < 60_000) {
    throw new Error("cron interval must be at least 1 minute");
  }
  return { cronExpression, timezone, nextRun };
};

export function validatePromptSchedule(
  value: unknown,
  now = Date.now(),
  options: { allowPastAt?: boolean } = {},
): ValidatedPromptSchedule {
  if (value === null || value === undefined) return { mode: "immediate" };
  if (!isRecord(value)) throw new Error("schedule must be an object");

  const schedule = value;
  if (schedule.mode === undefined) {
    assertOnlyKeys(schedule, []);
    return { mode: "immediate" };
  }
  if (schedule.mode === "immediate") {
    assertOnlyKeys(schedule, ["mode"]);
    return { mode: "immediate" };
  }
  if (schedule.mode === "delay") {
    assertOnlyKeys(schedule, ["mode", "delayMs"]);
    const delayMs = schedule.delayMs;
    if (typeof delayMs !== "number" || !Number.isSafeInteger(delayMs) || delayMs <= 0) {
      throw new Error("delayMs must be a positive integer, e.g. 600000");
    }
    const scheduledAt = new Date(now + delayMs);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new Error("delayMs is too large to schedule");
    }
    return { mode: "delay", delayMs, scheduledAt };
  }
  if (schedule.mode === "at") {
    assertOnlyKeys(schedule, ["mode", "sendAt"]);
    if (typeof schedule.sendAt !== "string" || !schedule.sendAt.trim()) {
      throw new Error("sendAt is required, e.g. 2026-05-09T10:00:00+08:00");
    }
    return { mode: "at", scheduledAt: parseScheduledAt(schedule.sendAt, now, options.allowPastAt === true) };
  }
  if (schedule.mode !== "repeat") {
    throw new Error("schedule.mode must be one of: immediate, delay, at, repeat");
  }

  assertOnlyKeys(schedule, ["mode", "cronExpression", "timezone"]);

  const cronExpression = typeof schedule.cronExpression === "string"
    ? schedule.cronExpression.trim()
    : "";
  if (!cronExpression) {
    throw new Error("cronExpression is required, e.g. 0 9 * * *");
  }
  const timezone = typeof schedule.timezone === "string"
    ? schedule.timezone.trim()
    : "";
  if (!timezone) {
    throw new Error("timezone is required, e.g. Asia/Shanghai");
  }
  return { mode: "repeat", ...validateRepeatSchedule({ cronExpression, timezone }) };
}
