import assert from "node:assert/strict";
import { test } from "node:test";
import type { PromptAuthContext } from "@cohub/core/sessions";
import { requireDelegatedTaskAuth, resolveScheduledPromptAuth } from "../src/work-viewer-prompt-auth.js";

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

const activeGrant = {
  scopes: ["session.prompt.fullaccess", "user.session.list"],
  expiresAt: new Date(now + 30_000),
  revokedAt: null,
  workStatus: "published",
  workSpaceId: "space-1",
  workScopes: ["space.view"],
  allowedViewerScopes: ["session.prompt.fullaccess", "user.session.list"],
};

test("delegated worker tasks fail closed when their authorization is missing", () => {
  assert.equal(requireDelegatedTaskAuth(false, null), null);
  assert.throws(
    () => requireDelegatedTaskAuth(true, null),
    /authorization is missing/,
  );
  assert.equal(requireDelegatedTaskAuth(true, auth), auth);
});

test("Work generation tasks revalidate generation.create against the active grant", async () => {
  const generationAuth: PromptAuthContext = {
    ...auth,
    scopes: ["space.view", "generation.create"],
    viewerScopes: ["generation.create"],
  };
  const resolved = await resolveScheduledPromptAuth(
    generationAuth,
    { spaceId: "space-1", userId: "viewer-1", requiredPermission: "generation.create" },
    async () => ({
      ...activeGrant,
      scopes: ["generation.create"],
      allowedViewerScopes: ["generation.create"],
    }),
    now,
  );
  assert.deepEqual(resolved?.viewerScopes, ["generation.create"]);

  await assert.rejects(
    resolveScheduledPromptAuth(
      generationAuth,
      { spaceId: "space-1", userId: "viewer-1", requiredPermission: "generation.create" },
      async () => ({
        ...activeGrant,
        expiresAt: new Date(now - 1),
        scopes: ["generation.create"],
        allowedViewerScopes: ["generation.create"],
      }),
      now,
    ),
    /no longer active/,
  );
});

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
      return activeGrant;
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
      ...activeGrant,
      expiresAt: new Date(now + 1_000),
      revokedAt: new Date(now - 1),
    }), now),
    /no longer active/,
  );
  await assert.rejects(
    resolveScheduledPromptAuth(auth, input, async () => ({
      ...activeGrant,
      expiresAt: new Date(now - 1),
    }), now),
    /no longer active/,
  );
  await assert.rejects(
    resolveScheduledPromptAuth(auth, input, async () => ({
      ...activeGrant,
      scopes: ["generation.create"],
    }), now),
    /no longer allows/,
  );
});

test("scheduled Work prompts stop after the Work is disabled or its policy shrinks", async () => {
  const input = {
    spaceId: "space-1",
    userId: "viewer-1",
    requiredPermission: "session.prompt.fullaccess" as const,
  };
  await assert.rejects(
    resolveScheduledPromptAuth(auth, input, async () => ({
      ...activeGrant,
      workStatus: "disabled",
    }), now),
    /Work is no longer active/,
  );
  await assert.rejects(
    resolveScheduledPromptAuth(auth, input, async () => ({
      ...activeGrant,
      allowedViewerScopes: ["user.session.list"],
    }), now),
    /no longer allows/,
  );
});
