import type { ContentBlock, Usage } from "@cohub/protocol/core";
import { getRealtimeSpaceRoom } from "@cohub/protocol/realtime/types";
import type {
  MessageRecord,
  SessionTurnRecord,
} from "@cohub/protocol/model";
import { ensureRealtimeConnected } from "./realtime.js";
import {
  SessionPatchReducer,
  type SessionPatchApplyInput,
  type SessionPatchApplyResult,
  type SessionPatchState,
} from "./session-patch-reducer.js";
import type { SessionTurnStreamSnapshotResponse } from "./types.js";
import type { WebsocketClient, WebsocketEventPayload } from "./websocket.js";

export type AssistantMessageCommit =
  | {
      kind: "intermediate";
      message: MessageRecord;
      isFinal: false;
    }
  | {
      kind: "final";
      message: MessageRecord;
      isFinal: true;
    }
  | {
      kind: "error";
      message: MessageRecord;
      isFinal: true;
    }
  | {
      kind: "ignored";
      message: MessageRecord;
      isFinal: false;
    };

export type GenerationStreamIntermediateMessage = {
  id?: string;
  sessionId?: string;
  role?: "user" | "assistant" | "system";
  messageId: string | null;
  messageOrdinal: number | null;
  content: ContentBlock[];
  text?: string | null;
  provider?: string | null;
  model?: string | null;
  stopReason?: string | null;
  errorMessage?: string | null;
  usage?: Usage | null;
  durationMs?: number | null;
  toolCallsObjectKey?: string | null;
  meta?: Record<string, unknown> | null;
  createdAt?: string;
};

export type GenerationStreamStateEvent = {
  type: "state";
  source: "patch" | "snapshot";
  state: SessionPatchState;
  messageId: string | null;
  messageOrdinal: number | null;
  intermediateMessages: GenerationStreamIntermediateMessage[];
  rawEvent: WebsocketEventPayload | null;
};

export type GenerationStreamCommitEvent = {
  type: "commit";
  commit: AssistantMessageCommit;
  rawEvent: WebsocketEventPayload;
};

export type GenerationStreamFinalizedEvent = {
  type: "finalized";
  turn: SessionTurnRecord;
  rawEvent: WebsocketEventPayload;
};

export type GenerationStreamTurnUpdatedEvent = {
  type: "turn_updated";
  turn: Partial<SessionTurnRecord>;
  rawEvent: WebsocketEventPayload;
};

export type GenerationStreamLifecycleEvent = {
  type: "lifecycle";
  phase: "llm_call_started";
  turnId: string | null;
  anchorUserMessageId: string | null;
  llmRound: number;
  provider: string | null;
  model: string | null;
  at: string;
  rawEvent: WebsocketEventPayload;
};

export type GenerationStreamErrorEvent = {
  type: "error";
  message: string;
  rawEvent: WebsocketEventPayload;
};

export type GenerationStreamOutOfSyncEvent = {
  type: "out_of_sync";
  source: "patch";
  reason: "duplicate" | "version_mismatch" | "invalid";
  state: SessionPatchState;
  rawEvent: WebsocketEventPayload;
};

export type GenerationStreamEvent =
  | GenerationStreamStateEvent
  | GenerationStreamCommitEvent
  | GenerationStreamFinalizedEvent
  | GenerationStreamTurnUpdatedEvent
  | GenerationStreamLifecycleEvent
  | GenerationStreamErrorEvent
  | GenerationStreamOutOfSyncEvent;

export type GenerationStreamSubscriptionHandlers = {
  event?: (event: GenerationStreamEvent) => void;
  state?: (event: GenerationStreamStateEvent) => void;
  commit?: (event: GenerationStreamCommitEvent) => void;
  finalized?: (event: GenerationStreamFinalizedEvent) => void;
  turnUpdated?: (event: GenerationStreamTurnUpdatedEvent) => void;
  lifecycle?: (event: GenerationStreamLifecycleEvent) => void;
  error?: (event: GenerationStreamErrorEvent) => void;
  outOfSync?: (event: GenerationStreamOutOfSyncEvent) => void;
};

export type GenerationStreamSubscribeOptions = {
  /** Seed the stream reducer from the server-side active stream snapshot. */
  recover?: boolean;
  /** Optional host-provided snapshot to avoid an extra HTTP request. */
  initialSnapshot?: SessionTurnStreamSnapshotResponse["snapshot"] | null;
  /** Emit a state event after snapshot seed. Defaults to true. */
  emitSnapshotState?: boolean;
};

const SNAPSHOT_RECOVERY_TIMEOUT_MS = 2500;
const SNAPSHOT_RECOVERY_MAX_BUFFERED_EVENTS = 256;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const isContentBlockArray = (value: unknown): value is ContentBlock[] =>
  Array.isArray(value) &&
  value.every((item) => isRecord(item) && typeof item.type === "string");

const getMessageKind = (message: MessageRecord) => {
  const kind = message.meta?.messageKind;
  return typeof kind === "string" ? kind : null;
};

export function parseAssistantMessageCommit(
  message: MessageRecord,
): AssistantMessageCommit {
  if (message.role !== "assistant") {
    return { kind: "ignored", message, isFinal: false };
  }

  const kind = getMessageKind(message);
  if (kind === "assistant_intermediate") {
    return { kind: "intermediate", message, isFinal: false };
  }
  if (kind === "assistant_final") {
    return { kind: "final", message, isFinal: true };
  }
  if (kind === "assistant_error") {
    return { kind: "error", message, isFinal: true };
  }

  return { kind: "ignored", message, isFinal: false };
}

function messageRecordToIntermediate(
  message: MessageRecord,
): GenerationStreamIntermediateMessage | null {
  if (!isContentBlockArray(message.content) || message.content.length === 0) {
    return null;
  }
  const meta = isRecord(message.meta) ? message.meta : {};
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    messageId:
      typeof meta.streamMessageId === "string"
        ? meta.streamMessageId
        : message.id ?? null,
    messageOrdinal:
      typeof meta.messageOrdinal === "number" ? meta.messageOrdinal : null,
    content: message.content,
    text: message.text,
    provider: message.provider,
    model: message.model,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    usage: message.usage,
    durationMs: message.durationMs,
    meta: message.meta,
    createdAt: message.createdAt,
  };
}

function resolveStreamMessageId(input: {
  sessionId: string;
  turnId?: string | null;
  anchorUserMessageId?: string | null;
  messageId?: string | null;
  messageOrdinal?: number | null;
}) {
  if (input.messageId?.trim()) return input.messageId.trim();
  if (input.messageOrdinal == null) return null;
  if (input.turnId?.trim()) {
    return `turn:${input.turnId.trim()}:assistant:${input.messageOrdinal}`;
  }
  return `session:${input.sessionId}:assistant:${input.messageOrdinal}:${
    input.anchorUserMessageId ?? "unknown"
  }`;
}

function getTurnIdFromMessage(message: MessageRecord) {
  const turnId = message.meta?.turnId;
  return typeof turnId === "string" ? turnId : null;
}

function isGenerationRealtimeEvent(event: WebsocketEventPayload) {
  return (
    event.type === "session.turn.patch" ||
    event.type === "session.message.persisted" ||
    event.type === "session.turn.finalized" ||
    event.type === "session.turn.updated" ||
    event.type === "session.turn.lifecycle" ||
    event.type === "session.turn.error"
  );
}

function getPatchSeq(event: WebsocketEventPayload) {
  if (event.type !== "session.turn.patch") return null;
  const seq = event.payload.seq;
  return typeof seq === "number" ? seq : null;
}

function getPatchTurnId(event: WebsocketEventPayload) {
  if (event.type !== "session.turn.patch") return null;
  const turnId = event.payload.turnId;
  return typeof turnId === "string" ? turnId : null;
}

function getPatchMessageIdentity(event: WebsocketEventPayload) {
  if (event.type !== "session.turn.patch") {
    return { messageId: null, messageOrdinal: null };
  }
  return {
    messageId:
      typeof event.payload.messageId === "string"
        ? event.payload.messageId
        : null,
    messageOrdinal:
      typeof event.payload.messageOrdinal === "number"
        ? event.payload.messageOrdinal
        : null,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`stream snapshot recovery timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function getIntermediateMessageKey(message: GenerationStreamIntermediateMessage) {
  if (message.messageOrdinal != null) return `ordinal:${message.messageOrdinal}`;
  if (message.messageId) return `message:${message.messageId}`;
  if (message.id) return `id:${message.id}`;
  try {
    return `content:${JSON.stringify(message.content)}`;
  } catch {
    return null;
  }
}

function debugToolUseIds(content: ContentBlock[]): string[] {
  return content
    .filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use")
    .map((block) => block.id);
}

// DEBUG(each_key_duplicate 排查): 核心疑点——快照恢复(seedFromSnapshot)拿到的
// intermediateMessages 里，最后一条(ordinal N)可能和 snapshot.current(仍在流式中的
// 同一条 ordinal N)内容完全重复(同一个 tool_use.id)。随后 WebSocket 补发的 patch 事件
// 推进到 ordinal N+2 时，prepareMessageBoundary 判定 messageChanged，会把 reducer 里
// 残留的 ordinal N 内容通过 appendCurrentMessage 再 push 一次。这里按 ordinal 做 key 去重
// 理论上会合并成一条，但如果合并前后两条记录的 content 里 tool_use.id 不一致(即 key 相同
// 但内容不同，或反过来 key 不同但 tool_use.id 相同)，就会在下游 ProcessCard/ToolCallList
// 的 {#each ... (id)} 渲染时产生重复 key，导致 each_key_duplicate 崩溃。
function compactIntermediateMessages(messages: GenerationStreamIntermediateMessage[]) {
  const merged: GenerationStreamIntermediateMessage[] = [];
  const indexByKey = new Map<string, number>();
  for (const message of messages) {
    const key = getIntermediateMessageKey(message);
    if (!key) {
      merged.push(message);
      continue;
    }
    const index = indexByKey.get(key);
    if (index == null) {
      indexByKey.set(key, merged.length);
      merged.push(message);
      continue;
    }
    const prevToolIds = debugToolUseIds(merged[index]?.content ?? []);
    const nextToolIds = debugToolUseIds(message.content ?? []);
    const toolIdsDiffer = JSON.stringify(prevToolIds) !== JSON.stringify(nextToolIds);
    console.log(
      "[each_key_duplicate DEBUG] compactIntermediateMessages merge",
      {
        key,
        prevOrdinal: merged[index]?.messageOrdinal,
        nextOrdinal: message.messageOrdinal,
        prevMessageId: merged[index]?.messageId,
        nextMessageId: message.messageId,
        prevToolIds,
        nextToolIds,
        toolIdsDiffer,
      },
    );
    merged[index] = { ...merged[index], ...message };
  }
  // 合并结束后再做一次全量扫描：检查最终数组里是否存在 tool_use.id 跨消息重复
  // (即不同 ordinal/messageId 的两条消息里，各自 content 出现了同一个 tool_use.id)。
  // 这直接对应 ToolCallList.svelte 的 {#each tools as tool (tool.id)} 潜在冲突源。
  const toolIdOwners = new Map<string, number[]>();
  merged.forEach((message, idx) => {
    for (const toolId of debugToolUseIds(message.content ?? [])) {
      const owners = toolIdOwners.get(toolId) ?? [];
      owners.push(idx);
      toolIdOwners.set(toolId, owners);
    }
  });
  for (const [toolId, owners] of toolIdOwners) {
    if (owners.length > 1) {
      console.log(
        "[each_key_duplicate DEBUG] duplicate tool_use.id across merged intermediateMessages",
        {
          toolId,
          ownerIndexes: owners,
          owners: owners.map((idx) => ({
            ordinal: merged[idx]?.messageOrdinal,
            messageId: merged[idx]?.messageId,
          })),
        },
      );
    }
  }
  return merged;
}

function normalizeSnapshotIntermediateMessages(
  messages: NonNullable<SessionTurnStreamSnapshotResponse["snapshot"]>["intermediateMessages"],
): GenerationStreamIntermediateMessage[] {
  return compactIntermediateMessages(
    messages
      .filter((message) => Array.isArray(message.content))
      .map((message) => ({
        ...message,
        messageId: message.messageId ?? null,
        messageOrdinal: message.messageOrdinal ?? null,
        content: message.content,
      })),
  );
}

export class SessionGenerationStreamClient {
  private readonly reducer = new SessionPatchReducer();
  private messageId: string | null = null;
  private messageOrdinal: number | null = null;
  private intermediateMessages: GenerationStreamIntermediateMessage[] = [];
  private patchState: SessionPatchState | null = null;

  constructor(
    private readonly websocketClient: WebsocketClient | null,
    private readonly spaceId: string,
    private readonly sessionId: string,
    private readonly fetchStreamSnapshot?: () => Promise<SessionTurnStreamSnapshotResponse>,
  ) {}

  subscribe(
    handlers: GenerationStreamSubscriptionHandlers,
    options: GenerationStreamSubscribeOptions = {},
  ) {
    if (!this.websocketClient) {
      throw new Error("realtime transport is not configured for this client");
    }
    ensureRealtimeConnected(this.websocketClient);
    const stream = new SessionGenerationStreamClient(
      this.websocketClient,
      this.spaceId,
      this.sessionId,
      this.fetchStreamSnapshot,
    );
    const shouldRecover =
      options.recover === true || options.initialSnapshot !== undefined;
    let recovering = shouldRecover;
    let disposed = false;
    let recoveryAborted = false;
    let bufferedEvents: WebsocketEventPayload[] = [];
    let bufferedEventsReplayed = false;
    const releaseRoom = this.websocketClient.retainRooms([getRealtimeSpaceRoom(this.spaceId)]);
    const unsubscribe = this.websocketClient.on("event", (event) => {
      if (event.spaceId !== this.spaceId || event.sessionId !== this.sessionId) {
        return;
      }
      if (recovering && isGenerationRealtimeEvent(event)) {
        bufferedEvents.push(event);
        if (bufferedEvents.length > SNAPSHOT_RECOVERY_MAX_BUFFERED_EVENTS) {
          recoveryAborted = true;
          recovering = false;
          stream.replayBufferedEvents(bufferedEvents, handlers);
          bufferedEvents = [];
          bufferedEventsReplayed = true;
        }
        return;
      }
      stream.handleEvent(event, handlers);
    });

    if (shouldRecover) {
      void stream
        .recoverFromSnapshot(
          handlers,
          options,
          () => !recoveryAborted && !disposed,
        )
        .finally(() => {
          if (disposed || bufferedEventsReplayed) return;
          recovering = false;
          stream.replayBufferedEvents(bufferedEvents, handlers);
          bufferedEventsReplayed = true;
        });
    }

    return () => {
      disposed = true;
      unsubscribe();
      releaseRoom();
    };
  }

  private async recoverFromSnapshot(
    handlers: GenerationStreamSubscriptionHandlers,
    options: GenerationStreamSubscribeOptions,
    shouldContinue: () => boolean,
  ) {
    const snapshot =
      options.initialSnapshot !== undefined
        ? options.initialSnapshot
        : options.recover === true && this.fetchStreamSnapshot
          ? (
              await withTimeout(
                this.fetchStreamSnapshot(),
                SNAPSHOT_RECOVERY_TIMEOUT_MS,
              ).catch((error) => {
                console.warn(
                  "[SessionGenerationStreamClient] Failed to recover stream snapshot:",
                  error,
                );
                return { snapshot: null };
              })
            ).snapshot
          : null;
    if (!shouldContinue()) return;
    if (!snapshot) return;
    this.seedFromSnapshot(snapshot, handlers, options);
  }

  private seedFromSnapshot(
    snapshot: NonNullable<SessionTurnStreamSnapshotResponse["snapshot"]>,
    handlers: GenerationStreamSubscriptionHandlers,
    options?: GenerationStreamSubscribeOptions,
  ) {
    if (snapshot.spaceId !== this.spaceId || snapshot.sessionId !== this.sessionId) return false;
    const intermediateMessages = normalizeSnapshotIntermediateMessages(
      snapshot.intermediateMessages,
    );
    // DEBUG(each_key_duplicate 排查): 核心疑点——后端 enrichSessionStreamSnapshot 会把
    // Redis 实时快照的 current(仍在流式中的那条) 和 DB 已持久化的 intermediateMessages
    // 拼接同一次返回，当 current.messageOrdinal 恰好等于 intermediateMessages 最后一条的
    // ordinal 时，两边携带的内容(包含 tool_use.id)完全重叠。seedFromSnapshot 把
    // this.messageId/this.messageOrdinal 定位到这条重叠的消息上，后面 WebSocket 补发的
    // 新 patch(ordinal 推进后)会触发 prepareMessageBoundary 的 appendCurrentMessage，
    // 把这条重叠内容再次追加进 intermediateMessages，最终可能导致下游渲染层
    // (ProcessCard/ToolCallList 的 {#each ... (id)}) 出现重复 key。
    const lastIntermediate = intermediateMessages[intermediateMessages.length - 1] ?? null;
    const currentOverlapsLastIntermediate =
      lastIntermediate != null &&
      lastIntermediate.messageOrdinal != null &&
      snapshot.current.messageOrdinal != null &&
      lastIntermediate.messageOrdinal === snapshot.current.messageOrdinal;
    console.log("[each_key_duplicate DEBUG] seedFromSnapshot", {
      turnId: snapshot.turnId,
      snapshotSeq: snapshot.seq,
      currentMessageId: snapshot.current.messageId,
      currentMessageOrdinal: snapshot.current.messageOrdinal,
      currentToolUseIds: debugToolUseIds(snapshot.current.content ?? []),
      intermediateMessagesCount: intermediateMessages.length,
      lastIntermediateOrdinal: lastIntermediate?.messageOrdinal ?? null,
      lastIntermediateMessageId: lastIntermediate?.messageId ?? null,
      lastIntermediateToolUseIds: debugToolUseIds(lastIntermediate?.content ?? []),
      currentOverlapsLastIntermediate,
    });
    const result = this.reducer.applySnapshot({
      spaceId: snapshot.spaceId,
      sessionId: snapshot.sessionId,
      turnId: snapshot.turnId,
      seq: snapshot.seq,
      contentBlocks: snapshot.current.content,
      anchorUserMessageId: snapshot.anchorUserMessageId,
      appendPath: snapshot.current.appendPath,
    });
    if (!result.applied) return false;
    this.patchState = result.state;
    this.messageId = snapshot.current.messageId;
    this.messageOrdinal = snapshot.current.messageOrdinal;
    this.intermediateMessages = intermediateMessages;
    if (options?.emitSnapshotState !== false) {
      this.emit(handlers, {
        type: "state",
        source: "snapshot",
        state: result.state,
        messageId: this.messageId,
        messageOrdinal: this.messageOrdinal,
        intermediateMessages: [...this.intermediateMessages],
        rawEvent: null,
      });
    }
    return true;
  }

  private replayBufferedEvents(
    events: WebsocketEventPayload[],
    handlers: GenerationStreamSubscriptionHandlers,
  ) {
    for (const event of events) {
      const seq = getPatchSeq(event);
      const turnId = getPatchTurnId(event);
      const identity = getPatchMessageIdentity(event);
      const sameTurn = Boolean(
        seq != null &&
          this.patchState?.turnId &&
          turnId &&
          this.patchState.turnId === turnId,
      );
      const sameMessage =
        sameTurn &&
        Boolean(
          this.messageId &&
            ((identity.messageId && identity.messageId === this.messageId) ||
              (identity.messageId == null &&
                identity.messageOrdinal != null &&
                identity.messageOrdinal === this.messageOrdinal)),
        );
      const olderMessageInSameTurn =
        sameTurn &&
        identity.messageOrdinal != null &&
        this.messageOrdinal != null &&
        identity.messageOrdinal < this.messageOrdinal;
      if (
        (sameMessage || olderMessageInSameTurn) &&
        this.patchState &&
        seq != null &&
        seq <= this.patchState.patchSeq
      ) {
        continue;
      }
      this.handleEvent(event, handlers);
    }
  }

  private emit(
    handlers: GenerationStreamSubscriptionHandlers,
    event: GenerationStreamEvent,
  ) {
    handlers.event?.(event);
    if (event.type === "state") handlers.state?.(event);
    if (event.type === "commit") handlers.commit?.(event);
    if (event.type === "finalized") handlers.finalized?.(event);
    if (event.type === "turn_updated") handlers.turnUpdated?.(event);
    if (event.type === "lifecycle") handlers.lifecycle?.(event);
    if (event.type === "error") handlers.error?.(event);
    if (event.type === "out_of_sync") handlers.outOfSync?.(event);
  }

  private resetCurrentMessage() {
    this.messageId = null;
    this.messageOrdinal = null;
    this.patchState = null;
  }

  private appendCurrentMessage(state: SessionPatchState) {
    if (state.contentBlocks.length === 0) return;
    this.addIntermediateMessage({
      messageId: this.messageId,
      messageOrdinal: this.messageOrdinal,
      content: state.contentBlocks,
    });
  }

  private addIntermediateMessage(message: GenerationStreamIntermediateMessage) {
    this.intermediateMessages = compactIntermediateMessages([
      ...this.intermediateMessages,
      message,
    ]);
  }

  private handleAppliedState(
    handlers: GenerationStreamSubscriptionHandlers,
    source: "patch",
    result: SessionPatchApplyResult,
    rawEvent: WebsocketEventPayload,
    messageId: string | null,
    messageOrdinal: number | null,
  ) {
    if (!result.applied) {
      this.emit(handlers, {
        type: "out_of_sync",
        source,
        reason: result.reason,
        state: result.state,
        rawEvent,
      });
      return;
    }

    this.patchState = result.state;
    this.messageId = messageId;
    this.messageOrdinal = messageOrdinal;
    this.emit(handlers, {
      type: "state",
      source,
      state: result.state,
      messageId,
      messageOrdinal,
      intermediateMessages: [...this.intermediateMessages],
      rawEvent,
    });
  }

  private prepareMessageBoundary(input: {
    turnId: string | null;
    messageId: string | null;
    messageOrdinal: number | null;
    anchorUserMessageId: string | null;
  }) {
    const current =
      this.patchState ??
      this.reducer.get({
        spaceId: this.spaceId,
        sessionId: this.sessionId,
      });
    const nextMessageId = resolveStreamMessageId({
      sessionId: this.sessionId,
      turnId: input.turnId,
      anchorUserMessageId: input.anchorUserMessageId,
      messageId: input.messageId,
      messageOrdinal: input.messageOrdinal,
    });
    const differentTurn = Boolean(
      current.turnId && input.turnId && current.turnId !== input.turnId,
    );
    const messageChanged = Boolean(
      nextMessageId &&
        current.contentBlocks.length > 0 &&
        this.messageId &&
        nextMessageId !== this.messageId,
    );

    if (differentTurn) {
      this.intermediateMessages = [];
      this.resetCurrentMessage();
      this.reducer.start({
        spaceId: this.spaceId,
        sessionId: this.sessionId,
        turnId: input.turnId,
      });
    } else if (messageChanged) {
      // DEBUG(each_key_duplicate 排查): 核心疑点——这里把 reducer 当前累积的
      // contentBlocks(可能是快照恢复时留下的、代表某个旧 ordinal 的内容)
      // 作为一条新记录 append 进 intermediateMessages。如果此时这个 ordinal
      // 已经存在于快照返回的 intermediateMessages 里(见 seedFromSnapshot 的
      // currentOverlapsLastIntermediate)，理论上会被 compactIntermediateMessages 按
      // ordinal 合并，但如果合并前后两边 tool_use.id 不一致或者合并逻辑失效，
      // 就会在 intermediateMessages 数组里留下两条带相同 tool_use.id 的记录，
      // 最终让 ProcessCard/ToolCallList 的 {#each ... (id)} 报 each_key_duplicate。
      console.log("[each_key_duplicate DEBUG] appendCurrentMessage triggered by messageChanged", {
        prevMessageId: this.messageId,
        prevMessageOrdinal: this.messageOrdinal,
        nextMessageId,
        nextMessageOrdinal: input.messageOrdinal,
        appendedToolUseIds: debugToolUseIds(current.contentBlocks ?? []),
        existingIntermediateOrdinals: this.intermediateMessages.map((m) => m.messageOrdinal),
        existingIntermediateToolUseIds: this.intermediateMessages.map((m) => debugToolUseIds(m.content ?? [])),
      });
      this.appendCurrentMessage(current);
      this.resetCurrentMessage();
      this.reducer.start({
        spaceId: this.spaceId,
        sessionId: this.sessionId,
        turnId: input.turnId ?? current.turnId,
      });
    }

    return nextMessageId;
  }

  private handlePatch(
    event: WebsocketEventPayload,
    handlers: GenerationStreamSubscriptionHandlers,
  ) {
    const payload = event.payload;
    const seq = typeof payload.seq === "number" ? payload.seq : null;
    const baseSeq = typeof payload.baseSeq === "number" ? payload.baseSeq : null;
    if (seq === null || baseSeq === null || !Array.isArray(payload.ops)) {
      this.emit(handlers, {
        type: "out_of_sync",
        source: "patch",
        reason: "invalid",
        state: this.reducer.get({ spaceId: this.spaceId, sessionId: this.sessionId }),
        rawEvent: event,
      });
      return;
    }

    const turnId = typeof payload.turnId === "string" ? payload.turnId : null;
    const anchorUserMessageId =
      typeof payload.anchorUserMessageId === "string"
        ? payload.anchorUserMessageId
        : null;
    const messageOrdinal =
      typeof payload.messageOrdinal === "number" ? payload.messageOrdinal : null;
    const messageId = this.prepareMessageBoundary({
      turnId,
      messageId:
        typeof payload.messageId === "string" ? payload.messageId : null,
      messageOrdinal,
      anchorUserMessageId,
    });

    const input: SessionPatchApplyInput = {
      spaceId: this.spaceId,
      sessionId: this.sessionId,
      turnId,
      seq,
      baseSeq,
      ops: payload.ops as SessionPatchApplyInput["ops"],
      anchorUserMessageId,
    };
    const result = this.reducer.applyPatch(input);
    this.handleAppliedState(
      handlers,
      "patch",
      result,
      event,
      messageId,
      messageOrdinal,
    );
  }

  private handlePersisted(
    event: WebsocketEventPayload,
    handlers: GenerationStreamSubscriptionHandlers,
  ) {
    const message = event.payload.message;
    if (!isRecord(message)) return;
    const commit = parseAssistantMessageCommit(message as MessageRecord);

    if (commit.kind === "intermediate") {
      const intermediate = messageRecordToIntermediate(commit.message);
      if (intermediate) {
        this.addIntermediateMessage(intermediate);
      }
      this.reducer.reset({ spaceId: this.spaceId, sessionId: this.sessionId });
      this.resetCurrentMessage();
    }
    if (commit.kind === "final") {
      this.reducer.complete({
        spaceId: this.spaceId,
        sessionId: this.sessionId,
        turnId: getTurnIdFromMessage(commit.message),
      });
      this.resetCurrentMessage();
    }
    if (commit.kind === "error") {
      this.reducer.fail({
        spaceId: this.spaceId,
        sessionId: this.sessionId,
        turnId: getTurnIdFromMessage(commit.message),
      });
      this.resetCurrentMessage();
    }

    this.emit(handlers, {
      type: "commit",
      commit,
      rawEvent: event,
    });
  }

  private handleFinalized(
    event: WebsocketEventPayload,
    handlers: GenerationStreamSubscriptionHandlers,
  ) {
    const turn = event.payload.turn;
    if (!isRecord(turn)) return;
    const typedTurn = turn as SessionTurnRecord;
    if (typedTurn.status === "interrupted") {
      this.reducer.interrupt({
        spaceId: this.spaceId,
        sessionId: this.sessionId,
        turnId: typedTurn.id,
      });
    } else {
      this.reducer.complete({
        spaceId: this.spaceId,
        sessionId: this.sessionId,
        turnId: typedTurn.id,
      });
    }
    this.resetCurrentMessage();
    this.emit(handlers, {
      type: "finalized",
      turn: typedTurn,
      rawEvent: event,
    });
  }

  private handleEvent(
    event: WebsocketEventPayload,
    handlers: GenerationStreamSubscriptionHandlers,
  ) {
    switch (event.type) {
      case "session.turn.patch":
        this.handlePatch(event, handlers);
        return;
      case "session.message.persisted":
        this.handlePersisted(event, handlers);
        return;
      case "session.turn.finalized":
        this.handleFinalized(event, handlers);
        return;
      case "session.turn.updated": {
        const turn = event.payload.turn;
        if (!isRecord(turn)) return;
        this.emit(handlers, {
          type: "turn_updated",
          turn: turn as Partial<SessionTurnRecord>,
          rawEvent: event,
        });
        return;
      }
      case "session.turn.lifecycle": {
        const payload = event.payload;
        if (payload.phase !== "llm_call_started") return;
        this.emit(handlers, {
          type: "lifecycle",
          phase: "llm_call_started",
          turnId: typeof payload.turnId === "string" ? payload.turnId : null,
          anchorUserMessageId:
            typeof payload.anchorUserMessageId === "string"
              ? payload.anchorUserMessageId
              : null,
          llmRound: typeof payload.llmRound === "number" ? payload.llmRound : 1,
          provider: typeof payload.provider === "string" ? payload.provider : null,
          model: typeof payload.model === "string" ? payload.model : null,
          at: typeof payload.at === "string" ? payload.at : new Date(event.timestamp).toISOString(),
          rawEvent: event,
        });
        return;
      }
      case "session.turn.error": {
        const message =
          typeof event.payload.error === "string" && event.payload.error.trim()
            ? event.payload.error.trim()
            : "Generation failed";
        this.reducer.fail({ spaceId: this.spaceId, sessionId: this.sessionId });
        this.resetCurrentMessage();
        this.emit(handlers, {
          type: "error",
          message,
          rawEvent: event,
        });
        return;
      }
      default:
        return;
    }
  }
}

export function createSessionGenerationStreamClient(input: {
  websocketClient: WebsocketClient | null;
  spaceId: string;
  sessionId: string;
  fetchStreamSnapshot?: () => Promise<SessionTurnStreamSnapshotResponse>;
}) {
  return new SessionGenerationStreamClient(
    input.websocketClient,
    input.spaceId,
    input.sessionId,
    input.fetchStreamSnapshot,
  );
}
