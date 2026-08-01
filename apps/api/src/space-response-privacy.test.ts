import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sanitizeRepoUrl,
  sanitizeSpaceMeta,
  stripSensitiveSpaceFields,
} from "./space-response-privacy.js";

test("space metadata strips repository credentials", () => {
  assert.equal(
    sanitizeRepoUrl("https://user:pass@example.com/repo.git"),
    "https://example.com/repo.git",
  );
  const meta = sanitizeSpaceMeta({
    bootstrap: {
      source: { type: "git_repo", repoUrl: "https://user:pass@example.com/repo.git" },
    },
  });
  assert.ok(meta);
  assert.equal(
    (meta.bootstrap as { source: { repoUrl: string } }).source.repoUrl,
    "https://example.com/repo.git",
  );
});

test("Work space responses keep meta but omit private fields", () => {
  const response = stripSensitiveSpaceFields({
    id: "space-1",
    meta: {
      publicProfile: { avatarUrl: "https://example.com/avatar.png" },
      extraEnv: [{ key: "TOKEN", value: "secret" }],
      config: { sandbox: { spec: "large" } },
      privateNote: "owner-only",
      bootstrap: {
        status: "ready",
        errorMessage: "private failure details",
        source: { type: "git_repo", repoUrl: "https://user:pass@example.com/repo.git", ref: "main" },
      },
    },
  });
  assert.deepEqual(response.meta, {
    publicProfile: { avatarUrl: "https://example.com/avatar.png" },
    bootstrap: {
      status: "ready",
      source: { type: "git_repo", repoUrl: "https://example.com/repo.git", ref: "main" },
    },
  });
  assert.equal("storageRepoName" in response, false);
});
