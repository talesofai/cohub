import assert from "node:assert/strict";

const {
  WorkAssetCleanupError,
  collectHistoricalWorkAssetKeys,
  deleteWorkAssetKeys,
  detachWorkWithAssetCleanupScheduled,
  excludeReferencedWorkAssetKeys,
} = await import("./work-delete.js");

const scope = {
  env: "prod" as const,
  spaceId: "4eb3029c-5113-4de0-9fef-cc42c25431c5",
  slug: "ip-planning-control-room",
};
const v1 = `w/${scope.spaceId}/${scope.slug}/d404f9484ccc/index.html`;
const v2 = `w/${scope.spaceId}/${scope.slug}/2786435fdeac/index.html`;
const v3 = `w/${scope.spaceId}/${scope.slug}/025ecf828f70/index.html`;

assert.deepEqual(
  collectHistoricalWorkAssetKeys(
    [
      { id: "version-1", assetKey: v1 },
      { id: "version-2", assetKey: v2 },
      { id: "version-3", assetKey: v3 },
    ],
    "version-3",
    scope,
  ),
  { assetKeys: [v1, v2], versionIds: ["version-1", "version-2"] },
);

const calls: string[] = [];
const cleaned = await deleteWorkAssetKeys(
  [v1, null, v2, v1, undefined],
  scope,
  async (assetKeys: string[]) => {
    calls.push(...assetKeys);
    return { deleted: 5 };
  },
);

assert.deepEqual(calls, [v1, v2]);
assert.deepEqual(cleaned, { assetKeys: 2, objects: 5 });

const attempted: string[] = [];
await assert.rejects(
  deleteWorkAssetKeys(
    [v1, v2, v3],
    scope,
    async (assetKeys: string[]) => {
      attempted.push(...assetKeys);
      throw new Error("storage unavailable");
    },
  ),
  (error: unknown) => {
    assert.ok(error instanceof WorkAssetCleanupError);
    assert.deepEqual(
      error.failures.map((failure: { assetKey: string; message: string }) => failure.assetKey),
      [v1, v2, v3],
    );
    return true;
  },
);
assert.deepEqual(attempted, [v1, v2, v3]);

assert.deepEqual(await deleteWorkAssetKeys([null, undefined], scope, async () => ({ deleted: 1 })), {
  assetKeys: 0,
  objects: 0,
});

let invalidKeyDeleterCalled = false;
await assert.rejects(
  deleteWorkAssetKeys(
    ["w/index.html", `w/another-space/work/0123456789ab/index.html`, `w/${scope.spaceId}/another-work/0123456789ab/index.html`],
    scope,
    async () => {
      invalidKeyDeleterCalled = true;
      return { deleted: 1 };
    },
  ),
  (error: unknown) => error instanceof WorkAssetCleanupError && error.failures.length === 3,
);
assert.equal(invalidKeyDeleterCalled, false);

await assert.rejects(
  deleteWorkAssetKeys([v1], scope, async () => ({ deleted: -1 })),
  (error: unknown) =>
    error instanceof WorkAssetCleanupError && error.failures[0]?.message === "invalid deleted object count",
);

const deleteOrder: string[] = [];
assert.deepEqual(
  await detachWorkWithAssetCleanupScheduled({
    assetKeys: [v1],
    scope,
    scheduleCleanup: async () => {
      deleteOrder.push("schedule");
    },
    deleteRecords: async () => {
      deleteOrder.push("records");
    },
  }),
  { assetKeys: [v1] },
);
assert.deepEqual(deleteOrder, ["schedule", "records"]);

let recordsDeleted = false;
await assert.rejects(
  detachWorkWithAssetCleanupScheduled({
    assetKeys: [v1],
    scope,
    scheduleCleanup: async () => {
      throw new Error("cleanup queue unavailable");
    },
    deleteRecords: async () => {
      recordsDeleted = true;
    },
  }),
  /cleanup queue unavailable/,
);
assert.equal(recordsDeleted, false);

assert.deepEqual(excludeReferencedWorkAssetKeys([v1, v2, v3], [v2, v2, null]), [v1, v3]);

console.log("api work delete asset cleanup checks passed");
