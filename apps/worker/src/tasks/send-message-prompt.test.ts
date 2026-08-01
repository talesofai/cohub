import assert from "node:assert/strict";
import test from "node:test";
import { requireScheduledPromptAuth } from "./send-message-prompt.js";

const input = { spaceId: "space-id", userId: "user-id" };

test("scheduled prompts reject expired delegated authorization", () => {
  assert.throws(() => requireScheduledPromptAuth({
    type: "delegated_prompt",
    source: "work_session",
    actorUserId: input.userId,
    spaceId: input.spaceId,
    scopes: ["session.prompt.fullaccess"],
    workScopes: ["session.prompt.fullaccess"],
    viewerScopes: [],
    delegatedAt: new Date(0).toISOString(),
    exp: 1,
  }, input), /invalid or expired/);
});

test("scheduled prompts keep a valid delegated authorization", () => {
  const auth = {
    type: "delegated_prompt" as const,
    source: "work_session",
    actorUserId: input.userId,
    spaceId: input.spaceId,
    scopes: ["session.prompt.fullaccess"],
    workScopes: ["session.prompt.fullaccess"],
    viewerScopes: [],
    delegatedAt: new Date().toISOString(),
    exp: Math.floor(Date.now() / 1000) + 60,
  };
  assert.equal(requireScheduledPromptAuth(auth, input), auth);
});
