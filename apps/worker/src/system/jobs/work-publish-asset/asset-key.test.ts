import assert from "node:assert/strict";

const { resolveWorkAssetObjectKey, usesReservedWorkAssetProtocol } = await import("./asset-key.js");

let generated = 0;
assert.equal(
  resolveWorkAssetObjectKey("w/space/work/0123456789ab/index.html", () => {
    generated += 1;
    return "legacy";
  }),
  "w/space/work/0123456789ab/index.html",
);
assert.equal(generated, 0);
assert.equal(resolveWorkAssetObjectKey(undefined, () => "legacy"), "legacy");
assert.equal(usesReservedWorkAssetProtocol("reserved"), true);
assert.equal(usesReservedWorkAssetProtocol(undefined), false);

console.log("worker work asset publish protocol compatibility checks passed");
