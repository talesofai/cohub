import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import * as schema from "@cohub/db";
import {
  canvasCheckpointSnapshots,
  canvasDocuments,
  checkpoints,
  labelAssignments,
  labels,
  proposals,
  providerMessageRefs,
  sessionForks,
  sessionMessages,
  sessionTurnSegments,
  sessionTurns,
  spaceChannels,
  spaceSessionBindings,
  spaceSessions,
  spaces,
  taskRuns,
  userChannels,
  workVersions,
  workViewerGrants,
  works,
} from "@cohub/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;

const hasSqlState = (error: unknown, code: string) => {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

test("relational constraints reject cross-space bindings and preserve channel message history", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  if (!databaseUrl) return;
  const client = postgres(databaseUrl, { prepare: false, max: 4 });
  const db = drizzle(client, { schema });
  const firstSpaceId = randomUUID();
  const secondSpaceId = randomUUID();
  const channelId = randomUUID();
  const spaceChannelId = randomUUID();
  const sessionId = randomUUID();
  const providerRefId = randomUUID();
  const messageId = randomUUID();

  try {
    await db.insert(spaces).values([
      { id: firstSpaceId, userUuid: randomUUID(), name: `space-${firstSpaceId}`, storageRepoName: `repo-${firstSpaceId}` },
      { id: secondSpaceId, userUuid: randomUUID(), name: `space-${secondSpaceId}`, storageRepoName: `repo-${secondSpaceId}` },
    ]);
    await db.insert(userChannels).values({
      id: channelId,
      userUuid: randomUUID(),
      provider: "test",
      credentialEnvelope: {
        version: 1,
        keyId: "test",
        algorithm: "aes-256-gcm",
        nonce: "AAAAAAAAAAAAAAAA",
        authTag: "AAAAAAAAAAAAAAAAAAAAAA",
        ciphertext: "AAA",
      },
    });
    await db.insert(spaceChannels).values({ id: spaceChannelId, spaceId: firstSpaceId, channelId });
    await db.insert(spaceSessions).values({ id: sessionId, spaceId: firstSpaceId });

    await assert.rejects(
      db.insert(spaceSessionBindings).values({
        spaceId: secondSpaceId,
        spaceSessionId: sessionId,
        spaceChannelId,
        provider: "test",
        bindingKey: randomUUID(),
        externalChatId: randomUUID(),
      }),
      (error: unknown) => hasSqlState(error, "23503"),
    );

    await db.insert(spaceSessionBindings).values({
      spaceId: firstSpaceId,
      spaceSessionId: sessionId,
      spaceChannelId,
      provider: "test",
      bindingKey: randomUUID(),
      externalChatId: randomUUID(),
    });
    await db.insert(sessionMessages).values({
      id: messageId,
      sessionId,
      role: "user",
      content: [],
      sequence: 1,
    });
    await db.insert(providerMessageRefs).values({
      id: providerRefId,
      provider: "test",
      spaceId: firstSpaceId,
      spaceSessionId: sessionId,
      spaceChannelId,
      sessionMessageId: messageId,
      direction: "inbound",
      externalConversationId: randomUUID(),
      externalMessageId: randomUUID(),
    });

    await assert.rejects(
      db.delete(userChannels).where(eq(userChannels.id, channelId)),
      (error: unknown) => hasSqlState(error, "23503"),
    );
    await db.delete(spaceChannels).where(eq(spaceChannels.id, spaceChannelId));

    const bindings = await db.select().from(spaceSessionBindings)
      .where(eq(spaceSessionBindings.spaceChannelId, spaceChannelId));
    const [providerRef] = await db.select().from(providerMessageRefs)
      .where(eq(providerMessageRefs.id, providerRefId));
    assert.equal(bindings.length, 0);
    assert.equal(providerRef?.spaceChannelId, null);
  } finally {
    try {
      await db.delete(spaces).where(eq(spaces.id, firstSpaceId));
      await db.delete(spaces).where(eq(spaces.id, secondSpaceId));
      await db.delete(userChannels).where(eq(userChannels.id, channelId));
    } finally {
      await client.end();
    }
  }
});

test("owned label and work rows cascade from their canonical parent", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  if (!databaseUrl) return;
  const client = postgres(databaseUrl, { prepare: false, max: 4 });
  const db = drizzle(client, { schema });
  const spaceId = randomUUID();
  const labelId = randomUUID();
  const workId = randomUUID();
  const workVersionId = randomUUID();

  try {
    await db.insert(spaces).values({
      id: spaceId,
      userUuid: randomUUID(),
      name: `space-${spaceId}`,
      storageRepoName: `repo-${spaceId}`,
    });
    await db.insert(labels).values({
      id: labelId,
      scopeType: "space",
      scopeId: spaceId,
      name: "Test label",
      slug: `label-${labelId}`,
    });
    await db.insert(labelAssignments).values({
      labelId,
      scopeType: "space",
      scopeId: spaceId,
      resourceType: "session",
      resourceRef: randomUUID(),
    });
    await db.insert(works).values({
      id: workId,
      spaceId,
      userUuid: randomUUID(),
      slug: `work-${workId}`,
      targetType: "file",
      targetRef: "index.html",
    });
    await db.insert(workVersions).values({
      id: workVersionId,
      workId,
      version: 1,
      targetType: "file",
      targetRef: "index.html",
    });
    await db.insert(workViewerGrants).values({
      workId,
      spaceId,
      viewerUserUuid: randomUUID(),
    });
    await db.update(works).set({ currentVersionId: workVersionId }).where(eq(works.id, workId));

    await db.delete(labels).where(eq(labels.id, labelId));
    assert.equal((await db.select().from(labelAssignments).where(eq(labelAssignments.labelId, labelId))).length, 0);

    await db.delete(works).where(eq(works.id, workId));
    assert.equal((await db.select().from(workVersions).where(eq(workVersions.workId, workId))).length, 0);
    assert.equal((await db.select().from(workViewerGrants).where(eq(workViewerGrants.workId, workId))).length, 0);
  } finally {
    try {
      await db.delete(labelAssignments).where(and(
        eq(labelAssignments.scopeType, "space"),
        eq(labelAssignments.scopeId, spaceId),
      ));
      await db.delete(labels).where(and(eq(labels.scopeType, "space"), eq(labels.scopeId, spaceId)));
      await db.delete(spaces).where(eq(spaces.id, spaceId));
    } finally {
      await client.end();
    }
  }
});

test("space deletion removes owned session lineage and preserves task history", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  if (!databaseUrl) return;
  const client = postgres(databaseUrl, { prepare: false, max: 4 });
  const db = drizzle(client, { schema });
  const spaceId = randomUUID();
  const parentSessionId = randomUUID();
  const childSessionId = randomUUID();
  const anchorTurnId = randomUUID();
  const taskRunId = randomUUID();
  const messageId = randomUUID();

  try {
    await db.insert(spaces).values({
      id: spaceId,
      userUuid: randomUUID(),
      name: `space-${spaceId}`,
      storageRepoName: `repo-${spaceId}`,
    });
    await db.insert(spaceSessions).values([
      { id: parentSessionId, spaceId },
      { id: childSessionId, spaceId },
    ]);
    await db.insert(sessionTurns).values({
      id: anchorTurnId,
      sessionId: parentSessionId,
      sequence: 1,
      userContent: [],
    });
    await db.insert(sessionMessages).values({
      id: messageId,
      sessionId: parentSessionId,
      role: "user",
      content: [],
      sequence: 1,
    });
    await db.update(spaceSessions)
      .set({ lastMessageId: messageId })
      .where(eq(spaceSessions.id, parentSessionId));
    await db.insert(sessionForks).values({
      spaceId,
      parentSessionId,
      childSessionId,
      rootSessionId: parentSessionId,
      depth: 1,
      anchorSourceSessionId: parentSessionId,
      anchorTurnId,
      anchorSequence: 1,
      ancestorSessionIds: [parentSessionId],
      sessionPath: [parentSessionId, childSessionId],
    });
    await db.insert(sessionTurnSegments).values({
      sessionId: childSessionId,
      ordinal: 0,
      sourceSessionId: parentSessionId,
      fromSequence: 1,
    });
    await db.insert(taskRuns).values({
      id: taskRunId,
      jobId: randomUUID(),
      taskType: "test",
      payload: { type: "test", data: {} },
      spaceId,
      sessionId: parentSessionId,
      turnId: anchorTurnId,
    });

    await assert.rejects(
      db.delete(spaceSessions).where(eq(spaceSessions.id, parentSessionId)),
      (error: unknown) => hasSqlState(error, "23503"),
    );
    await db.delete(spaces).where(eq(spaces.id, spaceId));

    assert.equal((await db.select().from(spaceSessions).where(eq(spaceSessions.spaceId, spaceId))).length, 0);
    assert.equal((await db.select().from(sessionForks).where(eq(sessionForks.spaceId, spaceId))).length, 0);
    const [taskRun] = await db.select().from(taskRuns).where(eq(taskRuns.id, taskRunId));
    assert.equal(taskRun?.spaceId, null);
    assert.equal(taskRun?.sessionId, null);
    assert.equal(taskRun?.turnId, null);
  } finally {
    try {
      await db.delete(taskRuns).where(eq(taskRuns.id, taskRunId));
      await db.delete(spaces).where(eq(spaces.id, spaceId));
    } finally {
      await client.end();
    }
  }
});

test("space deletion resolves checkpoint, proposal, and canvas ownership cycles", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  if (!databaseUrl) return;
  const client = postgres(databaseUrl, { prepare: false, max: 4 });
  const db = drizzle(client, { schema });
  const spaceId = randomUUID();
  const rootCheckpointId = randomUUID();
  const headCheckpointId = randomUUID();
  const documentId = randomUUID();
  const proposalId = randomUUID();

  try {
    await db.insert(spaces).values({
      id: spaceId,
      userUuid: randomUUID(),
      name: `space-${spaceId}`,
      storageRepoName: `repo-${spaceId}`,
    });
    await db.insert(checkpoints).values({
      id: rootCheckpointId,
      spaceId,
      commitHash: "1".repeat(40),
      description: "root",
    });
    await db.insert(checkpoints).values({
      id: headCheckpointId,
      spaceId,
      commitHash: "2".repeat(40),
      description: "head",
      parentCheckpointId: rootCheckpointId,
      rootCheckpointId,
    });
    await db.update(spaces).set({
      baseCheckpointId: rootCheckpointId,
      headCheckpointId,
    }).where(eq(spaces.id, spaceId));
    await db.insert(canvasDocuments).values({
      id: documentId,
      spaceId,
      filePath: "canvas.json",
      title: "Canvas",
    });
    await db.insert(canvasCheckpointSnapshots).values({
      checkpointId: headCheckpointId,
      sourceDocumentId: documentId,
      sourceSpaceId: spaceId,
      sourceFilePath: "canvas.json",
      sourceVersion: 0,
      manifest: {},
    });
    await db.insert(proposals).values({
      id: proposalId,
      title: "Proposal",
      sourceCheckpointId: headCheckpointId,
      targetSpaceId: spaceId,
    });

    await db.delete(spaces).where(eq(spaces.id, spaceId));

    assert.equal((await db.select().from(checkpoints).where(eq(checkpoints.spaceId, spaceId))).length, 0);
    assert.equal((await db.select().from(canvasDocuments).where(eq(canvasDocuments.spaceId, spaceId))).length, 0);
    assert.equal((await db.select().from(proposals).where(eq(proposals.id, proposalId))).length, 0);
  } finally {
    try {
      await db.delete(spaces).where(eq(spaces.id, spaceId));
    } finally {
      await client.end();
    }
  }
});
