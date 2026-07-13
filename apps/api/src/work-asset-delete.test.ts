import assert from "node:assert/strict";

const { assertDeleteObjectsSucceeded, createCloudflareWorkAssetPrefix, purgeCloudflareWorkAssetPrefixes } = await import(
  "./work-asset-delete.js"
);

assert.equal(
  createCloudflareWorkAssetPrefix(
    "https://works.cohub.run",
    "w/4eb3029c-5113-4de0-9fef-cc42c25431c5/ip-planning-control-room/d404f9484ccc/index.html",
  ),
  "works.cohub.run/w/4eb3029c-5113-4de0-9fef-cc42c25431c5/ip-planning-control-room/d404f9484ccc",
);

assert.equal(assertDeleteObjectsSucceeded(["one", "two"], { Errors: [] }), 2);
assert.throws(
  () =>
    assertDeleteObjectsSucceeded(["one", "two"], {
      Errors: [{ Key: "two", Code: "AccessDenied", Message: "denied" }],
    }),
  /failed to delete 1 work asset object/,
);

let purgeRequest: { url: string; init: RequestInit } | null = null;
await purgeCloudflareWorkAssetPrefixes({
  zoneId: "zone-id",
  apiToken: "api-token",
  prefixes: [
    "works.cohub.run/w/space/work/hash-1",
    "works.cohub.run/w/space/work/hash-2",
    "works.cohub.run/w/space/work/hash-3",
    "works.cohub.run/w/space/work/hash-4",
    "works.cohub.run/w/space/work/hash-5",
    "works.cohub.run/w/space/work/hash-6",
  ],
  fetchImpl: async (url: string, init: RequestInit) => {
    purgeRequest = { url, init };
    return new Response(JSON.stringify({ success: true, errors: [] }), { status: 200 });
  },
});
assert.equal(purgeRequest?.url, "https://api.cloudflare.com/client/v4/zones/zone-id/purge_cache");
assert.equal((purgeRequest?.init.headers as Record<string, string>).Authorization, "Bearer api-token");
assert.deepEqual(JSON.parse(String(purgeRequest?.init.body)), {
  prefixes: [
    "works.cohub.run/w/space/work/hash-1",
    "works.cohub.run/w/space/work/hash-2",
    "works.cohub.run/w/space/work/hash-3",
    "works.cohub.run/w/space/work/hash-4",
    "works.cohub.run/w/space/work/hash-5",
    "works.cohub.run/w/space/work/hash-6",
  ],
});

await assert.rejects(
  purgeCloudflareWorkAssetPrefixes({
    zoneId: "zone-id",
    apiToken: "api-token",
    prefixes: ["works.cohub.run/w/space/work/hash"],
    fetchImpl: async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: "purge failed" }] }), {
        status: 400,
      }),
  }),
  /Cloudflare rejected work asset cache purge/,
);

let largePurgeBody: unknown;
await purgeCloudflareWorkAssetPrefixes({
  zoneId: "zone-id",
  apiToken: "api-token",
  prefixes: Array.from({ length: 31 }, (_, index) => `works.cohub.run/w/space/work/hash-${index}`),
  fetchImpl: async (_url: string, init: RequestInit) => {
    largePurgeBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ success: true, errors: [] }), { status: 200 });
  },
});
assert.deepEqual(largePurgeBody, { hosts: ["works.cohub.run"] });

console.log("api work asset delete checks passed");
