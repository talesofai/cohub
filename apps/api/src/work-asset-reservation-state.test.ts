import assert from "node:assert/strict";

const {
  getWorkAssetReservationCleanupDecision,
  hasActiveWorkAssetWriterLease,
  shouldDeferWorkAssetCleanupForReferences,
} = await import(
  "./work-asset-reservation-state.js"
);

const now = Date.parse("2026-07-13T10:00:00Z");
assert.equal(getWorkAssetReservationCleanupDecision("committed", now - 1, now), "skip");
assert.equal(getWorkAssetReservationCleanupDecision("cleaned", now - 1, now), "skip");
assert.equal(getWorkAssetReservationCleanupDecision("pending", now + 1, now), "retry");
assert.equal(getWorkAssetReservationCleanupDecision("pending", now, now), "claim");
assert.equal(getWorkAssetReservationCleanupDecision("abandoned", now + 1, now), "claim");
assert.equal(getWorkAssetReservationCleanupDecision("claimed", now + 1, now), "claim");
assert.throws(() => getWorkAssetReservationCleanupDecision("broken", now, now));
assert.equal(hasActiveWorkAssetWriterLease(new Date(now + 1), now), true);
assert.equal(hasActiveWorkAssetWriterLease(new Date(now), now), false);
assert.equal(hasActiveWorkAssetWriterLease(null, now), false);
assert.equal(shouldDeferWorkAssetCleanupForReferences(true, 2, 1), true);
assert.equal(shouldDeferWorkAssetCleanupForReferences(true, 2, 2), false);
assert.equal(shouldDeferWorkAssetCleanupForReferences(false, 2, 1), false);

console.log("api work asset reservation state checks passed");
