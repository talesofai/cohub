import assert from "node:assert/strict";
import { test } from "node:test";
import type { PromptAuthContext } from "@cohub/core/sessions";
import { resolveScheduledPromptAuth } from "../src/work-viewer-prompt-auth.js";

const now = Date.UTC(2026, 6, 31);
const auth: PromptAuthContext = {
  type: "delegated_prompt",
  source: "work_session",
  actorUserId: "viewer-1",
  workId: "work-1",
  spaceId: "space-1",
  scopes: ["space.view", "session.prompt.fullaccess"],
  workScopes: ["space.view"],
  viewerScopes: ["session.prompt.fullaccess"],
  delegatedAt: new Date(now - 1_000).toISOString(),
  exp: Math.floor((now + 60_000) / 1000),
  workViewerGrantId: "grant-1",
};

test("scheduled Work prompts revalidate the exact active grant", async () => {
  const calls: unknown[] = [];
  const resolved = await resolveScheduledPromptAuth(
    auth,
    {
      spaceId: "space-1",
      userId: "viewer-1",
      requiredPermission: "session.prompt.fullaccess",
    },
    async (input) => {
      calls.push(input);
      return {
        scopes: ["session.prompt.fullaccess", "user.session.list"],
        expiresAt: new Date(now + 30_000),
        revokedAt: null,
      };
    },
    now,
  );
  assert.deepEqual(calls, [{
    grantId: "grant-1",
    workId: "work-1",
    spaceId: "space-1",
    viewerUserUuid: "viewer-1",
  }]);
  assert.deepEqual(resolved?.viewerScopes, ["session.prompt.fullaccess"]);
  assert.equal(resolved?.scopes.includes("user.session.list"), false);
});

test("scheduled Work prompts stop after revoke, expiry, or scope removal", async () => {
  const input = {
    spaceId: "space-1",
    userId: "viewer-1",
    requiredPermission: "session.prompt.fullaccess" as const,
  };
  await assert.rejects(
    resolveScheduledPromptAuth(auth, input, async () => ({
      scopes: ["session.prompt.fullaccess"],
      expiresAt: new Date(now + 1_000),
      revokedAt: new Date(now - 1),
    }), now),
    /no longer active/,
  );
  await assert.rejects(
    resolveScheduledPromptAuth(auth, input, async () => ({
      scopes: ["session.prompt.fullaccess"],
      expiresAt: new Date(now - 1),
      revokedAt: null,
    }), now),
    /no longer active/,
  );
  await assert.rejects(
    resolveScheduledPromptAuth(auth, input, async () => ({
      scopes: ["generation.create"],
      expiresAt: new Date(now + 1_000),
      revokedAt: null,
    }), now),
    /no longer allows/,
  );
});
