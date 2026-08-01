import assert from "node:assert/strict";
import { test } from "node:test";
import { projectSpaceInvitation } from "./space-invitation-view.js";

const invitation = {
  token: "inv_host_secret",
  role: "host" as const,
  status: "active",
  useCount: 0,
  maxUses: 1,
  createdAt: "2026-07-31T00:00:00.000Z",
  expiresInSeconds: 60,
};

test("member.view invitation summaries never expose bearer tokens", () => {
  const summary = projectSpaceInvitation(invitation, false);
  assert.equal("token" in summary, false);
  assert.match(summary.id, /^invite_[A-Za-z0-9_-]{43}$/);
  assert.equal(summary.role, "host");
  const managed = projectSpaceInvitation(invitation, true);
  assert.equal(managed.id, summary.id);
  assert.equal("token" in managed ? managed.token : null, invitation.token);
});
