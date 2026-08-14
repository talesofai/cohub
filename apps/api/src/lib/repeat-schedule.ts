import * as cronParser from "cron-parser";

const { CronExpressionParser } = cronParser;

export function validateRepeatSchedule(input: {
  cronExpression: string;
  timezone: string;
}): { cronExpression: string; timezone: string; nextRun: Date } {
  const fields = input.cronExpression.trim().split(/\s+/);
  const cronExpression = fields.join(" ");
  const timezone = input.timezone.trim();
  if (fields.length !== 5) {
    throw new Error("cronExpression must have 5 fields, e.g. 0 9 * * *");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(
      "timezone must be an IANA timezone, e.g. Asia/Shanghai or UTC",
    );
  }
  const interval = CronExpressionParser.parse(cronExpression, { tz: timezone });
  const nextRun = interval.next().toDate();
  const secondRun = interval.next().toDate();
  if (secondRun.getTime() - nextRun.getTime() < 60_000) {
    throw new Error("cron interval must be at least 1 minute");
  }
  return { cronExpression, timezone, nextRun };
}
