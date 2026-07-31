import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRealtimeAuthExpired,
  realtimeConnectionTtlSeconds,
} from "./realtime-auth-lifetime.js";

test("realtime auth lifetime never extends a token", () => {
  assert.equal(isRealtimeAuthExpired(1_999, 2_000), true);
  assert.equal(isRealtimeAuthExpired(2_001, 2_000), false);
  assert.equal(realtimeConnectionTtlSeconds(undefined, 300, 2_000), 300);
  assert.equal(realtimeConnectionTtlSeconds(12_000, 300, 2_000), 10);
  assert.equal(realtimeConnectionTtlSeconds(1_999, 300, 2_000), 0);
});
