import assert from "node:assert/strict";
import { test } from "node:test";
import { resampleModelStatusHeartbeats } from "./model-status-heartbeats.js";

test("resamples a 24-hour online window to 96 chart buckets", () => {
  const windowStart = "2026-07-29T08:30:00.000Z";
  const windowStartMs = Date.parse(windowStart);
  const heartbeats = Array.from({ length: 240 }, (_, index) => ({
    start: new Date(windowStartMs + index * 6 * 60 * 1000).toISOString(),
    success_rate: 100,
    sample_count: 1,
  }));

  const result = resampleModelStatusHeartbeats(
    heartbeats,
    windowStart,
    24 * 60,
  );

  assert.equal(result?.length, 96);
  assert.ok(result?.every((rate) => rate === 100));
});

test("keeps sample weighting when combining heartbeats", () => {
  const windowStart = "2026-07-29T08:30:00.000Z";
  const result = resampleModelStatusHeartbeats(
    [
      { start: windowStart, success_rate: 0, sample_count: 1 },
      {
        start: "2026-07-29T08:32:00.000Z",
        success_rate: 100,
        sample_count: 3,
      },
    ],
    windowStart,
    8 * 60,
  );

  assert.equal(result?.length, 96);
  assert.equal(result?.[0], 75);
});
