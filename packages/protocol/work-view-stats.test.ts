import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeWorkViewStatsRedisField,
  encodeWorkViewStatsRedisField,
  WORK_VIEW_STATS_ACTIVE_REDIS_KEY,
  WORK_VIEW_STATS_FLUSH_LOCK_REDIS_KEY,
  WORK_VIEW_STATS_PENDING_INDEX_REDIS_KEY,
  WORK_VIEW_STATS_PENDING_REDIS_KEY_PREFIX,
} from "./src/work-view-stats.js";

test("keeps Work view Redis keys in one cluster hash slot", () => {
  const keys = [
    WORK_VIEW_STATS_ACTIVE_REDIS_KEY,
    WORK_VIEW_STATS_FLUSH_LOCK_REDIS_KEY,
    WORK_VIEW_STATS_PENDING_INDEX_REDIS_KEY,
    `${WORK_VIEW_STATS_PENDING_REDIS_KEY_PREFIX}batch-1`,
  ];
  assert.deepEqual(keys.map((key) => key.match(/\{([^}]+)\}/)?.[1]), [
    "work-view-stats-v1",
    "work-view-stats-v1",
    "work-view-stats-v1",
    "work-view-stats-v1",
  ]);
});

test("round-trips Work view Redis field dimensions", () => {
  const dimensions = {
    workId: "11111111-1111-4111-8111-111111111111",
    workVersionId: "22222222-2222-4222-8222-222222222222",
    bucketStartAtMs: Date.parse("2026-08-07T14:00:00.000Z"),
    source: "web" as const,
  };
  assert.deepEqual(
    decodeWorkViewStatsRedisField(encodeWorkViewStatsRedisField(dimensions)),
    dimensions,
  );
});

test("rejects malformed Work view Redis fields", () => {
  assert.equal(decodeWorkViewStatsRedisField("not-json"), null);
  assert.equal(decodeWorkViewStatsRedisField(JSON.stringify(["work", "version", 1, "web"])), null);
  assert.equal(decodeWorkViewStatsRedisField(JSON.stringify([
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    -1,
    "web",
  ])), null);
  assert.equal(decodeWorkViewStatsRedisField(JSON.stringify([
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    1,
    "other",
  ])), null);
});
