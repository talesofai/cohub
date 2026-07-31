import { createHash } from "node:crypto";

const createIdempotencyDigest = (value: unknown) =>
  createHash("sha256").update(stableStringify(value)).digest("hex");

export const createRequestFingerprint = createIdempotencyDigest;

export function createScheduledPromptScheduleIdentity(
  schedule:
    | { mode: "delay"; delayMs: number }
    | { mode: "at"; scheduledAt: Date },
) {
  return schedule.mode === "delay"
    ? { mode: schedule.mode, delayMs: schedule.delayMs }
    : { mode: schedule.mode, scheduledAt: schedule.scheduledAt.toISOString() };
}

function createDeterministicUuid(value: unknown) {
  const hex = createIdempotencyDigest(value);
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createSessionlessPromptSessionId(input: {
  spaceId: string;
  userId: string;
  clientMessageId: string;
}) {
  return createDeterministicUuid(["space_prompt", input.spaceId, input.userId, input.clientMessageId]);
}

export function createGenerationTaskJobId(input: {
  userId: string;
  clientRequestId: string | null;
}) {
  if (!input.clientRequestId) return undefined;
  return `generation-${createIdempotencyDigest([input.userId, input.clientRequestId]).slice(0, 48)}`;
}

export function createRepeatPromptCronJobIdempotencyKey(input: {
  userId: string;
  spaceId: string;
  sessionId: string | null;
  clientMessageId: string;
}) {
  return createIdempotencyDigest([
    "space_prompt_repeat",
    input.userId,
    input.spaceId,
    input.sessionId,
    input.clientMessageId,
  ]);
}

export function createScheduledPromptTaskJobId(input: {
  userId: string;
  spaceId: string;
  sessionId: string | null;
  clientMessageId: string | null;
}) {
  if (!input.clientMessageId) return undefined;
  return `space-prompt-${createIdempotencyDigest([
    input.userId,
    input.spaceId,
    input.sessionId,
    input.clientMessageId,
  ]).slice(0, 48)}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
