import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOCAL_RUNTIME_STALE_AFTER_MS,
  LOCAL_RUNTIME_WIRE_PROTOCOL,
  LocalRuntimeCapabilitiesSchema,
  LocalRuntimeControlFrameSchema,
  LocalRuntimeDataFrameSchema,
  LocalRuntimeEventKindSchema,
  LocalRuntimeRegistrationSchema,
  parseLocalRuntimeDataFrame,
  isLocalRuntimeHeartbeatFresh,
} from "./src/local-runtime/index.js";

test("runtime heartbeat freshness tolerates a bounded outage", () => {
  const now = Date.parse("2026-09-07T00:00:00.000Z");
  assert.equal(isLocalRuntimeHeartbeatFresh(now - LOCAL_RUNTIME_STALE_AFTER_MS, now), true);
  assert.equal(isLocalRuntimeHeartbeatFresh(now - LOCAL_RUNTIME_STALE_AFTER_MS - 1, now), false);
  assert.equal(isLocalRuntimeHeartbeatFresh(null, now), false);
  assert.equal(isLocalRuntimeHeartbeatFresh("not-a-date", now), false);
});

test("local runtime capabilities have conservative defaults", () => {
  assert.deepEqual(LocalRuntimeCapabilitiesSchema.parse({}), {
    streaming: true,
    sessionResume: false,
    sessionFork: false,
    sessionCancel: true,
    permissionRequests: false,
    promptImages: false,
    nativeTools: true,
  });
  assert.throws(
    () => LocalRuntimeCapabilitiesSchema.parse({ permissionRequests: true }),
    /Invalid input/,
    "permission requests must not be advertised without a response operation",
  );
});

test("omitted access mode is read-only", () => {
  const parsed = LocalRuntimeDataFrameSchema.parse({
    version: 1,
    type: "command",
    commandId: "command-1",
    runtimeId: "runtime-1",
    spaceId: "space-1",
    runtimeSessionId: "session-1",
    cohubSessionId: "cohub-session-1",
    executionAttemptId: null,
    turnId: null,
    provider: "codex",
    providerSessionId: null,
    operation: "session.open",
    cwd: "/workspace",
    payload: {},
    connectionEpoch: 1,
  });
  assert.equal(parsed.type, "command");
  if (parsed.type === "command") assert.equal(parsed.accessMode, "read_only");
});

test("registration requires the local-runtime-v1 wire identity", () => {
  const registration = LocalRuntimeRegistrationSchema.parse({
    version: 1,
    runtimeId: "runtime-1",
    spaceId: "space-1",
    replicaId: "replica-1",
    deviceId: "device-1",
    provider: "pi",
    providerVersion: "0.81.1",
    adapterVersion: "pi-sdk-v1",
    protocolVersion: 1,
    capabilities: {},
  });
  assert.equal(registration.provider, "pi");
  assert.throws(() => LocalRuntimeControlFrameSchema.parse({
    type: "register",
    kind: "runtime",
    protocol: "invalid-runtime",
    ...registration,
  }));
  assert.equal(LOCAL_RUNTIME_WIRE_PROTOCOL, "local-runtime-v1");
});

test("normalized events use stable dotted kinds and strict envelopes", () => {
  const kinds = [
    "turn.started",
    "text.delta",
    "thinking.delta",
    "tool.started",
    "tool.updated",
    "tool.completed",
    "permission.requested",
    "usage",
    "turn.completed",
    "turn.failed",
    "session.ready",
  ] as const;
  for (const kind of kinds) assert.equal(LocalRuntimeEventKindSchema.parse(kind), kind);
  const event = parseLocalRuntimeDataFrame({
    version: 1,
    type: "event",
    runtimeId: "runtime-1",
    runtimeSessionId: "session-1",
    cohubSessionId: "cohub-session-1",
    executionAttemptId: null,
    turnId: "turn-1",
    provider: "codex",
    providerSessionId: "thread-1",
    eventId: "event-1",
    sequence: 1,
    kind: "text.delta",
    payload: { text: "hello" },
    connectionEpoch: 1,
  });
  assert.equal(event.type, "event");
  assert.throws(() => LocalRuntimeDataFrameSchema.parse({ ...event, sequence: 0 }));
});
