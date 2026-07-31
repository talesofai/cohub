import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asAccountIdentity } from "./permissions.js";

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

  it("returns null without a usable uuid", () => {
    assert.equal(asAccountIdentity(null), null);
    assert.equal(asAccountIdentity(undefined), null);
    assert.equal(asAccountIdentity({}), null);
    assert.equal(asAccountIdentity({ uuid: "   " }), null);
  });

  it("keeps the legacy UUID alias for dual-read account queries", () => {
    assert.deepEqual(asAccountIdentity({ uuid: "logto-sub", legacyUserUuid: "legacy-uuid" }), {
      uuid: "logto-sub",
      legacyUserUuid: "legacy-uuid",
    });
  });
});
