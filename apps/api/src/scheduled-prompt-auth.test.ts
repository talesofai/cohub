import assert from "node:assert/strict";
import { test } from "node:test";
import type { PromptAuthContext } from "@cohub/core/sessions";
import {
  SCHEDULED_PROMPT_AUTH_MARGIN_MS,
  scheduledPromptAuthCoversExecution,
} from "./scheduled-prompt-auth.js";

const delegatedAuth = (expiresAtMs: number): PromptAuthContext => ({
  type: "delegated_prompt",
  source: "work_session",
  actorUserId: "viewer",
  workId: "work",
  spaceId: "space",
  scopes: ["session.prompt.create"],
  workScopes: ["session.prompt.create"],
  viewerScopes: [],
  delegatedAt: new Date(0).toISOString(),
  exp: expiresAtMs / 1000,
  workViewerGrantId: "grant",
});

test("scheduled Work prompts must start before delegated authorization expires", () => {
  const scheduledAt = new Date("2026-07-30T12:00:00.000Z");
  assert.equal(scheduledPromptAuthCoversExecution(null, scheduledAt), true);
  assert.equal(
    scheduledPromptAuthCoversExecution(
      delegatedAuth(scheduledAt.getTime() + SCHEDULED_PROMPT_AUTH_MARGIN_MS),
      scheduledAt,
    ),
    false,
  );
  assert.equal(
    scheduledPromptAuthCoversExecution(
      delegatedAuth(scheduledAt.getTime() + SCHEDULED_PROMPT_AUTH_MARGIN_MS + 1),
      scheduledAt,
    ),
    true,
  );
});
