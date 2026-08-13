import type { ContentBlock } from "@cohub/protocol/core";
import {
  AGENT_TURN_STEER_META_KEY,
  type AgentTurnSteerEvent,
} from "@cohub/core/sessions";
import type { completeCheckpointSteer as CompleteCheckpointSteerApi } from "./api.js";
import { normalizeContentBlocksImages } from "./image-normalizer.js";
import { readPublicAssetImageUrl } from "./public-asset-storage.js";
import type { SessionHandle } from "./session.js";
import { logger } from "./logger.js";

export type QueuedCheckpointSteer = {
  id: string;
  spaceId: string;
  sessionId: string;
  userUuid: string | null;
  sequence: number;
  status: string;
  intent: string;
  userContent: ContentBlock[];
  meta: Record<string, unknown> | null;
};

export type CheckpointSteeringDependencies = {
  loadQueuedSteer: (input: {
    spaceId: string;
    sessionId: string;
    steerTurnId: string;
  }) => Promise<QueuedCheckpointSteer | null>;
  completeCheckpointSteer: (input: Parameters<typeof CompleteCheckpointSteerApi>[0]) => Promise<unknown>;
};

export type CheckpointSteeringCatchUpDependencies = CheckpointSteeringDependencies & {
  listPendingSteerIds: (input: {
    spaceId: string;
    sessionId: string;
    targetTurnId: string;
  }) => Promise<string[]>;
};

export type PersistedCheckpointSteer = {
  steerTurnId: string;
  targetTurnId: string;
  userMessageId: string;
  targetStatus: string;
  targetHasAssistantMessage: boolean;
};

export type CheckpointSteeringReconcileDependencies = CheckpointSteeringDependencies & {
  listPersistedSteers: (input: { spaceId: string; sessionId: string }) => Promise<PersistedCheckpointSteer[]>;
};

type ActiveSteeringTarget = {
  spaceId: string;
  sessionId: string;
  turnId: string;
  token: object;
  handle: SessionHandle;
  abortSignal: AbortSignal;
};

const activeTargets = new Map<string, ActiveSteeringTarget>();
const inFlightSteers = new Map<string, Promise<boolean>>();
const completedSteers = new Set<string>();
const MAX_COMPLETED_STEERS = 10_000;

function hasSessionUserMessage(handle: SessionHandle, userMessageId: string) {
  return handle.sessionManager.hasUserMessage(userMessageId);
}

function ensurePendingUserMessage(handle: SessionHandle, pending: SessionHandle["pendingUserMessages"][number]) {
  const userMessageId = pending.userMessageId.trim();
  if (!userMessageId || hasSessionUserMessage(handle, userMessageId)) return false;
  if (handle.pendingUserMessages.some((item) => item.userMessageId.trim() === userMessageId)) return false;
  handle.pendingUserMessages.push({ ...pending, userMessageId });
  return true;
}

function removePendingUserMessage(handle: SessionHandle, userMessageId: string) {
  const normalized = userMessageId.trim();
  handle.pendingUserMessages = handle.pendingUserMessages.filter((item) => item.userMessageId.trim() !== normalized);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function targetKey(spaceId: string, sessionId: string, turnId: string) {
  return `${spaceId}:${sessionId}:${turnId}`;
}

function resolvePendingTarget(meta: Record<string, unknown> | null) {
  const delivery = asRecord(asRecord(meta)[AGENT_TURN_STEER_META_KEY]);
  if (delivery.status !== "pending" || delivery.mode !== "checkpoint") return null;
  return nonEmptyString(delivery.targetTurnId);
}

function resolveMessageId(turn: QueuedCheckpointSteer) {
  const meta = asRecord(turn.meta);
  return nonEmptyString(meta.userMessageId) ?? nonEmptyString(meta.messageId) ?? turn.id;
}

function hasAssistantForUserMessage(messages: Array<{ meta: unknown }>, userMessageId: string) {
  return messages.some((message) => asRecord(message.meta).anchorUserMessageId === userMessageId);
}

function resolveAgentMessageContent(content: ContentBlock[]) {
  const textParts: string[] = [];
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const block of content) {
    if (block.type === "text" || block.type === "system_note") {
      textParts.push(block.text);
      continue;
    }
    if (block.type === "shell_command") {
      textParts.push(block.rawText ?? `!${block.command}`);
      continue;
    }
    if (block.type === "image" && block.source.type === "base64") {
      images.push({
        type: "image",
        data: block.source.data.replace(/^data:[^;,]+;base64,/, ""),
        mimeType: block.source.media_type || "application/octet-stream",
      });
    }
  }
  return { text: textParts.join("\n").trim(), images };
}

function isActiveTarget(target: ActiveSteeringTarget) {
  const current = activeTargets.get(targetKey(target.spaceId, target.sessionId, target.turnId));
  return current?.token === target.token
    && current.handle.spaceId === target.spaceId
    && current.handle.sessionId === target.sessionId
    && current.handle.currentTurnId === target.turnId
    && !current.abortSignal.aborted
    && current.handle.session.isStreaming;
}

async function loadQueuedSteer(input: {
  spaceId: string;
  sessionId: string;
  steerTurnId: string;
}): Promise<QueuedCheckpointSteer | null> {
  const [{ db }, { sessionTurns, spaceSessions }, { and, eq }] = await Promise.all([
    import("./db.js"),
    import("@cohub/db"),
    import("drizzle-orm"),
  ]);
  const [row] = await db.select({
    id: sessionTurns.id,
    spaceId: spaceSessions.spaceId,
    sessionId: sessionTurns.sessionId,
    userUuid: sessionTurns.userUuid,
    sequence: sessionTurns.sequence,
    status: sessionTurns.status,
    intent: sessionTurns.intent,
    userContent: sessionTurns.userContent,
    meta: sessionTurns.meta,
  }).from(sessionTurns)
    .innerJoin(spaceSessions, eq(spaceSessions.id, sessionTurns.sessionId))
    .where(and(
      eq(sessionTurns.id, input.steerTurnId),
      eq(sessionTurns.sessionId, input.sessionId),
      eq(spaceSessions.spaceId, input.spaceId),
      eq(sessionTurns.status, "queued"),
      eq(sessionTurns.intent, "steer"),
    ))
    .limit(1);
  return row ? {
    ...row,
    meta: row.meta && typeof row.meta === "object" && !Array.isArray(row.meta)
      ? row.meta as Record<string, unknown>
      : null,
  } : null;
}

async function listPendingSteerIds(input: {
  spaceId: string;
  sessionId: string;
  targetTurnId: string;
}): Promise<string[]> {
  const [{ db }, { sessionTurns, spaceSessions }, { and, asc, eq }] = await Promise.all([
    import("./db.js"),
    import("@cohub/db"),
    import("drizzle-orm"),
  ]);
  const rows = await db.select({ id: sessionTurns.id, meta: sessionTurns.meta })
    .from(sessionTurns)
    .innerJoin(spaceSessions, eq(spaceSessions.id, sessionTurns.sessionId))
    .where(and(
      eq(sessionTurns.sessionId, input.sessionId),
      eq(spaceSessions.spaceId, input.spaceId),
      eq(sessionTurns.status, "queued"),
      eq(sessionTurns.intent, "steer"),
    ))
    .orderBy(asc(sessionTurns.sequence));
  return rows
    .filter((row) => resolvePendingTarget(
      row.meta && typeof row.meta === "object" && !Array.isArray(row.meta)
        ? row.meta as Record<string, unknown>
        : null,
    ) === input.targetTurnId)
    .map((row) => row.id);
}

async function listPersistedSteers(input: {
  spaceId: string;
  sessionId: string;
}): Promise<PersistedCheckpointSteer[]> {
  const [{ db }, { sessionMessages, sessionTurns, spaceSessions }, { and, asc, eq }] = await Promise.all([
    import("./db.js"),
    import("@cohub/db"),
    import("drizzle-orm"),
  ]);
  const turns = await db.select({
    id: sessionTurns.id,
    meta: sessionTurns.meta,
  }).from(sessionTurns)
    .innerJoin(spaceSessions, eq(spaceSessions.id, sessionTurns.sessionId))
    .where(and(
      eq(sessionTurns.sessionId, input.sessionId),
      eq(spaceSessions.spaceId, input.spaceId),
      eq(sessionTurns.status, "queued"),
      eq(sessionTurns.intent, "steer"),
    ))
    .orderBy(asc(sessionTurns.sequence));

  const persisted: PersistedCheckpointSteer[] = [];
  for (const turn of turns) {
    const meta = turn.meta && typeof turn.meta === "object" && !Array.isArray(turn.meta)
      ? turn.meta as Record<string, unknown>
      : null;
    const targetTurnId = resolvePendingTarget(meta);
    if (!targetTurnId) continue;
    const userMessageId = nonEmptyString(asRecord(meta).userMessageId)
      ?? nonEmptyString(asRecord(meta).messageId)
      ?? turn.id;
    const [[target], [message], assistantMessages] = await Promise.all([
      db.select({ status: sessionTurns.status }).from(sessionTurns).where(and(
        eq(sessionTurns.id, targetTurnId),
        eq(sessionTurns.sessionId, input.sessionId),
      )).limit(1),
      db.select({ id: sessionMessages.id }).from(sessionMessages).where(and(
        eq(sessionMessages.id, userMessageId),
        eq(sessionMessages.sessionId, input.sessionId),
        eq(sessionMessages.turnId, turn.id),
        eq(sessionMessages.role, "user"),
      )).limit(1),
      db.select({ meta: sessionMessages.meta }).from(sessionMessages).where(and(
        eq(sessionMessages.sessionId, input.sessionId),
        eq(sessionMessages.turnId, targetTurnId),
        eq(sessionMessages.role, "assistant"),
      )),
    ]);
    if (!target || !message) continue;
    persisted.push({
      steerTurnId: turn.id,
      targetTurnId,
      userMessageId: message.id,
      targetStatus: target.status,
      targetHasAssistantMessage: hasAssistantForUserMessage(assistantMessages, message.id),
    });
  }
  return persisted;
}

const defaultDependencies: CheckpointSteeringDependencies = {
  loadQueuedSteer,
  async completeCheckpointSteer(input) {
    const { completeCheckpointSteer } = await import("./api.js");
    return completeCheckpointSteer(input);
  },
};

const defaultCatchUpDependencies: CheckpointSteeringCatchUpDependencies = {
  ...defaultDependencies,
  listPendingSteerIds,
};

const defaultReconcileDependencies: CheckpointSteeringReconcileDependencies = {
  ...defaultDependencies,
  listPersistedSteers,
};

export function registerCheckpointSteeringTarget(input: {
  spaceId: string;
  sessionId: string;
  turnId: string;
  handle: SessionHandle;
  abortSignal: AbortSignal;
}) {
  if (input.handle.spaceId !== input.spaceId
    || input.handle.sessionId !== input.sessionId
    || input.handle.currentTurnId !== input.turnId) return () => undefined;

  const key = targetKey(input.spaceId, input.sessionId, input.turnId);
  const token = {};
  activeTargets.set(key, { ...input, token });
  return () => {
    const current = activeTargets.get(key);
    if (current?.token === token) activeTargets.delete(key);
  };
}

function resolveAccessMode(meta: Record<string, unknown> | null) {
  return asRecord(meta).accessMode === "read_only" ? "read_only" : "full_access";
}

function waitForSteerPersistence(handle: SessionHandle, userMessageId: string) {
  let resolvePersisted!: () => void;
  let rejectPersisted!: (error: Error) => void;
  const persisted = new Promise<void>((resolve, reject) => {
    resolvePersisted = resolve;
    rejectPersisted = reject;
  });
  const completion = {
    userMessageId,
    ack: async () => resolvePersisted(),
    reject: async (reason: string) => rejectPersisted(new Error(reason)),
    done: () => {
      handle.pendingSteerCompletions = handle.pendingSteerCompletions.filter((item) => item !== completion);
    },
  };
  handle.pendingSteerCompletions.push(completion);
  return { persisted, completion };
}

async function deliverCheckpointSteer(
  target: ActiveSteeringTarget,
  ids: { steerTurnId: string; targetTurnId: string },
  dependencies: CheckpointSteeringDependencies,
) {
  const turn = await dependencies.loadQueuedSteer({
    spaceId: target.spaceId,
    sessionId: target.sessionId,
    steerTurnId: ids.steerTurnId,
  });
  if (!turn
    || turn.spaceId !== target.spaceId
    || turn.sessionId !== target.sessionId
    || turn.id !== ids.steerTurnId
    || turn.status !== "queued"
    || turn.intent !== "steer"
    || resolvePendingTarget(turn.meta) !== ids.targetTurnId
    || !isActiveTarget(target)) return false;
  if (target.handle.currentAccessMode !== resolveAccessMode(turn.meta)) return false;

  const userMessageId = resolveMessageId(turn);
  if (!Array.isArray(turn.userContent) || turn.userContent.length === 0) return false;
  const normalizedContent = await normalizeContentBlocksImages(turn.userContent, {
    readUrlImage: readPublicAssetImageUrl,
  });
  const content = resolveAgentMessageContent(normalizedContent);
  const meta = {
    ...asRecord(turn.meta),
    checkpointSteer: true,
    checkpointSteerTargetTurnId: ids.targetTurnId,
    executionTurnId: target.turnId,
    ...(target.handle.currentTurnSeq != null ? { executionTurnSeq: target.handle.currentTurnSeq } : {}),
    turnId: turn.id,
    userMessageId,
    messageId: userMessageId,
  };

  const alreadyInSession = hasSessionUserMessage(target.handle, userMessageId);
  const alreadyPending = target.handle.pendingUserMessages.some((pending) => pending.userMessageId === userMessageId);
  let insertedPending = false;
  if (!alreadyInSession && !alreadyPending) {
    insertedPending = ensurePendingUserMessage(target.handle, {
      userMessageId,
      turnId: turn.id,
      turnSeq: turn.sequence,
      content: normalizedContent,
      meta,
    });
    if (!insertedPending) return false;
  }

  if (!isActiveTarget(target)) {
    if (insertedPending) removePendingUserMessage(target.handle, userMessageId);
    return false;
  }

  let persistenceWait: ReturnType<typeof waitForSteerPersistence> | null = null;
  if (!alreadyInSession) persistenceWait = waitForSteerPersistence(target.handle, userMessageId);
  if (!alreadyInSession && !alreadyPending) {
    try {
      target.handle.session.enqueueSteer(content.text, content.images, meta);
    } catch (error) {
      persistenceWait?.completion.done();
      if (insertedPending) removePendingUserMessage(target.handle, userMessageId);
      throw error;
    }
  }

  if (persistenceWait) {
    try {
      const persisted = await Promise.race([
        persistenceWait.persisted.then(() => true),
        target.handle.session.waitForIdle().then(async () => {
          await target.handle.persistenceChain;
          return hasSessionUserMessage(target.handle, userMessageId);
        }),
      ]);
      if (!persisted) {
        persistenceWait.completion.done();
        target.handle.session.agent.clearSteeringQueue();
        if (insertedPending) removePendingUserMessage(target.handle, userMessageId);
        return false;
      }
    } catch (error) {
      persistenceWait.completion.done();
      if (!target.handle.session.isStreaming) target.handle.session.agent.clearSteeringQueue();
      logger.warn(`[AgentSteer] delivery persistence failed steerTurnId=${ids.steerTurnId} targetTurnId=${ids.targetTurnId}`, error);
      return false;
    }
  }

  const result = await dependencies.completeCheckpointSteer({
    spaceId: target.spaceId,
    sessionId: target.sessionId,
    steerTurnId: ids.steerTurnId,
    targetTurnId: ids.targetTurnId,
    userMessageId,
  });
  return !(result && typeof result === "object" && "ok" in result && (result as { ok?: unknown }).ok === false);
}

export async function handleCheckpointSteerEvent(
  event: AgentTurnSteerEvent,
  dependencies: CheckpointSteeringDependencies = defaultDependencies,
) {
  const spaceId = nonEmptyString(event.spaceId);
  const sessionId = nonEmptyString(event.sessionId);
  const steerTurnId = nonEmptyString(event.queuedTurnId);
  const targetTurnId = nonEmptyString(event.activeTurnId);
  if (!spaceId || !sessionId || !steerTurnId || !targetTurnId) return false;

  const target = activeTargets.get(targetKey(spaceId, sessionId, targetTurnId));
  if (!target || !isActiveTarget(target)) return false;
  if (completedSteers.has(steerTurnId)) return true;
  const pending = inFlightSteers.get(steerTurnId);
  if (pending) return pending;

  const delivery = deliverCheckpointSteer(target, { steerTurnId, targetTurnId }, dependencies)
    .then((completed) => {
      if (completed) {
        completedSteers.add(steerTurnId);
        if (completedSteers.size > MAX_COMPLETED_STEERS) {
          const oldest = completedSteers.values().next().value;
          if (typeof oldest === "string") completedSteers.delete(oldest);
        }
      }
      return completed;
    })
    .catch((error) => {
      logger.warn(`[AgentSteer] delivery failed steerTurnId=${steerTurnId} targetTurnId=${targetTurnId}`, error);
      return false;
    })
    .finally(() => inFlightSteers.delete(steerTurnId));
  inFlightSteers.set(steerTurnId, delivery);
  return delivery;
}

export async function catchUpCheckpointSteersForTarget(
  input: { spaceId: string; sessionId: string; targetTurnId: string },
  dependencies: CheckpointSteeringCatchUpDependencies = defaultCatchUpDependencies,
) {
  const target = activeTargets.get(targetKey(input.spaceId, input.sessionId, input.targetTurnId));
  if (!target || !isActiveTarget(target)) return 0;

  const steerTurnIds = await dependencies.listPendingSteerIds(input);
  let completed = 0;
  for (const steerTurnId of steerTurnIds) {
    const delivered = await handleCheckpointSteerEvent({
      id: `catch-up:${steerTurnId}`,
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      activeTurnId: input.targetTurnId,
      queuedTurnId: steerTurnId,
      actorUserId: null,
      timestamp: Date.now(),
    }, dependencies);
    if (delivered) completed += 1;
  }
  return completed;
}

const TERMINAL_RECONCILABLE_TARGET_STATUSES = new Set([
  "abort_requested",
  "completed",
  "interrupted",
  "aborted",
  "failed",
]);

export async function reconcilePersistedCheckpointSteers(
  input: { spaceId: string; sessionId: string },
  dependencies: CheckpointSteeringReconcileDependencies = defaultReconcileDependencies,
) {
  const persisted = await dependencies.listPersistedSteers(input);
  let reconciled = 0;
  for (const steer of persisted) {
    const canReconcile = TERMINAL_RECONCILABLE_TARGET_STATUSES.has(steer.targetStatus)
      || (steer.targetStatus === "running" && steer.targetHasAssistantMessage);
    if (!canReconcile) continue;
    const result = await dependencies.completeCheckpointSteer({
      ...input,
      steerTurnId: steer.steerTurnId,
      targetTurnId: steer.targetTurnId,
      userMessageId: steer.userMessageId,
    });
    if (result && typeof result === "object" && "ok" in result && (result as { ok?: unknown }).ok === false) {
      throw new Error(`Failed to reconcile persisted checkpoint steer ${steer.steerTurnId}`);
    }
    reconciled += 1;
  }
  return reconciled;
}

export const __test = {
  reset() {
    activeTargets.clear();
    inFlightSteers.clear();
    completedSteers.clear();
  },
  activeTargets,
  hasAssistantForUserMessage,
};
