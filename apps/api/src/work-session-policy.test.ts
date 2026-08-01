import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveActiveWorkSessionPolicy } from "./work-session-policy.js";

const token = {
  spaceId: "space-1",
  workScopes: ["space.view", "file.view"],
  viewerScopes: ["generation.create", "user.session.list"],
};

describe("resolveActiveWorkSessionPolicy", () => {
  it("intersects token scopes with the current published Work policy", () => {
    assert.deepEqual(resolveActiveWorkSessionPolicy(token, {
      status: "published",
      spaceId: "space-1",
      workScopes: ["space.view"],
      allowedViewerScopes: ["generation.create"],
    }), {
      workScopes: ["space.view"],
      allowedViewerScopes: ["generation.create"],
    });
  });

  it("invalidates tokens for disabled, deleted, or differently bound Works", () => {
    assert.equal(resolveActiveWorkSessionPolicy(token, null), null);
    assert.equal(resolveActiveWorkSessionPolicy(token, {
      status: "disabled",
      spaceId: "space-1",
      workScopes: ["space.view"],
      allowedViewerScopes: ["generation.create"],
    }), null);
    assert.equal(resolveActiveWorkSessionPolicy(token, {
      status: "published",
      spaceId: "space-2",
      workScopes: ["space.view"],
      allowedViewerScopes: ["generation.create"],
    }), null);
  });
});
