import { access } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { canonicalizeJson } from "@cohub/protocol";
import type { ContentBlock, Usage } from "@cohub/protocol/core";
import { SessionManager, type SessionEntry } from "./runtime/local-session-manager.js";
import {
  ensureAgentSpaceSessionPath,
  getAgentSessionFilePath,
  getAgentSpaceSessionsPath,
  getAgentWorkspacePath,
} from "./runtime/paths.js";

const LOCAL_ACP_SOURCE = "local_acp";

type LocalAcpMessageIdentity = {
  id: string;
  contentHash: string;
};

export type LocalAcpTranscriptInput = {
  spaceId: string;
  sessionId: string;
  turnId: string;
  executionAttemptId: string;
  userMessageId: string;
  startedAt: string;
};

export type LocalAcpAssistantTranscriptInput = LocalAcpTranscriptInput & {
  assistantMessageId: string;
  content: ContentBlock[];
  provider: string;
  model: string | null;
  stopReason: string | null;
  usage: Usage | null;
  messageKind?: "assistant_final" | "assistant_error";
  errorMessage?: string | null;
  completedAt: string;
};

type TranscriptPart =
  | { kind: "assistant"; blocks: Array<Record<string, unknown>>; index: number }
  | { kind: "tool_result"; block: Extract<ContentBlock, { type: "tool_result" }>; index: number };

export async function openLocalAcpSession(spaceId: string, sessionId: string) {
  await ensureAgentSpaceSessionPath(spaceId);
  const sessionDir = getAgentSpaceSessionsPath(spaceId);
  const sessionFile = getAgentSessionFilePath(spaceId, sessionId);
  try {
    await access(sessionFile);
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const manager = SessionManager.create(getAgentWorkspacePath(spaceId), sessionDir);
    manager.newSession({ id: sessionId });
    manager.setSessionFile(sessionFile);
    await manager.flush();
    return manager;
  }
  const manager = await SessionManager.open(sessionFile, sessionDir, { recoverTrailingPartial: true });
  if (manager.getSessionId() !== sessionId) throw new Error("local ACP session JSONL identity does not match the requested session");
  return manager;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function timestampMs(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function contentHash(value: unknown) {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

function stableEntryId(identity: string) {
  const bytes = createHash("sha256").update(`cohub-local-acp-jsonl-entry-v1:${identity}`, "utf8").digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function messageMeta(entry: SessionEntry) {
  if (entry.type !== "message") return null;
  return record((entry.message as unknown as Record<string, unknown>).meta);
}

function findExistingMessage(manager: SessionManager, identity: LocalAcpMessageIdentity) {
  for (const entry of manager.getEntries()) {
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as Record<string, unknown>;
    const meta = messageMeta(entry);
    const matches = meta?.localAcpMessageId === identity.id
      || meta?.messageId === identity.id
      || message.id === identity.id;
    if (!matches) continue;
    if (meta?.localAcpContentHash && meta.localAcpContentHash !== identity.contentHash) {
      throw new Error("local ACP session message identity was reused with different content");
    }
    return entry.id;
  }
  return null;
}

function appendMessageOnce(manager: SessionManager, identity: LocalAcpMessageIdentity, entryId: string, message: AgentMessage) {
  const existing = findExistingMessage(manager, identity);
  if (existing) return existing;
  if (manager.getEntries().some((entry) => entry.id === entryId)) {
    throw new Error("local ACP session entry identity was reused by a different message");
  }
  return manager.appendMessage(message, { id: entryId });
}

function sessionImage(source: Extract<ContentBlock, { type: "image" }>["source"]): Record<string, unknown> {
  return source.type === "url"
    ? { type: "image", source: { type: "url", url: source.url } }
    : { type: "image", source: { type: "base64", media_type: source.media_type, data: source.data } };
}

function sessionAssistantImage(source: Extract<ContentBlock, { type: "image" }>["source"]): Record<string, unknown> {
  return source.type === "url"
    ? sessionImage(source)
    : { type: "image", data: source.data, mimeType: source.media_type };
}

function sessionUserContent(content: ContentBlock[]): string | Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = content.flatMap((block): Array<Record<string, unknown>> => {
    if (block.type === "text") return [{ type: "text", text: block.text, ...(block._meta ? { _meta: block._meta } : {}) }];
    if (block.type === "thinking") return [{ type: "text", text: block.thinking, ...(block._meta ? { _meta: block._meta } : {}) }];
    if (block.type === "image") return [sessionImage(block.source)];
    return [];
  });
  return blocks.length > 0 ? blocks : "";
}

export function appendLocalAcpUserMessage(manager: SessionManager, input: LocalAcpTranscriptInput, content: ContentBlock[], meta?: Record<string, unknown> | null) {
  const baseMeta = {
    ...(meta ?? {}),
    source: LOCAL_ACP_SOURCE,
    localAcpMessageId: input.userMessageId,
    messageId: input.userMessageId,
    turnId: input.turnId,
    executionAttemptId: input.executionAttemptId,
    messageKind: "user",
  };
  const persistedContent = sessionUserContent(content);
  const stableMessage = { role: "user", content: persistedContent, meta: baseMeta };
  const messageHash = contentHash(stableMessage);
  const message = {
    role: "user",
    content: persistedContent,
    timestamp: timestampMs(input.startedAt),
    meta: { ...baseMeta, localAcpContentHash: messageHash },
  } as unknown as AgentMessage;
  return appendMessageOnce(
    manager,
    { id: input.userMessageId, contentHash: messageHash },
    stableEntryId(`${input.sessionId}:user:${input.userMessageId}`),
    message,
  );
}

function sessionTextContent(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return [{ type: "text", text: JSON.stringify(value) ?? "" }];
  const blocks: Array<Record<string, unknown>> = value.flatMap((item): Array<Record<string, unknown>> => {
    const block = record(item);
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block.type === "image" && block.source && typeof block.source === "object" && !Array.isArray(block.source)) {
      const source = record(block.source);
      if (source.type === "url" && typeof source.url === "string") return [{ type: "image", source: { type: "url", url: source.url } }];
      if (source.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string") {
        return [{ type: "image", source: { type: "base64", media_type: source.media_type, data: source.data } }];
      }
    }
    return [];
  });
  return blocks.length > 0 ? blocks : [{ type: "text", text: JSON.stringify(value) ?? "" }];
}

function sessionUsage(usage: Usage | null) {
  return {
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
  };
}

function sessionStopReason(value: string | null, intermediate: boolean): "stop" | "length" | "toolUse" | "error" | "aborted" {
  if (value === "cancelled" || value === "canceled" || value === "aborted") return "aborted";
  if (value === "error") return "error";
  if (value === "length" || value === "max_tokens") return "length";
  if (intermediate || value === "tool_use") return "toolUse";
  return "stop";
}

function buildTranscriptParts(content: ContentBlock[]): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  let assistantBlocks: Array<Record<string, unknown>> = [];
  const flushAssistant = () => {
    if (assistantBlocks.length === 0) return;
    parts.push({ kind: "assistant", blocks: assistantBlocks, index: parts.length });
    assistantBlocks = [];
  };
  for (const block of content) {
    if (block.type === "tool_result") {
      flushAssistant();
      parts.push({ kind: "tool_result", block, index: parts.length });
      continue;
    }
    if (block.type === "text") {
      assistantBlocks.push({ type: "text", text: block.text, ...(block._meta ? { _meta: block._meta } : {}) });
    } else if (block.type === "thinking") {
      assistantBlocks.push({ type: "thinking", thinking: block.thinking, ...(block.signature ? { thinkingSignature: block.signature } : {}), ...(block._meta ? { _meta: block._meta } : {}) });
    } else if (block.type === "image") {
      assistantBlocks.push(sessionAssistantImage(block.source));
    } else if (block.type === "tool_use") {
      assistantBlocks.push({ type: "toolCall", id: block.id, name: block.name, arguments: block.input, ...(block._meta ? { _meta: block._meta } : {}) });
    } else if (block.type === "system_note") {
      assistantBlocks.push({ type: "text", text: block.text });
    }
  }
  flushAssistant();
  if (parts.length === 0) parts.push({ kind: "assistant", blocks: [], index: 0 });
  return parts;
}

export function appendLocalAcpAssistantMessages(manager: SessionManager, input: LocalAcpAssistantTranscriptInput) {
  const parts = buildTranscriptParts(input.content);
  const lastAssistantIndex = parts.reduce((last, part, index) => part.kind === "assistant" ? index : last, -1);
  const toolNames = new Map(input.content
    .filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use")
    .map((block) => [block.id, block.name]));
  let finalEntryId = "";

  for (const [partIndex, part] of parts.entries()) {
    if (part.kind === "assistant") {
      const isFinal = partIndex === lastAssistantIndex;
      const identity = isFinal ? input.assistantMessageId : `${input.assistantMessageId}:assistant:${partIndex}`;
      const baseMeta = {
        source: LOCAL_ACP_SOURCE,
        localAcpMessageId: identity,
        messageId: isFinal ? input.assistantMessageId : identity,
        turnId: input.turnId,
        executionAttemptId: input.executionAttemptId,
        anchorUserMessageId: input.userMessageId,
        messageKind: isFinal ? input.messageKind ?? "assistant_final" : "assistant_intermediate",
      };
      const stopReason = sessionStopReason(input.stopReason, !isFinal);
      const stableMessage = {
        role: "assistant",
        content: part.blocks,
        meta: baseMeta,
        stopReason,
        ...(isFinal && input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      };
      const messageHash = contentHash(stableMessage);
      const message = {
        ...stableMessage,
        api: "local-acp",
        provider: input.provider,
        model: input.model ?? "",
        usage: sessionUsage(isFinal ? input.usage : null),
        timestamp: timestampMs(input.completedAt),
        meta: { ...baseMeta, localAcpContentHash: messageHash },
      } as unknown as AgentMessage;
      const entryId = appendMessageOnce(
        manager,
        { id: identity, contentHash: messageHash },
        stableEntryId(`${input.sessionId}:assistant:${identity}`),
        message,
      );
      if (isFinal) finalEntryId = entryId;
      continue;
    }

    const identity = `${input.assistantMessageId}:tool-result:${part.index}`;
    const baseMeta = {
      source: LOCAL_ACP_SOURCE,
      localAcpMessageId: identity,
      messageId: identity,
      turnId: input.turnId,
      executionAttemptId: input.executionAttemptId,
      anchorUserMessageId: input.userMessageId,
      messageKind: "tool_result",
    };
    const messageHash = contentHash({ role: "toolResult", block: part.block, meta: baseMeta });
    const message = {
      role: "toolResult",
      toolCallId: part.block.tool_use_id,
      toolName: toolNames.get(part.block.tool_use_id) ?? "tool",
      content: sessionTextContent(part.block.content),
      isError: part.block.is_error === true,
      timestamp: timestampMs(input.completedAt),
      meta: { ...baseMeta, localAcpContentHash: messageHash },
    } as unknown as AgentMessage;
    appendMessageOnce(
      manager,
      { id: identity, contentHash: messageHash },
      stableEntryId(`${input.sessionId}:tool-result:${identity}`),
      message,
    );
  }

  if (!finalEntryId) throw new Error("local ACP assistant transcript has no final message entry");
  return finalEntryId;
}
