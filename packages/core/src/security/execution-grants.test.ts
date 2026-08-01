import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionGrantService } from "./execution-grants.js";

test("execution grants preserve account versus restricted authorization mode", async () => {
  const service = createExecutionGrantService({ signingKey: "test-signing-key" });
  const restricted = await service.createExecutionGrant({
    actorUserId: "user-1",
    spaceId: "space-1",
    sessionId: "session-1",
    turnId: "turn-1",
    source: "prompt",
    scopes: [],
    authorizationMode: "restricted",
  });
  const account = await service.createExecutionGrant({
    actorUserId: "user-1",
    spaceId: "space-1",
    sessionId: "session-1",
    turnId: "turn-1",
    source: "prompt",
    scopes: [],
    authorizationMode: "account",
  });

  assert.equal((await service.verifyExecutionGrant(restricted.token))?.authorizationMode, "restricted");
  assert.equal((await service.verifyExecutionGrant(account.token))?.authorizationMode, "account");
});
