import { validateRepeatSchedule } from "./repeat-schedule.js";

export const MAX_SPACE_COMMAND_LENGTH = 16 * 1024;

export type ParsedSpaceCommandRequest =
  | {
      mode: "immediate";
      command: string;
    }
  | {
      mode: "repeat";
      command: string;
      title: string;
      cronExpression: string;
      timezone: string;
      nextRun: Date;
    };

export function parseSpaceCommandRequest(
  input: unknown,
): ParsedSpaceCommandRequest {
  if (!isRecord(input)) throw new Error("invalid json body");

  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) throw new Error("command is required");
  if (command.length > MAX_SPACE_COMMAND_LENGTH) {
    throw new Error(
      `command is too long; max ${MAX_SPACE_COMMAND_LENGTH} characters`,
    );
  }

  if (input.schedule === undefined) return { mode: "immediate", command };
  if (!isRecord(input.schedule)) throw new Error("schedule must be an object");

  const mode = input.schedule.mode ?? "immediate";
  if (mode === "immediate") return { mode, command };
  if (mode !== "repeat") {
    throw new Error("schedule.mode must be one of: immediate, repeat");
  }

  const cronExpression = input.schedule.cronExpression;
  const timezone = input.schedule.timezone;
  if (typeof cronExpression !== "string" || !cronExpression.trim()) {
    throw new Error("cronExpression is required, e.g. */5 * * * *");
  }
  if (typeof timezone !== "string" || !timezone.trim()) {
    throw new Error("timezone is required, e.g. Asia/Shanghai");
  }

  const title = input.title === undefined
    ? "scheduled command"
    : requireTitle(input.title);
  const schedule = validateRepeatSchedule({ cronExpression, timezone });
  return { mode, command, title, ...schedule };
}

function requireTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("title must be a non-empty string");
  }
  const title = value.trim();
  if (title.length > 255) throw new Error("title must be at most 255 characters");
  return title;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
