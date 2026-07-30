import assert from "node:assert/strict";
import test from "node:test";
import { resolveMessageTurnId } from "./message-turn-id.js";

const TURN_ID = "33333333-3333-4333-8333-333333333333";

test("resolveMessageTurnId normalizes a valid metadata turn id", () => {
  assert.equal(resolveMessageTurnId({ turnId: ` ${TURN_ID.toUpperCase()} ` }), TURN_ID);
});

test("resolveMessageTurnId rejects missing and malformed metadata turn ids", () => {
  assert.equal(resolveMessageTurnId(null), null);
  assert.equal(resolveMessageTurnId({}), null);
  assert.equal(resolveMessageTurnId({ turnId: 42 }), null);
  assert.equal(resolveMessageTurnId({ turnId: "not-a-uuid" }), null);
});
