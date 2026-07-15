import assert from "node:assert/strict";
import { test } from "node:test";
import { createRealtimeEventDeduplicator } from "./realtime-event-dedup.js";

test("realtime event deduplication suppresses retries until the TTL expires", () => {
  let now = 1000;
  const deduplicator = createRealtimeEventDeduplicator({
    ttlMs: 100,
    maxEntries: 2,
    now: () => now,
  });

  assert.equal(deduplicator.accept("event-1"), true);
  assert.equal(deduplicator.accept("event-1"), false);
  now += 101;
  assert.equal(deduplicator.accept("event-1"), true);
});

test("realtime event deduplication stays bounded", () => {
  const deduplicator = createRealtimeEventDeduplicator({ ttlMs: 1000, maxEntries: 2 });

  assert.equal(deduplicator.accept("event-1"), true);
  assert.equal(deduplicator.accept("event-2"), true);
  assert.equal(deduplicator.accept("event-3"), true);
  assert.equal(deduplicator.size(), 2);
  assert.equal(deduplicator.accept("event-1"), true);
});
