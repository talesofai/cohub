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

const hasExplicitTimezone = (value: string) => /(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim());

const validateTimezone = (timezone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const parseScheduledAt = (sendAt: string, now: number) => {
  const trimmed = sendAt.trim();
  if (!hasExplicitTimezone(trimmed)) {
    throw new Error("sendAt must include timezone, e.g. 2026-05-09T10:00:00+08:00 or 2026-05-09T02:00:00Z");
  }
  const scheduledAt = new Date(trimmed);
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new Error("sendAt must be a valid ISO 8601 datetime, e.g. 2026-05-09T10:00:00+08:00");
  }
  if (scheduledAt.getTime() <= now) throw new Error("sendAt must be in the future");
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
  value: SpacePromptSchedule | null | undefined,
  now = Date.now(),
): ValidatedPromptSchedule {
  const schedule = value ?? { mode: "immediate" as const };
  if (schedule.mode === undefined || schedule.mode === "immediate") {
    return { mode: "immediate" };
  }
  if (schedule.mode === "delay") {
    const delayMs = Number(schedule.delayMs);
    if (!Number.isSafeInteger(delayMs) || delayMs <= 0) {
      throw new Error("delayMs must be a positive integer, e.g. 600000");
    }
    return { mode: "delay", delayMs, scheduledAt: new Date(now + delayMs) };
  }
  if (schedule.mode === "at") {
    if (!schedule.sendAt?.trim()) {
      throw new Error("sendAt is required, e.g. 2026-05-09T10:00:00+08:00");
    }
    return { mode: "at", scheduledAt: parseScheduledAt(schedule.sendAt, now) };
  }
  if (schedule.mode !== "repeat") {
    throw new Error("schedule.mode must be one of: immediate, delay, at, repeat");
  }

  const cronExpression = schedule.cronExpression?.trim();
  if (!cronExpression) {
    throw new Error("cronExpression is required, e.g. 0 9 * * *");
  }
  const timezone = schedule.timezone?.trim();
  if (!timezone) {
    throw new Error("timezone is required, e.g. Asia/Shanghai");
  }
  return { mode: "repeat", ...validateRepeatSchedule({ cronExpression, timezone }) };
}
