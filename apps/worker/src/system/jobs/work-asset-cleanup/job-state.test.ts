import assert from "node:assert/strict";

const { isWorkAssetPublishJobTerminal } = await import("./job-state.js");

assert.equal(isWorkAssetPublishJobTerminal("completed"), true);
assert.equal(isWorkAssetPublishJobTerminal("failed"), true);
assert.equal(isWorkAssetPublishJobTerminal("active"), false);
assert.equal(isWorkAssetPublishJobTerminal("waiting"), false);
assert.equal(isWorkAssetPublishJobTerminal("delayed"), false);
assert.equal(isWorkAssetPublishJobTerminal("prioritized"), false);
assert.equal(isWorkAssetPublishJobTerminal("waiting-children"), false);
assert.equal(isWorkAssetPublishJobTerminal("unknown"), false);

console.log("worker work asset cleanup job state checks passed");
