import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
const enabled = process.env.CHECKPOINT_STEERING_INTEGRATION === "1";

test("durably consumes a persisted steer exactly once", { skip: !enabled }, async () => {
  const [{ sessionMessages, sessionTurns, spaceSessions, spaces }, { eq }, { db }, { consumeCheckpointSteerTurn }] = await Promise.all([
    import("@cohub/db"),
    import("drizzle-orm"),
    import("./db/index.js"),
    import("./session-turns.js"),
  ]);
  const spaceId = randomUUID();
  const sessionId = randomUUID();
  const targetTurnId = randomUUID();
  const steerTurnId = randomUUID();
  const userMessageId = randomUUID();

  try {
    await db.insert(spaces).values({
      id: spaceId,
      userUuid: "checkpoint-steering-integration",
      name: `Checkpoint steering ${spaceId}`,
      storageRepoName: `checkpoint-steering-${spaceId}`,
    });
    await db.insert(spaceSessions).values({
      id: sessionId,
      spaceId,
      userUuid: "checkpoint-steering-integration",
      status: "active",
    });
    await db.insert(sessionTurns).values([
      {
        id: targetTurnId,
        sessionId,
        sequence: 1,
        status: "completed",
        intent: "steer",
        userContent: [{ type: "text", text: "Initial work" }],
      },
      {
        id: steerTurnId,
        sessionId,
        sequence: 2,
        status: "queued",
        intent: "steer",
        userContent: [{ type: "text", text: "Use the smaller contract" }],
        meta: {
          agentTurnSteer: {
            mode: "checkpoint",
            status: "pending",
            targetTurnId,
          },
        },
      },
    ]);
    await db.insert(sessionMessages).values({
      id: userMessageId,
      sessionId,
      turnId: steerTurnId,
      role: "user",
      content: [{ type: "text", text: "Use the smaller contract" }],
      text: "Use the smaller contract",
      sequence: 1,
      meta: { turnId: steerTurnId, executionTurnId: targetTurnId },
    });

    const first = await consumeCheckpointSteerTurn({
      spaceId,
      sessionId,
      turnId: steerTurnId,
      targetTurnId,
      userMessageId,
    });
    const second = await consumeCheckpointSteerTurn({
      spaceId,
      sessionId,
      turnId: steerTurnId,
      targetTurnId,
      userMessageId,
    });

    assert.equal(first.consumed, true);
    assert.equal(first.turn.status, "merged");
    assert.equal(second.consumed, false);
    const [target] = await db.select({ status: sessionTurns.status })
      .from(sessionTurns)
      .where(eq(sessionTurns.id, targetTurnId))
      .limit(1);
    assert.equal(target?.status, "completed");
  } finally {
    await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, sessionId));
    await db.delete(sessionTurns).where(eq(sessionTurns.sessionId, sessionId));
    await db.delete(spaceSessions).where(eq(spaceSessions.id, sessionId));
    await db.delete(spaces).where(eq(spaces.id, spaceId));
    await (db as unknown as { $client: { end(options?: { timeout?: number }): Promise<void> } }).$client.end({ timeout: 5 });
  }
});
