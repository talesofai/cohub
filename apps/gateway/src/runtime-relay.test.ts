import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { WebSocket } from "ws";
import {
  claimPendingRuntimePeer,
  decodeRelayPathSegment,
  parseRuntimeOpenFrame,
  waitForRuntimeOpenFrame,
  RUNTIME_OPEN_BUFFER_MAX_BYTES,
  RUNTIME_OPEN_FRAME_MAX_BYTES,
  parseRuntimeDataRoute,
  signRuntimeDataRoute,
  normalizeRuntimeProxyCloseCode,
  runtimeDataRouteKey,
  runtimeChannelBindingsEqual,
  type RuntimeChannelBinding,
} from "./runtime-relay.js";

const binding: RuntimeChannelBinding = {
  executionAttemptId: "11111111-1111-4111-8111-111111111111",
  spaceId: "22222222-2222-4222-8222-222222222222",
  replicaId: "33333333-3333-4333-8333-333333333333",
  connectionEpoch: 4,
  baseSnapshotId: "44444444-4444-4444-8444-444444444444",
  leaseEpoch: 7,
  leaseExpiresAt: "2026-09-07T12:00:00.000Z",
};

class FakeRuntimeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = this.OPEN;
}

test("runtime data channel claim is one-shot under concurrent callers", async () => {
  const pending = { claimed: false };
  const results = await Promise.all(
    Array.from({ length: 128 }, () => Promise.resolve().then(() => claimPendingRuntimePeer(pending))),
  );
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(pending.claimed, true);
  assert.equal(claimPendingRuntimePeer(pending), false);
});

test("runtime channel binding equality covers every fencing field", () => {
  assert.equal(runtimeChannelBindingsEqual(binding, { ...binding }), true);
  for (const field of [
    "executionAttemptId",
    "spaceId",
    "replicaId",
    "connectionEpoch",
    "baseSnapshotId",
    "leaseEpoch",
    "leaseExpiresAt",
  ] as const) {
    const changed = { ...binding, [field]: field === "connectionEpoch" || field === "leaseEpoch" ? binding[field] + 1 : `${binding[field]}-changed` };
    assert.equal(runtimeChannelBindingsEqual(binding, changed), false, `binding field ${field} must be fenced`);
  }
});

test("runtime data open frame requires the channel, protocol, and complete binding", () => {
  const frame = JSON.stringify({ type: "open", channel: "channel-1", protocol: "local-runtime-v1", binding });
  const parsed = parseRuntimeOpenFrame(Buffer.from(frame), false, "channel-1", "local-runtime-v1");
  assert.deepEqual(parsed?.binding, binding);
  assert.equal(parseRuntimeOpenFrame(Buffer.from(frame), false, "channel-2", "local-runtime-v1"), null);
  assert.equal(parseRuntimeOpenFrame(Buffer.from(frame), false, "channel-1", "other-runtime" as "local-runtime-v1"), null);
  assert.equal(parseRuntimeOpenFrame(Buffer.from(JSON.stringify({ ...JSON.parse(frame), binding: { ...binding, leaseEpoch: 8 } })), false, "channel-1", "local-runtime-v1")?.binding.leaseEpoch, 8);
  assert.equal(parseRuntimeOpenFrame(Buffer.from(JSON.stringify({ type: "open", channel: "channel-1", protocol: "local-runtime-v1" })), false, "channel-1", "local-runtime-v1"), null);
});

test("runtime open handshake rejects oversized frames and buffered data", async () => {
  const frame = JSON.stringify({ type: "open", channel: "channel-1", protocol: "local-runtime-v1", binding });
  const oversized = Buffer.from(`${frame.slice(0, -1)},"padding":"${"x".repeat(RUNTIME_OPEN_FRAME_MAX_BYTES)}"}`);
  assert(oversized.byteLength > RUNTIME_OPEN_FRAME_MAX_BYTES);
  assert.equal(parseRuntimeOpenFrame(oversized, false, "channel-1", "local-runtime-v1"), null);

  const socket = new FakeRuntimeSocket();
  const waiter = waitForRuntimeOpenFrame(socket as unknown as WebSocket, "channel-1", "local-runtime-v1");
  socket.emit("message", Buffer.from(frame), false);
  socket.emit("message", Buffer.alloc(RUNTIME_OPEN_BUFFER_MAX_BYTES + 1), false);
  assert.ok(await waiter.promise);
  assert.equal(waiter.release(), null, "buffer overflow must prevent pairing");
});

test("runtime data owner hints are namespaced and reject unsafe endpoints", () => {
  const channelId = "channel-1";
  assert.equal(runtimeDataRouteKey(channelId), "gateway:runtime-relay:data:channel-1");
  const unsignedRoute = {
    ownerNodeId: "gateway-0",
    runtimeId: "runtime-1",
    endpoint: "ws://10.0.0.12:8788/runtime/relay/data",
  };
  const route = { ...unsignedRoute, signature: signRuntimeDataRoute(channelId, unsignedRoute, "route-secret") };
  const parseOptions = { channelId, signingSecret: "route-secret" };
  assert.deepEqual(parseRuntimeDataRoute(JSON.stringify(route), parseOptions), route);
  assert.equal(parseRuntimeDataRoute(JSON.stringify(unsignedRoute), parseOptions), null);
  assert.equal(parseRuntimeDataRoute(JSON.stringify(route), { ...parseOptions, signingSecret: "wrong-secret" }), null);
  assert.equal(parseRuntimeDataRoute(JSON.stringify(route), { ...parseOptions, channelId: "other-channel" }), null);
  for (const endpoint of [
    "file:///etc/passwd",
    "ws://gateway.internal:8788/runtime/relay/data",
    "ws://user:pass@10.0.0.12:8788/runtime/relay/data",
    "ws://10.0.0.12:8788/runtime/relay/data?channel=other",
    "ws://10.0.0.12:6379/runtime/relay/data",
    "ws://8.8.8.8:8788/runtime/relay/data",
  ]) {
    const forged = { ...route, endpoint, signature: signRuntimeDataRoute(channelId, { ...unsignedRoute, endpoint }, "route-secret") };
    assert.equal(parseRuntimeDataRoute(JSON.stringify(forged), parseOptions), null, endpoint);
  }
  assert.equal(parseRuntimeDataRoute("not-json", parseOptions), null);
});

test("relay peer path decoding rejects malformed or empty segments", () => {
  assert.equal(decodeRelayPathSegment("runtime%2Fid"), "runtime/id");
  assert.equal(decodeRelayPathSegment("  runtime-id  "), "runtime-id");
  assert.equal(decodeRelayPathSegment("%"), null);
  assert.equal(decodeRelayPathSegment("%E0%A4%A"), null);
  assert.equal(decodeRelayPathSegment("   "), null);
});

test("runtime proxy only forwards sendable WebSocket close codes", () => {
  for (const code of [1000, 1001, 1002, 1003, 1007, 1014, 3000, 4999]) {
    assert.equal(normalizeRuntimeProxyCloseCode(code, true), code);
  }
  for (const code of [1004, 1005, 1006, 1015, 2999, 5000, 0]) {
    assert.equal(normalizeRuntimeProxyCloseCode(code, true), 4503);
  }
  assert.equal(normalizeRuntimeProxyCloseCode(1000, false), 4503);
});
