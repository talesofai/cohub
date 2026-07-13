import assert from "node:assert/strict";

const {
  assertWorkAssetWriterLeaseResponse,
  getWorkAssetWriterLeaseExpiresAt,
  isWorkAssetWriterLeaseUsable,
} = await import(
  "./writer-lease-response.js"
);

assert.deepEqual(assertWorkAssetWriterLeaseResponse({ ok: true, leaseMs: 120000 }), {
  ok: true,
  leaseMs: 120000,
});
assert.throws(() => assertWorkAssetWriterLeaseResponse({ ok: true, leaseMs: 0 }));
assert.throws(() => assertWorkAssetWriterLeaseResponse({ ok: false }));
assert.equal(isWorkAssetWriterLeaseUsable(120000, 0, 70000), true);
assert.equal(isWorkAssetWriterLeaseUsable(70000, 0, 70000), false);
assert.equal(isWorkAssetWriterLeaseUsable(69999, 0, 70000), false);
assert.equal(getWorkAssetWriterLeaseExpiresAt(1000, 120000), 121000);
assert.notEqual(getWorkAssetWriterLeaseExpiresAt(1000, 120000), 151000);

console.log("worker work asset writer lease response checks passed");
