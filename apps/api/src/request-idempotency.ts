import { createHash } from "node:crypto";

const digest = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");

export function createSessionlessPromptSessionId(input: {
  spaceId: string;
  userId: string;
  clientMessageId: string;
}) {
  const hex = digest(["space_prompt", input.spaceId, input.userId, input.clientMessageId]);
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createGenerationTaskJobId(input: {
  userId: string;
  clientRequestId: string | null;
  request: unknown;
}) {
  if (!input.clientRequestId) return undefined;
  return `generation-${digest([
    input.userId,
    input.clientRequestId,
    input.request,
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
