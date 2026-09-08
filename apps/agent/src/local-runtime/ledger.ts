import { createHash } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  localAgentRuntimeCommands,
  localAgentRuntimeEvents,
  localAgentRuntimeSessions,
  localAgentRuntimes,
} from "@cohub/db";
import { canonicalizeJson } from "@cohub/protocol";
import { db } from "../db.js";
import { commandMayReuseExecutionAttempt } from "./ledger-policy.js";

/**
 * Durable command and event ledgers for local provider runtimes.
 *
 * Provider SDKs do not make a `turn.start` operation idempotent across an
 * Agent restart or a dropped relay connection. These ledgers do: a command is
 * recorded before it is sent, its outcome is recorded when known, and every
 * inbound normalized event is stored once so a later worker can replay the
 * projection instead of re-running the provider.
 */

export const MAX_RUNTIME_EVENT_BYTES = 4 * 1024 * 1024;

export const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export type RuntimeCommandRow = typeof localAgentRuntimeCommands.$inferSelect;
export type RuntimeSessionRow = typeof localAgentRuntimeSessions.$inferSelect;
export type RuntimeCommandClaim = RuntimeCommandRow & { claimed: boolean };

export type LedgerScope = {
  runtimeId: string;
  runtimeSessionId: string;
  connectionEpoch: number;
  providerSessionId: string;
};

export class ProviderRuntimeError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
    this.name = "ProviderRuntimeError";
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * Store one inbound notification. Returns false when the exact event was
 * already recorded (a replay), and throws when an event id is reused with
 * different content, which is a provider integrity fault.
 */
export async function recordInboundEvent(input: {
  scope: LedgerScope;
  commandId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  fallbackSequence: number;
  /** Canonical envelope identity. Provider ids are preferred over random ids. */
  eventId?: string | null;
  providerEventId?: string | null;
  sequence?: number;
}): Promise<boolean> {
  const canonical = canonicalizeJson(input.payload);
  if (Buffer.byteLength(canonical, "utf8") > MAX_RUNTIME_EVENT_BYTES) throw new Error("local runtime event exceeds the persistence size limit");
  const payloadHash = sha256(canonical);
  const meta = record(input.payload.meta);
  const explicitId = [
    input.providerEventId,
    input.eventId,
    input.payload.eventId, input.payload.event_id, input.payload.eventIdempotencyKey,
    meta.eventId, meta.cohubEventId, meta.eventIdempotencyKey,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
  const sourceSequence = [input.sequence, input.payload.sequence, input.payload.eventSequence]
    .find((value): value is string | number => (typeof value === "string" && value.trim().length > 0) || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0));
  const sourceMessageId = [input.payload.messageId]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
  const commandScope = input.commandId ?? "lifecycle";
  const rawEventId = explicitId
    ? `${input.scope.providerSessionId}:${commandScope}:${input.kind}:${explicitId}`
    : sourceSequence !== undefined
      ? `${input.scope.providerSessionId}:${commandScope}:${input.kind}:${sourceMessageId ?? ""}:${sourceSequence}`
      : `${input.scope.connectionEpoch}:${input.fallbackSequence}`;
  const eventId = rawEventId.length <= 255 ? rawEventId : `${input.kind.slice(0, 64)}:${sha256(rawEventId)}`;
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(localAgentRuntimeSessions).where(eq(localAgentRuntimeSessions.id, input.scope.runtimeSessionId)).for("update").limit(1);
    if (session?.status !== "active") throw new Error("local runtime session is unavailable");
    if (session.connectionEpoch !== input.scope.connectionEpoch) throw new Error("runtime_reconnect_required: local runtime session epoch is stale");
    const [existing] = await tx.select({ payloadHash: localAgentRuntimeEvents.payloadHash }).from(localAgentRuntimeEvents).where(and(
      eq(localAgentRuntimeEvents.runtimeSessionId, session.id),
      eq(localAgentRuntimeEvents.eventId, eventId),
    )).limit(1);
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new Error("local runtime event id was reused with different content");
      return false;
    }
    const sequence = session.lastEventSequence + 1;
    await tx.insert(localAgentRuntimeEvents).values({
      runtimeSessionId: session.id,
      eventId,
      sequence,
      kind: input.kind,
      commandId: input.commandId,
      payload: input.payload,
      payloadHash,
    });
    await tx.update(localAgentRuntimeSessions).set({
      lastEventSequence: sequence,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(localAgentRuntimeSessions.id, session.id));
    return true;
  });
}

export async function loadCommandEvents(runtimeSessionId: string, commandId: string) {
  return db.select({ kind: localAgentRuntimeEvents.kind, payload: localAgentRuntimeEvents.payload }).from(localAgentRuntimeEvents).where(and(
    eq(localAgentRuntimeEvents.runtimeSessionId, runtimeSessionId),
    eq(localAgentRuntimeEvents.commandId, commandId),
  )).orderBy(localAgentRuntimeEvents.sequence);
}

export async function findRuntimeCommand(runtimeSessionId: string, commandId: string): Promise<RuntimeCommandRow | null> {
  const [row] = await db.select().from(localAgentRuntimeCommands).where(and(
    eq(localAgentRuntimeCommands.runtimeSessionId, runtimeSessionId),
    eq(localAgentRuntimeCommands.commandId, commandId),
  )).limit(1);
  return row ?? null;
}

/**
 * Record a command before sending it. Turn and resume/close commands are
 * attempt-scoped; the durable session.open lifecycle command is explicitly
 * reusable across attempts. The provider session id is excluded because an
 * adapter restart can legitimately assign a new one for the same Cohub
 * session.
 */
export async function prepareCommand(input: {
  scope: LedgerScope;
  commandId: string;
  executionAttemptId: string;
  cohubSessionId: string;
  operation: string;
  payload: Record<string, unknown>;
}): Promise<RuntimeCommandRow> {
  const identity = { ...input.payload };
  delete identity.providerSessionId;
  const payloadHash = sha256(canonicalizeJson(identity));
  return db.transaction(async (tx) => {
    const [runtime] = await tx.select({ connectionEpoch: localAgentRuntimes.connectionEpoch, status: localAgentRuntimes.status }).from(localAgentRuntimes).where(eq(localAgentRuntimes.id, input.scope.runtimeId)).for("update").limit(1);
    if (!runtime || !["ready", "busy"].includes(runtime.status) || runtime.connectionEpoch !== input.scope.connectionEpoch) {
      throw new Error("runtime_reconnect_required: local runtime connection epoch is stale");
    }
    const [session] = await tx.select({ id: localAgentRuntimeSessions.id }).from(localAgentRuntimeSessions).where(eq(localAgentRuntimeSessions.id, input.scope.runtimeSessionId)).for("update").limit(1);
    if (!session) throw new Error("local runtime session disappeared");
    const [existing] = await tx.select().from(localAgentRuntimeCommands).where(and(
      eq(localAgentRuntimeCommands.runtimeSessionId, session.id),
      eq(localAgentRuntimeCommands.commandId, input.commandId),
    )).for("update").limit(1);
    if (existing) {
      const attemptMatches = existing.executionAttemptId === input.executionAttemptId;
      const sameOperation = existing.operation === input.operation;
      const sessionScopedLifecycle = sameOperation && commandMayReuseExecutionAttempt(input.operation);
      if (existing.runtimeId !== input.scope.runtimeId
        || (!attemptMatches && !sessionScopedLifecycle)
        || existing.cohubSessionId !== input.cohubSessionId) {
        throw new Error("local runtime command id was reused by a different execution attempt");
      }
      if (!sameOperation) throw new Error("local runtime command id was reused for a different operation");
      if (existing.payloadHash !== payloadHash) throw new Error("local runtime command id was reused with different content");
      return existing;
    }
    const [last] = await tx.select({ max: sql<number>`coalesce(max(${localAgentRuntimeCommands.sequence}), 0)` }).from(localAgentRuntimeCommands).where(eq(localAgentRuntimeCommands.runtimeSessionId, session.id));
    const [created] = await tx.insert(localAgentRuntimeCommands).values({
      runtimeId: input.scope.runtimeId,
      runtimeSessionId: session.id,
      executionAttemptId: input.executionAttemptId,
      cohubSessionId: input.cohubSessionId,
      commandId: input.commandId,
      sequence: Number(last?.max ?? 0) + 1,
      operation: input.operation,
      payload: input.payload,
      payloadHash,
      status: "prepared",
    }).returning();
    if (!created) throw new Error("failed to persist local runtime command");
    return created;
  });
}

export async function markCommandSent(runtimeSessionId: string, commandId: string): Promise<RuntimeCommandClaim> {
  const [updated] = await db.update(localAgentRuntimeCommands).set({ status: "sent", updatedAt: new Date() }).where(and(
    eq(localAgentRuntimeCommands.runtimeSessionId, runtimeSessionId),
    eq(localAgentRuntimeCommands.commandId, commandId),
    eq(localAgentRuntimeCommands.status, "prepared"),
  )).returning();
  if (updated) return { ...updated, claimed: true };
  const [current] = await db.select().from(localAgentRuntimeCommands).where(and(
    eq(localAgentRuntimeCommands.runtimeSessionId, runtimeSessionId),
    eq(localAgentRuntimeCommands.commandId, commandId),
  )).limit(1);
  if (!current || (current.status !== "sent" && current.status !== "completed")) throw new Error("local runtime command is not sendable");
  return { ...current, claimed: false };
}

/**
 * A data channel starts a fresh provider host process. A previously completed
 * resume therefore needs one new host activation, while an open command must
 * never be replayed (it could create a second native session). Re-arming is
 * only allowed for the known-safe resume operation; once re-armed it follows
 * the normal sent/unknown fencing rules if the channel drops.
 */
export async function rearmCompletedResumeCommand(runtimeSessionId: string, commandId: string): Promise<RuntimeCommandClaim> {
  const [updated] = await db.update(localAgentRuntimeCommands).set({ status: "sent", updatedAt: new Date() }).where(and(
    eq(localAgentRuntimeCommands.runtimeSessionId, runtimeSessionId),
    eq(localAgentRuntimeCommands.commandId, commandId),
    eq(localAgentRuntimeCommands.operation, "session.resume"),
    eq(localAgentRuntimeCommands.status, "completed"),
  )).returning();
  if (updated) return { ...updated, claimed: true };
  const [current] = await db.select().from(localAgentRuntimeCommands).where(and(
    eq(localAgentRuntimeCommands.runtimeSessionId, runtimeSessionId),
    eq(localAgentRuntimeCommands.commandId, commandId),
  )).limit(1);
  if (!current || (current.status !== "sent" && current.status !== "completed")) {
    throw new Error("local runtime resume command is not rearmable");
  }
  return { ...current, claimed: false };
}

/**
 * Re-arm a completed open only when its recorded readiness is still
 * provisional. A native provider id means the open side effect is known and
 * must be resumed instead of creating another provider session.
 */
export async function rearmCompletedOpenCommand(runtimeSessionId: string, commandId: string): Promise<RuntimeCommandClaim> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(localAgentRuntimeCommands).where(and(
      eq(localAgentRuntimeCommands.runtimeSessionId, runtimeSessionId),
      eq(localAgentRuntimeCommands.commandId, commandId),
    )).for("update").limit(1);
    if (current?.operation !== "session.open") throw new Error("local runtime open command is not rearmable");
    if (current.status === "completed") {
      const [ready] = await tx.select({ payload: localAgentRuntimeEvents.payload }).from(localAgentRuntimeEvents).where(and(
        eq(localAgentRuntimeEvents.runtimeSessionId, runtimeSessionId),
        eq(localAgentRuntimeEvents.commandId, commandId),
        eq(localAgentRuntimeEvents.kind, "session.ready"),
      )).orderBy(localAgentRuntimeEvents.sequence).limit(1);
      const payload = record(ready?.payload);
      const providerSessionId = typeof payload.providerSessionId === "string" ? payload.providerSessionId.trim() : "";
      const provisional = payload.provisional === true || providerSessionId.startsWith("pending:");
      if (!provisional || (providerSessionId && !providerSessionId.startsWith("pending:"))) {
        throw new Error("local runtime open command has a native provider session id");
      }
      const [updated] = await tx.update(localAgentRuntimeCommands).set({ status: "sent", updatedAt: new Date() }).where(and(
        eq(localAgentRuntimeCommands.runtimeSessionId, runtimeSessionId),
        eq(localAgentRuntimeCommands.commandId, commandId),
        eq(localAgentRuntimeCommands.operation, "session.open"),
        eq(localAgentRuntimeCommands.status, "completed"),
      )).returning();
      if (updated) return { ...updated, claimed: true };
    }
    if (current.status === "sent" || current.status === "completed") return { ...current, claimed: false };
    throw new Error("local runtime open command is not rearmable");
  });
}

export async function completeCommand(runtimeSessionId: string, commandId: string, response: Record<string, unknown>): Promise<RuntimeCommandRow> {
  const [updated] = await db.update(localAgentRuntimeCommands).set({
    status: "completed",
    response,
    errorCode: null,
    errorMessage: null,
    updatedAt: new Date(),
  }).where(and(
    eq(localAgentRuntimeCommands.runtimeSessionId, runtimeSessionId),
    eq(localAgentRuntimeCommands.commandId, commandId),
    inArray(localAgentRuntimeCommands.status, ["prepared", "sent"]),
  )).returning();
  if (updated) return updated;
  const [current] = await db.select().from(localAgentRuntimeCommands).where(and(
    eq(localAgentRuntimeCommands.runtimeSessionId, runtimeSessionId),
    eq(localAgentRuntimeCommands.commandId, commandId),
  )).limit(1);
  if (current?.status !== "completed") throw new Error("local runtime command completion was lost");
  return current;
}

export async function failCommand(runtimeSessionId: string, commandId: string, error: ProviderRuntimeError) {
  await db.update(localAgentRuntimeCommands).set({
    status: "failed",
    errorCode: error.code,
    errorMessage: error.message.slice(0, 2000),
    updatedAt: new Date(),
  }).where(and(
    eq(localAgentRuntimeCommands.runtimeSessionId, runtimeSessionId),
    eq(localAgentRuntimeCommands.commandId, commandId),
    inArray(localAgentRuntimeCommands.status, ["prepared", "sent"]),
  ));
}

/**
 * A sent prompt whose outcome cannot be established must never be retried
 * blindly. Mark the command unknown and fence the runtime so the next claim
 * requires an explicit reconnect.
 */
export async function markReconnectRequired(scope: LedgerScope, message: string, commandId?: string) {
  const error = message.slice(0, 2000);
  if (commandId) {
    await db.update(localAgentRuntimeCommands).set({ status: "unknown", errorMessage: error, updatedAt: new Date() }).where(and(
      eq(localAgentRuntimeCommands.runtimeSessionId, scope.runtimeSessionId),
      eq(localAgentRuntimeCommands.commandId, commandId),
      inArray(localAgentRuntimeCommands.status, ["prepared", "sent"]),
    ));
  }
  await db.update(localAgentRuntimeSessions).set({ status: "error", updatedAt: new Date() }).where(and(
    eq(localAgentRuntimeSessions.id, scope.runtimeSessionId),
    eq(localAgentRuntimeSessions.connectionEpoch, scope.connectionEpoch),
    eq(localAgentRuntimeSessions.status, "active"),
  ));
  await db.update(localAgentRuntimes).set({ status: "error", lastError: error, updatedAt: new Date() }).where(and(
    eq(localAgentRuntimes.id, scope.runtimeId),
    eq(localAgentRuntimes.connectionEpoch, scope.connectionEpoch),
    ne(localAgentRuntimes.status, "revoked"),
  ));
}

/** Bind (or rebind) the provider's native session to a Cohub session. */
export async function upsertRuntimeSession(input: {
  /**
   * The caller allocates the durable id before the first command is sent.
   * Keeping it on the row makes the wire runtimeSessionId, ledger scope, and
   * provider provisional id refer to the same session from the outset.
   */
  id?: string;
  runtimeId: string;
  spaceId: string;
  cohubSessionId: string;
  providerSessionId: string;
  connectionEpoch: number;
}): Promise<RuntimeSessionRow> {
  return db.transaction(async (tx) => {
    // Bindings are connection-scoped. Lock the runtime row before touching a
    // session so an old worker cannot re-activate a session after a newer
    // relay connection has fenced the runtime.
    const [runtime] = await tx.select({
      spaceId: localAgentRuntimes.spaceId,
      connectionEpoch: localAgentRuntimes.connectionEpoch,
      status: localAgentRuntimes.status,
    }).from(localAgentRuntimes).where(eq(localAgentRuntimes.id, input.runtimeId)).for("update").limit(1);
    if (!runtime || runtime.spaceId !== input.spaceId || !["ready", "busy"].includes(runtime.status) || runtime.connectionEpoch !== input.connectionEpoch) {
      throw new Error("runtime_reconnect_required: local runtime connection epoch is stale");
    }
    const [row] = await tx.select().from(localAgentRuntimeSessions).where(and(
      eq(localAgentRuntimeSessions.runtimeId, input.runtimeId),
      eq(localAgentRuntimeSessions.cohubSessionId, input.cohubSessionId),
    )).for("update").limit(1);
    if (row && input.id && row.id !== input.id) {
      throw new Error("local runtime session id does not match the durable session");
    }
    if (row && row.connectionEpoch > input.connectionEpoch) {
      throw new Error("runtime_reconnect_required: local runtime session epoch is stale");
    }
    const [providerOwner] = await tx.select({ id: localAgentRuntimeSessions.id, cohubSessionId: localAgentRuntimeSessions.cohubSessionId }).from(localAgentRuntimeSessions).where(and(
      eq(localAgentRuntimeSessions.runtimeId, input.runtimeId),
      eq(localAgentRuntimeSessions.providerSessionId, input.providerSessionId),
    )).for("update").limit(1);
    if (providerOwner && providerOwner.id !== row?.id && providerOwner.cohubSessionId !== input.cohubSessionId) {
      throw new Error("local provider session is already bound to another CoHub session");
    }
    const now = new Date();
    if (row) {
      const [updated] = await tx.update(localAgentRuntimeSessions).set({
        providerSessionId: input.providerSessionId,
        connectionEpoch: input.connectionEpoch,
        status: "active",
        lastSeenAt: now,
        updatedAt: now,
      }).where(eq(localAgentRuntimeSessions.id, row.id)).returning();
      return updated ?? row;
    }
    const [created] = await tx.insert(localAgentRuntimeSessions).values({
      ...(input.id ? { id: input.id } : {}),
      runtimeId: input.runtimeId,
      spaceId: input.spaceId,
      cohubSessionId: input.cohubSessionId,
      providerSessionId: input.providerSessionId,
      connectionEpoch: input.connectionEpoch,
      status: "active",
      lastSeenAt: now,
    }).returning();
    if (!created) throw new Error("failed to persist local runtime session");
    return created;
  });
}

export async function findRuntimeSession(runtimeId: string, cohubSessionId: string) {
  const [row] = await db.select().from(localAgentRuntimeSessions).where(and(
    eq(localAgentRuntimeSessions.runtimeId, runtimeId),
    eq(localAgentRuntimeSessions.cohubSessionId, cohubSessionId),
  )).limit(1);
  return row ?? null;
}

export async function markRuntimeSessionDisconnected(runtimeSessionId: string, connectionEpoch: number) {
  await db.update(localAgentRuntimeSessions).set({ status: "disconnected", updatedAt: new Date() }).where(and(
    eq(localAgentRuntimeSessions.id, runtimeSessionId),
    eq(localAgentRuntimeSessions.connectionEpoch, connectionEpoch),
    eq(localAgentRuntimeSessions.status, "active"),
  ));
}
