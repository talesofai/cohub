import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalAgentServiceError } from "./local-agent-service.js";
import {
  assertSupportedLocalRuntimeProtocolVersion,
  isSupportedLocalRuntimeProvider,
  shouldFenceLocalRuntimeRegistration,
  validateGatewayWsEndpoint,
} from "./local-runtime-service.js";

test("local runtime protocol validation pins registrations to v1", () => {
  assert.equal(assertSupportedLocalRuntimeProtocolVersion(1), 1);
  assert.throws(
    () => assertSupportedLocalRuntimeProtocolVersion(undefined),
    (error: unknown) => error instanceof LocalAgentServiceError
      && error.code === "unsupported_protocol"
      && error.status === 400,
  );
});

test("local runtime protocol validation rejects unsupported values", () => {
  for (const value of [0, -1, 2, Number.NaN, Number.POSITIVE_INFINITY, "1", null]) {
    assert.throws(
      () => assertSupportedLocalRuntimeProtocolVersion(value),
      (error: unknown) => error instanceof LocalAgentServiceError
        && error.code === "unsupported_protocol"
        && error.status === 400,
    );
  }
});

test("local runtime supports every native provider", () => {
  for (const provider of ["pi", "claude_code", "codex"]) {
    assert.equal(isSupportedLocalRuntimeProvider(provider), true);
  }
  assert.equal(isSupportedLocalRuntimeProvider("unknown"), false);
});

test("runtime registration fences stale active connections but reuses fresh ones", () => {
  const now = Date.now();
  assert.equal(shouldFenceLocalRuntimeRegistration({
    status: "ready",
    lastSeenAt: new Date(now - 1_000),
    replicaChanged: false,
  }), false);
  assert.equal(shouldFenceLocalRuntimeRegistration({
    status: "ready",
    lastSeenAt: new Date(now - 120_000),
    replicaChanged: false,
  }), true);
  assert.equal(shouldFenceLocalRuntimeRegistration({
    status: "ready",
    lastSeenAt: null,
    replicaChanged: false,
  }), true);
  assert.equal(shouldFenceLocalRuntimeRegistration({
    status: "offline",
    lastSeenAt: null,
    replicaChanged: false,
  }), false);
  assert.equal(shouldFenceLocalRuntimeRegistration({
    status: "ready",
    lastSeenAt: new Date(now - 1_000),
    replicaChanged: true,
  }), true);
});

test("gateway peer endpoint validation canonicalizes the trusted relay path", () => {
  assert.equal(
    validateGatewayWsEndpoint(" ws://127.0.0.1:8788/internal/runtime-relay/ "),
    "ws://127.0.0.1:8788/internal/runtime-relay",
  );
  assert.equal(
    validateGatewayWsEndpoint("wss://[::1]:8788/internal/runtime-relay"),
    "wss://[::1]:8788/internal/runtime-relay",
  );
  assert.equal(
    validateGatewayWsEndpoint("wss://gateway.cohub.example/internal/runtime-relay"),
    "wss://gateway.cohub.example/internal/runtime-relay",
  );
  assert.equal(validateGatewayWsEndpoint(null), null);
});

test("gateway peer endpoint validation rejects unsafe or unusable URLs", () => {
  for (const value of [
    "",
    "http://127.0.0.1:8788/internal/runtime-relay",
    "ws://127.0.0.1:8788/anything",
    "ws://127.0.0.1:8788/internal/runtime-relay?runtime=1",
    "ws://user:pass@127.0.0.1:8788/internal/runtime-relay",
    "not a URL",
  ]) {
    assert.throws(
      () => validateGatewayWsEndpoint(value),
      (error: unknown) => error instanceof LocalAgentServiceError
        && error.code === "invalid_gateway_endpoint"
        && error.status === 400,
    );
  }
});
