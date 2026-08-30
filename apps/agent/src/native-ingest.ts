import { access } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Job } from "bullmq";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  nativeAgentEventReceipts,
  nativeAgentIngests,
  nativeAgentSessions,
  nativeAgentTurns,
  sessionForks,
  sessionMessages,
  sessionRealtimeOutbox,
  sessionTranscriptState,
  sessionTurnSegments,
  sessionTurns,
  spaceSessions,
  workspaceExecutionAttempts,
} from "@cohub/db";
import {
  NativeTurnBundleSchema,
  canonicalizeJsonBytes,
  type NativeTurnBundleV1,
  type SanitizedProviderHistoryEntryV1,
} from "@cohub/protocol";
import type { ContentBlock } from "@cohub/protocol/core";
import type { Usage } from "@cohub/protocol/core";
import type { RealtimeMessageRecord, RealtimeSessionRecord, RealtimeTurnRecord } from "@cohub/protocol/realtime";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent, ToolResultMessage, Usage as PiUsage, UserMessage } from "@earendil-works/pi-ai";
import { db } from "./db.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { acquireSessionLock } from "./session-lock.js";
import { getAgentSessionFilePath, getAgentSpaceSessionsPath, getAgentWorkspacePath } from "./runtime/paths.js";
import { SessionManager } from "./runtime/local-session-manager.js";
import type { NativeAgentIngestJobData } from "./queue.js";
import { publishPersistedRealtimeEnvelope } from "./redis.js";
import {
  buildNativeProjectedGroups,
  nativeContentText as toText,
  nativeGroupText,
  nativeUsage as safeUsage,
  portableContentToBlocks,
  portableToolId,
  sumNativeUsage,
} from "./native-projection.js";

const MAX_TURN_TEXT_BYTES = 32 * 1024 * 1024;

let nativePayloadClient: S3Client | null = null;
const getNativePayloadClient = () => {
  const endpoint = env.WORKSPACE_OBJECT_ENDPOINT ?? env.USER_UPLOAD_S3_ENDPOINT;
  const bucket = env.WORKSPACE_OBJECT_BUCKET ?? env.SPACE_UPLOAD_S3_BUCKET;
  const accessKeyId = env.WORKSPACE_OBJECT_ACCESS_KEY_ID ?? env.USER_UPLOAD_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.WORKSPACE_OBJECT_SECRET_ACCESS_KEY ?? env.USER_UPLOAD_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error("native_payload_storage_not_configured");
  nativePayloadClient ??= new S3Client({
    endpoint,
    region: env.WORKSPACE_OBJECT_REGION ?? env.USER_UPLOAD_S3_REGION,
    forcePathStyle: false,
    credentials: { accessKeyId, secretAccessKey },
  });
  return nativePayloadClient;
};
const getNativePayloadBucket = () => {
  const bucket = env.WORKSPACE_OBJECT_BUCKET ?? env.SPACE_UPLOAD_S3_BUCKET;
  if (!bucket) throw new Error("native_payload_storage_not_configured");
  return bucket;
};

async function readNativePayloadObject(input: { objectKey: string; expectedBytes: number; expectedSha256: string }): Promise<unknown> {
  const response = await getNativePayloadClient().send(new GetObjectCommand({
    Bucket: getNativePayloadBucket(),
    Key: input.objectKey,
  }));
  if (!response.Body) throw new Error("native_payload_object_empty");
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  if (bytes.byteLength !== input.expectedBytes) throw new Error("native_payload_size_mismatch");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("native_payload_json_invalid");
  }
  if (canonicalHash(parsed) !== input.expectedSha256) throw new Error("native_payload_hash_mismatch");
  return parsed;
}

const sha256 = (value: Uint8Array) => createHash("sha256").update(Buffer.from(value)).digest("hex");
const canonicalHash = (value: unknown) => sha256(canonicalizeJsonBytes(value));
const deterministicUuid = (domain: string, value: string) => {
  const bytes = createHash("sha256").update(`cohub-${domain}-v1\0${value}`).digest();
  bytes[6] = (bytes[6] ?? 0) & 0x0f | 0x50;
  bytes[8] = (bytes[8] ?? 0) & 0x3f | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
const toIsoOrNull = (value: Date | null | undefined) => value?.toISOString() ?? null;
const toIso = (value: Date | null | undefined) => value?.toISOString() ?? new Date().toISOString();
const recordMeta = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const realtimeMessageMeta = (value: unknown) => {
  const meta = recordMeta(value);
  if (!meta) return null;
  const allowed = [
    "messageKind", "turnId", "cohubNativeIngestId", "cohubNativeEntryId",
    "nativeMessageKey", "usageSource", "messageOrdinal", "anchorUserMessageId",
  ];
  const picked: Record<string, unknown> = {};
  for (const key of allowed) if (meta[key] !== undefined) picked[key] = meta[key];
  return Object.keys(picked).length > 0 ? picked : null;
};

function toRealtimeMessage(row: typeof sessionMessages.$inferSelect): RealtimeMessageRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as RealtimeMessageRecord["role"],
    content: row.content as ContentBlock[],
    text: row.content.length > 0 ? null : row.text ?? null,
    sequence: row.sequence,
    provider: row.provider ?? null,
    model: row.model ?? null,
    stopReason: row.stopReason ?? null,
    errorMessage: row.errorMessage ?? null,
    usage: row.usage as Usage | null,
    meta: realtimeMessageMeta(row.meta),
    startedAt: toIsoOrNull(row.startedAt),
    completedAt: toIsoOrNull(row.completedAt),
    durationMs: row.durationMs ?? null,
    createdAt: toIso(row.createdAt),
  };
}

function toRealtimeTurn(row: typeof sessionTurns.$inferSelect): RealtimeTurnRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    userUuid: row.userUuid ?? null,
    sequence: row.sequence,
    executionKind: row.executionKind,
    status: row.status,
    intent: row.intent,
    userContent: row.userContent,
    userText: row.userText ?? null,
    assistantContent: row.assistantContent ?? null,
    assistantText: row.assistantText ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    stopReason: row.stopReason ?? null,
    errorMessage: row.errorMessage ?? null,
    finalUsage: row.finalUsage ?? null,
    totalUsage: row.totalUsage ?? null,
    summary: row.summary ?? null,
    intermediateIndex: row.intermediateIndex ?? null,
    intermediateSummary: row.intermediateSummary ?? null,
    meta: recordMeta(row.meta),
    startedAt: toIsoOrNull(row.startedAt),
    completedAt: toIsoOrNull(row.completedAt),
    durationMs: row.durationMs ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function toRealtimeSession(row: typeof spaceSessions.$inferSelect): RealtimeSessionRecord {
  return {
    id: row.id,
    spaceId: row.spaceId,
    userUuid: row.userUuid ?? null,
    title: row.title ?? null,
    source: row.source ?? null,
    status: row.status ?? null,
    externalSessionId: row.externalSessionId ?? null,
    latestMessageText: row.latestMessageText ?? null,
    lastMessageAt: toIsoOrNull(row.lastMessageAt),
    lastMessageId: row.lastMessageId ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

type NativeMessageMeta = {
  cohubNativeIngestId: string;
  cohubNativeMessageKey: string;
  turnId: string;
  provider: NativeTurnBundleV1["provider"];
  adapterVersion: string;
  messageKind?: string;
};

type NativeUserMessage = UserMessage & { meta: NativeMessageMeta };
type NativeToolResultMessage = ToolResultMessage & { meta: NativeMessageMeta };
type NativeAssistantMessage = AssistantMessage & { meta: NativeMessageMeta };

const toPiUsage = (usage: Usage | null): PiUsage => ({
  input: usage?.input ?? 0,
  output: usage?.output ?? 0,
  cacheRead: usage?.cacheRead ?? 0,
  cacheWrite: usage?.cacheWrite ?? 0,
  totalTokens: usage?.totalTokens ?? 0,
  cost: {
    input: usage?.cost?.input ?? 0,
    output: usage?.cost?.output ?? 0,
    cacheRead: usage?.cost?.cacheRead ?? 0,
    cacheWrite: usage?.cost?.cacheWrite ?? 0,
    total: usage?.cost?.total ?? 0,
  },
});

function buildProviderMessage(entry: SanitizedProviderHistoryEntryV1, bundle: NativeTurnBundleV1, ingestId: string, turnId: string): AgentMessage {
  const timestamp = entry.occurredAt ? Date.parse(entry.occurredAt) : Date.now();
  const content = portableContentToBlocks(entry);
  const meta: NativeMessageMeta = {
    cohubNativeIngestId: ingestId,
    cohubNativeMessageKey: entry.nativeMessageKey,
    turnId,
    provider: bundle.provider,
    adapterVersion: bundle.adapterVersion,
  };
  if (entry.role === "user") {
    const textContent: TextContent[] = content.flatMap((block) => block.type === "text" ? [{ type: "text", text: block.text }] : []);
    const message: NativeUserMessage = { role: "user", content: textContent.length > 0 ? textContent : "", timestamp, meta };
    return message;
  }
  if (entry.role === "tool_result") {
    const resultContent = entry.toolResult?.content ?? entry.content;
    const resultBlocks: TextContent[] = resultContent.map((item) => ({
      type: "text",
      text: item.type === "text" ? item.text ?? "" : item.artifactKey ? `[Attachment: ${item.artifactKey}]` : "[Image attachment unavailable]",
    }));
    const message: NativeToolResultMessage = {
      role: "toolResult",
      toolCallId: portableToolId(entry.nativeToolCallKey ?? entry.nativeMessageKey),
      toolName: "native_tool",
      content: resultBlocks,
      isError: entry.toolResult?.isError ?? false,
      timestamp,
      meta,
    };
    return message;
  }
  if (entry.role === "compaction") {
    const message: NativeUserMessage = {
      role: "user",
      content: [{ type: "text", text: content.map((block) => block.type === "text" ? block.text : "").join("\n") }],
      timestamp,
      meta: { ...meta, messageKind: "native_compaction" },
    };
    return message;
  }
  const assistantContent: AssistantMessage["content"] = [];
  for (const block of content) {
    if (block.type === "tool_use") assistantContent.push({ type: "toolCall", id: block.id, name: block.name, arguments: block.input });
    else if (block.type === "thinking") assistantContent.push({ type: "thinking", thinking: block.thinking });
    else if (block.type === "text") assistantContent.push({ type: "text", text: block.text });
  }
  const message: NativeAssistantMessage = {
    role: "assistant",
    content: assistantContent,
    api: "native-local",
    provider: bundle.provider,
    model: "native",
    usage: toPiUsage(safeUsage(entry.usage)),
    stopReason: "stop",
    timestamp,
    meta,
  };
  return message;
}

function validateBundle(bundle: unknown, expectedHash: string) {
  const parsed = NativeTurnBundleSchema.parse(bundle);
  const versionTokens = parsed.providerVersion.split(/[^0-9.]+/).filter(Boolean);
  if (parsed.fidelityHint === "exact" && (parsed.provider !== "pi" || !versionTokens.includes("0.81.1") || parsed.adapterVersion !== "locald-pi-v1")) {
    throw new Error(`unsupported_native_transcript_version:${parsed.provider}:${parsed.providerVersion}:${parsed.adapterVersion}`);
  }
  const actualHash = canonicalHash(parsed);
  if (actualHash !== expectedHash) throw new Error("native_payload_hash_mismatch");
  const totalText = parsed.historyDelta.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry), "utf8"), 0);
  if (totalText > MAX_TURN_TEXT_BYTES) throw new Error("native_turn_content_too_large");
  const userEntries = parsed.historyDelta.filter((entry) => entry.role === "user");
  if (parsed.sessionMirrorMode === "full" && userEntries.length !== 1) throw new Error("native_turn_requires_one_user_prompt");
  if (parsed.sessionMirrorMode === "full" && !parsed.historyDelta.some((entry) => entry.role === "assistant")) throw new Error("native_turn_requires_assistant_message");
  return parsed;
}

function assertBundleMatchesIngest(bundle: NativeTurnBundleV1, ingest: typeof nativeAgentIngests.$inferSelect) {
  if (
    bundle.bundleId !== ingest.bundleId
    || bundle.executionAttemptId !== ingest.executionAttemptId
    || bundle.nativeTurnKey !== ingest.nativeTurnKey
    || bundle.workspacePolicyVersion !== ingest.workspacePolicyVersion
    || bundle.integrationPolicyVersion !== ingest.integrationPolicyVersion
    || bundle.sessionMirrorMode !== ingest.sessionMirrorMode
  ) {
    throw new Error("native_bundle_identity_mismatch");
  }
}

async function persistBundleReceipts(input: {
  ingest: typeof nativeAgentIngests.$inferSelect;
  bundle: NativeTurnBundleV1;
}) {
  await db.transaction(async (tx) => {
    for (const event of input.bundle.events) {
      const eventSha256 = canonicalHash(event);
      const [existing] = await tx.select().from(nativeAgentEventReceipts).where(and(
        eq(nativeAgentEventReceipts.bindingId, input.ingest.bindingId),
        eq(nativeAgentEventReceipts.eventId, event.eventId),
      )).for("update").limit(1);
      if (existing) {
        if (existing.eventSha256 !== eventSha256) throw new Error("native_event_id_conflict");
        await tx.update(nativeAgentEventReceipts).set({
          executionAttemptId: existing.executionAttemptId ?? input.ingest.executionAttemptId,
          nativeAgentTurnId: existing.nativeAgentTurnId ?? input.ingest.nativeAgentTurnId,
          firstIngestId: existing.firstIngestId ?? input.ingest.id,
        }).where(eq(nativeAgentEventReceipts.id, existing.id));
        continue;
      }
      await tx.insert(nativeAgentEventReceipts).values({
        bindingId: input.ingest.bindingId,
        eventId: event.eventId,
        executionAttemptId: input.ingest.executionAttemptId,
        nativeAgentTurnId: input.ingest.nativeAgentTurnId,
        eventSha256,
        eventSequence: event.nativeEventSequence,
        eventType: event.type,
        firstIngestId: input.ingest.id,
      });
    }
  });
}

async function exists(path: string) {
  try { await access(path); return true; } catch { return false; }
}

async function openOrCreateSession(spaceId: string, sessionId: string) {
  const sessionFile = getAgentSessionFilePath(spaceId, sessionId);
  const sessionsDir = getAgentSpaceSessionsPath(spaceId);
  if (await exists(sessionFile)) return SessionManager.open(sessionFile, sessionsDir, { recoverTrailingPartial: true });
  const manager = SessionManager.create(getAgentWorkspacePath(spaceId), sessionsDir);
  manager.newSession({ id: sessionId });
  manager.setSessionFile(sessionFile);
  await manager.flush();
  return manager;
}

function nativeEntryId(bindingId: string, entry: SanitizedProviderHistoryEntryV1) {
  return deterministicUuid("native-entry", `${bindingId}\0${entry.nativeMessageKey}\0${canonicalHash(entry)}`);
}
function markerId(ingestId: string) {
  return deterministicUuid("native-marker", ingestId);
}

type AgentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type NativeForkTarget = {
  parentSessionId: string;
  childSessionId: string;
  anchorTurnId: string;
  anchorSequence: number;
  anchorEntryId: string | null;
};

async function ensureRootSegment(tx: AgentTransaction, sessionId: string) {
  const [segment] = await tx.select().from(sessionTurnSegments).where(eq(sessionTurnSegments.sessionId, sessionId)).orderBy(asc(sessionTurnSegments.ordinal)).limit(1);
  if (segment) return;
  await tx.insert(sessionTurnSegments).values({
    sessionId,
    ordinal: 1,
    sourceSessionId: sessionId,
    fromSequence: 1,
    toSequence: null,
  }).onConflictDoNothing();
}

function clipNativeForkSegments(segments: Array<typeof sessionTurnSegments.$inferSelect>, anchorSequence: number) {
  const clipped: Array<{ sourceSessionId: string; fromSequence: number; toSequence: number }> = [];
  for (const segment of segments) {
    if (segment.fromSequence > anchorSequence) break;
    const toSequence = Math.min(segment.toSequence ?? anchorSequence, anchorSequence);
    if (toSequence < segment.fromSequence) continue;
    clipped.push({ sourceSessionId: segment.sourceSessionId, fromSequence: segment.fromSequence, toSequence });
    if (toSequence >= anchorSequence) break;
  }
  return clipped;
}

function forkCursor(value: unknown): NativeForkTarget | null {
  const record = recordMeta(value);
  if (!record) return null;
  const parentSessionId = typeof record.forkParentSessionId === "string" ? record.forkParentSessionId : "";
  const childSessionId = typeof record.forkChildSessionId === "string" ? record.forkChildSessionId : "";
  const anchorTurnId = typeof record.forkAnchorTurnId === "string" ? record.forkAnchorTurnId : "";
  const anchorSequence = typeof record.forkAnchorSequence === "number" ? record.forkAnchorSequence : 0;
  const anchorEntryId = typeof record.forkAnchorEntryId === "string" ? record.forkAnchorEntryId : null;
  if (!parentSessionId || !childSessionId || !anchorTurnId || !Number.isSafeInteger(anchorSequence) || anchorSequence < 1) return null;
  return { parentSessionId, childSessionId, anchorTurnId, anchorSequence, anchorEntryId };
}

async function ensureNativeContinuationFork(input: {
  tx: AgentTransaction;
  binding: typeof nativeAgentSessions.$inferSelect;
  nativeTurn: typeof nativeAgentTurns.$inferSelect;
  bundle: NativeTurnBundleV1;
}): Promise<{ sessionId: string; fork: NativeForkTarget | null; created: boolean }> {
  const { tx, binding, nativeTurn, bundle } = input;
  const storedFork = forkCursor(nativeTurn.baseCohubCursor);
  if (storedFork) {
    if (binding.cohubSessionId !== storedFork.childSessionId) {
      await tx.update(nativeAgentSessions).set({ cohubSessionId: storedFork.childSessionId, updatedAt: new Date() }).where(eq(nativeAgentSessions.id, binding.id));
    }
    return { sessionId: storedFork.childSessionId, fork: storedFork, created: true };
  }
  const sessionId = binding.cohubSessionId;
  if (!sessionId || !binding.lastMirroredTurnId) return { sessionId: sessionId ?? deterministicUuid("native-session", binding.id), fork: null, created: false };
  const [anchor] = await tx.select().from(sessionTurns).where(and(eq(sessionTurns.id, binding.lastMirroredTurnId), eq(sessionTurns.sessionId, sessionId))).limit(1);
  if (!anchor) return { sessionId, fork: null, created: false };
  const laterTurns = await tx.select().from(sessionTurns).where(and(eq(sessionTurns.sessionId, sessionId), gt(sessionTurns.sequence, anchor.sequence))).orderBy(asc(sessionTurns.sequence));
  if (laterTurns.some((turn) => ["queued", "running", "abort_requested"].includes(turn.status))) {
    throw new Error("native_session_busy");
  }
  if (!laterTurns.some((turn) => ["completed", "failed", "interrupted", "merged", "cancelled"].includes(turn.status))) {
    return { sessionId, fork: null, created: false };
  }

  const forkOperationKey = `native-fork-v1:${binding.id}:${bundle.nativeTurnKey}:${anchor.id}`;
  const childSessionId = deterministicUuid("native-fork-session", forkOperationKey);
  const [parent] = await tx.select().from(spaceSessions).where(and(eq(spaceSessions.id, sessionId), eq(spaceSessions.spaceId, binding.spaceId))).limit(1);
  if (!parent) throw new Error("native_parent_session_missing");
  let [child] = await tx.select().from(spaceSessions).where(eq(spaceSessions.id, childSessionId)).for("update").limit(1);
  let fork: typeof sessionForks.$inferSelect | undefined;
  if (!child) {
    const segments = await tx.select().from(sessionTurnSegments).where(eq(sessionTurnSegments.sessionId, sessionId)).orderBy(asc(sessionTurnSegments.ordinal));
    if (segments.length === 0) await ensureRootSegment(tx, sessionId);
    const parentSegments = segments.length > 0 ? segments : await tx.select().from(sessionTurnSegments).where(eq(sessionTurnSegments.sessionId, sessionId)).orderBy(asc(sessionTurnSegments.ordinal));
    const anchorSegment = parentSegments.find((segment) => segment.sourceSessionId === anchor.sessionId && segment.fromSequence <= anchor.sequence && (segment.toSequence == null || anchor.sequence <= segment.toSequence));
    if (!anchorSegment) throw new Error("native_fork_anchor_not_visible");
    const clipped = clipNativeForkSegments(parentSegments, anchor.sequence);
    const parentFork = (await tx.select().from(sessionForks).where(eq(sessionForks.childSessionId, sessionId)).limit(1))[0];
    const rootSessionId = parentFork?.rootSessionId ?? sessionId;
    const ancestorSessionIds = parentFork?.sessionPath ?? [sessionId];
    const sessionPath = [...ancestorSessionIds, childSessionId];
    const parentMeta = recordMeta(parent.meta) ?? {};
    const participants = recordMeta(parentMeta.participants) ?? {};
    const participantIds = Array.isArray(participants.userUuids) ? participants.userUuids.filter((value): value is string => typeof value === "string") : [];
    const childMeta = {
      ...parentMeta,
      participants: { ...participants, userUuids: [...new Set([binding.userUuid, ...participantIds])] },
      fork: { version: 1, kind: "native_continuation", createdAt: new Date().toISOString(), createdBy: binding.userUuid },
    };
    [child] = await tx.insert(spaceSessions).values({
      id: childSessionId,
      spaceId: binding.spaceId,
      userUuid: binding.userUuid,
      title: parent.title,
      source: parent.source,
      status: "active",
      externalSessionId: null,
      meta: childMeta,
      lastMessageAt: new Date(),
      lastMessageId: null,
      latestMessageText: anchor.userText ?? parent.latestMessageText ?? null,
    }).returning();
    if (!child) throw new Error("native_fork_session_create_failed");
    [fork] = await tx.insert(sessionForks).values({
      spaceId: binding.spaceId,
      parentSessionId: sessionId,
      childSessionId,
      rootSessionId,
      depth: parentFork ? parentFork.depth + 1 : 1,
      anchorSourceSessionId: anchorSegment.sourceSessionId,
      anchorTurnId: anchor.id,
      anchorSequence: anchor.sequence,
      ancestorSessionIds,
      sessionPath,
      createdBy: binding.userUuid,
    }).returning();
    if (!fork) throw new Error("native_fork_record_create_failed");
    await tx.insert(sessionTurnSegments).values([
      ...clipped.map((segment, index) => ({ sessionId: childSessionId, ordinal: index + 1, sourceSessionId: segment.sourceSessionId, fromSequence: segment.fromSequence, toSequence: segment.toSequence })),
      { sessionId: childSessionId, ordinal: clipped.length + 1, sourceSessionId: childSessionId, fromSequence: anchor.sequence + 1, toSequence: null },
    ]);
  } else {
    [fork] = await tx.select().from(sessionForks).where(eq(sessionForks.childSessionId, childSessionId)).limit(1);
    if (!fork || fork.parentSessionId !== sessionId || fork.anchorTurnId !== anchor.id || fork.anchorSequence !== anchor.sequence) {
      throw new Error("native_fork_identity_conflict");
    }
  }
  const anchorEntryId = typeof recordMeta(binding.cohubCursor)?.leafEntryId === "string" ? String(recordMeta(binding.cohubCursor)?.leafEntryId) : null;
  const forkTarget: NativeForkTarget = {
    parentSessionId: sessionId,
    childSessionId,
    anchorTurnId: anchor.id,
    anchorSequence: anchor.sequence,
    anchorEntryId,
  };
  await tx.update(nativeAgentSessions).set({ cohubSessionId: childSessionId, updatedAt: new Date() }).where(eq(nativeAgentSessions.id, binding.id));
  await tx.update(nativeAgentTurns).set({
    forkOperationKey,
    baseCohubCursor: {
      ...(recordMeta(nativeTurn.baseCohubCursor) ?? {}),
      forkParentSessionId: forkTarget.parentSessionId,
      forkChildSessionId: forkTarget.childSessionId,
      forkAnchorTurnId: forkTarget.anchorTurnId,
      forkAnchorSequence: forkTarget.anchorSequence,
      ...(forkTarget.anchorEntryId ? { forkAnchorEntryId: forkTarget.anchorEntryId } : {}),
    },
    updatedAt: new Date(),
  }).where(eq(nativeAgentTurns.id, nativeTurn.id));
  return { sessionId: childSessionId, fork: forkTarget, created: true };
}

async function ensureNativeForkFile(input: NativeForkTarget, spaceId: string) {
  const childSessionFile = getAgentSessionFilePath(spaceId, input.childSessionId);
  if (await exists(childSessionFile)) return;
  const parentSessionFile = getAgentSessionFilePath(spaceId, input.parentSessionId);
  const sessionsDir = getAgentSpaceSessionsPath(spaceId);
  const parentManager = await SessionManager.open(parentSessionFile, sessionsDir, { recoverTrailingPartial: true });
  try {
    let anchorEntryId = input.anchorEntryId;
    if (!anchorEntryId) {
      const candidate = [...parentManager.getEntries()].reverse().find((entry) => {
        if (entry.type !== "message") return false;
        const message = entry.message as AgentMessage & { meta?: unknown };
        const meta = recordMeta(message.meta);
        return meta?.turnId === input.anchorTurnId;
      });
      anchorEntryId = candidate?.id ?? null;
    }
    if (!anchorEntryId) throw new Error("native_fork_anchor_entry_missing");
    await parentManager.createBranchedSession(anchorEntryId, {
      id: input.childSessionId,
      filePath: childSessionFile,
      parentSession: parentSessionFile,
    });
  } finally {
    await parentManager.close();
  }
}

async function createSessionAndTurn(input: { ingestId: string; bundle: NativeTurnBundleV1; bindingId: string; nativeTurnId: string }) {
  return db.transaction(async (tx) => {
    const [binding] = await tx.select().from(nativeAgentSessions).where(eq(nativeAgentSessions.id, input.bindingId)).for("update").limit(1);
    if (!binding) throw new Error("native_binding_missing");
    let sessionId = binding.cohubSessionId;
    let sessionCreated = false;
    if (!sessionId) {
      sessionId = deterministicUuid("native-session", input.bindingId);
      await tx.insert(spaceSessions).values({
        id: sessionId,
        spaceId: binding.spaceId,
        userUuid: binding.userUuid,
        source: "local_agent",
        status: "active",
        meta: {
          localAgent: {
            provider: binding.provider,
            deviceId: binding.deviceId,
            replicaId: binding.replicaId,
            adapterVersion: binding.adapterVersion,
            mirrorFidelity: binding.mirrorFidelity,
            mirrorCompleteness: binding.mirrorCompleteness,
          },
          participants: { userUuids: [binding.userUuid] },
        },
        lastMessageAt: new Date(),
      }).onConflictDoNothing();
      await tx.update(nativeAgentSessions).set({ cohubSessionId: sessionId, updatedAt: new Date() }).where(eq(nativeAgentSessions.id, binding.id));
      await ensureRootSegment(tx, sessionId);
      sessionCreated = true;
    }
    const [existingTurn] = await tx.select().from(nativeAgentTurns).where(eq(nativeAgentTurns.id, input.nativeTurnId)).for("update").limit(1);
    if (!existingTurn) throw new Error("native_turn_projection_row_missing");
    const continuation = await ensureNativeContinuationFork({ tx, binding, nativeTurn: existingTurn, bundle: input.bundle });
    sessionId = continuation.sessionId;
    const firstUser = input.bundle.historyDelta.find((entry) => entry.role === "user");
    const userContent = firstUser ? portableContentToBlocks(firstUser) : [{ type: "text", text: "[Native turn]" } satisfies ContentBlock];
    if (existingTurn.cohubTurnId) {
      const [priorCohubTurn] = await tx.select({ meta: sessionTurns.meta }).from(sessionTurns).where(eq(sessionTurns.id, existingTurn.cohubTurnId)).limit(1);
      return {
        sessionId,
        turnId: existingTurn.cohubTurnId,
        sessionCreated: sessionCreated || continuation.created || recordMeta(priorCohubTurn?.meta)?.nativeSessionCreated === true,
        turnCreated: false,
        fork: continuation.fork,
      };
    }
    const [sequenceRow] = await tx.select({ max: sql<number>`coalesce(max(${sessionTurns.sequence}), 0)::int` }).from(sessionTurns).where(eq(sessionTurns.sessionId, sessionId));
    const sequenceBase = Math.max(sequenceRow?.max ?? 0, continuation.fork?.anchorSequence ?? 0);
    const turnId = deterministicUuid("native-turn", `${input.bindingId}\0${input.bundle.nativeTurnKey}`);
    const [turn] = await tx.insert(sessionTurns).values({
      id: turnId,
      sessionId,
      userUuid: binding.userUuid,
      sequence: sequenceBase + 1,
      executionKind: "native_agent",
      status: "running",
      intent: "followup",
      userContent,
      userText: toText(userContent),
      provider: input.bundle.provider,
      model: "native",
      meta: {
        executionAttemptId: input.bundle.executionAttemptId,
        nativeIngestId: input.ingestId,
        nativeSessionCreated: sessionCreated || continuation.created,
        nativeTurnCreated: true,
        localAgent: {
          bindingId: binding.id,
          nativeTurnKey: input.bundle.nativeTurnKey,
          provider: input.bundle.provider,
          adapterVersion: input.bundle.adapterVersion,
          mirrorFidelity: input.bundle.fidelityHint,
          mirrorCompleteness: input.bundle.sessionMirrorMode === "metadata_only" ? "metadata_only" : "complete",
          usageSource: "external",
        },
      },
    }).onConflictDoNothing().returning();
    let turnCreated = Boolean(turn);
    if (!turn) {
      const [raced] = await tx.select({ id: sessionTurns.id }).from(sessionTurns).where(eq(sessionTurns.id, turnId)).limit(1);
      if (!raced) throw new Error("native_turn_projection_create_failed");
      turnCreated = false;
    }
    await tx.update(nativeAgentTurns).set({ cohubSessionId: sessionId, cohubTurnId: turnId, updatedAt: new Date() }).where(eq(nativeAgentTurns.id, input.nativeTurnId));
    await tx.update(nativeAgentIngests).set({ cohubSessionId: sessionId, cohubTurnId: turnId, updatedAt: new Date() }).where(eq(nativeAgentIngests.id, input.ingestId));
    return { sessionId, turnId, sessionCreated: sessionCreated || continuation.created, turnCreated, fork: continuation.fork };
  });
}

async function appendPhysicalEntries(manager: SessionManager, input: { bindingId: string; ingestId: string; turnId: string; bundle: NativeTurnBundleV1 }) {
  const existing = new Set(manager.getEntries().map((entry) => entry.id));
  const ids: string[] = [];
  for (const entry of input.bundle.historyDelta) {
    const id = nativeEntryId(input.bindingId, entry);
    ids.push(id);
    if (existing.has(id)) continue;
    const message = buildProviderMessage(entry, input.bundle, input.ingestId, input.turnId);
    manager.appendMessage(message, { id });
    existing.add(id);
  }
  return ids;
}

async function projectEntries(input: {
  ingestId: string;
  bindingId: string;
  turnId: string;
  sessionId: string;
  bundle: NativeTurnBundleV1;
  entryIds: string[];
  markerEntryId: string;
}) {
  return db.transaction(async (tx) => {
    const sequenceRow = await tx.select({ max: sql<number>`coalesce(max(${sessionMessages.sequence}), 0)::int` }).from(sessionMessages).where(eq(sessionMessages.sessionId, input.sessionId));
    let nextSequence = (sequenceRow[0]?.max ?? 0) + 1;
    const projectedMessageIds: string[] = [];
    const groups = buildNativeProjectedGroups(input.bundle, input.entryIds);
    for (const group of groups) {
      const sourceKey = canonicalHash(group.sources.map((source) => ({ key: source.nativeMessageKey, hash: canonicalHash(source) })));
      const messageId = deterministicUuid("native-message", `${input.bindingId}\0${sourceKey}`);
      const idempotencyKey = `native:${input.ingestId}:${sourceKey}`;
      const firstSource = group.sources[0];
      const lastSource = group.sources.at(-1) ?? firstSource;
      if (!firstSource || !lastSource) continue;
      const [message] = await tx.insert(sessionMessages).values({
        id: messageId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        role: group.role,
        content: group.content,
        text: nativeGroupText(group.content),
        provider: input.bundle.provider,
        model: "native",
        stopReason: group.role === "assistant" && group.messageKind === "assistant_final" ? "stop" : group.role === "assistant" ? "tool_use" : null,
        meta: {
          messageKind: group.messageKind,
          cohubNativeIngestId: input.ingestId,
          cohubNativeEntryId: group.entryIds[0],
          cohubNativeEntryIds: group.entryIds,
          nativeMessageKey: firstSource.nativeMessageKey,
          nativeMessageKeys: group.sources.map((source) => source.nativeMessageKey),
          turnId: input.turnId,
          usageSource: "external",
        },
        idempotencyKey,
        sequence: nextSequence,
        usage: group.usage,
        startedAt: firstSource.occurredAt ? new Date(firstSource.occurredAt) : new Date(),
        completedAt: lastSource.occurredAt ? new Date(lastSource.occurredAt) : new Date(),
      }).onConflictDoNothing().returning();
      if (message) {
        projectedMessageIds.push(message.id);
        nextSequence += 1;
      } else {
        const [existing] = await tx.select({ id: sessionMessages.id }).from(sessionMessages).where(and(eq(sessionMessages.sessionId, input.sessionId), eq(sessionMessages.idempotencyKey, idempotencyKey))).limit(1);
        if (existing) projectedMessageIds.push(existing.id);
      }
    }

    const lastAssistant = [...groups].reverse().find((group) => group.role === "assistant");
    const terminalStatus = input.bundle.events.some((event) => event.type === "turn_failed") ? "failed" : "completed";
    const finalContent = lastAssistant?.content ?? null;
    const totalUsage = sumNativeUsage(groups.filter((group) => group.role === "assistant"));
    await tx.update(sessionTurns).set({
      status: terminalStatus,
      assistantContent: finalContent,
      assistantText: finalContent ? nativeGroupText(finalContent) : null,
      provider: input.bundle.provider,
      model: "native",
      stopReason: terminalStatus === "failed" ? "error" : "stop",
      errorMessage: terminalStatus === "failed" ? "Native provider reported a failed turn" : null,
      finalUsage: lastAssistant?.usage ?? null,
      totalUsage,
      summary: { text: finalContent ? nativeGroupText(finalContent) : null, finishReason: terminalStatus === "failed" ? "failed" : "completed" },
      meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify({ nativeTranscriptMarkerId: input.markerEntryId, nativeIngestId: input.ingestId })}::jsonb`,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(sessionTurns.id, input.turnId), inArray(sessionTurns.status, ["queued", "running", "abort_requested"])));

    // The realtime outbox is inserted after the physical commit marker is
    // durable. This keeps a dispatcher from exposing a partially projected
    // native turn while the marker barrier is still absent.
    await tx.update(nativeAgentIngests).set({ transcriptEntryIds: input.entryIds, transcriptMarkerEntryId: input.markerEntryId, transcriptVisibility: "hidden", status: "publishing_marker", updatedAt: new Date() }).where(and(eq(nativeAgentIngests.id, input.ingestId), inArray(nativeAgentIngests.status, ["committed", "translating", "forking", "appending_jsonl", "projecting", "publishing_marker"])));
    await tx.update(workspaceExecutionAttempts).set({
      status: sql`case when ${workspaceExecutionAttempts.status} = 'workspace_sealed' then 'completed' else 'transcript_sealed' end`,
      resultTranscriptCursor: { sessionId: input.sessionId, turnId: input.turnId, markerEntryId: input.markerEntryId },
      completedAt: sql`case when ${workspaceExecutionAttempts.status} = 'workspace_sealed' then now() else ${workspaceExecutionAttempts.completedAt} end`,
      updatedAt: new Date(),
    }).where(and(eq(workspaceExecutionAttempts.id, input.bundle.executionAttemptId), inArray(workspaceExecutionAttempts.status, ["prepared", "running", "workspace_sealed", "awaiting_recovery"])));
    return { projectedMessageIds };
  });
}

async function publishStoredOutbox(spaceId: string, sessionId: string, ingestId: string) {
  const rows = await db.select().from(sessionRealtimeOutbox).where(and(eq(sessionRealtimeOutbox.spaceId, spaceId), eq(sessionRealtimeOutbox.sessionId, sessionId), eq(sessionRealtimeOutbox.ingestId, ingestId), eq(sessionRealtimeOutbox.status, "ready"))).orderBy(asc(sessionRealtimeOutbox.revision));
  for (const row of rows) {
    try {
      const stored = row.envelope as Record<string, unknown>;
      await publishPersistedRealtimeEnvelope({
        id: typeof stored.id === "string" ? stored.id : row.id,
        timestamp: typeof stored.timestamp === "number" ? stored.timestamp : row.createdAt.getTime(),
        domain: "session",
        type: typeof stored.type === "string" ? stored.type : row.eventType,
        spaceId,
        sessionId,
        payload: stored.payload && typeof stored.payload === "object" && !Array.isArray(stored.payload)
          ? stored.payload as Record<string, unknown>
          : {},
      });
      await db.update(sessionRealtimeOutbox).set({ status: "published", publishedAt: new Date(), updatedAt: new Date() }).where(and(eq(sessionRealtimeOutbox.id, row.id), eq(sessionRealtimeOutbox.status, "ready")));
    } catch (error) {
      logger.warn("[NativeIngest] realtime outbox publish failed", { ingestId, error });
    }
  }
}

async function markQuarantined(ingestId: string, code: string, message: string) {
  await db.update(nativeAgentIngests).set({ status: "quarantined", errorCode: code, errorMessage: message, updatedAt: new Date() }).where(and(eq(nativeAgentIngests.id, ingestId), inArray(nativeAgentIngests.status, ["prepared", "uploaded", "committed", "translating", "publishing_marker"])));
}

export async function processNativeAgentIngestJob(job: Job<NativeAgentIngestJobData>) {
  const { ingestId } = job.data;
  const [ingest] = await db.select().from(nativeAgentIngests).where(eq(nativeAgentIngests.id, ingestId)).limit(1);
  if (!ingest) throw new Error("native_ingest_not_found");
  if (ingest.status === "applied" || ingest.status === "quarantined") return { ingestId, status: ingest.status };
  if (ingest.status === "prepared") return { ingestId, status: "prepared", skipped: "upload_not_committed" };
  let payload: unknown = ingest.payloadInline;
  if (!payload) {
    if (!ingest.payloadObjectKey) {
      await markQuarantined(ingest.id, "native_payload_missing", "Native ingest has neither inline nor object-backed payload data");
      return { ingestId, status: "quarantined" };
    }
    await db.update(nativeAgentIngests).set({ status: "verifying", attemptCount: sql`${nativeAgentIngests.attemptCount} + 1`, updatedAt: new Date() }).where(and(eq(nativeAgentIngests.id, ingest.id), inArray(nativeAgentIngests.status, ["uploaded", "verifying"]))).catch(() => undefined);
    payload = await readNativePayloadObject({
      objectKey: ingest.payloadObjectKey,
      expectedBytes: ingest.payloadBytes,
      expectedSha256: ingest.payloadSha256,
    });
    if (ingest.status === "uploaded" || ingest.status === "verifying") {
      await db.update(nativeAgentIngests).set({ status: "committed", errorCode: null, errorMessage: null, updatedAt: new Date() }).where(and(eq(nativeAgentIngests.id, ingest.id), inArray(nativeAgentIngests.status, ["uploaded", "verifying"]))).catch(() => undefined);
    }
  }
  const bundle = validateBundle(payload, ingest.payloadSha256);
  assertBundleMatchesIngest(bundle, ingest);
  await persistBundleReceipts({ ingest, bundle });
  if (ingest.sessionMirrorMode === "metadata_only" || ingest.transcriptVisibility === "orphaned") {
    await db.transaction(async (tx) => {
      await tx.update(nativeAgentIngests).set({ status: "applied", transcriptVisibility: "orphaned", updatedAt: new Date() }).where(eq(nativeAgentIngests.id, ingest.id));
      await tx.update(nativeAgentTurns).set({
        status: "applied",
        resultCohubCursor: null,
        stoppedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(nativeAgentTurns.id, ingest.nativeAgentTurnId));
      await tx.update(nativeAgentSessions).set({
        nativeCursor: bundle.nextNativeCursor,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(nativeAgentSessions.id, ingest.bindingId));
      await tx.update(workspaceExecutionAttempts).set({
        status: sql`case when ${workspaceExecutionAttempts.status} = 'workspace_sealed' then 'completed' else 'transcript_sealed' end`,
        completedAt: sql`case when ${workspaceExecutionAttempts.status} = 'workspace_sealed' then now() else ${workspaceExecutionAttempts.completedAt} end`,
        updatedAt: new Date(),
      }).where(and(
        eq(workspaceExecutionAttempts.id, ingest.executionAttemptId),
        inArray(workspaceExecutionAttempts.status, ["prepared", "running", "workspace_sealed", "awaiting_recovery"]),
      ));
    });
    return { ingestId, status: "applied", metadataOnly: true };
  }
  const [binding] = await db.select().from(nativeAgentSessions).where(eq(nativeAgentSessions.id, ingest.bindingId)).limit(1);
  const [nativeTurn] = await db.select().from(nativeAgentTurns).where(eq(nativeAgentTurns.id, ingest.nativeAgentTurnId)).limit(1);
  if (!binding || !nativeTurn) throw new Error("native_binding_or_turn_missing");
  const sessionId = binding.cohubSessionId ?? deterministicUuid("native-session", binding.id);
  const lockSessionId = forkCursor(nativeTurn.baseCohubCursor)?.parentSessionId ?? sessionId;
  const lock = await acquireSessionLock(lockSessionId, { holderKind: "native_ingest", holderId: ingest.id });
  if (!lock) throw new Error("native_session_busy");
  let manager: SessionManager | null = null;
  try {
    lock.assertHealthy();
    const target = await createSessionAndTurn({ ingestId: ingest.id, bundle, bindingId: binding.id, nativeTurnId: nativeTurn.id });
    if (target.fork) await ensureNativeForkFile(target.fork, binding.spaceId);
    manager = await openOrCreateSession(binding.spaceId, target.sessionId);
    const entryIds = await appendPhysicalEntries(manager, { bindingId: binding.id, ingestId: ingest.id, turnId: target.turnId, bundle });
    await manager.flush();
    const markerEntryId = markerId(ingest.id);
    const markerExists = manager.hasTranscriptCommitMarker(ingest.id);
    const [projectedMessage] = await db.select({ id: sessionMessages.id }).from(sessionMessages).where(and(
      eq(sessionMessages.sessionId, target.sessionId),
      eq(sessionMessages.turnId, target.turnId),
      sql`${sessionMessages.meta}->>'cohubNativeIngestId' = ${ingest.id}`,
    )).limit(1);
    const [projectedTurn] = await db.select({ meta: sessionTurns.meta }).from(sessionTurns).where(eq(sessionTurns.id, target.turnId)).limit(1);
    const projectedTurnMeta = recordMeta(projectedTurn?.meta);
    const projectionReady = Boolean(projectedMessage && projectedTurnMeta?.nativeTranscriptMarkerId === markerEntryId);
    // Projection is replayable. If a process died after appending the marker
    // but before committing the DB rows (or vice versa), rebuild the hidden
    // projection before treating the marker as a visibility barrier.
    if (!projectionReady) {
      await projectEntries({
        ingestId: ingest.id,
        bindingId: binding.id,
        turnId: target.turnId,
        sessionId: target.sessionId,
        bundle,
        entryIds,
        markerEntryId,
      });
    }
    if (!markerExists) {
      manager.appendCustomEntry("cohub_transcript_commit", {
        protocolVersion: 1,
        ingestId: ingest.id,
        entryIds,
        finalEntryHash: entryIds.at(-1) ? canonicalHash(entryIds.at(-1)) : "",
        previousVisibleLeafId: manager.getVisibleEntries().at(-1)?.id ?? null,
      }, { id: markerEntryId });
      await manager.flush();
    }
    lock.assertHealthy();
    await db.transaction(async (tx) => {
      await tx.update(nativeAgentIngests).set({ status: "applied", transcriptVisibility: "visible", transcriptMarkerEntryId: markerEntryId, transcriptEntryIds: entryIds, cohubSessionId: target.sessionId, cohubTurnId: target.turnId, updatedAt: new Date() }).where(eq(nativeAgentIngests.id, ingest.id));
      await tx.update(nativeAgentTurns).set({ status: "applied", resultCohubCursor: { sessionId: target.sessionId, leafEntryId: markerEntryId }, stoppedAt: new Date(), updatedAt: new Date() }).where(eq(nativeAgentTurns.id, nativeTurn.id));
      await tx.update(nativeAgentSessions).set({ cohubSessionId: target.sessionId, cohubCursor: { sessionId: target.sessionId, leafEntryId: markerEntryId }, lastMirroredTurnId: target.turnId, nativeCursor: bundle.nextNativeCursor, updatedAt: new Date(), lastSeenAt: new Date() }).where(eq(nativeAgentSessions.id, binding.id));
      await tx.insert(sessionTranscriptState).values({
        sessionId: target.sessionId,
        visibleLeafEntryId: markerEntryId,
        physicalLeafEntryId: markerEntryId,
        visibleLeafHash: canonicalHash(markerEntryId),
        physicalLeafHash: canonicalHash(markerEntryId),
        logicalEntryCount: entryIds.length,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: sessionTranscriptState.sessionId,
        set: {
          visibleLeafEntryId: markerEntryId,
          physicalLeafEntryId: markerEntryId,
          visibleLeafHash: canonicalHash(markerEntryId),
          physicalLeafHash: canonicalHash(markerEntryId),
          logicalEntryCount: entryIds.length,
          updatedAt: new Date(),
        },
      });

      // Rebuild the standard realtime records from committed rows. The
      // delivery keys make this safe when a worker crashes after insertion.
      const [bindingRow] = await tx.select({ spaceId: nativeAgentSessions.spaceId }).from(nativeAgentSessions).where(eq(nativeAgentSessions.id, binding.id)).limit(1);
      const [turnRow] = await tx.select().from(sessionTurns).where(eq(sessionTurns.id, target.turnId)).limit(1);
      const messageRows = await tx.select().from(sessionMessages).where(and(
        eq(sessionMessages.sessionId, target.sessionId),
        sql`${sessionMessages.meta}->>'cohubNativeIngestId' = ${ingest.id}`,
      )).orderBy(asc(sessionMessages.sequence));
      const lastMessage = messageRows.at(-1) ?? null;
      if (lastMessage) {
        await tx.update(spaceSessions).set({
          lastMessageId: lastMessage.id,
          latestMessageText: lastMessage.text,
          lastMessageAt: lastMessage.createdAt ?? new Date(),
          updatedAt: new Date(),
        }).where(eq(spaceSessions.id, target.sessionId));
      }
      const [sessionRow] = await tx.select().from(spaceSessions).where(eq(spaceSessions.id, target.sessionId)).limit(1);
      if (!bindingRow || !turnRow || !sessionRow) throw new Error("native_realtime_projection_rows_missing");
      const turnMeta = turnRow.meta && typeof turnRow.meta === "object" && !Array.isArray(turnRow.meta)
        ? turnRow.meta as Record<string, unknown>
        : {};
      const outboxRows: Array<{
        deliveryKey: string;
        ingestId: string;
        sessionId: string;
        eventType: string;
        entityId: string;
        revision: number;
        envelope: Record<string, unknown>;
      }> = [];
      let revision = Math.max(...messageRows.map((row) => row.sequence), 1) * 10;
      const addEvent = (suffix: string, eventType: string, entityId: string, payload: Record<string, unknown>) => {
        outboxRows.push({
          deliveryKey: `native:${ingest.id}:${suffix}`,
          ingestId: ingest.id,
          sessionId: target.sessionId,
          eventType,
          entityId,
          revision,
          envelope: {
            id: deterministicUuid("native-envelope", `${ingest.id}:${suffix}`),
            timestamp: turnRow.updatedAt?.getTime() ?? Date.now(),
            domain: "session",
            type: eventType,
            spaceId: bindingRow.spaceId,
            sessionId: target.sessionId,
            payload,
          },
        });
        revision += 1;
      };
      if (turnMeta.nativeSessionCreated === true) {
        addEvent("session-created", "session.created", target.sessionId, { session: toRealtimeSession(sessionRow) });
      }
      if (turnMeta.nativeTurnCreated === true) {
        addEvent("turn-created", "session.turn.created", target.turnId, { turn: toRealtimeTurn(turnRow) });
      }
      for (const row of messageRows) {
        addEvent(`message:${row.id}`, "session.message.persisted", row.id, { message: toRealtimeMessage(row) });
      }
      addEvent("turn-updated", "session.turn.updated", target.turnId, { turn: toRealtimeTurn(turnRow) });
      addEvent("turn-finalized", "session.turn.finalized", target.turnId, { turn: toRealtimeTurn(turnRow), sessionLabelRefs: null });
      addEvent("session-updated", "session.updated", target.sessionId, {
        session: toRealtimeSession(sessionRow),
        changed: ["lastMessageId", "latestMessageText", "lastMessageAt", "updatedAt"],
      });
      for (const row of outboxRows) {
        await tx.insert(sessionRealtimeOutbox).values({ ...row, spaceId: bindingRow.spaceId }).onConflictDoNothing();
      }
    });
    await publishStoredOutbox(binding.spaceId, target.sessionId, ingest.id);
    return { ingestId, status: "applied", sessionId: target.sessionId, turnId: target.turnId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^native_(?:payload|bundle|turn|text|schema)|unsupported/i.test(message)) {
      await markQuarantined(ingest.id, "native_bundle_invalid", message);
      return { ingestId, status: "quarantined" };
    }
    throw error;
  } finally {
    await manager?.close().catch((error) => logger.warn("[NativeIngest] session close failed", error));
    await lock.release();
  }
}
