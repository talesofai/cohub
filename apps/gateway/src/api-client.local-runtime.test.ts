import assert from "node:assert/strict";
import test from "node:test";
import { authorizeLocalRuntime, disconnectLocalRuntime, touchLocalRuntime } from "./api-client.js";

test("local runtime control requests carry only authoritative connection fields", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      path: url.pathname,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    if (url.pathname.endsWith("/authorize")) {
      return Response.json({
        ok: true,
        runtimeId: "runtime-1",
        spaceId: "space-1",
        replicaId: "replica-1",
        provider: "codex",
        connectionEpoch: 7,
      });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;

  try {
    const authorized = await authorizeLocalRuntime({
      authToken: "device-token",
      runtimeId: "runtime-1",
      spaceId: "space-1",
      gatewayNodeId: "gateway-1",
      gatewayWsEndpoint: "ws://127.0.0.1:8788/internal/runtime-relay",
    });
    assert.equal(authorized.ok, true);
    await touchLocalRuntime({
      authToken: "device-token",
      runtimeId: "runtime-1",
      connectionEpoch: 7,
    });
    await disconnectLocalRuntime({
      authToken: "device-token",
      runtimeId: "runtime-1",
      connectionEpoch: 7,
      reason: "runtime connection closed",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    {
      path: "/internal/gateway/local-runtime/authorize",
      body: {
        runtimeId: "runtime-1",
        spaceId: "space-1",
        gatewayNodeId: "gateway-1",
        gatewayWsEndpoint: "ws://127.0.0.1:8788/internal/runtime-relay",
      },
    },
    {
      path: "/internal/gateway/local-runtime/heartbeat",
      body: { runtimeId: "runtime-1", connectionEpoch: 7 },
    },
    {
      path: "/internal/gateway/local-runtime/disconnect",
      body: { runtimeId: "runtime-1", connectionEpoch: 7, reason: "runtime connection closed" },
    },
  ]);
});
