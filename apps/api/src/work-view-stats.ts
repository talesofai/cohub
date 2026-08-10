import { and, asc, eq, gte, sql } from "drizzle-orm";
import { workViewStatsHourly } from "@cohub/db";
import {
  encodeWorkViewStatsRedisField,
  WORK_VIEW_STATS_ACTIVE_REDIS_KEY,
  type WorkViewStatsSource,
} from "@cohub/protocol";
import type { RequestSource } from "@cohub/protocol/provenance";
import { db } from "./db/index.js";

export type WorkViewSource = WorkViewStatsSource;

export type WorkViewStatsResponse = {
  summary: {
    totalViews: number;
    views24h: number;
    views7d: number;
    views30d: number;
  };
  daily: Array<{ date: string; views: number }>;
  sources: Array<{ source: WorkViewSource; views: number }>;
};

type WorkViewStatsRow = {
  bucketStartAt: Date;
  source: string;
  viewCount: number;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const STATS_DAYS = 30;
const SOURCE_ORDER: WorkViewSource[] = ["web", "cli", "api"];

const toCount = (value: unknown) => {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
};

export function toUtcHourBucket(date: Date): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
  ));
}

function toUtcDayBucket(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

const dateKey = (date: Date) => date.toISOString().slice(0, 10);

export function resolveWorkViewSource(source: RequestSource | null | undefined, fallback: WorkViewSource): WorkViewSource {
  if (source?.via === "cli") return "cli";
  if (source?.via === "web") return "web";
  if (source?.via) return "api";
  return fallback;
}

type WorkViewStatsRedisClient = {
  readonly status: string;
  hincrby(key: string, field: string, increment: number): Promise<number>;
};

let workViewStatsRedisPromise: Promise<WorkViewStatsRedisClient> | null = null;
const resolveWorkViewStatsRedis = (): Promise<WorkViewStatsRedisClient> => {
  workViewStatsRedisPromise ??= import("./redis.js")
    .then((module) => module.redisBestEffortCommandClient);
  return workViewStatsRedisPromise;
};

export async function recordWorkViewStatsHourly(input: {
  workId: string;
  workVersionId: string;
  source: WorkViewSource;
  viewedAt?: Date;
  redis?: WorkViewStatsRedisClient;
}): Promise<boolean> {
  const now = input.viewedAt ?? new Date();
  const bucketStartAt = toUtcHourBucket(now);
  const redis = input.redis ?? await resolveWorkViewStatsRedis();
  if (redis.status !== "ready") return false;
  await redis.hincrby(WORK_VIEW_STATS_ACTIVE_REDIS_KEY, encodeWorkViewStatsRedisField({
    workId: input.workId,
    workVersionId: input.workVersionId,
    bucketStartAtMs: bucketStartAt.getTime(),
    source: input.source,
  }), 1);
  return true;
}

export function aggregateWorkViewStats(input: {
  totalViews: unknown;
  rows: readonly WorkViewStatsRow[];
  now: Date;
}): WorkViewStatsResponse {
  const currentHourMs = toUtcHourBucket(input.now).getTime();
  const start24h = currentHourMs - 23 * HOUR_MS;
  const start7d = currentHourMs - 167 * HOUR_MS;
  const startDay = toUtcDayBucket(new Date(input.now.getTime() - (STATS_DAYS - 1) * DAY_MS));
  const dailyMap = new Map<string, number>();
  const sourceMap = new Map<WorkViewSource, number>();
  for (let offset = 0; offset < STATS_DAYS; offset += 1) {
    dailyMap.set(dateKey(new Date(startDay.getTime() + offset * DAY_MS)), 0);
  }

  let views24h = 0;
  let views7d = 0;
  let views30d = 0;
  for (const row of input.rows) {
    const views = toCount(row.viewCount);
    const bucketMs = row.bucketStartAt.getTime();
    if (bucketMs >= start24h) views24h += views;
    if (bucketMs >= start7d) views7d += views;
    const day = dateKey(row.bucketStartAt);
    if (!dailyMap.has(day)) continue;
    views30d += views;
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + views);
    const source = SOURCE_ORDER.includes(row.source as WorkViewSource)
      ? row.source as WorkViewSource
      : "api";
    sourceMap.set(source, (sourceMap.get(source) ?? 0) + views);
  }

  return {
    summary: {
      totalViews: toCount(input.totalViews),
      views24h,
      views7d,
      views30d,
    },
    daily: Array.from(dailyMap, ([date, views]) => ({ date, views })),
    sources: SOURCE_ORDER
      .map((source) => ({ source, views: sourceMap.get(source) ?? 0 }))
      .filter((item) => item.views > 0),
  };
}

export async function getWorkViewStats(workId: string): Promise<WorkViewStatsResponse> {
  const now = new Date();
  const startDay = toUtcDayBucket(new Date(now.getTime() - (STATS_DAYS - 1) * DAY_MS));
  const [totalRows, recentRows] = await Promise.all([
    db
      .select({ totalViews: sql<string>`coalesce(sum(${workViewStatsHourly.viewCount}), 0)` })
      .from(workViewStatsHourly)
      .where(eq(workViewStatsHourly.workId, workId)),
    db
      .select({
        bucketStartAt: workViewStatsHourly.bucketStartAt,
        source: workViewStatsHourly.source,
        viewCount: workViewStatsHourly.viewCount,
      })
      .from(workViewStatsHourly)
      .where(and(
        eq(workViewStatsHourly.workId, workId),
        gte(workViewStatsHourly.bucketStartAt, startDay),
      ))
      .orderBy(asc(workViewStatsHourly.bucketStartAt)),
  ]);
  return aggregateWorkViewStats({
    totalViews: totalRows[0]?.totalViews ?? 0,
    rows: recentRows,
    now,
  });
}
