import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeSpaceMeta } from "./space-response-sanitize.js";

describe("sanitizeSpaceMeta", () => {
  it("removes environment values and bootstrap credentials", () => {
    assert.deepEqual(
      sanitizeSpaceMeta({
        extraEnv: [{ name: "GITHUB_TOKEN", value: "secret" }],
        config: { sandbox: { spec: "standard" } },
        bootstrap: {
          status: "ready",
          source: {
            type: "git_repo",
            repoUrl: "https://user:password@example.com/org/repo.git",
            gitToken: "secret-token",
            ref: "main",
          },
        },
      }),
      {
        config: { sandbox: { spec: "standard" } },
        bootstrap: {
          status: "ready",
          source: {
            type: "git_repo",
            repoUrl: "https://example.com/org/repo.git",
            ref: "main",
          },
        },
      },
    );
  });

  it("normalizes absent metadata", () => {
    assert.equal(sanitizeSpaceMeta(null), null);
  });
});
