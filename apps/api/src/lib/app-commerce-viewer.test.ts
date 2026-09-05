import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canTargetCommerceViewer,
  resolveCommerceViewerUserId,
} from "./app-commerce-viewer.js";

const actionExecution = {
  source: "app_action",
  appId: "app-1",
  viewerUserId: "viewer-1",
};

describe("App Action Commerce viewer", () => {
  it("uses the bound viewer only for the matching App", () => {
    assert.equal(resolveCommerceViewerUserId(actionExecution, "app-1", "owner-1"), "viewer-1");
    assert.equal(resolveCommerceViewerUserId(actionExecution, "app-2", "owner-1"), null);
    assert.equal(
      resolveCommerceViewerUserId({ ...actionExecution, viewerUserId: null }, "app-1", "owner-1"),
      null,
    );
    assert.equal(resolveCommerceViewerUserId(null, "app-1", "user-1"), "user-1");
  });

  it("prevents an App Action from targeting another user", () => {
    assert.equal(canTargetCommerceViewer(actionExecution, "viewer-1", null), true);
    assert.equal(canTargetCommerceViewer(actionExecution, "viewer-1", "viewer-1"), true);
    assert.equal(canTargetCommerceViewer(actionExecution, "viewer-1", "viewer-2"), false);
    assert.equal(canTargetCommerceViewer(null, "owner-1", "viewer-2"), true);
  });
});
