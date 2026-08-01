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

  it("returns null without a usable uuid", () => {
    assert.equal(asAccountIdentity(null), null);
    assert.equal(asAccountIdentity(undefined), null);
    assert.equal(asAccountIdentity({}), null);
    assert.equal(asAccountIdentity({ uuid: "   " }), null);
  });

  it("treats a scoped execution grant as a hard permission boundary", async () => {
    const executionUser = {
      uuid: "user-1",
      execution: { spaceId: "space-a", scopes: ["session.view"] },
    };
    assert.equal(await hasPermission(executionUser, "session.view", { spaceId: "space-a" }), true);
    assert.equal(await hasPermission(executionUser, "session.prompt.fullaccess", { spaceId: "space-a" }), false);
    assert.equal(await hasPermission(executionUser, "session.view", { spaceId: "space-b" }), false);
  });

  it("does not turn an empty restricted grant into account access", async () => {
    const restrictedUser = {
      uuid: "user-1",
      execution: { spaceId: "space-a", scopes: [], authorizationMode: "restricted" as const },
    };
    assert.equal(await hasPermission(restrictedUser, "session.prompt.fullaccess", { spaceId: "space-a" }), false);
    assert.equal(await hasPermission(restrictedUser, "session.view", { spaceId: "space-b" }), false);
  });
});
