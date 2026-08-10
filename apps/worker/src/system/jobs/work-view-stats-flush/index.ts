import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { workViewStatsHourly } from "@cohub/db";
import {
  WORK_VIEW_STATS_ACTIVE_REDIS_KEY,
  WORK_VIEW_STATS_FLUSH_JOB,
  WORK_VIEW_STATS_FLUSH_LOCK_REDIS_KEY,
  WORK_VIEW_STATS_PENDING_INDEX_REDIS_KEY,
  WORK_VIEW_STATS_PENDING_REDIS_KEY_PREFIX,
} from "@cohub/protocol";
import { createLogger } from "@cohub/infra/logging";
import { db } from "../../../db.js";
import { redisCommandClient } from "../../../redis.js";
import { registerSystemJob } from "../../registry.js";
import { parseWorkViewStatsBatch } from "./batch.js";

const logger = createLogger({ serviceName: "cohub-worker" });
const LOCK_TTL_MS = 2 * 60_000;
const UPSERT_CHUNK_SIZE = 500;
const CUT_ACTIVE_HASH_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 0 then
  return 0
end
redis.call("SADD", KEYS[3], KEYS[2])
redis.call("RENAME", KEYS[1], KEYS[2])
return 1
`;
const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function cutActiveBatch(): Promise<void> {
  const pendingKey = `${WORK_VIEW_STATS_PENDING_REDIS_KEY_PREFIX}${Date.now()}-${randomUUID()}`;
  await redisCommandClient.eval(
    CUT_ACTIVE_HASH_SCRIPT,
    3,
    WORK_VIEW_STATS_ACTIVE_REDIS_KEY,
    pendingKey,
    WORK_VIEW_STATS_PENDING_INDEX_REDIS_KEY,
  );
}

async function persistPendingBatch(key: string) {
  const parsed = parseWorkViewStatsBatch(await redisCommandClient.hgetall(key));
  if (parsed.rows.length > 0) {
    await db.transaction(async (tx) => {
      for (const rows of chunk(parsed.rows, UPSERT_CHUNK_SIZE)) {
        await tx.insert(workViewStatsHourly).values(rows).onConflictDoUpdate({
          target: [
            workViewStatsHourly.workId,
            workViewStatsHourly.workVersionId,
            workViewStatsHourly.bucketStartAt,
            workViewStatsHourly.source,
          ],
          set: {
            viewCount: sql`${workViewStatsHourly.viewCount} + excluded.view_count`,
            updatedAt: rows[0]?.updatedAt ?? new Date(),
          },
        });
      }
    });
  }
  await redisCommandClient.multi()
    .del(key)
    .srem(WORK_VIEW_STATS_PENDING_INDEX_REDIS_KEY, key)
    .exec();
  return { rows: parsed.rows.length, invalid: parsed.invalid };
}

registerSystemJob(WORK_VIEW_STATS_FLUSH_JOB, async () => {
  const lockToken = randomUUID();
  const acquired = await redisCommandClient.set(
    WORK_VIEW_STATS_FLUSH_LOCK_REDIS_KEY,
    lockToken,
    "PX",
    LOCK_TTL_MS,
    "NX",
  );
  if (acquired !== "OK") return { skipped: true, batches: 0, rows: 0, invalid: 0 };

  try {
    await cutActiveBatch();
    const pendingKeys = await redisCommandClient.smembers(WORK_VIEW_STATS_PENDING_INDEX_REDIS_KEY);

    let rows = 0;
    let invalid = 0;
    for (const key of pendingKeys) {
      const result = await persistPendingBatch(key);
      rows += result.rows;
      invalid += result.invalid;
    }
    if (rows > 0 || invalid > 0) {
      logger.info("[WorkViewStats] flushed buffered views", {
        batches: pendingKeys.length,
        rows,
        invalid,
      });
    }
    return { skipped: false, batches: pendingKeys.length, rows, invalid };
  } finally {
    await redisCommandClient.eval(
      RELEASE_LOCK_SCRIPT,
      1,
      WORK_VIEW_STATS_FLUSH_LOCK_REDIS_KEY,
      lockToken,
    ).catch(() => undefined);
  }
});
