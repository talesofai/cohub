import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accountUserFromPrincipal, type AuthUser, type RequestPrincipal } from "./middleware.js";

const account = { uuid: "viewer-1" } as AuthUser;

describe("account principal isolation", () => {
  it("accepts only the real account principal", () => {
    const principals: RequestPrincipal[] = [
      { type: "user", user: account },
      {
        type: "work_session",
        workSession: {
          type: "work_session",
          typ: "work_session",
          userUuid: account.uuid,
          workId: "work-1",
          spaceId: "space-1",
          workScopes: [],
          viewerScopes: [],
          scopes: [],
          iat: 0,
          exp: 1,
        },
      },
      {
        type: "preview_session",
        previewSession: {
          type: "preview_session",
          typ: "preview_session",
          userUuid: account.uuid,
          spaceId: "space-1",
          scopes: [],
          iat: 0,
          exp: 1,
        },
      },
      {
        type: "execution",
        execution: {
          type: "execution",
          actorUserId: account.uuid,
          spaceId: "space-1",
          sessionId: null,
          turnId: null,
          source: "test",
          scopes: [],
          expiresAt: 1,
        },
      },
    ];

    assert.equal(accountUserFromPrincipal(principals[0]), account);
    assert.equal(accountUserFromPrincipal(principals[1]), null);
    assert.equal(accountUserFromPrincipal(principals[2]), null);
    assert.equal(accountUserFromPrincipal(principals[3]), null);
    assert.equal(accountUserFromPrincipal(null), null);
  });
});
