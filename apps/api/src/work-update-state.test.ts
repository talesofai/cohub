import assert from "node:assert/strict";

const { getWorkUpdateVersionState } = await import("./work-update-state.js");

const publishedAt = new Date("2026-07-13T08:00:00Z");
const locked = {
  assetKey: "w/space/work/0123456789ab/index.html",
  currentVersionId: "version-42",
  latestVersion: 42,
  publishedAt,
};
assert.deepEqual(getWorkUpdateVersionState(locked, "published", new Date()), locked);
assert.deepEqual(getWorkUpdateVersionState(locked, "disabled", new Date()), {
  assetKey: null,
  currentVersionId: "version-42",
  latestVersion: 42,
  publishedAt: null,
});

console.log("api work update version fencing checks passed");
