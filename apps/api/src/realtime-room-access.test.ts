import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthUser, RequestPrincipal } from "./lib/middleware.js";
import { spaceRoomReadPermission } from "./realtime-room-access.js";

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
