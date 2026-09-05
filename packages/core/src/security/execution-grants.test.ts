import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createExecutionGrantService } from "./execution-grants.js";

describe("execution grants", () => {
  it("round-trips optional App Action context", async () => {
    const service = createExecutionGrantService({ signingKey: "test-key" });
    const grant = await service.createExecutionGrant({
      actorUserId: "owner-1",
      viewerUserId: "viewer-1",
      appId: "app-1",
      appVersionId: "version-1",
      action: "summarize",
      taskRunId: "task-1",
      spaceId: "space-1",
      sessionId: null,
      turnId: null,
      source: "app_action",
      scopes: ["generation.create"],
    });

    const payload = await service.verifyExecutionGrant(grant.token);
    assert.equal(payload?.actorUserId, "owner-1");
    assert.equal(payload?.viewerUserId, "viewer-1");
    assert.equal(payload?.appId, "app-1");
    assert.equal(payload?.appVersionId, "version-1");
    assert.equal(payload?.action, "summarize");
    assert.equal(payload?.taskRunId, "task-1");
    assert.equal(payload?.source, "app_action");
  });
});
