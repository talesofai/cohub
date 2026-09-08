import assert from "node:assert/strict";
import test from "node:test";

import { commandMayReuseExecutionAttempt } from "../local-runtime/ledger-policy.js";

test("only session.open commands are reusable across execution attempts", () => {
  assert.equal(commandMayReuseExecutionAttempt("session.open"), true);
  assert.equal(commandMayReuseExecutionAttempt("session.resume"), false);
  assert.equal(commandMayReuseExecutionAttempt("session.close"), false);
  assert.equal(commandMayReuseExecutionAttempt("turn.start"), false);
  assert.equal(commandMayReuseExecutionAttempt("turn.cancel"), false);
});
