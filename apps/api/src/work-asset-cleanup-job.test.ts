import assert from "node:assert/strict";

const { createWorkAssetCleanupJobId } = await import("./work-asset-cleanup-job.js");

const assetKeys = ["w/space/work/0123456789ab/index.html"];
const first = createWorkAssetCleanupJobId(assetKeys, "11111111-1111-4111-8111-111111111111");
const second = createWorkAssetCleanupJobId(assetKeys, "22222222-2222-4222-8222-222222222222");

assert.notEqual(first, second);
assert.match(first, /^work-asset-cleanup-[a-f0-9]{24}-11111111-1111-4111-8111-111111111111$/);
assert.notEqual(createWorkAssetCleanupJobId(assetKeys), createWorkAssetCleanupJobId(assetKeys));

console.log("api work asset cleanup job identity checks passed");
