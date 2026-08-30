import { createHash } from "node:crypto";
import type { NativeTurnBundleV1, SanitizedProviderHistoryEntryV1 } from "@cohub/protocol";
import type { ContentBlock, Usage } from "@cohub/protocol/core";

const MAX_TEXT_BLOCK_BYTES = 4 * 1024 * 1024;

export const nativeContentText = (content: ContentBlock[]) => content
  .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
  .map((block) => block.text)
  .join("\n")
  .trim() || null;

const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;

export const nativeUsage = (value: Record<string, number> | null | undefined): Usage | null => {
  if (!value) return null;
  const input = finite(value.input);
  const output = finite(value.output);
  const cacheRead = finite(value.cacheRead);
  const cacheWrite = finite(value.cacheWrite);
  const totalTokens = finite(value.totalTokens) || input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
};

export function portableToolId(nativeToolKey: string) {
  return `native_${createHash("sha256").update(nativeToolKey).digest("hex").slice(0, 24)}`;
}

export function portableContentToBlocks(entry: SanitizedProviderHistoryEntryV1): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const item of entry.content) {
    if (item.type === "text") {
      const text = item.text ?? "";
      if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BLOCK_BYTES) throw new Error("native_text_block_too_large");
      blocks.push({ type: "text", text });
    } else if (item.type === "thinking") {
      blocks.push({ type: "thinking", thinking: item.text ?? "" });
    } else {
      blocks.push({ type: "text", text: item.artifactKey ? `[Attachment: ${item.artifactKey}]` : "[Image attachment unavailable]" });
    }
  }
  for (const call of entry.toolCalls ?? []) {
    blocks.push({ type: "tool_use", id: portableToolId(call.nativeToolCallKey), name: call.name, input: call.arguments });
  }
  return blocks;
}

export function portableProjectedContent(entry: SanitizedProviderHistoryEntryV1, toolCallKeyOverride?: string): ContentBlock[] {
  if (entry.role === "tool_result") {
    const resultContent = entry.toolResult?.content ?? entry.content;
    const content = resultContent.map((item) => item.type === "text"
      ? { type: "text", text: item.text ?? "" } satisfies ContentBlock
      : { type: "text", text: item.artifactKey ? `[Attachment: ${item.artifactKey}]` : "[Image attachment unavailable]" } satisfies ContentBlock);
    return [{
      type: "tool_result",
      tool_use_id: portableToolId(toolCallKeyOverride ?? entry.nativeToolCallKey ?? entry.nativeMessageKey),
      content,
      is_error: entry.toolResult?.isError ?? false,
    }];
  }
  if (entry.role === "compaction") {
    return [{
      type: "system_note",
      note_type: "compacted",
      text: nativeContentText(portableContentToBlocks(entry)) ?? "Native provider compacted its context",
    }];
  }
  return portableContentToBlocks(entry);
}

export type NativeProjectedGroup = {
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  sources: SanitizedProviderHistoryEntryV1[];
  entryIds: string[];
  messageKind: "user" | "assistant_intermediate" | "assistant_final" | "tool_result" | "compacted";
  usage: Usage | null;
};

export function sumNativeUsage(groups: NativeProjectedGroup[]): Usage | null {
  const usages = groups.map((group) => group.usage).filter((usage): usage is Usage => usage !== null);
  if (usages.length === 0) return null;
  return usages.reduce<Usage>((total, usage) => ({
    input: (total.input ?? 0) + (usage.input ?? 0),
    output: (total.output ?? 0) + (usage.output ?? 0),
    cacheRead: (total.cacheRead ?? 0) + (usage.cacheRead ?? 0),
    cacheWrite: (total.cacheWrite ?? 0) + (usage.cacheWrite ?? 0),
    totalTokens: (total.totalTokens ?? 0) + (usage.totalTokens ?? 0),
    cost: {
      input: (total.cost?.input ?? 0) + (usage.cost?.input ?? 0),
      output: (total.cost?.output ?? 0) + (usage.cost?.output ?? 0),
      cacheRead: (total.cost?.cacheRead ?? 0) + (usage.cost?.cacheRead ?? 0),
      cacheWrite: (total.cost?.cacheWrite ?? 0) + (usage.cost?.cacheWrite ?? 0),
      total: (total.cost?.total ?? 0) + (usage.cost?.total ?? 0),
    },
  }), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
}

export function nativeGroupText(content: ContentBlock[]): string | null {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "system_note") parts.push(block.text);
    else if (block.type === "tool_result") {
      if (typeof block.content === "string") parts.push(block.content);
      else {
        const nested = nativeGroupText(block.content);
        if (nested) parts.push(nested);
      }
    }
  }
  return parts.join("\n").trim() || null;
}

export function buildNativeProjectedGroups(bundle: NativeTurnBundleV1, entryIds: string[]): NativeProjectedGroup[] {
  const groups: NativeProjectedGroup[] = [];
  const toolGroupById = new Map<string, NativeProjectedGroup>();
  const pendingToolGroups = new Set<NativeProjectedGroup>();

  for (const [index, source] of bundle.historyDelta.entries()) {
    const entryId = entryIds[index];
    if (!entryId) continue;
    if (source.role === "tool_result") {
      const parentGroup = source.nativeParentMessageKey
        ? groups.find((candidate) => candidate.sources.some((entry) => entry.nativeMessageKey === source.nativeParentMessageKey))
        : undefined;
      const explicitToolId = source.nativeToolCallKey ? portableToolId(source.nativeToolCallKey) : null;
      const parentCalls = parentGroup?.sources.flatMap((entry) => entry.toolCalls ?? []) ?? [];
      const parentCall = parentCalls.length === 1 ? parentCalls[0] : undefined;
      const adjacentGroup = groups.at(-1);
      const adjacentPending = adjacentGroup?.role === "assistant" && pendingToolGroups.has(adjacentGroup) ? adjacentGroup : undefined;
      const group = (explicitToolId ? toolGroupById.get(explicitToolId) : undefined)
        ?? parentGroup
        ?? (pendingToolGroups.size === 1 ? adjacentPending : undefined);
      if (group) {
        group.content.push(...portableProjectedContent(source, source.nativeToolCallKey ?? parentCall?.nativeToolCallKey));
        group.sources.push(source);
        group.entryIds.push(entryId);
        group.messageKind = "assistant_intermediate";
        group.usage = nativeUsage(source.usage) ?? group.usage;
        if (parentCall) pendingToolGroups.delete(group);
      } else {
        groups.push({
          role: "assistant",
          content: portableProjectedContent(source),
          sources: [source],
          entryIds: [entryId],
          messageKind: "tool_result",
          usage: nativeUsage(source.usage),
        });
      }
      continue;
    }

    const group: NativeProjectedGroup = {
      role: source.role === "user" ? "user" : source.role === "compaction" ? "system" : "assistant",
      content: portableProjectedContent(source),
      sources: [source],
      entryIds: [entryId],
      messageKind: source.role === "user" ? "user" : source.role === "compaction" ? "compacted" : source.toolCalls?.length ? "assistant_intermediate" : "assistant_final",
      usage: nativeUsage(source.usage),
    };
    groups.push(group);
    if (source.role === "assistant" && source.toolCalls?.length) {
      pendingToolGroups.add(group);
      for (const call of source.toolCalls) toolGroupById.set(portableToolId(call.nativeToolCallKey), group);
    }
  }
  return groups;
}
