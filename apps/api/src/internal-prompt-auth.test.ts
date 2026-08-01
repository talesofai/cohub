import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveInternalPromptActor } from "./internal-prompt-auth.js";
import type { WorkSessionPrincipal } from "./work-sessions.js";

const workSession: WorkSessionPrincipal = {
  type: "work_session",
  typ: "work_session",
  userUuid: "viewer-1",
  workId: "work-1",
  spaceId: "space-1",
  workScopes: [],
  viewerScopes: ["session.prompt.fullaccess"],
  scopes: ["session.prompt.fullaccess"],
  iat: 1,
  exp: 2,
};

test("internal Work prompts never downgrade an invalid token into an account", () => {
  const input = {
    principalType: "work_session" as const,
    userId: "viewer-1",
    authToken: "work-token",
  };
  assert.equal(resolveInternalPromptActor(input, () => null), null);
  assert.equal(resolveInternalPromptActor(
    input,
    () => ({ ...workSession, userUuid: "viewer-2" }),
  ), null);
  assert.equal(resolveInternalPromptActor(input, () => workSession)?.principal.type, "work_session");
});

test("internal account prompts retain a real user principal", () => {
  const resolved = resolveInternalPromptActor({
    principalType: "user",
    userId: "viewer-1",
    authToken: "account-token",
    accountUser: { uuid: "viewer-1" },
  }, () => null);
  assert.deepEqual(resolved?.principal, { type: "user", user: { uuid: "viewer-1" } });
});

test("internal account prompts reject an unverified or mismatched user token", () => {
  assert.equal(resolveInternalPromptActor({
    principalType: "user",
    userId: "viewer-1",
    authToken: "account-token",
  }, () => null), null);
  assert.equal(resolveInternalPromptActor({
    principalType: "user",
    userId: "viewer-1",
    authToken: "account-token",
    accountUser: { uuid: "viewer-2" },
  }, () => null), null);
});
