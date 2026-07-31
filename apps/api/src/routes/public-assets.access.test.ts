import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuthUser, RequestPrincipal } from "../lib/middleware.js";
import { resolvePublicAssetUploadActor } from "../public-asset-access.js";

const account = { uuid: "viewer-1" } as AuthUser;
const work: RequestPrincipal = {
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
};

describe("public asset upload principal isolation", () => {
  it("keeps every upload purpose available to the real account", () => {
    const principal: RequestPrincipal = { type: "user", user: account };
    assert.deepEqual(
      resolvePublicAssetUploadActor(principal, { purpose: "user_avatar" }),
      { userUuid: account.uuid, workSpaceId: null },
    );
    assert.deepEqual(
      resolvePublicAssetUploadActor(principal, { purpose: "chat_attachment", spaceId: "space-2" }),
      { userUuid: account.uuid, workSpaceId: null },
    );
  });

  it("allows a Work to request only chat attachments in its bound Space", () => {
    assert.deepEqual(
      resolvePublicAssetUploadActor(work, { purpose: "chat_attachment", spaceId: "space-1" }),
      { userUuid: account.uuid, workSpaceId: "space-1" },
    );
    assert.equal(resolvePublicAssetUploadActor(work, { purpose: "user_avatar", spaceId: "space-1" }), null);
    assert.equal(resolvePublicAssetUploadActor(work, { purpose: "chat_attachment", spaceId: "space-2" }), null);
    assert.equal(resolvePublicAssetUploadActor(work, { purpose: "chat_attachment" }), null);
  });

  it("rejects preview and execution principals even when their UUID matches", () => {
    const preview: RequestPrincipal = {
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
    };
    const execution: RequestPrincipal = {
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
    };
    const input = { purpose: "chat_attachment" as const, spaceId: "space-1" };
    assert.equal(resolvePublicAssetUploadActor(preview, input), null);
    assert.equal(resolvePublicAssetUploadActor(execution, input), null);
    assert.equal(resolvePublicAssetUploadActor(null, input), null);
  });
});
