import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseGenerationTimeline,
  partitionTimelineDuration,
  planGenerationTimeline,
} from "../src/tasks/generation-timeline.js";

const image = (name: string) => ({ type: "url" as const, url: `https://example.com/${name}.png` });

test("partitions timeline intervals into H3-compatible durations", () => {
  assert.deepEqual(partitionTimelineDuration(4), [4]);
  assert.deepEqual(partitionTimelineDuration(15), [15]);
  assert.deepEqual(partitionTimelineDuration(16), [8, 8]);
  assert.deepEqual(partitionTimelineDuration(31), [11, 10, 10]);
});

test("plans a direct first-frame to last-frame transition", () => {
  const plan = planGenerationTimeline({
    keyframes: [
      { timeSec: 0, source: image("start") },
      { timeSec: 5, source: image("end") },
    ],
  });

  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0], {
    startSec: 0,
    endSec: 5,
    durationSec: 5,
    startSource: image("start"),
    endSource: image("end"),
  });
});

test("plans long gaps as chained segments with an extracted intermediate frame", () => {
  const plan = planGenerationTimeline({
    keyframes: [
      { timeSec: 0, source: image("start") },
      { timeSec: 20, source: image("end") },
    ],
  });

  assert.deepEqual(plan.map(({ startSec, endSec, durationSec, startSource, endSource }) => ({
    startSec,
    endSec,
    durationSec,
    startSource,
    endSource,
  })), [
    { startSec: 0, endSec: 10, durationSec: 10, startSource: image("start"), endSource: undefined },
    { startSec: 10, endSec: 20, durationSec: 10, startSource: undefined, endSource: image("end") },
  ]);
});

test("accepts a timeline that starts from text and ends at a fixed image", () => {
  const parsed = parseGenerationTimeline({ keyframes: [{ timeSec: 5, source: image("end") }] });
  assert.deepEqual(parsed.keyframes, [{ timeSec: 5, source: image("end") }]);
});

test("rejects invalid timeline ordering and non-image sources", () => {
  assert.throws(
    () => parseGenerationTimeline({ keyframes: [{ timeSec: 5, source: image("a") }, { timeSec: 4, source: image("b") }] }),
    /strictly increasing/,
  );
  assert.throws(
    () => parseGenerationTimeline({ keyframes: [{ timeSec: 5, source: { type: "base64", mediaType: "video/mp4", data: "abc" } }] }),
    /image source/,
  );
  assert.throws(
    () => parseGenerationTimeline({ keyframes: [{ timeSec: 0, source: image("a") }] }),
    /at least one second/,
  );
  assert.throws(
    () => parseGenerationTimeline({ keyframes: [{ timeSec: 5, source: { type: "base64", mediaType: "video/mp4", data: "AAAA" } }] }),
    /image source/,
  );
});
