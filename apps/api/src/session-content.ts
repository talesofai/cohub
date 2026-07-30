import { sanitizePromptMetaForClient } from "@cohub/core/sessions";
import type { ContentBlock } from "@cohub/protocol/core";

const imagePreviewLabel = (count: number) => (count === 1 ? "Image" : `${count} images`);

export const deriveMessagePreviewText = (input: { content: ContentBlock[] }): string => {
  const parts: string[] = [];
  let imageCount = 0;

  for (const block of input.content) {
    switch (block.type) {
      case "text": {
        const text = block.text.trim();
        if (text) parts.push(text);
        break;
      }
      case "image":
        imageCount += 1;
        break;
      case "shell_command":
        parts.push(["$", block.command].join(""));
        break;
      case "system_note": {
        const text = block.text.trim();
        if (text) parts.push(text);
        break;
      }
      default:
        break;
    }
  }

  if (imageCount > 0) parts.push(imagePreviewLabel(imageCount));
  return parts.join(" · ").replace(/\s+/g, " ").trim();
};

export const extractPlainText = (blocks: ContentBlock[]): string => {
  return blocks
    .flatMap((block) => {
      switch (block.type) {
        case "text":
          return [block.text];
        case "thinking":
          return [block.thinking];
        case "image":
          return block.source.type === "url" ? [block.source.url] : [];
        case "shell_command":
          return [["$", block.command].join("")];
        case "tool_use":
          return [`${block.name}(...)`];
        case "tool_result":
          return typeof block.content === "string" ? [block.content] : [];
        case "system_note":
          return [block.text];
        default:
          return [];
      }
    })
    .join("\n")
    .trim();
};

export const countToolCallsInContent = (blocks: ContentBlock[]) => blocks.filter((block) => block.type === "tool_use").length;

const HISTORY_THINKING_PREVIEW_CHARS = 260;
const HISTORY_TOOL_INPUT_PREVIEW_CHARS = 260;

const truncateText = (text: string, limit: number) => {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, limit - 1))}…`, truncated: true };
};

const summarizeToolInput = (name: string, input: Record<string, unknown>) => {
  if (name === "bash" && typeof input.command === "string") {
    return { command: truncateText(input.command, HISTORY_TOOL_INPUT_PREVIEW_CHARS).text };
  }
  if (["read", "write", "edit"].includes(name) && typeof input.path === "string") {
    return { path: input.path };
  }
  try {
    return { preview: truncateText(JSON.stringify(input), HISTORY_TOOL_INPUT_PREVIEW_CHARS).text };
  } catch {
    return { preview: truncateText(String(input), HISTORY_TOOL_INPUT_PREVIEW_CHARS).text };
  }
};

const getHistorySummary = (content: ContentBlock[]) => ({
  toolCallCount: countToolCallsInContent(content),
  thinkingCharCount: content.reduce(
    (sum, block) => sum + (block.type === "thinking" ? block.thinking.length : 0),
    0,
  ),
});

const summarizeContentForDefaultView = (content: ContentBlock[]): ContentBlock[] => {
  return content.map((block) => {
    if (block.type === "thinking") {
      const truncated = block.thinking.length > HISTORY_THINKING_PREVIEW_CHARS
        ? { text: block.thinking.slice(0, HISTORY_THINKING_PREVIEW_CHARS), truncated: true }
        : { text: block.thinking, truncated: false };
      return {
        ...block,
        thinking: truncated.text,
        _meta: {
          ...(block._meta ?? {}),
          contentDetail: "summary",
          truncated: truncated.truncated,
          fullLength: block.thinking.length,
        },
      };
    }
    if (block.type === "tool_use") {
      return {
        ...block,
        input: summarizeToolInput(block.name, block.input),
        _meta: {
          ...(block._meta ?? {}),
          contentDetail: "summary",
        },
      };
    }
    if (block.type === "tool_result") {
      const outputLength =
        typeof block.content === "string" ? block.content.length : JSON.stringify(block.content).length;
      return {
        ...block,
        content: "",
        _meta: {
          ...(block._meta ?? {}),
          contentDetail: "summary",
          outputLength,
        },
      };
    }
    return block;
  });
};

export const summarizeMessageForHistory = <T extends { content: ContentBlock[]; meta: unknown }>(
  message: T,
  options?: { placeholderIntermediate?: boolean },
): T => {
  const meta = sanitizePromptMetaForClient(message.meta) ?? {};
  const isIntermediate = meta.messageKind === "assistant_intermediate" && options?.placeholderIntermediate !== false;
  const historySummary = getHistorySummary(message.content);
  const summaryMeta = isIntermediate
    ? {
        messageKind: "assistant_intermediate",
        contentDetail: "summary",
        contentPlaceholder: "assistant_intermediate",
        historySummary,
      }
    : {
        ...meta,
        contentDetail: "summary",
        historySummary,
      };
  return {
    ...message,
    content: isIntermediate ? [] : summarizeContentForDefaultView(message.content),
    meta: summaryMeta,
  };
};

export const markMessageAsFull = <T extends { meta: unknown }>(message: T): T => {
  const meta = sanitizePromptMetaForClient(message.meta) ?? {};
  return {
    ...message,
    meta: {
      ...meta,
      contentDetail: "full",
    },
  };
};
