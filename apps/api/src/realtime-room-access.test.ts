import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthUser, RequestPrincipal } from "./lib/middleware.js";
import { filterReadableSpaceRoomIds, spaceRoomReadPermission } from "./realtime-room-access.js";

test("only account principals can subscribe to mixed Space rooms", () => {
  const account: RequestPrincipal = {
    type: "user",
    user: { uuid: "viewer-1" } as AuthUser,
  };
  const work: RequestPrincipal = {
    type: "work_session",
    workSession: {
      type: "work_session",
      typ: "work_session",
      userUuid: "viewer-1",
      workId: "work-1",
      spaceId: "space-1",
      workScopes: ["space.view"],
      viewerScopes: [],
      scopes: ["space.view"],
      iat: 0,
      exp: 1,
    },
  };

  assert.equal(spaceRoomReadPermission(account), "space.view");
  assert.equal(spaceRoomReadPermission(work), null);
  assert.equal(spaceRoomReadPermission(null), null);
});

test("account Space rooms use policy-aware space.view authorization", async () => {
  const account: RequestPrincipal = {
    type: "user",
    user: { uuid: "viewer-1" } as AuthUser,
  };
  const calls: Array<{ permission: string; spaceIds: string[] }> = [];
  const allowed = await filterReadableSpaceRoomIds(account, ["public-space", "private-space"], async (permission, spaceIds) => {
    calls.push({ permission, spaceIds });
    return ["public-space"];
  });

  assert.deepEqual(calls, [{ permission: "space.view", spaceIds: ["public-space", "private-space"] }]);
  assert.deepEqual(allowed, ["public-space"]);
});
