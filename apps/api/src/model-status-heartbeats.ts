export type RawOnlineHeartbeat = {
  start?: string;
  success_rate?: number;
  sample_count?: number;
};

/** Stable density that fits the 288px model-status hover card. */
export const MODEL_STATUS_HEARTBEAT_BUCKET_COUNT = 96;

const MINUTE_MS = 60 * 1000;

export function resampleModelStatusHeartbeats(
  heartbeats: RawOnlineHeartbeat[],
  windowStart: string | null | undefined,
  windowMinutes: number,
): Array<number | null> | null {
  const windowStartMs = windowStart ? Date.parse(windowStart) : Number.NaN;
  if (
    !Number.isFinite(windowStartMs) ||
    !Number.isFinite(windowMinutes) ||
    windowMinutes <= 0 ||
    !heartbeats.length
  ) {
    return null;
  }

  const heartbeatBucketMs =
    (windowMinutes * MINUTE_MS) / MODEL_STATUS_HEARTBEAT_BUCKET_COUNT;
  const acc = new Map<number, { sum: number; weight: number }>();
  for (const heartbeat of heartbeats) {
    const timestamp = heartbeat.start
      ? Date.parse(heartbeat.start)
      : Number.NaN;
    if (
      !Number.isFinite(timestamp) ||
      typeof heartbeat.success_rate !== "number"
    ) {
      continue;
    }
    const index = Math.floor(
      (timestamp - windowStartMs) / heartbeatBucketMs,
    );
    if (index < 0 || index >= MODEL_STATUS_HEARTBEAT_BUCKET_COUNT) continue;
    const weight =
      heartbeat.sample_count && heartbeat.sample_count > 0
        ? heartbeat.sample_count
        : 1;
    const bucket = acc.get(index) ?? { sum: 0, weight: 0 };
    bucket.sum += heartbeat.success_rate * weight;
    bucket.weight += weight;
    acc.set(index, bucket);
  }

  return Array.from(
    { length: MODEL_STATUS_HEARTBEAT_BUCKET_COUNT },
    (_, index) => {
      const bucket = acc.get(index);
      return bucket && bucket.weight > 0
        ? Math.round((bucket.sum / bucket.weight) * 10) / 10
        : null;
    },
  );
}
