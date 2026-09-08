import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOCAL_RUNTIME_STALE_AFTER_MS,
  LOCAL_RUNTIME_WIRE_PROTOCOL,
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

test("runtime registration retains provider and protocol version", () => {
  const registration = LocalRuntimeRegistrationSchema.parse({
    version: 1,
    runtimeId: "runtime-1",
    spaceId: "space-1",
    replicaId: "replica-1",
    deviceId: "device-1",
    provider: "pi",
    protocolVersion: 1,
  });
  assert.equal(registration.provider, "pi");
  assert.equal(registration.protocolVersion, 1);
});

test("control registration carries only the pre-registered connection identity", () => {
  const registration = {
    runtimeId: "runtime-1",
    spaceId: "space-1",
    replicaId: "replica-1",
    provider: "pi" as const,
  };
  assert.deepEqual(LocalRuntimeControlFrameSchema.parse({
    type: "register",
    kind: "runtime",
    protocol: LOCAL_RUNTIME_WIRE_PROTOCOL,
    ...registration,
  }), {
    type: "register",
    kind: "runtime",
    protocol: LOCAL_RUNTIME_WIRE_PROTOCOL,
    ...registration,
  });
  assert.throws(() => LocalRuntimeControlFrameSchema.parse({
    type: "register",
    kind: "runtime",
    protocol: "invalid-runtime",
    ...registration,
  }));
  assert.throws(() => LocalRuntimeControlFrameSchema.parse({
    type: "register",
    kind: "runtime",
    protocol: LOCAL_RUNTIME_WIRE_PROTOCOL,
    ...registration,
    protocolVersion: 1,
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
