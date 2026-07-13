import assert from "node:assert/strict";

const { WorkAssetUploadError, withWorkAssetUploadCleanupKey } = await import("./upload-failure.js");

const cleanupAssetKey = "w/space/work/0123456789ab/index.html";
await assert.rejects(
  withWorkAssetUploadCleanupKey(cleanupAssetKey, async () => {
    throw new Error("second object upload failed");
  }),
  (error: unknown) =>
    error instanceof WorkAssetUploadError &&
    error.cleanupAssetKey === cleanupAssetKey &&
    error.cause instanceof Error &&
    error.cause.message === "second object upload failed",
);

console.log("worker work asset upload cleanup metadata checks passed");
