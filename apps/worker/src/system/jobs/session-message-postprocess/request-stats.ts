export type LlmRequestStats = {
  requestCount: number;
  successCount: number;
  errorCount: number;
};

type LlmUsageMessageLike = {
  role: string;
  errorMessage?: unknown;
  stopReason?: unknown;
  meta?: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const positiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;

const nonNegativeInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;

const isSuccessfulMessage = (message: LlmUsageMessageLike) =>
  !message.errorMessage && message.stopReason !== "error" && message.stopReason !== "aborted";

export function resolveLlmRequestStats(message: LlmUsageMessageLike): LlmRequestStats {
  const meta = asRecord(message.meta);
  const compaction = message.role === "system" && meta?.messageKind === "compacted"
    ? asRecord(meta.compaction)
    : null;

  if (compaction) {
    const providerCalls = asRecord(compaction.providerCalls);
    const requestCount = positiveInteger(providerCalls?.total);
    const successCount = nonNegativeInteger(providerCalls?.succeeded);
    const errorCount = nonNegativeInteger(providerCalls?.failed);
    if (
      requestCount != null &&
      successCount != null &&
      errorCount != null &&
      successCount + errorCount === requestCount
    ) {
      return { requestCount, successCount, errorCount };
    }
  }

  const requestCount = positiveInteger(compaction?.providerCallCount) ?? 1;
  return isSuccessfulMessage(message)
    ? { requestCount, successCount: requestCount, errorCount: 0 }
    : { requestCount, successCount: 0, errorCount: requestCount };
}
