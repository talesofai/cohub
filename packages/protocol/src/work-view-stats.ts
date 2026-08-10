const WORK_VIEW_STATS_REDIS_PREFIX = "cohub:{work-view-stats-v1}";
export const WORK_VIEW_STATS_ACTIVE_REDIS_KEY = `${WORK_VIEW_STATS_REDIS_PREFIX}:active`;
export const WORK_VIEW_STATS_PENDING_REDIS_KEY_PREFIX = `${WORK_VIEW_STATS_REDIS_PREFIX}:pending:`;
export const WORK_VIEW_STATS_PENDING_INDEX_REDIS_KEY = `${WORK_VIEW_STATS_REDIS_PREFIX}:pending-index`;
export const WORK_VIEW_STATS_FLUSH_LOCK_REDIS_KEY = `${WORK_VIEW_STATS_REDIS_PREFIX}:flush-lock`;
export const WORK_VIEW_STATS_FLUSH_JOB = "work.view_stats.flush";
export const WORK_VIEW_STATS_FLUSH_SCHEDULER_ID = "work-view-stats-flush";
export const WORK_VIEW_STATS_FLUSH_INTERVAL_MS = 30_000;

export type WorkViewStatsSource = "web" | "cli" | "api";

export type WorkViewStatsRedisField = {
  workId: string;
  workVersionId: string;
  bucketStartAtMs: number;
  source: WorkViewStatsSource;
};

const WORK_VIEW_STATS_SOURCES = new Set<WorkViewStatsSource>(["web", "cli", "api"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeWorkViewStatsRedisField(input: WorkViewStatsRedisField): string {
  return JSON.stringify([
    input.workId,
    input.workVersionId,
    input.bucketStartAtMs,
    input.source,
  ]);
}

export function decodeWorkViewStatsRedisField(value: string): WorkViewStatsRedisField | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [workId, workVersionId, bucketStartAtMs, source] = parsed;
    if (typeof workId !== "string" || !UUID_RE.test(workId)) return null;
    if (typeof workVersionId !== "string" || !UUID_RE.test(workVersionId)) return null;
    if (
      !Number.isSafeInteger(bucketStartAtMs)
      || bucketStartAtMs < 0
      || Number.isNaN(new Date(bucketStartAtMs).getTime())
    ) return null;
    if (typeof source !== "string" || !WORK_VIEW_STATS_SOURCES.has(source as WorkViewStatsSource)) return null;
    return {
      workId,
      workVersionId,
      bucketStartAtMs,
      source: source as WorkViewStatsSource,
    };
  } catch {
    return null;
  }
}
