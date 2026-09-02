import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LocalAcpRuntimeCapabilitiesSchema,
  LocalAcpRuntimeCommandStatusSchema,
  LocalAcpRuntimeRegistrationSchema,
  isAcpJsonRpcNotification,
  isAcpJsonRpcRequest,
  isAcpJsonRpcResponse,
} from "./src/acp-runtime/index.js";

test("ACP runtime capabilities default to native-provider execution", () => {
  assert.deepEqual(LocalAcpRuntimeCapabilitiesSchema.parse({}), {
    sessionLoad: false,
    sessionResume: false,
    sessionCancel: true,
    permissionRequests: true,
    nativeTools: true,
  });
});

test("ACP runtime registration requires a local replica and rejects unknown capabilities", () => {
  const registration = LocalAcpRuntimeRegistrationSchema.parse({
    version: 1,
    runtimeId: "runtime-1",
    spaceId: "space-1",
    replicaId: "replica-1",
    deviceId: "device-1",
    provider: "pi",
    providerVersion: "0.81.1",
    adapterVersion: "pi-acp-0.0.33",
    protocolVersion: 1,
    capabilities: {},
  });
  assert.equal(registration.capabilities.nativeTools, true);
  assert.throws(() => LocalAcpRuntimeRegistrationSchema.parse({
    ...registration,
    capabilities: { providerCommand: "pi-acp" },
  }));
});

test("ACP command states and JSON-RPC direction guards are explicit", () => {
  for (const status of ["prepared", "sent", "completed", "failed", "unknown"] as const) {
    assert.equal(LocalAcpRuntimeCommandStatusSchema.parse(status), status);
  }
  const request = { jsonrpc: "2.0" as const, id: 1, method: "session/prompt" };
  const notification = { jsonrpc: "2.0" as const, method: "session/update" };
  const response = { jsonrpc: "2.0" as const, id: 1, result: { stopReason: "end_turn" } };
  assert.equal(isAcpJsonRpcRequest(request), true);
  assert.equal(isAcpJsonRpcNotification(notification), true);
  assert.equal(isAcpJsonRpcResponse(response), true);
});
