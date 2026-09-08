import assert from "node:assert/strict";
import test from "node:test";

import {
  isTrustedRuntimeRelayEndpoint,
  selectRuntimeRelayEndpoint,
} from "../local-runtime/relay-endpoint.js";

const configured = "wss://gateway.cohub.example/internal/runtime-relay";

test("runtime relay endpoint accepts the configured gateway and private pod addresses", () => {
  assert.equal(isTrustedRuntimeRelayEndpoint(configured, configured), true);
  assert.equal(isTrustedRuntimeRelayEndpoint("wss://10.42.0.17:443/internal/runtime-relay", configured), true);
  assert.equal(isTrustedRuntimeRelayEndpoint("wss://[fd00::17]:443/internal/runtime-relay", configured), true);
  assert.equal(isTrustedRuntimeRelayEndpoint("wss://localhost:443/internal/runtime-relay", configured), false);
});

test("runtime relay endpoint rejects public, credentialed, and malformed coordinates", () => {
  for (const value of [
    "wss://attacker.example/internal/runtime-relay",
    "wss://8.8.8.8:443/internal/runtime-relay",
    "wss://169.254.169.254:443/internal/runtime-relay",
    "wss://localhost:443/internal/runtime-relay",
    "wss://10.42.0.17:8443/internal/runtime-relay",
    "wss://10.42.0.17:443/internal/runtime-relay?channel=stolen",
    "wss://user:secret@10.42.0.17:443/internal/runtime-relay",
    "https://10.42.0.17:443/internal/runtime-relay",
    "wss://10.42.0.17:443/internal/other",
  ]) {
    assert.equal(isTrustedRuntimeRelayEndpoint(value, configured), false, value);
  }
  assert.equal(isTrustedRuntimeRelayEndpoint("wss://localhost:443/internal/runtime-relay", "wss://localhost:443/internal/runtime-relay"), true);
});

test("untrusted persisted endpoint falls back to the configured relay", () => {
  assert.equal(
    selectRuntimeRelayEndpoint("wss://attacker.example/internal/runtime-relay", configured),
    configured,
  );
  assert.throws(
    () => selectRuntimeRelayEndpoint("wss://10.42.0.17/internal/runtime-relay", "not-a-url"),
    /configured local runtime relay URL is invalid/,
  );
});
