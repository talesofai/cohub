import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionHandle } from "../session.js";
import type { QueuedCheckpointSteer } from "../checkpoint-steering.js";

process.env.DATABASE_URL ??= "postgres://localhost/cohub_test";
process.env.APP_ENCRYPTION_KEY ??= "test-key";
process.env.SESSIONS_NAMESPACE ??= "test";

const {
  __test: checkpointSteeringTest,
  catchUpCheckpointSteersForTarget,
  handleCheckpointSteerEvent,
  reconcilePersistedCheckpointSteers,
  registerCheckpointSteeringTarget,
} = await import("../checkpoint-steering.js");

function createFixture(overrides: { spaceId?: string; sessionId?: string; consumeSteer?: boolean } = {}) {
  const spaceId = overrides.spaceId ?? "space-1";
  const sessionId = overrides.sessionId ?? "session-1";
  const sessionMessages: AgentMessage[] = [];
  let enqueueCount = 0;
  let abortCount = 0;
  let isStreaming = true;
  let clearSteeringQueueCount = 0;
  let enqueueMeta: Record<string, unknown> | null = null;
  const abortController = new AbortController();

  const session = {
    get isStreaming() { return isStreaming; },
    enqueueSteer(text: string, _images?: unknown[], meta?: Record<string, unknown>) {
      enqueueCount += 1;
      enqueueMeta = meta ?? null;
      if (overrides.consumeSteer !== false) {
        sessionMessages.push({
          role: "user",
          content: [{ type: "text", text }],
          timestamp: Date.now(),
          meta,
        } as AgentMessage);
      }
    },
    async waitForIdle() {
      if (overrides.consumeSteer === false) isStreaming = false;
    },
    async abort() { abortCount += 1; },
    agent: {
      clearSteeringQueue() { clearSteeringQueueCount += 1; },
    },
  };
  const handle = {
    spaceId,
    sessionId,
    session,
    currentTurnId: "active-turn-1",
    currentTurnSeq: 7,
    currentAccessMode: "full_access",
    pendingUserMessages: [],
    pendingSteerCompletions: [],
    persistenceChain: Promise.resolve(),
    sessionManager: {
      hasUserMessage(userMessageId: string) {
        return sessionMessages.some((message) => {
          const meta = (message as unknown as { meta?: Record<string, unknown> | null }).meta;
          return meta?.userMessageId === userMessageId;
        });
      },
    },
  } as unknown as SessionHandle;
  const turn: QueuedCheckpointSteer = {
    id: "steer-turn-1",
    spaceId,
    sessionId,
    userUuid: "user-1",
    sequence: 8,
    status: "queued",
    intent: "steer",
    userContent: [{ type: "text", text: "Use the smaller API surface." }],
    meta: {
      userMessageId: "steer-message-1",
      accessMode: "full_access",
      agentTurnSteer: {
        mode: "checkpoint",
        status: "pending",
        targetTurnId: "active-turn-1",
      },
    },
  };
  const event = {
    id: "steer-event-1",
    spaceId,
    sessionId,
    queuedTurnId: turn.id,
    activeTurnId: "active-turn-1",
    actorUserId: "user-1",
    timestamp: Date.now(),
  } as const;
  return {
    handle,
    abortSignal: abortController.signal,
    turn,
    event,
    get enqueueCount() { return enqueueCount; },
    get abortCount() { return abortCount; },
    get enqueueMeta() { return enqueueMeta; },
    get clearSteeringQueueCount() { return clearSteeringQueueCount; },
    setStreaming(value: boolean) { isStreaming = value; },
    requestAbort() { abortController.abort(); },
  };
}

function dependencies(
  fixture: ReturnType<typeof createFixture>,
  onComplete: (input: unknown) => void = () => undefined,
) {
  return {
    async loadQueuedSteer() { return fixture.turn; },
    async completeCheckpointSteer(input: unknown) {
      onComplete(input);
      return { ok: true };
    },
  };
}

test("delivers to the exact active Pi target without aborting", async () => {
  checkpointSteeringTest.reset();
  const fixture = createFixture();
  const unregister = registerCheckpointSteeringTarget({
    spaceId: fixture.event.spaceId,
    sessionId: fixture.event.sessionId,
    turnId: fixture.event.activeTurnId,
    handle: fixture.handle,
    abortSignal: fixture.abortSignal,
  });
  const completed: unknown[] = [];

  const result = await handleCheckpointSteerEvent(
    fixture.event,
    dependencies(fixture, (input) => completed.push(input)),
  );

  assert.equal(result, true);
  assert.equal(fixture.enqueueCount, 1);
  assert.equal(fixture.abortCount, 0);
  assert.equal(completed.length, 1);
  assert.equal(fixture.enqueueMeta?.checkpointSteer, true);
  assert.equal(fixture.enqueueMeta?.executionTurnId, "active-turn-1");
  unregister();
});

test("deduplicates concurrent delivery of the same queued steer", async () => {
  checkpointSteeringTest.reset();
  const fixture = createFixture();
  const unregister = registerCheckpointSteeringTarget({
    spaceId: fixture.event.spaceId,
    sessionId: fixture.event.sessionId,
    turnId: fixture.event.activeTurnId,
    handle: fixture.handle,
    abortSignal: fixture.abortSignal,
  });

  const results = await Promise.all([
    handleCheckpointSteerEvent(fixture.event, dependencies(fixture)),
    handleCheckpointSteerEvent(fixture.event, dependencies(fixture)),
  ]);

  assert.deepEqual(results, [true, true]);
  assert.equal(fixture.enqueueCount, 1);
  unregister();
});

test("leaves the steer queued when the target has already become idle", async () => {
  checkpointSteeringTest.reset();
  const fixture = createFixture();
  const unregister = registerCheckpointSteeringTarget({
    spaceId: fixture.event.spaceId,
    sessionId: fixture.event.sessionId,
    turnId: fixture.event.activeTurnId,
    handle: fixture.handle,
    abortSignal: fixture.abortSignal,
  });
  fixture.setStreaming(false);

  assert.equal(await handleCheckpointSteerEvent(fixture.event, dependencies(fixture)), false);
  assert.equal(fixture.enqueueCount, 0);
  unregister();
});

test("completion race clears a stale native queue and falls back to the DB turn", async () => {
  checkpointSteeringTest.reset();
  const fixture = createFixture({ consumeSteer: false });
  const unregister = registerCheckpointSteeringTarget({
    spaceId: fixture.event.spaceId,
    sessionId: fixture.event.sessionId,
    turnId: fixture.event.activeTurnId,
    handle: fixture.handle,
    abortSignal: fixture.abortSignal,
  });

  assert.equal(await handleCheckpointSteerEvent(fixture.event, dependencies(fixture)), false);
  assert.equal(fixture.enqueueCount, 1);
  assert.equal(fixture.clearSteeringQueueCount, 1);
  unregister();
});

test("does not deliver an event across session ownership boundaries", async () => {
  checkpointSteeringTest.reset();
  const fixture = createFixture();
  const other = createFixture({ sessionId: "session-2" });
  const unregister = registerCheckpointSteeringTarget({
    spaceId: other.event.spaceId,
    sessionId: other.event.sessionId,
    turnId: other.event.activeTurnId,
    handle: other.handle,
    abortSignal: other.abortSignal,
  });

  assert.equal(await handleCheckpointSteerEvent(fixture.event, dependencies(fixture)), false);
  assert.equal(other.enqueueCount, 0);
  unregister();
});

test("catches up a persisted steer whose pubsub event was missed", async () => {
  checkpointSteeringTest.reset();
  const fixture = createFixture();
  const unregister = registerCheckpointSteeringTarget({
    spaceId: fixture.event.spaceId,
    sessionId: fixture.event.sessionId,
    turnId: fixture.event.activeTurnId,
    handle: fixture.handle,
    abortSignal: fixture.abortSignal,
  });
  const completed = await catchUpCheckpointSteersForTarget({
    spaceId: fixture.event.spaceId,
    sessionId: fixture.event.sessionId,
    targetTurnId: fixture.event.activeTurnId,
  }, {
    ...dependencies(fixture),
    async listPendingSteerIds() { return [fixture.turn.id]; },
  });

  assert.equal(completed, 1);
  assert.equal(fixture.enqueueCount, 1);
  unregister();
});

test("keeps a different access-mode steer queued for the next turn", async () => {
  checkpointSteeringTest.reset();
  const fixture = createFixture();
  fixture.turn.meta = { ...fixture.turn.meta, accessMode: "read_only" };
  const unregister = registerCheckpointSteeringTarget({
    spaceId: fixture.event.spaceId,
    sessionId: fixture.event.sessionId,
    turnId: fixture.event.activeTurnId,
    handle: fixture.handle,
    abortSignal: fixture.abortSignal,
  });

  assert.equal(await handleCheckpointSteerEvent(fixture.event, dependencies(fixture)), false);
  assert.equal(fixture.enqueueCount, 0);
  unregister();
});

test("does not enqueue a steer after explicit Stop has reached the active target", async () => {
  checkpointSteeringTest.reset();
  const fixture = createFixture();
  const unregister = registerCheckpointSteeringTarget({
    spaceId: fixture.event.spaceId,
    sessionId: fixture.event.sessionId,
    turnId: fixture.event.activeTurnId,
    handle: fixture.handle,
    abortSignal: fixture.abortSignal,
  });
  fixture.requestAbort();

  assert.equal(await handleCheckpointSteerEvent(fixture.event, dependencies(fixture)), false);
  assert.equal(fixture.enqueueCount, 0);
  unregister();
});

test("reconciles a persisted native steer before it can run as a second turn", async () => {
  const completed: unknown[] = [];
  const result = await reconcilePersistedCheckpointSteers({
    spaceId: "space-1",
    sessionId: "session-1",
  }, {
    async loadQueuedSteer() { return null; },
    async listPersistedSteers() {
      return [{
        steerTurnId: "steer-turn-1",
        targetTurnId: "active-turn-1",
        userMessageId: "steer-message-1",
        targetStatus: "completed",
        targetHasAssistantMessage: true,
      }];
    },
    async completeCheckpointSteer(input) {
      completed.push(input);
      return { ok: true };
    },
  });

  assert.equal(result, 1);
  assert.deepEqual(completed, [{
    spaceId: "space-1",
    sessionId: "session-1",
    steerTurnId: "steer-turn-1",
    targetTurnId: "active-turn-1",
    userMessageId: "steer-message-1",
  }]);
});

test("blocks next-turn replay while durable checkpoint completion is unavailable", async () => {
  await assert.rejects(() => reconcilePersistedCheckpointSteers({
    spaceId: "space-1",
    sessionId: "session-1",
  }, {
    async loadQueuedSteer() { return null; },
    async listPersistedSteers() {
      return [{
        steerTurnId: "steer-turn-1",
        targetTurnId: "active-turn-1",
        userMessageId: "steer-message-1",
        targetStatus: "completed",
        targetHasAssistantMessage: true,
      }];
    },
    async completeCheckpointSteer() {
      throw new Error("API unavailable");
    },
  }), /API unavailable/);
});

test("leaves an orphaned running target queued when no assistant response was persisted", async () => {
  let completeCount = 0;
  const result = await reconcilePersistedCheckpointSteers({
    spaceId: "space-1",
    sessionId: "session-1",
  }, {
    async loadQueuedSteer() { return null; },
    async listPersistedSteers() {
      return [{
        steerTurnId: "steer-turn-1",
        targetTurnId: "active-turn-1",
        userMessageId: "steer-message-1",
        targetStatus: "running",
        targetHasAssistantMessage: false,
      }];
    },
    async completeCheckpointSteer() {
      completeCount += 1;
      return { ok: true };
    },
  });

  assert.equal(result, 0);
  assert.equal(completeCount, 0);
});

test("does not mistake an older assistant round for the steer response", () => {
  assert.equal(checkpointSteeringTest.hasAssistantForUserMessage([
    { meta: { anchorUserMessageId: "older-message" } },
  ], "steer-message-1"), false);
  assert.equal(checkpointSteeringTest.hasAssistantForUserMessage([
    { meta: { anchorUserMessageId: "steer-message-1" } },
  ], "steer-message-1"), true);
});
