import type { ContentBlock } from "@cohub/protocol/core";
import type {
  CompletionAssistantMessage,
  CompletionMessage,
  CompletionThinkingLevel,
  CompletionUsage,
  SpaceCompletionStreamEvent,
} from "@cohub/protocol";
import {
  clampThinkingLevel,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type ThinkingLevel,
  type Usage as PiUsage,
} from "@earendil-works/pi-ai";
import type { CompletionModelRegistry, RuntimeLlmModel } from "./models.js";
import { createModelsFromRegistry, streamSimpleWithModels } from "./pi-models-adapter.js";

const THINKING_LEVELS = new Set<CompletionThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
/**
 * Marker mime used to smuggle remote image URLs through pi-ai's base64-only
 * ImageContent shape. Restored to real URLs in onPayload before the provider call.
 * Cohub never downloads the image; the upstream model fetches it.
 */
const URL_IMAGE_MIME = "application/x-cohub-image-url";
const URL_IMAGE_DATA_PREFIX = `data:${URL_IMAGE_MIME};base64,`;

export function normalizeThinkingLevel(level: string | null | undefined): CompletionThinkingLevel | undefined {
  return level && THINKING_LEVELS.has(level as CompletionThinkingLevel)
    ? level as CompletionThinkingLevel
    : undefined;
}

function resolveThinkingLevelForModel(model: RuntimeLlmModel, requested?: string | null): ThinkingLevel | undefined {
  const fallback = normalizeThinkingLevel(model.defaultThinkingLevel) ?? (model.reasoning ? "high" : "off");
  const level = normalizeThinkingLevel(requested) ?? fallback;
  if (!model.reasoning || level === "off") return undefined;
  return clampThinkingLevel(model, level) as ThinkingLevel;
}

function encodeImageUrl(url: string): ImageContent {
  return {
    type: "image",
    mimeType: URL_IMAGE_MIME,
    data: Buffer.from(url, "utf8").toString("base64"),
  };
}

function decodeImageUrlData(data: string): string | null {
  try {
    const url = Buffer.from(data, "base64").toString("utf8").trim();
    return url || null;
  } catch {
    return null;
  }
}

function contentBlocksToPiContent(blocks: ContentBlock[]): string | Array<{ type: "text"; text: string } | ImageContent> {
  const parts: Array<{ type: "text"; text: string } | ImageContent> = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image" && block.source.type === "base64") {
      parts.push({
        type: "image",
        data: block.source.data.replace(/^data:[^;,]+;base64,/, ""),
        mimeType: block.source.media_type || "application/octet-stream",
      });
      continue;
    }
    if (block.type === "image" && block.source.type === "url") {
      const url = block.source.url.trim();
      if (url) parts.push(encodeImageUrl(url));
      continue;
    }
    if (block.type === "thinking") {
      parts.push({ type: "text", text: block.thinking });
    }
  }
  if (parts.length === 0) return "";
  if (parts.length === 1 && parts[0]?.type === "text") return parts[0].text;
  return parts;
}

/**
 * Rewrite provider payloads so marker base64 images become real remote URLs.
 * Supports OpenAI-compatible (`image_url`) and Anthropic (`source`) shapes.
 */
export function restoreRemoteImageUrls(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    return payload.map((item) => restoreRemoteImageUrls(item));
  }
  if (!payload || typeof payload !== "object") return payload;

  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) return payload;

  const record = payload as Record<string, unknown>;

  // OpenAI-compatible: { type: "image_url", image_url: { url: "data:..." } | "data:..." }
  if (record.type === "image_url") {
    const imageUrl = record.image_url;
    if (typeof imageUrl === "string" && imageUrl.startsWith(URL_IMAGE_DATA_PREFIX)) {
      const url = decodeImageUrlData(imageUrl.slice(URL_IMAGE_DATA_PREFIX.length));
      if (url) return { ...record, image_url: { url } };
    }
    if (imageUrl && typeof imageUrl === "object" && !Array.isArray(imageUrl)) {
      const nested = imageUrl as Record<string, unknown>;
      if (typeof nested.url === "string" && nested.url.startsWith(URL_IMAGE_DATA_PREFIX)) {
        const url = decodeImageUrlData(nested.url.slice(URL_IMAGE_DATA_PREFIX.length));
        if (url) return { ...record, image_url: { ...nested, url } };
      }
    }
  }

  // Anthropic-compatible: { type: "image", source: { type: "base64", media_type, data } }
  if (record.type === "image" && record.source && typeof record.source === "object" && !Array.isArray(record.source)) {
    const source = record.source as Record<string, unknown>;
    if (source.type === "base64" && source.media_type === URL_IMAGE_MIME && typeof source.data === "string") {
      const url = decodeImageUrlData(source.data);
      if (url) return { ...record, source: { type: "url", url } };
    }
  }

  // Mistral-style: { type: "image_url", imageUrl: "data:..." }
  if (typeof record.imageUrl === "string" && record.imageUrl.startsWith(URL_IMAGE_DATA_PREFIX)) {
    const url = decodeImageUrlData(record.imageUrl.slice(URL_IMAGE_DATA_PREFIX.length));
    if (url) return { ...record, imageUrl: url };
  }

  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    next[key] = restoreRemoteImageUrls(value);
  }
  return next;
}

function toPiMessages(messages: CompletionMessage[]): Message[] {
  const result: Message[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      // System role is folded into systemPrompt by the caller; keep as user text if present.
      const text = contentBlocksToPiContent(message.content);
      result.push({
        role: "user",
        content: typeof text === "string" ? text : text,
        timestamp: Date.now(),
      });
      continue;
    }
    if (message.role === "user") {
      result.push({
        role: "user",
        content: contentBlocksToPiContent(message.content),
        timestamp: Date.now(),
      });
      continue;
    }
    if (message.role === "assistant") {
      const textParts = message.content
        .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("");
      result.push({
        role: "assistant",
        content: textParts ? [{ type: "text", text: textParts }] : [],
        api: "openai-completions",
        provider: "unknown",
        model: "unknown",
        usage: emptyPiUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      });
    }
  }
  return result;
}

function emptyPiUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function toCompletionUsage(usage: PiUsage | null | undefined): CompletionUsage | null {
  if (!usage) return null;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: usage.cost
      ? {
          input: usage.cost.input,
          output: usage.cost.output,
          cacheRead: usage.cost.cacheRead,
          cacheWrite: usage.cost.cacheWrite,
          total: usage.cost.total,
        }
      : null,
  };
}

function assistantContentBlocks(message: AssistantMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const part of message.content ?? []) {
    if (part.type === "text" && part.text) {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "thinking" && part.thinking) {
      blocks.push({ type: "thinking", thinking: part.thinking, ...(part.thinkingSignature ? { signature: part.thinkingSignature } : {}) });
    }
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });
  return blocks;
}

export function toCompletionAssistantMessage(message: AssistantMessage): CompletionAssistantMessage {
  const stopReason =
    message.stopReason === "length" || message.stopReason === "error" || message.stopReason === "aborted"
      ? message.stopReason
      : "stop";
  return {
    role: "assistant",
    content: assistantContentBlocks(message),
    stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
  };
}

export function extractSystemMessagesPrompt(messages: CompletionMessage[]): {
  systemFromMessages: string;
  remaining: CompletionMessage[];
} {
  const systemParts: string[] = [];
  const remaining: CompletionMessage[] = [];
  for (const message of messages) {
    if (message.role !== "system") {
      remaining.push(message);
      continue;
    }
    const text = message.content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (text.trim()) systemParts.push(text);
  }
  return {
    systemFromMessages: systemParts.join("\n\n"),
    remaining,
  };
}

export type RunCompletionInput = {
  completionId: string;
  registry: CompletionModelRegistry;
  model: RuntimeLlmModel;
  systemPrompt: string;
  messages: CompletionMessage[];
  temperature?: number | null;
  maxTokens?: number | null;
  thinkingLevel?: string | null;
  userId: string;
  spaceId: string;
  signal?: AbortSignal;
};

export type RunCompletionOutcome = {
  message: CompletionAssistantMessage;
  usage: CompletionUsage | null;
  raw: AssistantMessage | null;
  aborted: boolean;
  error: { code: string; message: string } | null;
};

export async function* streamCompletionEvents(input: RunCompletionInput): AsyncGenerator<SpaceCompletionStreamEvent, RunCompletionOutcome> {
  const { systemFromMessages, remaining } = extractSystemMessagesPrompt(input.messages);
  const systemPrompt = [input.systemPrompt, systemFromMessages].filter((part) => part.trim().length > 0).join("\n\n");
  const piMessages = toPiMessages(remaining);
  const apiKey = input.registry.getApiKey(input.model.provider);
  const headers = input.registry.getHeaders(input.model.provider, input.model.id);
  const reasoning = resolveThinkingLevelForModel(input.model, input.thinkingLevel);

  yield {
    type: "meta",
    completionId: input.completionId,
    provider: input.model.provider,
    model: input.model.id,
    systemPromptPath: null,
  };

  // Note: route layer may re-emit meta with systemPromptPath.

  let finalMessage: AssistantMessage | null = null;
  let aborted = Boolean(input.signal?.aborted);
  let error: { code: string; message: string } | null = null;

  try {
    if (aborted) throw new Error("aborted");
    const models = createModelsFromRegistry(input.registry, input.model);
    const stream = streamSimpleWithModels(models, input.model, {
      systemPrompt: systemPrompt || undefined,
      messages: piMessages,
    }, {
      apiKey,
      headers: input.model.provider === "cohub"
        ? {
            ...(headers ?? {}),
            "x-litellm-track-extra": JSON.stringify({
              user_uuid: input.userId,
              cohub_space_uuid: input.spaceId,
              cohub_completion_id: input.completionId,
            }),
          }
        : headers,
      temperature: typeof input.temperature === "number" && Number.isFinite(input.temperature) ? input.temperature : undefined,
      maxTokens: typeof input.maxTokens === "number" && Number.isFinite(input.maxTokens) ? Math.floor(input.maxTokens) : undefined,
      reasoning,
      signal: input.signal,
      // pi-ai only models images as base64; rewrite URL markers back to remote URLs
      // so Cohub never downloads image bytes.
      onPayload: (payload) => restoreRemoteImageUrls(payload),
    });

    for await (const event of stream) {
      if (input.signal?.aborted) {
        aborted = true;
        break;
      }
      if (event.type === "text_delta" && event.delta) {
        yield { type: "delta", text: event.delta };
      } else if (event.type === "thinking_delta" && event.delta) {
        yield { type: "thinking_delta", text: event.delta };
      } else if (event.type === "done") {
        finalMessage = event.message;
      } else if (event.type === "error") {
        finalMessage = event.error;
        if (event.reason === "aborted") {
          aborted = true;
        } else {
          error = {
            code: "llm_error",
            message: event.error.errorMessage?.trim() || "LLM request failed",
          };
        }
      }
    }
  } catch (caught) {
    if (input.signal?.aborted || (caught instanceof Error && /abort/i.test(caught.message))) {
      aborted = true;
    } else {
      error = {
        code: "llm_error",
        message: caught instanceof Error ? caught.message : String(caught),
      };
    }
  }

  if (!finalMessage) {
    finalMessage = {
      role: "assistant",
      content: [],
      api: input.model.api,
      provider: input.model.provider,
      model: input.model.id,
      usage: emptyPiUsage(),
      stopReason: aborted ? "aborted" : "error",
      errorMessage: error?.message ?? (aborted ? "aborted" : "LLM request failed"),
      timestamp: Date.now(),
    };
  }

  const message = toCompletionAssistantMessage(finalMessage);
  const usage = toCompletionUsage(finalMessage.usage);
  if (usage) yield { type: "usage", usage };

  if (error && !aborted) {
    yield {
      type: "error",
      code: error.code,
      message: error.message,
      completionId: input.completionId,
    };
  } else {
    yield {
      type: "done",
      completionId: input.completionId,
      message,
      usage,
    };
  }

  return {
    message,
    usage,
    raw: finalMessage,
    aborted,
    error: aborted ? { code: "aborted", message: "aborted" } : error,
  };
}

export async function runCompletion(input: RunCompletionInput): Promise<RunCompletionOutcome> {
  const iterator = streamCompletionEvents(input);
  let outcome: IteratorResult<SpaceCompletionStreamEvent, RunCompletionOutcome>;
  do {
    outcome = await iterator.next();
  } while (!outcome.done);
  return outcome.value;
}
