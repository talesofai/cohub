import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuthUser, RequestPrincipal } from "./lib/middleware.js";
import {
  canManageSpaceInvitations,
  canViewSpaceInvitations,
  invitationAccountUser,
} from "./space-invitation-access.js";

const account = { uuid: "viewer-1" } as AuthUser;
const accountPrincipal: RequestPrincipal = { type: "user", user: account };
const scopedPrincipals: RequestPrincipal[] = [
  {
    type: "work_session",
    workSession: {
      type: "work_session",
      typ: "work_session",
      userUuid: account.uuid,
      workId: "work-1",
      spaceId: "space-1",
      workScopes: ["member.manage"],
      viewerScopes: ["member.manage"],
      scopes: ["member.manage"],
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
      scopes: ["member.manage"],
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
      scopes: ["member.manage"],
      expiresAt: 1,
    },
  },
];

describe("space invitation principal isolation", () => {
  it("rejects scoped-principal replay even when it carries the same user UUID", () => {
    for (const principal of scopedPrincipals) {
      assert.equal(invitationAccountUser(principal), null);
    }
    assert.equal(invitationAccountUser(null), null);
    assert.equal(invitationAccountUser(accountPrincipal), account);
  });

  it("allows invitation management only to a real account host", () => {
    assert.equal(canManageSpaceInvitations(accountPrincipal, "host"), true);
    assert.equal(canManageSpaceInvitations(accountPrincipal, "builder"), false);
    assert.equal(canManageSpaceInvitations(accountPrincipal, "guest"), false);
    for (const principal of scopedPrincipals) {
      assert.equal(canManageSpaceInvitations(principal, "host"), false);
    }
    assert.equal(canManageSpaceInvitations(null, "host"), false);
  });

  it("keeps account member.view separate from host-only management", () => {
    assert.equal(canViewSpaceInvitations(accountPrincipal, true), true);
    assert.equal(canViewSpaceInvitations(accountPrincipal, false), false);
    for (const principal of scopedPrincipals) {
      assert.equal(canViewSpaceInvitations(principal, true), false);
    }
  });
});
