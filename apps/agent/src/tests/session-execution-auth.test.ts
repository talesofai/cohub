import assert from "node:assert/strict";
import {
  clearCurrentSessionExecutionAuth,
  getCurrentSessionExecutionAuth,
  setCurrentSessionExecutionAuth,
} from "../runtime/session-execution-auth.js";

const sessionId = "session-1";
const turnId = "turn-1";

setCurrentSessionExecutionAuth({
  sessionId,
  turnId,
  actorUserId: "user-1",
  executionToken: "token-1",
  executionScopes: [],
});

assert.equal(getCurrentSessionExecutionAuth(sessionId, turnId)?.executionToken, "token-1");
assert.equal(getCurrentSessionExecutionAuth(sessionId, "turn-2"), null);

clearCurrentSessionExecutionAuth(sessionId);
assert.equal(getCurrentSessionExecutionAuth(sessionId, turnId), null);

console.log("session execution auth isolation checks passed");
