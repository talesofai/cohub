import type { ContentBlock, Usage } from "@cohub/protocol/core";
import type { LocalRuntimeEvent, LocalRuntimeProviderEvent, LocalRuntimePromptInput } from "@cohub/protocol";

/**
 * Reduce provider-neutral runtime events into the content shape used by
 * Cohub. The reducer is intentionally pure so a turn can be reconstructed
 * from the durable event ledger after a worker restart.
 */

export type RuntimeToolState = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string | ContentBlock[];
  isError: boolean;
};

export type RuntimeTurnProjection = {
  content: ContentBlock[];
  tools: Map<string, RuntimeToolState>;
  textStreamIndexByMessageId: Map<string, number>;
  thinkingStreamIndexByMessageId: Map<string, number>;
  nextStreamIndex: number;
  currentTextStreamIndex: number | null;
  currentThinkingStreamIndex: number | null;
  usage: Usage | null;
  stopReason: string | null;
  errorMessage: string | null;
};

export function createTurnProjection(): RuntimeTurnProjection {
  return {
    content: [],
    tools: new Map(),
    textStreamIndexByMessageId: new Map(),
    thinkingStreamIndexByMessageId: new Map(),
    nextStreamIndex: 0,
    currentTextStreamIndex: null,
    currentThinkingStreamIndex: null,
    usage: null,
    stopReason: null,
    errorMessage: null,
  };
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const nonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromContent).join("");
  const entry = record(value);
  if (entry.type === "text") return typeof entry.text === "string" ? entry.text : "";
  if (entry.type === "content") return textFromContent(entry.content);
  return "";
}

function appendTextBlock(content: ContentBlock[], type: "text" | "thinking", value: string, streamIndex: number): void {
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

function streamIndexFor(state: RuntimeTurnProjection, type: "text" | "thinking", messageId: string | null): number {
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

function startNewContentSegment(state: RuntimeTurnProjection): void {
  state.currentTextStreamIndex = null;
  state.currentThinkingStreamIndex = null;
}

/** Normalize provider usage fields without inventing values. */
export function parseRuntimeUsage(value: unknown): Usage | null {
  const usage = record(value);
  const input = nonNegativeInteger(usage.input) ?? nonNegativeInteger(usage.inputTokens) ?? nonNegativeInteger(usage.input_tokens);
  const output = nonNegativeInteger(usage.output) ?? nonNegativeInteger(usage.outputTokens) ?? nonNegativeInteger(usage.output_tokens);
  const thought = nonNegativeInteger(usage.thinking) ?? nonNegativeInteger(usage.thoughtTokens) ?? nonNegativeInteger(usage.reasoning);
  const cacheRead = nonNegativeInteger(usage.cacheRead) ?? nonNegativeInteger(usage.cachedReadTokens) ?? nonNegativeInteger(usage.cached_input_tokens);
  const cacheWrite = nonNegativeInteger(usage.cacheWrite) ?? nonNegativeInteger(usage.cachedWriteTokens) ?? nonNegativeInteger(usage.cache_write_input_tokens);
  const total = nonNegativeInteger(usage.totalTokens) ?? nonNegativeInteger(usage.total_tokens) ?? nonNegativeInteger(usage.used);
  const derivedTotal = total ?? (() => {
    const values = [input, output, thought, cacheRead, cacheWrite].filter((entry): entry is number => entry !== undefined);
    return values.length > 0 ? values.reduce((sum, entry) => sum + entry, 0) : undefined;
  })();
  const cost = record(usage.cost);
  const costInput = nonNegativeNumber(cost.input);
  const costOutput = nonNegativeNumber(cost.output);
  const costRead = nonNegativeNumber(cost.cacheRead);
  const costWrite = nonNegativeNumber(cost.cacheWrite);
  const costTotal = nonNegativeNumber(cost.total) ?? nonNegativeNumber(cost.amount);
  if (input === undefined && output === undefined && thought === undefined && cacheRead === undefined && cacheWrite === undefined && derivedTotal === undefined && costInput === undefined && costOutput === undefined && costRead === undefined && costWrite === undefined && costTotal === undefined) return null;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(derivedTotal !== undefined ? { totalTokens: derivedTotal } : {}),
    ...((costInput !== undefined || costOutput !== undefined || costRead !== undefined || costWrite !== undefined || costTotal !== undefined)
      ? { cost: { ...(costInput !== undefined ? { input: costInput } : {}), ...(costOutput !== undefined ? { output: costOutput } : {}), ...(costRead !== undefined ? { cacheRead: costRead } : {}), ...(costWrite !== undefined ? { cacheWrite: costWrite } : {}), ...(costTotal !== undefined ? { total: costTotal } : {}) } }
      : {}),
  };
}

function toolResultContent(value: unknown): string | ContentBlock[] {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = textFromContent(value);
    return text || value as ContentBlock[];
  }
  return textFromContent(value) || JSON.stringify(value) || "";
}

function eventPayload(event: LocalRuntimeProviderEvent | LocalRuntimeEvent): Record<string, unknown> {
  return record(event.payload);
}

function eventIdValue(payload: Record<string, unknown>): string | null {
  return stringValue(payload.itemId) ?? stringValue(payload.messageId) ?? stringValue(payload.id);
}

/** Materialize tool state into ordered tool-use/tool-result blocks. */
export function syncToolBlocks(state: RuntimeTurnProjection): void {
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
      if (resultIndex < 0) state.content.push({ type: "tool_result", tool_use_id: tool.id, content: tool.result, is_error: tool.isError });
      else {
        const result = state.content[resultIndex];
        if (result?.type === "tool_result") {
          result.content = tool.result;
          result.is_error = tool.isError;
        }
      }
    }
  }
}

/** Apply one canonical event; returns true when visible content or usage changed. */
export function applyRuntimeEvent(state: RuntimeTurnProjection, event: LocalRuntimeProviderEvent | LocalRuntimeEvent): boolean {
  const payload = eventPayload(event);
  switch (event.kind) {
    case "turn.started":
      startNewContentSegment(state);
      return false;
    case "text.delta": {
      const text = typeof payload.text === "string" ? payload.text : textFromContent(payload.content);
      if (!text) return false;
      appendTextBlock(state.content, "text", text, streamIndexFor(state, "text", eventIdValue(payload)));
      return true;
    }
    case "thinking.delta": {
      const text = typeof payload.text === "string" ? payload.text : textFromContent(payload.content);
      if (!text) return false;
      appendTextBlock(state.content, "thinking", text, streamIndexFor(state, "thinking", eventIdValue(payload)));
      return true;
    }
    case "tool.started": {
      const id = stringValue(payload.id) ?? stringValue(payload.toolId);
      if (!id) return false;
      const existing = state.tools.get(id);
      state.tools.set(id, {
        id,
        name: stringValue(payload.name) ?? existing?.name ?? "tool",
        input: record(payload.input ?? existing?.input),
        ...(existing?.result !== undefined ? { result: existing.result } : {}),
        isError: existing?.isError ?? false,
      });
      startNewContentSegment(state);
      return true;
    }
    case "tool.updated":
    case "tool.completed": {
      const id = stringValue(payload.id) ?? stringValue(payload.toolId);
      if (!id) return false;
      const existing = state.tools.get(id) ?? { id, name: "tool", input: {}, isError: false };
      const output = payload.output !== undefined ? payload.output : payload.result;
      state.tools.set(id, {
        ...existing,
        name: stringValue(payload.name) ?? existing.name,
        input: payload.input !== undefined ? record(payload.input) : existing.input,
        ...(output !== undefined ? { result: toolResultContent(output) } : {}),
        isError: payload.isError === true || payload.status === "failed" || (event.kind === "tool.completed" && existing.isError),
      });
      return true;
    }
    case "usage": {
      const usage = parseRuntimeUsage(payload.usage ?? payload);
      if (!usage) return false;
      state.usage = usage;
      return true;
    }
    case "turn.completed":
      state.stopReason = stringValue(payload.stopReason) ?? stringValue(payload.reason) ?? "stop";
      if (payload.usage !== undefined) state.usage = parseRuntimeUsage(payload.usage) ?? state.usage;
      return false;
    case "turn.failed":
      state.stopReason = payload.aborted === true || payload.code === "cancelled" ? "aborted" : "error";
      state.errorMessage = stringValue(payload.message) ?? "Local provider failed";
      if (payload.usage !== undefined) state.usage = parseRuntimeUsage(payload.usage) ?? state.usage;
      return false;
    case "permission.requested":
    case "session.ready":
      return false;
  }
}

/** Convert Cohub content to the provider-neutral prompt payload. */
export function toRuntimePrompt(content: ContentBlock[]): LocalRuntimePromptInput {
  const text = content.filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text").map((block) => block.text).join("\n\n");
  return { text, content };
}

export function mapRuntimeStopReason(value: unknown): string | null {
  if (value === "cancelled" || value === "canceled" || value === "aborted") return "aborted";
  return typeof value === "string" && value.trim() ? value : null;
}
