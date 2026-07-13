import assert from "node:assert/strict";

const { WORK_ASSET_S3_REQUEST_HANDLER_OPTIONS } = await import("./request-timeout.js");

assert.deepEqual(WORK_ASSET_S3_REQUEST_HANDLER_OPTIONS, {
  connectionTimeout: 10_000,
  requestTimeout: 60_000,
  throwOnRequestTimeout: true,
});

console.log("worker work asset S3 request timeout checks passed");
