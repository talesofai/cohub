import { createHash, randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  localAgentRuntimeCommands,
  localAgentRuntimeEvents,
  localAgentRuntimeSessions,
  localAgentRuntimes,
  sessionTurns,
  spaceLocalAgentPolicies,
  workspaceExecutionAttempts,
  workspaceReplicas,
  workspaceState,
  workspaceWriterLeases,
} from "@cohub/db";
import {
  canonicalizeJson,
  type AcpJsonRpcMessage,
  type AcpJsonRpcNotification,
  type AcpJsonRpcRequest,
  type AcpJsonRpcResponse,
  type LocalAcpRuntimeCapabilities,
} from "@cohub/protocol";
import type { ContentBlock, Usage } from "@cohub/protocol/core";
import { db } from "./db.js";
import { env, isLocalAcpProviderRolloutEnabled } from "./env.js";
import { logger } from "./logger.js";
import { persistAssistantMessage, persistUserMessage, failSessionTurn } from "./persistence.js";
import { registerActiveAbortHandle } from "./active-turns.js";
import { sendOutput } from "./redis.js";

const ACP_PROTOCOL_VERSION = 1;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_RUNTIME_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_RUNTIME_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_ACP_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const RUNTIME_CWD = "/workspace";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onResponse?: (result: unknown, error: Error | null) => Promise<void>;
};

class AcpRpcError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
    this.name = "AcpRpcError";
  }
}

function isAcpRpcError(error: unknown): error is AcpRpcError {
  return error instanceof AcpRpcError;
}

type RuntimeRequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type RuntimeNotificationHandler = (method: string, params: Record<string, unknown>) => Promise<void>;

class JsonRpcWebSocket {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private notificationTail: Promise<void> = Promise.resolve();
  private notificationError: Error | null = null;
  private nextRequestId = 1;
  private closed = false;
  private readonly opened: Promise<void>;

  private constructor(
    private readonly socket: WebSocket,
    private readonly onRequest: RuntimeRequestHandler,
    private readonly onNotification: RuntimeNotificationHandler,
  ) {
    this.opened = new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        socket.off("open", onOpen);
        socket.off("error", onError);
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
    });
    socket.on("message", (data: RawData) => this.handleRawMessage(data));
    socket.on("close", () => this.handleClose(new Error("local ACP runtime connection closed")));
    socket.on("error", (error) => this.handleClose(error instanceof Error ? error : new Error(String(error))));
  }

  static async connect(
    url: string,
    headers: Record<string, string>,
    onRequest: RuntimeRequestHandler,
    onNotification: RuntimeNotificationHandler,
  ) {
    const socket = new WebSocket(url, { headers, maxPayload: MAX_RUNTIME_MESSAGE_BYTES });
    const connection = new JsonRpcWebSocket(socket, onRequest, onNotification);
    const timeout = setTimeout(() => socket.terminate(), CONNECT_TIMEOUT_MS);
    try {
      await connection.opened;
    } finally {
      clearTimeout(timeout);
    }
    return connection;
  }

  onClose(listener: (error?: Error) => void) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async request<T>(method: string, params: Record<string, unknown>, onResponse?: PendingRequest["onResponse"]): Promise<T> {
    if (this.closed) throw new Error("local ACP runtime connection is closed");
    const id = this.nextRequestId++;
    const encoded = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (Buffer.byteLength(encoded, "utf8") > MAX_RUNTIME_MESSAGE_BYTES) throw new Error("local ACP request exceeds the message size limit");
    const key = String(id);
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(key, { resolve, reject, onResponse });
    });
    try {
      this.socket.send(encoded);
    } catch (error) {
      this.pending.delete(key);
      throw error;
    }
    return promise as Promise<T>;
  }

  notify(method: string, params: Record<string, unknown>) {
    if (this.closed) throw new Error("local ACP runtime connection is closed");
    const encoded = JSON.stringify({ jsonrpc: "2.0", method, params });
    if (Buffer.byteLength(encoded, "utf8") > MAX_RUNTIME_MESSAGE_BYTES) throw new Error("local ACP notification exceeds the message size limit");
    this.socket.send(encoded);
  }

  async drainNotifications() {
    for (let pass = 0; pass < 3; pass += 1) {
      const tail = this.notificationTail;
      await tail;
      if (tail === this.notificationTail) break;
    }
    if (this.notificationError) throw this.notificationError;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.close(1000, "local ACP client closed");
    this.rejectPending(new Error("local ACP runtime connection closed"));
  }

  private handleRawMessage(data: RawData) {
    const text = data.toString();
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        this.handleClose(new Error("local ACP runtime sent invalid JSON"));
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        this.handleClose(new Error("local ACP runtime sent a non-object JSON-RPC message"));
        return;
      }
      if ((value as Record<string, unknown>).jsonrpc !== "2.0") {
        this.handleClose(new Error("local ACP runtime sent an unsupported JSON-RPC version"));
        return;
      }
      this.handleMessage(value as AcpJsonRpcMessage);
    }
  }

  private handleMessage(message: AcpJsonRpcMessage) {
    if ("method" in message && (typeof message.method !== "string" || !message.method.trim())) {
      this.handleClose(new Error("local ACP runtime returned an invalid JSON-RPC method"));
      return;
    }
    if ("id" in message && !("method" in message)) {
      const response = message as AcpJsonRpcResponse;
      if (!validJsonRpcId(response.id)) {
        this.handleClose(new Error("local ACP runtime returned an invalid JSON-RPC response id"));
        return;
      }
      const pending = this.pending.get(String(response.id));
      if (!pending) return;
      this.pending.delete(String(response.id));
      const settle = async () => {
        let responseError: AcpRpcError | null = null;
        if (response.error) {
          const code = typeof response.error.code === "number" && Number.isSafeInteger(response.error.code) ? response.error.code : -32000;
          const message = typeof response.error.message === "string" && response.error.message.trim() ? response.error.message : "ACP provider returned an error";
          responseError = new AcpRpcError(`${message} (${code})`, code);
        }
        try {
          await pending.onResponse?.(response.result, responseError);
        } catch (error) {
          pending.reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (responseError) pending.reject(responseError);
        else pending.resolve(response.result);
      };
      void this.notificationTail.then(settle).catch((error) => pending.reject(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    if ("method" in message && "id" in message) {
      const request = message as AcpJsonRpcRequest;
      void this.onRequest(request.method, request.params ?? {}).then((result) => {
        if (this.closed) return;
        try {
          this.socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
        } catch {
          this.handleClose(new Error("local ACP runtime response could not be sent"));
        }
      }).catch((error) => {
        if (this.closed) return;
        try {
          this.socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
          }));
        } catch {
          this.handleClose(new Error("local ACP runtime error response could not be sent"));
        }
      });
      return;
    }
    if ("method" in message) {
      const notification = message as AcpJsonRpcNotification;
      this.notificationTail = this.notificationTail
        .then(() => this.onNotification(notification.method, notification.params ?? {}))
        .catch((error) => {
          const failure = error instanceof Error ? error : new Error(String(error));
          this.notificationError = this.notificationError ?? failure;
          logger.warn("[LocalACP] notification projection failed", { method: notification.method, error: failure });
          throw failure;
        });
      void this.notificationTail.catch(() => undefined);
    }
  }

  private handleClose(error: Error) {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(error);
    for (const listener of this.closeListeners) listener(error);
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

type AcpToolState = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string | ContentBlock[];
  isError: boolean;
};

type LocalAcpTurnState = {
  runtimeId: string;
  spaceId: string;
  runtimeSessionId: string;
  cohubSessionId: string;
  acpSessionId: string;
  turnId: string;
  userMessageId: string;
  provider: string;
  model: string | null;
  accessMode: "read_only" | "full_access";
  executionAttemptId: string;
  commandId: string;
  leaseEpoch: number;
  content: ContentBlock[];
  tools: Map<string, AcpToolState>;
  textStreamIndexByMessageId: Map<string, number>;
  thinkingStreamIndexByMessageId: Map<string, number>;
  nextStreamIndex: number;
  currentTextStreamIndex: number | null;
  currentThinkingStreamIndex: number | null;
  usage: Usage | null;
  patchSeq: number;
  assistantMessageId: string;
  startedAt: string;
  cancelRequested: boolean;
};

type RuntimeConnection = {
  runtimeId: string;
  spaceId: string;
  cohubSessionId: string;
  connectionEpoch: number;
  capabilities: LocalAcpRuntimeCapabilities;
  acp: JsonRpcWebSocket;
  acpSessionId: string;
  runtimeSessionId: string;
  activeTurn: LocalAcpTurnState | null;
  nextInboundEventSequence: number;
  unsubscribeClose: () => void;
};

const connections = new Map<string, RuntimeConnection>();
const runtimeTails = new Map<string, Promise<unknown>>();

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const deterministicUuid = (seed: string) => {
  const hex = sha256(seed);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const nonNegativeInteger = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const validJsonRpcId = (value: unknown): value is string | number =>
  (typeof value === "string" && value.trim().length > 0) || (typeof value === "number" && Number.isFinite(value));
const nonNegativeNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const textFromAcpContent = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => textFromAcpContent(item)).join("");
  const entry = record(value);
  if (entry.type === "text") return typeof entry.text === "string" ? entry.text : "";
  if (entry.type === "content") return textFromAcpContent(entry.content);
  return "";
};

function runtimeRelayPeerUrl(runtime: typeof localAgentRuntimes.$inferSelect) {
  const base = (runtime.gatewayWsEndpoint?.trim() || env.LOCAL_ACP_RUNTIME_RELAY_URL).replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(runtime.id)}`;
}

function acpPromptContent(content: ContentBlock[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block.type === "text") result.push({ type: "text", text: block.text });
    else if (block.type === "image") {
      if (block.source.type === "url") result.push({ type: "image", uri: block.source.url });
      else result.push({ type: "image", mimeType: block.source.media_type, data: block.source.data });
    } else if (block.type === "thinking") result.push({ type: "text", text: block.thinking });
  }
  return result;
}

function mapStopReason(value: unknown): "aborted" | "error" | string | null {
  if (value === "cancelled" || value === "canceled") return "aborted";
  return typeof value === "string" ? value : null;
}

function requireAcpPromptResponse(value: unknown, persisted = false): Record<string, unknown> {
  const response = record(value);
  if (typeof response.stopReason !== "string" || !response.stopReason.trim() || response.stopReason.length > 50 || Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_RUNTIME_EVENT_BYTES) {
    throw new Error(persisted
      ? "runtime_reconnect_required: persisted ACP command response is invalid"
      : "ACP provider returned an invalid session/prompt response");
  }
  return response;
}

function getUpdate(params: Record<string, unknown>) {
  const update = params.update;
  return update && typeof update === "object" && !Array.isArray(update) ? update as Record<string, unknown> : null;
}

function appendTextBlock(content: ContentBlock[], type: "text" | "thinking", value: string, streamIndex: number) {
  if (!value) return;
  const current = content.find((block) => block.type === type && block._meta?.streamIndex === streamIndex);
  if (type === "text" && current?.type === "text") {
    current.text += value;
    return;
  }
  if (type === "thinking" && current?.type === "thinking") {
    current.thinking += value;
    return;
  }
  content.push(type === "text"
    ? { type: "text", text: value, _meta: { streamIndex } }
    : { type: "thinking", thinking: value, _meta: { streamIndex } });
}

function streamIndexForUpdate(state: LocalAcpTurnState, type: "text" | "thinking", update: Record<string, unknown>) {
  const messageId = typeof update.messageId === "string" && update.messageId.trim() ? update.messageId.trim() : null;
  const byMessageId = type === "text" ? state.textStreamIndexByMessageId : state.thinkingStreamIndexByMessageId;
  const current = type === "text" ? state.currentTextStreamIndex : state.currentThinkingStreamIndex;
  if (messageId) {
    const existing = byMessageId.get(messageId);
    if (existing !== undefined) return existing;
    const next = state.nextStreamIndex++;
    byMessageId.set(messageId, next);
    if (type === "text") state.currentTextStreamIndex = next;
    else state.currentThinkingStreamIndex = next;
    return next;
  }
  if (current !== null) return current;
  const next = state.nextStreamIndex++;
  if (type === "text") state.currentTextStreamIndex = next;
  else state.currentThinkingStreamIndex = next;
  return next;
}

function startNewContentSegment(state: LocalAcpTurnState) {
  state.currentTextStreamIndex = null;
  state.currentThinkingStreamIndex = null;
}

function parseAcpUsage(value: unknown): Usage | null {
  const usage = record(value);
  const input = nonNegativeInteger(usage.inputTokens) ?? nonNegativeInteger(usage.input_tokens);
  const output = nonNegativeInteger(usage.outputTokens) ?? nonNegativeInteger(usage.output_tokens);
  const thought = nonNegativeInteger(usage.thoughtTokens) ?? nonNegativeInteger(usage.thought_tokens);
  const cacheRead = nonNegativeInteger(usage.cachedReadTokens) ?? nonNegativeInteger(usage.cached_read_tokens) ?? nonNegativeInteger(usage.cacheRead);
  const cacheWrite = nonNegativeInteger(usage.cachedWriteTokens) ?? nonNegativeInteger(usage.cached_write_tokens) ?? nonNegativeInteger(usage.cacheWrite);
  const totalTokens = nonNegativeInteger(usage.totalTokens) ?? nonNegativeInteger(usage.total_tokens) ?? nonNegativeInteger(usage.used);
  const derivedTotal = totalTokens ?? (() => {
    const values = [input, output, thought, cacheRead, cacheWrite].filter((value): value is number => value !== undefined);
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
  })();
  const cost = record(usage.cost);
  const costAmount = nonNegativeNumber(cost.amount);
  if (input === undefined && output === undefined && thought === undefined && cacheRead === undefined && cacheWrite === undefined && derivedTotal === undefined && costAmount === undefined) return null;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(derivedTotal !== undefined ? { totalTokens: derivedTotal } : {}),
    ...(costAmount !== undefined ? { cost: { total: costAmount } } : {}),
  };
}

function toolResultContent(value: unknown): string | ContentBlock[] {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return textFromAcpContent(value) || JSON.stringify(value) || "";
  const text = textFromAcpContent(value);
  return text || value as ContentBlock[];
}

function syncToolBlocks(state: LocalAcpTurnState) {
  for (const tool of state.tools.values()) {
    const useIndex = state.content.findIndex((block) => block.type === "tool_use" && block.id === tool.id);
    if (useIndex < 0) {
      state.content.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input, _meta: { streamIndex: state.content.length } });
    } else {
      const use = state.content[useIndex];
      if (use?.type === "tool_use") {
        use.name = tool.name;
        use.input = tool.input;
      }
    }
    if (tool.result !== undefined) {
      const resultIndex = state.content.findIndex((block) => block.type === "tool_result" && block.tool_use_id === tool.id);
      if (resultIndex < 0) {
        state.content.push({ type: "tool_result", tool_use_id: tool.id, content: tool.result, is_error: tool.isError });
      } else {
        const result = state.content[resultIndex];
        if (result?.type === "tool_result") {
          result.content = tool.result;
          result.is_error = tool.isError;
        }
      }
    }
  }
}

async function persistRuntimeEvent(connection: RuntimeConnection, method: string, params: Record<string, unknown>) {
  const canonicalPayload = canonicalizeJson(params);
  if (Buffer.byteLength(canonicalPayload, "utf8") > MAX_RUNTIME_EVENT_BYTES) throw new Error("local ACP event exceeds the persistence size limit");
  const payloadHash = sha256(canonicalPayload);
  const meta = record(params._meta);
  const update = getUpdate(params);
  const updateMeta = record(update?._meta);
  const explicitId = [
    params.eventId,
    params.event_id,
    params.eventIdempotencyKey,
    meta.eventId,
    meta.cohubEventId,
    meta.eventIdempotencyKey,
    update?.eventId,
    update?.event_id,
    update?.updateId,
    updateMeta.eventId,
    updateMeta.cohubEventId,
    updateMeta.eventIdempotencyKey,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
  const sourceSequence = [params.sequence, params.eventSequence, update?.sequence, update?.eventSequence]
    .find((value): value is string | number => (typeof value === "string" && value.trim().length > 0) || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0));
  const sourceMessageId = [params.messageId, update?.messageId]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
  const commandScope = connection.activeTurn?.commandId ?? "lifecycle";
  const rawEventId = explicitId
    ? `${connection.acpSessionId}:${commandScope}:${method}:${explicitId}`
    : sourceSequence !== undefined
      ? `${connection.acpSessionId}:${commandScope}:${method}:${sourceMessageId ?? ""}:${sourceSequence}`
      : `${connection.connectionEpoch}:${connection.nextInboundEventSequence}`;
  const eventId = rawEventId.length <= 255 ? rawEventId : `${method}:${sha256(rawEventId)}`;
  connection.nextInboundEventSequence += 1;
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(localAgentRuntimeSessions).where(eq(localAgentRuntimeSessions.id, connection.runtimeSessionId)).for("update").limit(1);
    if (!session || session.status === "revoked") throw new Error("local ACP runtime session is unavailable");
    if (session.connectionEpoch !== connection.connectionEpoch) throw new Error("runtime_reconnect_required: local ACP runtime session epoch is stale");
    const [existing] = await tx.select({ id: localAgentRuntimeEvents.id, payloadHash: localAgentRuntimeEvents.payloadHash }).from(localAgentRuntimeEvents).where(and(
      eq(localAgentRuntimeEvents.runtimeSessionId, session.id),
      eq(localAgentRuntimeEvents.eventId, eventId),
    )).limit(1);
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new Error("local ACP event id was reused with different content");
      return false;
    }
    const sequence = session.lastEventSequence + 1;
    await tx.insert(localAgentRuntimeEvents).values({
      runtimeSessionId: session.id,
      eventId,
      sequence,
      direction: "inbound",
      method,
      commandId: connection.activeTurn?.commandId ?? null,
      payload: params,
      payloadHash,
    });
    await tx.update(localAgentRuntimeSessions).set({
      lastEventSequence: sequence,
      lastEventHash: payloadHash,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(localAgentRuntimeSessions.id, session.id));
    return true;
  });
}

type RuntimeCommandRow = typeof localAgentRuntimeCommands.$inferSelect;

type RuntimePromptCommand = {
  row: RuntimeCommandRow;
  shouldSend: boolean;
};

async function prepareRuntimePromptCommand(input: {
  connection: RuntimeConnection;
  state: LocalAcpTurnState;
  params: Record<string, unknown>;
}): Promise<RuntimePromptCommand> {
  const providerParams = { ...input.params };
  delete providerParams._meta;
  // The ACP session id can legitimately change when an adapter is restarted;
  // command identity is the CoHub attempt plus the actual prompt content.
  delete providerParams.sessionId;
  const paramsHash = sha256(canonicalizeJson(providerParams));
  return db.transaction(async (tx) => {
    const [runtime] = await tx.select({ connectionEpoch: localAgentRuntimes.connectionEpoch, status: localAgentRuntimes.status }).from(localAgentRuntimes).where(eq(localAgentRuntimes.id, input.connection.runtimeId)).for("update").limit(1);
    if (!runtime || !["ready", "busy"].includes(runtime.status) || runtime.connectionEpoch !== input.connection.connectionEpoch) {
      throw new Error("runtime_reconnect_required: local ACP runtime connection epoch is stale");
    }
    const [session] = await tx.select({ id: localAgentRuntimeSessions.id }).from(localAgentRuntimeSessions).where(eq(localAgentRuntimeSessions.id, input.connection.runtimeSessionId)).for("update").limit(1);
    if (!session) throw new Error("local ACP runtime session disappeared");
    const [existing] = await tx.select().from(localAgentRuntimeCommands).where(and(
      eq(localAgentRuntimeCommands.runtimeSessionId, session.id),
      eq(localAgentRuntimeCommands.commandId, input.state.commandId),
    )).for("update").limit(1);
    if (existing) {
      if (existing.runtimeId !== input.connection.runtimeId || existing.executionAttemptId !== input.state.executionAttemptId || existing.cohubSessionId !== input.state.cohubSessionId) {
        throw new Error("local ACP command id was reused by a different execution attempt");
      }
      if (existing.paramsHash !== paramsHash) throw new Error("local ACP command id was reused with different content");
      return { row: existing, shouldSend: existing.status === "prepared" };
    }
    const [last] = await tx.select({ max: sql<number>`coalesce(max(${localAgentRuntimeCommands.sequence}), 0)` }).from(localAgentRuntimeCommands).where(eq(localAgentRuntimeCommands.runtimeSessionId, session.id));
    const [created] = await tx.insert(localAgentRuntimeCommands).values({
      runtimeId: input.connection.runtimeId,
      runtimeSessionId: session.id,
      executionAttemptId: input.state.executionAttemptId,
      cohubSessionId: input.state.cohubSessionId,
      commandId: input.state.commandId,
      sequence: Number(last?.max ?? 0) + 1,
      method: "session/prompt",
      params: input.params,
      paramsHash,
      status: "prepared",
    }).returning();
    if (!created) throw new Error("failed to persist local ACP command");
    return { row: created, shouldSend: true };
  });
}

async function markRuntimePromptSent(commandId: string, runtimeSessionId: string) {
  const [updated] = await db.update(localAgentRuntimeCommands).set({
    status: "sent",
    updatedAt: new Date(),
  }).where(and(
    eq(localAgentRuntimeCommands.runtimeSessionId, runtimeSessionId),
    eq(localAgentRuntimeCommands.commandId, commandId),
    eq(localAgentRuntimeCommands.status, "prepared"),
  )).returning();
  if (updated) return updated;
  const [current] = await db.select().from(localAgentRuntimeCommands).where(and(
    eq(localAgentRuntimeCommands.runtimeSessionId, runtimeSessionId),
    eq(localAgentRuntimeCommands.commandId, commandId),
  )).limit(1);
  if (!current || (current.status !== "sent" && current.status !== "completed")) {
    throw new Error("local ACP command is not sendable");
  }
  return current;
}

async function completeRuntimePromptCommand(input: {
  commandId: string;
  runtimeSessionId: string;
  response: Record<string, unknown>;
}) {
  const [updated] = await db.update(localAgentRuntimeCommands).set({
    status: "completed",
    response: input.response,
    errorCode: null,
    errorMessage: null,
    updatedAt: new Date(),
  }).where(and(
    eq(localAgentRuntimeCommands.runtimeSessionId, input.runtimeSessionId),
    eq(localAgentRuntimeCommands.commandId, input.commandId),
    inArray(localAgentRuntimeCommands.status, ["prepared", "sent"]),
  )).returning();
  if (updated) return updated;
  const [current] = await db.select().from(localAgentRuntimeCommands).where(and(
    eq(localAgentRuntimeCommands.runtimeSessionId, input.runtimeSessionId),
    eq(localAgentRuntimeCommands.commandId, input.commandId),
  )).limit(1);
  if (current?.status !== "completed") throw new Error("local ACP command completion was lost");
  return current;
}

async function failRuntimePromptCommand(input: {
  commandId: string;
  runtimeSessionId: string;
  error: AcpRpcError;
}) {
  await db.update(localAgentRuntimeCommands).set({
    status: "failed",
    errorCode: input.error.code,
    errorMessage: input.error.message.slice(0, 2000),
    updatedAt: new Date(),
  }).where(and(
    eq(localAgentRuntimeCommands.runtimeSessionId, input.runtimeSessionId),
    eq(localAgentRuntimeCommands.commandId, input.commandId),
    inArray(localAgentRuntimeCommands.status, ["prepared", "sent"]),
  ));
}

async function replayRuntimePromptEvents(connection: RuntimeConnection, state: LocalAcpTurnState) {
  const rows = await db.select({ payload: localAgentRuntimeEvents.payload }).from(localAgentRuntimeEvents).where(and(
    eq(localAgentRuntimeEvents.runtimeSessionId, connection.runtimeSessionId),
    eq(localAgentRuntimeEvents.commandId, state.commandId),
  )).orderBy(localAgentRuntimeEvents.sequence);
  for (const row of rows) await handleSessionUpdate(connection, row.payload, false);
}

async function markRuntimeReconnectRequired(connection: RuntimeConnection, message: string, commandId?: string) {
  const error = message.slice(0, 2000);
  if (commandId) {
    await db.update(localAgentRuntimeCommands).set({ status: "unknown", errorMessage: error, updatedAt: new Date() }).where(and(
      eq(localAgentRuntimeCommands.runtimeSessionId, connection.runtimeSessionId),
      eq(localAgentRuntimeCommands.commandId, commandId),
      inArray(localAgentRuntimeCommands.status, ["prepared", "sent"]),
    ));
  }
  await db.update(localAgentRuntimeSessions).set({ status: "error", updatedAt: new Date() }).where(and(
    eq(localAgentRuntimeSessions.id, connection.runtimeSessionId),
    eq(localAgentRuntimeSessions.connectionEpoch, connection.connectionEpoch),
    eq(localAgentRuntimeSessions.status, "active"),
  ));
  await db.update(localAgentRuntimes).set({ status: "error", lastError: error, updatedAt: new Date() }).where(and(
    eq(localAgentRuntimes.id, connection.runtimeId),
    eq(localAgentRuntimes.connectionEpoch, connection.connectionEpoch),
    ne(localAgentRuntimes.status, "revoked"),
  ));
}

async function publishAcpUpdate(state: LocalAcpTurnState) {
  syncToolBlocks(state);
  const contentBytes = Buffer.byteLength(JSON.stringify(state.content), "utf8");
  if (contentBytes > MAX_ACP_TRANSCRIPT_BYTES) throw new Error("local ACP transcript exceeds the persistence size limit");
  state.patchSeq += 1;
  await sendOutput({
    type: "stream_update",
    spaceId: state.spaceId,
    sessionId: state.cohubSessionId,
    turnId: state.turnId,
    seq: state.patchSeq,
    baseSeq: state.patchSeq - 1,
    content: structuredClone(state.content),
    snapshotContent: structuredClone(state.content),
    messageId: state.assistantMessageId,
    messageOrdinal: 0,
    sourceMessageId: state.userMessageId,
    anchorUserMessageId: state.userMessageId,
    timestamp: Date.now(),
  });
}

async function handleSessionUpdate(connection: RuntimeConnection, params: Record<string, unknown>, publish = true) {
  const eventSessionId = typeof params.sessionId === "string" ? params.sessionId : null;
  if (eventSessionId && eventSessionId !== connection.acpSessionId) {
    throw new Error("local ACP update belongs to a different session");
  }
  const state = connection.activeTurn;
  if (!state) return;
  const update = getUpdate(params);
  if (!update) return;
  const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
  let changed = false;
  if (kind === "agent_message_chunk") {
    const content = record(update.content);
    if (content.type === "text" && typeof content.text === "string") {
      appendTextBlock(state.content, "text", content.text, streamIndexForUpdate(state, "text", update));
      changed = true;
    }
  } else if (kind === "agent_thought_chunk") {
    const content = record(update.content);
    if (content.type === "text" && typeof content.text === "string") {
      appendTextBlock(state.content, "thinking", content.text, streamIndexForUpdate(state, "thinking", update));
      changed = true;
    }
  } else if (kind === "tool_call") {
    startNewContentSegment(state);
    const id = typeof update.toolCallId === "string" && update.toolCallId.trim() ? update.toolCallId.trim() : null;
    if (!id) return;
    const rawInput = record(update.rawInput);
    const initialResult = update.content !== undefined
      ? toolResultContent(update.content)
      : update.rawOutput !== undefined
        ? toolResultContent(update.rawOutput)
        : undefined;
    state.tools.set(id, {
      id,
      name: typeof update.title === "string" && update.title.trim() ? update.title : typeof update.kind === "string" ? update.kind : "tool",
      input: rawInput,
      ...(initialResult !== undefined ? { result: initialResult } : {}),
      isError: update.status === "failed",
    });
    changed = true;
  } else if (kind === "tool_call_update") {
    const id = typeof update.toolCallId === "string" ? update.toolCallId.trim() : "";
    let tool = state.tools.get(id);
    if (!tool && id) {
      tool = { id, name: "tool", input: {}, isError: false };
      state.tools.set(id, tool);
    }
    if (tool) {
      if (update.rawInput && typeof update.rawInput === "object") tool.input = record(update.rawInput);
      if (typeof update.title === "string" && update.title.trim()) tool.name = update.title;
      if (typeof update.kind === "string" && update.kind.trim() && tool.name === "tool") tool.name = update.kind;
      if (update.content !== undefined) tool.result = toolResultContent(update.content);
      if (update.rawOutput !== undefined) tool.result = toolResultContent(update.rawOutput);
      if (update.status !== undefined && update.status !== null) tool.isError = update.status === "failed";
      changed = true;
    }
  } else if (kind === "usage_update") {
    const parsedUsage = parseAcpUsage(update.usage && typeof update.usage === "object" && !Array.isArray(update.usage) ? update.usage : update);
    if (parsedUsage) {
      state.usage = parsedUsage;
      changed = true;
    }
  }
  if (changed && publish) await publishAcpUpdate(state);
}

async function handleRuntimeRequest(connection: RuntimeConnection, method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === "session/request_permission") {
    const state = connection.activeTurn;
    const options = Array.isArray(params.options) ? params.options : [];
    if (state?.cancelRequested) return { outcome: { outcome: "cancelled" } };
    const allow = state?.accessMode === "full_access";
    const selected = options.find((option) => {
      const kind = record(option).kind;
      return allow ? kind === "allow_once" : kind === "reject_once";
    }) ?? options.find((option) => {
      const kind = record(option).kind;
      return allow ? kind === "allow_always" : kind === "reject_always";
    });
    await publishRuntimeControlEvent(connection, "session.permission.requested", params);
    if (state?.cancelRequested || !selected) return { outcome: { outcome: "cancelled" } };
    const optionId = record(selected).optionId;
    const result = { outcome: { outcome: "selected", optionId: typeof optionId === "string" ? optionId : "" } };
    await publishRuntimeControlEvent(connection, "session.permission.resolved", result as unknown as Record<string, unknown>);
    return result;
  }
  throw new Error(`ACP client method is not supported by Cohub: ${method}`);
}

async function publishRuntimeControlEvent(connection: RuntimeConnection, type: string, payload: Record<string, unknown>) {
  // Permission requests are already durable ACP receipts. Do not emit a fake
  // llm_call lifecycle event: that would make the Web stream count a second
  // model round for one native provider turn.
  logger.info("[LocalACP] runtime control event", {
    runtimeId: connection.runtimeId,
    turnId: connection.activeTurn?.turnId ?? null,
    type,
    payloadKeys: Object.keys(payload),
  });
}

async function ensureRuntimeSession(runtime: typeof localAgentRuntimes.$inferSelect, connectionEpoch: number, cohubSessionId: string): Promise<RuntimeConnection> {
  const existingConnection = connections.get(runtime.id);
  if (existingConnection && existingConnection.connectionEpoch === connectionEpoch && existingConnection.cohubSessionId === cohubSessionId) {
    return existingConnection;
  }
  if (existingConnection) {
    existingConnection.unsubscribeClose();
    existingConnection.acp.close();
  }
  const headers: Record<string, string> = env.WORKER_SECRET ? { "x-worker-secret": env.WORKER_SECRET } : {};
  let connection: RuntimeConnection | null = null;
  let acpClient: JsonRpcWebSocket | null = null;
  const acp = await JsonRpcWebSocket.connect(
    runtimeRelayPeerUrl(runtime),
    headers,
    (method, params) => connection ? handleRuntimeRequest(connection, method, params) : Promise.reject(new Error("local ACP connection is not initialized")),
    async (method, params) => {
      if (method !== "session/update" || !connection) return;
      try {
        const accepted = await persistRuntimeEvent(connection, method, params);
        if (accepted) await handleSessionUpdate(connection, params);
      } catch (error) {
        logger.error("[LocalACP] fatal session/update integrity error", { runtimeId: runtime.id, error });
        acpClient?.close();
        throw error;
      }
    },
  );
  acpClient = acp;
  let setupComplete = false;
  try {
  const initialized = await acp.request<Record<string, unknown>>("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "cohub-local-runtime", version: "1.0.0" },
  });
  if (initialized.protocolVersion !== ACP_PROTOCOL_VERSION) throw new Error("local ACP provider negotiated an unsupported protocol version");
  const agentCapabilities = record(initialized.agentCapabilities ?? initialized.capabilities);
  const sessionCapabilities = record(agentCapabilities.sessionCapabilities ?? initialized.sessionCapabilities);
  const [currentRuntime] = await db.select({ connectionEpoch: localAgentRuntimes.connectionEpoch, status: localAgentRuntimes.status }).from(localAgentRuntimes).where(eq(localAgentRuntimes.id, runtime.id)).limit(1);
  if (!currentRuntime || !["ready", "busy"].includes(currentRuntime.status) || currentRuntime.connectionEpoch !== connectionEpoch) {
    throw new Error("runtime_reconnect_required: local ACP runtime connection epoch is stale");
  }
  const capabilities: LocalAcpRuntimeCapabilities = {
    sessionLoad: agentCapabilities.loadSession === true || agentCapabilities.sessionLoad === true || sessionCapabilities.load === true,
    sessionResume: agentCapabilities.resumeSession === true || agentCapabilities.sessionResume === true || sessionCapabilities.resume === true,
    sessionCancel: agentCapabilities.cancelSession !== false,
    permissionRequests: agentCapabilities.permissionRequests !== false,
    nativeTools: agentCapabilities.nativeTools !== false,
  };
  const [existingSession] = await db.select().from(localAgentRuntimeSessions).where(and(
    eq(localAgentRuntimeSessions.runtimeId, runtime.id),
    eq(localAgentRuntimeSessions.cohubSessionId, cohubSessionId),
  )).for("update").limit(1);
  let acpSessionId = existingSession?.acpSessionId ?? "";
  let restored = false;
  if (existingSession && acpSessionId && capabilities.sessionResume) {
    try {
      await acp.request("session/resume", { sessionId: acpSessionId, cwd: RUNTIME_CWD, mcpServers: [] });
      restored = true;
    } catch (error) {
      logger.warn("[LocalACP] provider session resume failed", { runtimeId: runtime.id, cohubSessionId, error });
    }
  }
  if (existingSession && acpSessionId && !restored && capabilities.sessionLoad) {
    try {
      await acp.request("session/load", { sessionId: acpSessionId, cwd: RUNTIME_CWD, mcpServers: [] });
      restored = true;
    } catch (error) {
      logger.warn("[LocalACP] provider session load failed", { runtimeId: runtime.id, cohubSessionId, error });
    }
  }
  if (existingSession && existingSession.lastEventSequence > 0 && !restored) {
    throw new Error("runtime_reconnect_required: provider session cannot be resumed or loaded");
  }
  if (!restored) {
    const created = await acp.request<Record<string, unknown>>("session/new", { cwd: RUNTIME_CWD, mcpServers: [] });
    if (typeof created.sessionId !== "string" || !created.sessionId || created.sessionId.length > 255) throw new Error("local ACP runtime returned an invalid session id");
    acpSessionId = created.sessionId;
  }
  const runtimeSession = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(localAgentRuntimeSessions).where(and(
      eq(localAgentRuntimeSessions.runtimeId, runtime.id),
      eq(localAgentRuntimeSessions.cohubSessionId, cohubSessionId),
    )).for("update").limit(1);
    const [acpOwner] = await tx.select({ id: localAgentRuntimeSessions.id, cohubSessionId: localAgentRuntimeSessions.cohubSessionId }).from(localAgentRuntimeSessions).where(and(
      eq(localAgentRuntimeSessions.runtimeId, runtime.id),
      eq(localAgentRuntimeSessions.acpSessionId, acpSessionId),
    )).for("update").limit(1);
    if (acpOwner && acpOwner.id !== row?.id && acpOwner.cohubSessionId !== cohubSessionId) {
      throw new Error("local ACP provider session is already bound to another CoHub session");
    }
    if (row) {
      const [updated] = await tx.update(localAgentRuntimeSessions).set({
        acpSessionId,
        connectionEpoch,
        status: "active",
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(localAgentRuntimeSessions.id, row.id)).returning();
      return updated ?? row;
    }
    const [created] = await tx.insert(localAgentRuntimeSessions).values({
      runtimeId: runtime.id,
      spaceId: runtime.spaceId,
      cohubSessionId,
      acpSessionId,
      connectionEpoch,
      status: "active",
      lastSeenAt: new Date(),
    }).returning();
    if (!created) throw new Error("failed to persist local ACP runtime session");
    return created;
  });
  const establishedConnection: RuntimeConnection = {
    runtimeId: runtime.id,
    spaceId: runtime.spaceId,
    cohubSessionId,
    connectionEpoch,
    capabilities,
    acp,
    acpSessionId,
    runtimeSessionId: runtimeSession.id,
    activeTurn: null,
    // Continue the ingress component after durable events so an Agent restart
    // cannot reuse fallback identities while the Gateway connection epoch is
    // still valid.
    nextInboundEventSequence: runtimeSession.lastEventSequence + 1,
    unsubscribeClose: () => {},
  };
  connection = establishedConnection;
  establishedConnection.unsubscribeClose = acp.onClose(() => {
    if (connections.get(runtime.id) === establishedConnection) connections.delete(runtime.id);
    void db.update(localAgentRuntimeSessions).set({ status: "disconnected", updatedAt: new Date() }).where(and(
      eq(localAgentRuntimeSessions.id, runtimeSession.id),
      eq(localAgentRuntimeSessions.connectionEpoch, connectionEpoch),
      eq(localAgentRuntimeSessions.status, "active"),
    )).catch(() => undefined);
  });
  connections.set(runtime.id, establishedConnection);
  setupComplete = true;
  return establishedConnection;
  } finally {
    if (!setupComplete) acp.close();
  }
}

async function loadRuntimeForAttempt(attemptId: string) {
  const [row] = await db.select({
    attempt: workspaceExecutionAttempts,
    runtime: localAgentRuntimes,
    turn: sessionTurns,
    state: workspaceState,
    replica: workspaceReplicas,
  }).from(workspaceExecutionAttempts)
    .innerJoin(localAgentRuntimes, eq(localAgentRuntimes.id, workspaceExecutionAttempts.runtimeId))
    .innerJoin(sessionTurns, eq(sessionTurns.id, workspaceExecutionAttempts.turnId))
    .innerJoin(workspaceState, eq(workspaceState.spaceId, workspaceExecutionAttempts.spaceId))
    .leftJoin(workspaceReplicas, eq(workspaceReplicas.id, workspaceExecutionAttempts.replicaId))
    .where(eq(workspaceExecutionAttempts.id, attemptId)).limit(1);
  return row ?? null;
}

async function acquireLocalAcpWorkspaceLease(input: { attemptId: string; spaceId: string; replicaId: string; deviceId: string; userUuid: string; baseSnapshotId: string | null; integrationPolicyVersion: number | null }) {
  if (!input.baseSnapshotId) throw new Error("local ACP execution requires a canonical workspace snapshot");
  const baseSnapshotId = input.baseSnapshotId;
  return db.transaction(async (tx) => {
    const [policy] = await tx.select({ sessionMirrorMode: spaceLocalAgentPolicies.sessionMirrorMode, workspaceMode: spaceLocalAgentPolicies.workspaceMode, integrationPolicyVersion: spaceLocalAgentPolicies.integrationPolicyVersion }).from(spaceLocalAgentPolicies).where(and(
      eq(spaceLocalAgentPolicies.spaceId, input.spaceId),
      eq(spaceLocalAgentPolicies.deviceId, input.deviceId),
    )).limit(1);
    if (policy?.sessionMirrorMode !== "full" || policy.workspaceMode === "one_way_to_local" || input.integrationPolicyVersion == null || policy.integrationPolicyVersion !== input.integrationPolicyVersion) {
      throw new Error("runtime_transcript_consent_required: local ACP integration policy changed; re-authorize the runtime");
    }
    const [workspace] = await tx.select({ canonicalSnapshotId: workspaceState.canonicalSnapshotId, status: workspaceState.status }).from(workspaceState).where(eq(workspaceState.spaceId, input.spaceId)).for("update").limit(1);
    if (workspace?.status !== "ready" || workspace.canonicalSnapshotId !== baseSnapshotId) {
      throw new Error("local ACP workspace changed before execution; synchronize the replica and retry");
    }
    const [replica] = await tx.select({ id: workspaceReplicas.id, deviceId: workspaceReplicas.deviceId, status: workspaceReplicas.status, appliedSnapshotId: workspaceReplicas.appliedSnapshotId }).from(workspaceReplicas).where(and(
      eq(workspaceReplicas.id, input.replicaId),
      eq(workspaceReplicas.spaceId, input.spaceId),
      eq(workspaceReplicas.kind, "local"),
    )).for("update").limit(1);
    if (replica?.deviceId !== input.deviceId || replica.status !== "ready" || replica.appliedSnapshotId !== baseSnapshotId) {
      throw new Error("local ACP replica is stale or bound to a different device; synchronize it before execution");
    }
    const [existing] = await tx.select().from(workspaceWriterLeases).where(eq(workspaceWriterLeases.spaceId, input.spaceId)).for("update").limit(1);
    const now = new Date();
    const sameHolder = existing?.holderKind === "local_agent" && existing.holderId === input.attemptId;
    if (existing && existing.expiresAt > now && !sameHolder) {
      throw new Error("workspace is held by another writer");
    }
    if (existing && existing.expiresAt <= now && !sameHolder && (existing.holderKind === "local_agent" || existing.holderKind === "local_offline_reservation")) {
      const [unresolved] = await tx.select({ id: workspaceExecutionAttempts.id }).from(workspaceExecutionAttempts).where(and(
        eq(workspaceExecutionAttempts.spaceId, input.spaceId),
        inArray(workspaceExecutionAttempts.status, ["running", "workspace_sealed", "transcript_sealed", "awaiting_recovery"]),
        existing.holderKind === "local_agent" ? eq(workspaceExecutionAttempts.id, existing.holderId) : undefined,
      )).limit(1);
      if (unresolved) throw new Error("workspace takeover requires explicit confirmation");
    }
    const same = sameHolder && existing.expiresAt > now;
    const epoch = (existing?.epoch ?? 0) + (same ? 0 : 1);
    const [lease] = await tx.insert(workspaceWriterLeases).values({
      spaceId: input.spaceId,
      holderKind: "local_agent",
      holderId: input.attemptId,
      holderUserUuid: input.userUuid,
      epoch,
      baseSnapshotId,
      expiresAt: new Date(now.getTime() + 30_000),
      lastHeartbeatAt: now,
      maximumDurationAt: null,
      takeoverRequiresConfirmation: false,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: workspaceWriterLeases.spaceId,
      set: {
        holderKind: "local_agent",
        holderId: input.attemptId,
        holderUserUuid: input.userUuid,
        epoch,
        baseSnapshotId,
        expiresAt: new Date(now.getTime() + 30_000),
        lastHeartbeatAt: now,
        takeoverRequiresConfirmation: false,
        updatedAt: now,
      },
    }).returning();
    if (!lease) throw new Error("local ACP workspace lease unavailable");
    const [activatedAttempt] = await tx.update(workspaceExecutionAttempts).set({ status: "running", workspaceLeaseEpoch: lease.epoch, updatedAt: now }).where(and(eq(workspaceExecutionAttempts.id, input.attemptId), inArray(workspaceExecutionAttempts.status, ["queued", "prepared", "running"]))).returning({ id: workspaceExecutionAttempts.id });
    if (!activatedAttempt) throw new Error("local ACP execution attempt is no longer claimable");
    await tx.update(workspaceState).set({ activeExecutionAttemptId: input.attemptId, updatedAt: now }).where(eq(workspaceState.spaceId, input.spaceId));
    const [activatedReplica] = await tx.update(workspaceReplicas).set({ activeExecutionAttemptId: input.attemptId, updatedAt: now }).where(and(
      eq(workspaceReplicas.id, input.replicaId),
      eq(workspaceReplicas.spaceId, input.spaceId),
      eq(workspaceReplicas.kind, "local"),
      eq(workspaceReplicas.appliedSnapshotId, baseSnapshotId),
    )).returning({ id: workspaceReplicas.id });
    if (!activatedReplica) throw new Error("local ACP replica changed while acquiring the workspace lease");
    return lease;
  });
}

async function markLocalAcpTranscriptSealed(attemptId: string) {
  await db.update(workspaceExecutionAttempts).set({ status: "transcript_sealed", updatedAt: new Date() }).where(and(eq(workspaceExecutionAttempts.id, attemptId), inArray(workspaceExecutionAttempts.status, ["running", "queued"])));
}

async function setLocalAcpRuntimeStatus(input: {
  runtimeId: string;
  connectionEpoch: number;
  status: "busy" | "ready" | "error";
  error?: string | null;
}) {
  const now = new Date();
  const [updated] = await db.update(localAgentRuntimes).set({
    status: input.status,
    lastSeenAt: now,
    lastError: input.error ?? null,
    updatedAt: now,
  }).where(and(
    eq(localAgentRuntimes.id, input.runtimeId),
    eq(localAgentRuntimes.connectionEpoch, input.connectionEpoch),
    ne(localAgentRuntimes.status, "revoked"),
  )).returning({ id: localAgentRuntimes.id });
  if (!updated) throw new Error("local ACP runtime connection epoch is stale or revoked");
}

const localAcpErrorCode = (message: string) => message.startsWith("runtime_reconnect_required") ? "runtime_reconnect_required" : "local_acp_failed";

async function failLocalAcpAttempt(input: { attemptId: string; spaceId: string; turnId: string; message: string; errorCode?: string }) {
  await failSessionTurn({ spaceId: input.spaceId, sessionId: (await db.select({ sessionId: sessionTurns.sessionId }).from(sessionTurns).where(eq(sessionTurns.id, input.turnId)).limit(1))[0]?.sessionId ?? "", turnId: input.turnId, errorMessage: input.message }).catch(() => undefined);
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx.update(workspaceExecutionAttempts).set({ status: "failed", errorCode: input.errorCode ?? "local_acp_failed", errorMessage: input.message, completedAt: now, updatedAt: now }).where(and(
      eq(workspaceExecutionAttempts.id, input.attemptId),
      inArray(workspaceExecutionAttempts.status, ["queued", "prepared", "running", "workspace_sealed", "transcript_sealed", "awaiting_recovery"]),
    ));
    await tx.update(workspaceWriterLeases).set({ expiresAt: now, lastHeartbeatAt: now, updatedAt: now }).where(and(eq(workspaceWriterLeases.spaceId, input.spaceId), eq(workspaceWriterLeases.holderKind, "local_agent"), eq(workspaceWriterLeases.holderId, input.attemptId)));
    await tx.update(workspaceState).set({ activeExecutionAttemptId: null, updatedAt: now }).where(and(eq(workspaceState.spaceId, input.spaceId), eq(workspaceState.activeExecutionAttemptId, input.attemptId)));
    await tx.update(workspaceReplicas).set({ activeExecutionAttemptId: null, updatedAt: now }).where(and(eq(workspaceReplicas.spaceId, input.spaceId), eq(workspaceReplicas.activeExecutionAttemptId, input.attemptId)));
  });
}

export async function processLocalAcpTurn(input: { attemptId: string }) {
  const loaded = await loadRuntimeForAttempt(input.attemptId);
  if (!loaded) throw new Error("local ACP execution attempt not found");
  const { attempt, runtime, turn, state, replica } = loaded;
  if (attempt.executorKind !== "local_acp" || !attempt.runtimeId || !attempt.turnId || turn.executionKind !== "agent") throw new Error("execution attempt is not a local ACP attempt");
  const failPreflight = async (message: string, errorCode: string): Promise<never> => {
    await failLocalAcpAttempt({ attemptId: attempt.id, spaceId: attempt.spaceId, turnId: turn.id, message, errorCode }).catch((cleanupError) => {
      logger.error("[LocalACP] preflight cleanup failed", { attemptId: attempt.id, error: cleanupError });
    });
    throw new Error(message);
  };
  if (attempt.sessionMirrorMode !== "full") await failPreflight("runtime_transcript_consent_required: ACP transcript projection requires full session mirror consent", "runtime_transcript_consent_required");
  if (runtime.status === "revoked") await failPreflight("local ACP runtime is revoked", "runtime_revoked");
  if (runtime.spaceId !== attempt.spaceId || !replica?.id || runtime.replicaId !== replica.id || attempt.replicaId !== replica.id) await failPreflight("local ACP execution workspace binding is invalid", "attempt_identity_mismatch");
  const boundReplica = replica;
  if (!boundReplica) {
    await failPreflight("local ACP execution workspace binding is invalid", "attempt_identity_mismatch");
    throw new Error("local ACP execution workspace binding is invalid");
  }
  if (!turn.userUuid || runtime.userUuid !== turn.userUuid) await failPreflight("local ACP runtime ownership does not match the turn actor", "runtime_owner_mismatch");
  const meta = record(turn.meta);
  const userMessageId = typeof meta.userMessageId === "string" ? meta.userMessageId : randomUUID();
  let lease: typeof workspaceWriterLeases.$inferSelect;
  try {
    if (!isLocalAcpProviderRolloutEnabled(runtime.provider)) throw new Error(`${runtime.provider} local ACP runtime is disabled`);
    lease = await acquireLocalAcpWorkspaceLease({
      attemptId: attempt.id,
      spaceId: attempt.spaceId,
      replicaId: boundReplica.id,
      deviceId: runtime.deviceId,
      userUuid: turn.userUuid ?? runtime.userUuid,
      baseSnapshotId: attempt.baseCanonicalSnapshotId,
      integrationPolicyVersion: attempt.integrationPolicyVersion,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failLocalAcpAttempt({ attemptId: attempt.id, spaceId: attempt.spaceId, turnId: turn.id, message, errorCode: localAcpErrorCode(message) }).catch((cleanupError) => {
      logger.error("[LocalACP] lease setup cleanup failed", { attemptId: attempt.id, error: cleanupError });
    });
    throw error;
  }
  let establishedConnection: RuntimeConnection | null = null;
  try {
    establishedConnection = await ensureRuntimeSession(runtime, runtime.connectionEpoch, turn.sessionId);
    await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(localAgentRuntimeSessions).where(eq(localAgentRuntimeSessions.id, establishedConnection?.runtimeSessionId ?? "")).for("update").limit(1);
      if (!existing) throw new Error("local ACP runtime session disappeared");
      if (existing.cohubSessionId !== turn.sessionId) {
        const [conflict] = await tx.select().from(localAgentRuntimeSessions).where(and(eq(localAgentRuntimeSessions.runtimeId, runtime.id), eq(localAgentRuntimeSessions.cohubSessionId, turn.sessionId))).limit(1);
        if (conflict && conflict.id !== existing.id) throw new Error("runtime is already bound to another CoHub session");
        await tx.update(localAgentRuntimeSessions).set({ cohubSessionId: turn.sessionId, updatedAt: new Date() }).where(eq(localAgentRuntimeSessions.id, existing.id));
      }
    });
    await persistUserMessage({
      spaceId: attempt.spaceId,
      sessionId: turn.sessionId,
      userMessageId,
      turnId: turn.id,
      content: turn.userContent,
      meta: { ...meta, runtimeId: runtime.id, executorKind: "local_acp" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failLocalAcpAttempt({ attemptId: attempt.id, spaceId: attempt.spaceId, turnId: turn.id, message, errorCode: localAcpErrorCode(message) }).catch((cleanupError) => {
      logger.error("[LocalACP] setup cleanup failed", { attemptId: attempt.id, error: cleanupError });
    });
    await db.update(localAgentRuntimeSessions).set({ status: "error", updatedAt: new Date() }).where(and(
      eq(localAgentRuntimeSessions.runtimeId, runtime.id),
      eq(localAgentRuntimeSessions.cohubSessionId, turn.sessionId),
      eq(localAgentRuntimeSessions.connectionEpoch, runtime.connectionEpoch),
      eq(localAgentRuntimeSessions.status, "active"),
    )).catch(() => undefined);
    await setLocalAcpRuntimeStatus({ runtimeId: runtime.id, connectionEpoch: runtime.connectionEpoch, status: "error", error: message }).catch(() => undefined);
    establishedConnection?.acp.close();
    throw error;
  }
  if (!establishedConnection) throw new Error("local ACP runtime connection was not established");
  const connection = establishedConnection;
  if (connection.activeTurn) {
    await failLocalAcpAttempt({ attemptId: attempt.id, spaceId: attempt.spaceId, turnId: turn.id, message: "local ACP runtime already has an active turn", errorCode: "local_acp_concurrency" });
    throw new Error("local ACP runtime already has an active turn");
  }
  const stateForTurn: LocalAcpTurnState = {
    runtimeId: runtime.id,
    spaceId: attempt.spaceId,
    runtimeSessionId: connection.runtimeSessionId,
    cohubSessionId: turn.sessionId,
    acpSessionId: connection.acpSessionId,
    turnId: turn.id,
    userMessageId,
    provider: runtime.provider,
    model: typeof meta.model === "string" && meta.model.trim() ? meta.model.trim() : null,
    accessMode: meta.accessMode === "read_only" ? "read_only" : "full_access",
    executionAttemptId: attempt.id,
    commandId: `prompt:${attempt.id}`,
    leaseEpoch: lease.epoch,
    content: [],
    tools: new Map(),
    textStreamIndexByMessageId: new Map(),
    thinkingStreamIndexByMessageId: new Map(),
    nextStreamIndex: 0,
    currentTextStreamIndex: null,
    currentThinkingStreamIndex: null,
    usage: null,
    patchSeq: 0,
    assistantMessageId: deterministicUuid(`cohub-local-acp-assistant-v1:${connection.runtimeSessionId}:${turn.id}`),
    startedAt: turn.startedAt?.toISOString() ?? new Date().toISOString(),
    cancelRequested: false,
  };
  connection.activeTurn = stateForTurn;
  try {
    await setLocalAcpRuntimeStatus({ runtimeId: runtime.id, connectionEpoch: connection.connectionEpoch, status: "busy" });
  } catch (error) {
    connection.activeTurn = null;
    await failLocalAcpAttempt({ attemptId: attempt.id, spaceId: attempt.spaceId, turnId: turn.id, message: error instanceof Error ? error.message : String(error), errorCode: localAcpErrorCode(error instanceof Error ? error.message : String(error)) }).catch(() => undefined);
    connection.acp.close();
    throw error;
  }
  let cancelTimer: ReturnType<typeof setTimeout> | null = null;
  const unregisterAbortHandle = registerActiveAbortHandle(turn.id, {
    id: `local-acp:${runtime.id}:${turn.id}`,
    kind: "turn",
    abort: () => {
      if (connection.activeTurn?.turnId === turn.id) connection.activeTurn.cancelRequested = true;
      try {
        connection.acp.notify("session/cancel", { sessionId: connection.acpSessionId });
      } catch {
        // The prompt request observes the closed connection if cancellation races shutdown.
      }
      cancelTimer = setTimeout(() => {
        if (connection.activeTurn?.turnId === turn.id) connection.acp.close();
      }, 5_000);
      cancelTimer.unref?.();
    },
  });
  let leaseLost: Error | null = null;
  let heartbeatInFlight: Promise<void> | null = null;
  let heartbeatStopped = false;
  const heartbeatLease = async () => {
    const current = new Date();
    const [updated] = await db.update(workspaceWriterLeases).set({
      expiresAt: new Date(current.getTime() + 30_000),
      lastHeartbeatAt: current,
      updatedAt: current,
    }).where(and(
      eq(workspaceWriterLeases.spaceId, attempt.spaceId),
      eq(workspaceWriterLeases.holderKind, "local_agent"),
      eq(workspaceWriterLeases.holderId, attempt.id),
      eq(workspaceWriterLeases.epoch, lease.epoch),
      sql`${workspaceWriterLeases.expiresAt} > now()`,
    )).returning({ epoch: workspaceWriterLeases.epoch, expiresAt: workspaceWriterLeases.expiresAt });
    if (!updated) throw new Error("local ACP workspace lease was lost");
  };
  const runHeartbeat = () => {
    if (heartbeatStopped || heartbeatInFlight) return;
    const pending = heartbeatLease().catch((error) => {
      leaseLost = error instanceof Error ? error : new Error(String(error));
      heartbeatStopped = true;
      if (connection.activeTurn?.turnId === turn.id) connection.activeTurn.cancelRequested = true;
      try {
        connection.acp.notify("session/cancel", { sessionId: connection.acpSessionId });
      } catch {
        // The prompt request will observe the closed connection.
      }
      // Once the workspace lease is lost, the provider must not keep mutating
      // the replica while the turn is being fenced.
      connection.acp.close();
    }).finally(() => {
      if (heartbeatInFlight === pending) heartbeatInFlight = null;
    });
    heartbeatInFlight = pending;
  };
  const heartbeatTimer = setInterval(runHeartbeat, 10_000);
  heartbeatTimer.unref();
  let command: RuntimePromptCommand | null = null;
  let response: Record<string, unknown>;
  let durableResponse: Record<string, unknown> | null = null;
  let responseCompletedAt: string | null = null;
  let completionAt = new Date().toISOString();
  const promptParams = {
    sessionId: connection.acpSessionId,
    prompt: acpPromptContent(turn.userContent),
    _meta: {
      cohubCommandId: stateForTurn.commandId,
      cohubRuntimeId: runtime.id,
      cohubSpaceId: attempt.spaceId,
      cohubSessionId: turn.sessionId,
      cohubExecutionAttemptId: attempt.id,
      cohubReplicaId: boundReplica.id,
      cohubLeaseEpoch: lease.epoch,
      cohubLeaseExpiresAt: lease.expiresAt.toISOString(),
      cohubBaseSnapshotId: state.canonicalSnapshotId,
    },
  } satisfies Record<string, unknown>;
  try {
    command = await prepareRuntimePromptCommand({ connection, state: stateForTurn, params: promptParams });
    if (command.row.status === "completed") {
      if (!command.row.response) throw new Error("runtime_reconnect_required: completed ACP command has no response");
      await replayRuntimePromptEvents(connection, stateForTurn);
      response = requireAcpPromptResponse(command.row.response, true);
      stateForTurn.usage = parseAcpUsage(response.usage) ?? stateForTurn.usage;
      completionAt = command.row.updatedAt.toISOString();
    } else if (command.row.status === "sent" || command.row.status === "unknown") {
      const message = "runtime_reconnect_required: ACP prompt outcome is unknown; reconnect the local runtime before retrying";
      await markRuntimeReconnectRequired(connection, message, stateForTurn.commandId).catch(() => undefined);
      throw new Error(message);
    } else if (command.row.status === "failed") {
      throw new AcpRpcError(command.row.errorMessage ?? "local ACP prompt failed", command.row.errorCode ?? -32000);
    } else {
      const sent = await markRuntimePromptSent(stateForTurn.commandId, connection.runtimeSessionId);
      if (sent.status === "completed") {
        if (!sent.response) throw new Error("runtime_reconnect_required: completed ACP command has no response");
        await replayRuntimePromptEvents(connection, stateForTurn);
        response = requireAcpPromptResponse(sent.response, true);
        stateForTurn.usage = parseAcpUsage(response.usage) ?? stateForTurn.usage;
        completionAt = sent.updatedAt.toISOString();
      } else {
        try {
          const rawResponse = await connection.acp.request<unknown>("session/prompt", promptParams, async (result, responseError) => {
            if (responseError) {
              if (isAcpRpcError(responseError)) {
                await failRuntimePromptCommand({ commandId: stateForTurn.commandId, runtimeSessionId: connection.runtimeSessionId, error: responseError }).catch((ledgerError) => {
                  logger.warn("[LocalACP] failed to record provider command error", { commandId: stateForTurn.commandId, error: ledgerError });
                });
              }
              throw responseError;
            }
            let completedResponse = requireAcpPromptResponse(result);
            stateForTurn.usage = parseAcpUsage(completedResponse.usage) ?? stateForTurn.usage;
            if (stateForTurn.cancelRequested) completedResponse = { ...completedResponse, stopReason: "cancelled" };
            const completed = await completeRuntimePromptCommand({ commandId: stateForTurn.commandId, runtimeSessionId: connection.runtimeSessionId, response: completedResponse });
            const persistedResponse = completed.response ? requireAcpPromptResponse(completed.response, true) : completedResponse;
            responseCompletedAt = completed.updatedAt.toISOString();
            durableResponse = persistedResponse;
            response = persistedResponse;
          });
          response = durableResponse ?? requireAcpPromptResponse(rawResponse);
          stateForTurn.usage = parseAcpUsage(response.usage) ?? stateForTurn.usage;
          if (!responseCompletedAt && stateForTurn.cancelRequested) response = { ...response, stopReason: "cancelled" };
        } catch (error) {
          if (isAcpRpcError(error)) {
            await failRuntimePromptCommand({ commandId: stateForTurn.commandId, runtimeSessionId: connection.runtimeSessionId, error }).catch((ledgerError) => {
              logger.warn("[LocalACP] failed to record provider command error", { commandId: stateForTurn.commandId, error: ledgerError });
            });
          }
          throw error;
        }
        await connection.acp.drainNotifications();
        if (responseCompletedAt) {
          completionAt = responseCompletedAt;
        } else {
          const completed = await completeRuntimePromptCommand({ commandId: stateForTurn.commandId, runtimeSessionId: connection.runtimeSessionId, response });
          completionAt = completed.updatedAt.toISOString();
        }
      }
    }
    if (stateForTurn.cancelRequested && !leaseLost) response = { ...response, stopReason: "cancelled" };
    if (leaseLost) throw leaseLost;
    syncToolBlocks(stateForTurn);
    const responseIsAborted = mapStopReason(response.stopReason) === "aborted";
    const responseIsError = response.stopReason === "error" || (!responseIsAborted && stateForTurn.content.length === 0);
    await persistAssistantMessage({
      spaceId: attempt.spaceId,
      spaceSessionId: turn.sessionId,
      userMessageId,
      turnId: turn.id,
      userId: turn.userUuid,
      startedAt: stateForTurn.startedAt,
      completedAt: completionAt,
      messageOrdinal: 0,
      event: {
        type: "turn_end",
        message: {
          id: stateForTurn.assistantMessageId,
          role: "assistant",
          content: stateForTurn.content,
          provider: runtime.provider,
          model: stateForTurn.model,
          stopReason: mapStopReason(response.stopReason),
          errorMessage: responseIsError
            ? typeof response.message === "string" && response.message.trim()
              ? response.message
              : "The local ACP provider returned no assistant content."
            : null,
          usage: stateForTurn.usage,
          meta: {
            messageKind: responseIsError ? "assistant_error" : "assistant_final",
            runtimeId: runtime.id,
            acpSessionId: connection.acpSessionId,
            executionAttemptId: attempt.id,
            commandId: stateForTurn.commandId,
          },
        },
        toolResults: [],
      },
    });
    if (leaseLost) throw leaseLost;
    await markLocalAcpTranscriptSealed(attempt.id);
    connection.activeTurn = null;
    await setLocalAcpRuntimeStatus({ runtimeId: runtime.id, connectionEpoch: connection.connectionEpoch, status: "ready" }).catch((statusError) => {
      logger.warn("[LocalACP] failed to publish runtime ready status", { runtimeId: runtime.id, error: statusError });
    });
    return { attemptId: attempt.id, sessionId: turn.sessionId, turnId: turn.id, stopReason: response.stopReason ?? null };
  } catch (error) {
    connection.activeTurn = null;
    const message = error instanceof Error ? error.message : String(error);
    if (command && (command.row.status === "prepared" || command.row.status === "sent")) {
      const reconnectMessage = message.startsWith("runtime_reconnect_required") ? message : `runtime_reconnect_required: ${message}`;
      await markRuntimeReconnectRequired(connection, reconnectMessage, stateForTurn.commandId).catch((ledgerError) => {
        logger.warn("[LocalACP] failed to mark provider command outcome unknown", { commandId: stateForTurn.commandId, error: ledgerError });
      });
    }
    await failLocalAcpAttempt({ attemptId: attempt.id, spaceId: attempt.spaceId, turnId: turn.id, message, errorCode: localAcpErrorCode(message) }).catch((cleanupError) => {
      logger.error("[LocalACP] turn cleanup failed", { attemptId: attempt.id, error: cleanupError });
    });
    const requiresReconnect = message.startsWith("runtime_reconnect_required") || !isAcpRpcError(error);
    await setLocalAcpRuntimeStatus({
      runtimeId: runtime.id,
      connectionEpoch: connection.connectionEpoch,
      status: requiresReconnect ? "error" : "ready",
      error: requiresReconnect ? message : null,
    }).catch(() => undefined);
    if (requiresReconnect) {
      connection.acp.close();
      if (connections.get(runtime.id) === connection) connections.delete(runtime.id);
    }
    throw error;
  } finally {
    heartbeatStopped = true;
    clearInterval(heartbeatTimer);
    if (cancelTimer) clearTimeout(cancelTimer);
    await Promise.resolve(heartbeatInFlight).catch(() => undefined);
    unregisterAbortHandle();
  }
}

export async function findQueuedLocalAcpAttempt(sessionId: string) {
  const [row] = await db.select({ attemptId: workspaceExecutionAttempts.id }).from(workspaceExecutionAttempts).innerJoin(sessionTurns, eq(sessionTurns.id, workspaceExecutionAttempts.turnId)).where(and(
    eq(sessionTurns.sessionId, sessionId),
    eq(sessionTurns.executionKind, "agent"),
    eq(sessionTurns.status, "queued"),
    eq(workspaceExecutionAttempts.executorKind, "local_acp"),
    inArray(workspaceExecutionAttempts.status, ["queued", "prepared"]),
  )).orderBy(sessionTurns.sequence).limit(1);
  return row?.attemptId ?? null;
}

export async function closeLocalAcpConnections() {
  for (const connection of connections.values()) {
    connection.unsubscribeClose();
    connection.acp.close();
  }
  connections.clear();
  runtimeTails.clear();
}

export async function runSerializedLocalAcpTurn(attemptId: string) {
  const loaded = await loadRuntimeForAttempt(attemptId);
  if (!loaded) throw new Error("local ACP execution attempt not found");
  const previous = runtimeTails.get(loaded.runtime.id) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => processLocalAcpTurn({ attemptId }));
  runtimeTails.set(loaded.runtime.id, current);
  try {
    return await current;
  } finally {
    if (runtimeTails.get(loaded.runtime.id) === current) runtimeTails.delete(loaded.runtime.id);
  }
}
