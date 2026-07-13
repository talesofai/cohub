import assert from "node:assert/strict";

const {
  createWorkAssetCleanupScope,
  createWorkAssetObjectKey,
  createWorkAssetPublishJobId,
  selectWorkAssetCleanupKey,
} = await import("./work-asset-publish-cleanup.js");

const current = {
  spaceId: "space-id",
  slug: "old-slug",
};
const locked = {
  spaceId: "space-id",
  slug: "renamed-slug",
};

assert.deepEqual(createWorkAssetCleanupScope("prod", locked), {
  env: "prod",
  spaceId: "space-id",
  slug: "renamed-slug",
});
assert.notDeepEqual(createWorkAssetCleanupScope("prod", locked), createWorkAssetCleanupScope("prod", current));
assert.equal(
  createWorkAssetObjectKey("prod", locked, "0123456789ab"),
  "w/space-id/renamed-slug/0123456789ab/index.html",
);
assert.equal(
  createWorkAssetObjectKey("dev", locked, "0123456789ab"),
  "dev/w/space-id/renamed-slug/0123456789ab/index.html",
);
assert.match(
  createWorkAssetPublishJobId(
    "w/space-id/renamed-slug/0123456789ab/index.html",
    "11111111-1111-4111-8111-111111111111",
  ),
  /^work-publish-asset-[a-f0-9]{24}-11111111-1111-4111-8111-111111111111$/,
);
assert.notEqual(
  createWorkAssetPublishJobId("w/space-id/renamed-slug/0123456789ab/index.html"),
  createWorkAssetPublishJobId("w/space-id/renamed-slug/0123456789ab/index.html"),
);
assert.equal(
  selectWorkAssetCleanupKey(null, {
    ok: false,
    status: 502,
    message: "work asset storage failed",
    cleanupAssetKey: "w/space-id/renamed-slug/0123456789ab/index.html",
  }),
  "w/space-id/renamed-slug/0123456789ab/index.html",
);
assert.equal(
  selectWorkAssetCleanupKey("w/space-id/renamed-slug/0123456789ab/index.html", {
    ok: false,
    status: 502,
    message: "worker returned an unexpected key",
    cleanupAssetKey: "w/space-id/renamed-slug/fedcba987654/index.html",
  }),
  "w/space-id/renamed-slug/fedcba987654/index.html",
);

console.log("api work asset publish cleanup scope checks passed");
