import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asAccountIdentity, hasPermission } from "./permissions.js";

describe("asAccountIdentity", () => {
  it("keeps only the account uuid so work/preview scopes cannot leak into account lists", () => {
    const workish = {
      uuid: "user-1",
      workSession: {
        type: "work_session",
        spaceId: "home-space",
        workScopes: ["session.view"],
      },
    };
    assert.deepEqual(asAccountIdentity(workish), { uuid: "user-1" });
    assert.equal(
      Object.keys(asAccountIdentity(workish) as object).join(","),
      "uuid",
    );
  });

  it("does not upgrade preview or execution principals to account permissions", async () => {
    const preview = {
      uuid: "user-1",
      previewSession: { userUuid: "user-1", spaceId: "space-1", scopes: ["file.view"] },
    } as Parameters<typeof hasPermission>[0];
    const execution = {
      uuid: "user-1",
      execution: { actorUserId: "user-1", spaceId: "space-1", scopes: ["file.view"] },
    } as Parameters<typeof hasPermission>[0];

    assert.equal(await hasPermission(preview, "user.session.list", { spaceId: "" }), false);
    assert.equal(await hasPermission(execution, "user.session.list", { spaceId: "" }), false);
    assert.equal(await hasPermission({ uuid: "user-1" }, "user.session.list", { spaceId: "" }), true);
  });

  it("returns null without a usable uuid", () => {
    assert.equal(asAccountIdentity(null), null);
    assert.equal(asAccountIdentity(undefined), null);
    assert.equal(asAccountIdentity({}), null);
    assert.equal(asAccountIdentity({ uuid: "   " }), null);
  });
});
