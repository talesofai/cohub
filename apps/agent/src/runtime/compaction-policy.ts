import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Pure compaction policy: context-token accounting.
 * Deliberately free of db/redis/env imports so it can be unit-tested without
 * booting the agent's side-effectful module graph.
 */

// Cap above pi default (16k). Scaled down for small windows so we never
// reserve more than the whole context (which would compact on every turn).
const RESERVE_TOKENS_CAP = 32_768;
const RESERVE_TOKENS_RATIO = 0.25;

// Some provider proxies tokenize inline base64 image payloads as raw text
// instead of charging vision tokens. Observed ratio on the cohub proxy is
// ~1.97 chars/token, so one normalized image can bill ~100k tokens while pi's
// heuristic estimates a flat 1.2k. Without this lower bound the accurate
// provider usage stays far below the threshold and auto-compaction never runs
// until the request hard-fails with a context-overflow error.
const BASE64_CHARS_PER_TOKEN = 2;
const TEXT_CHARS_PER_TOKEN = 4;

/** Resolve reserveTokens for a model context window. */
export function resolveReserveTokens(contextWindow: number): number {
  if (contextWindow <= 0) return RESERVE_TOKENS_CAP;
  return Math.min(RESERVE_TOKENS_CAP, Math.max(1, Math.floor(contextWindow * RESERVE_TOKENS_RATIO)));
}

function safeBlockLength(block: Record<string, unknown>): number {
  try {
    return JSON.stringify(block)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Estimate context tokens the way a base64-counting proxy would bill them. */
export function estimateProxyContextTokens(messages: AgentMessage[]): number {
  let textChars = 0;
  let base64Chars = 0;

  for (const message of messages) {
    const content = (message as unknown as { content?: unknown }).content;
    if (typeof content === "string") {
      textChars += content.length;
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const record = block as Record<string, unknown>;
      if (record.type === "image") {
        // Data-less image blocks carry no payload to bill.
        if (typeof record.data === "string") base64Chars += record.data.length;
        continue;
      }
      if (typeof record.text === "string") {
        textChars += record.text.length;
        continue;
      }
      if (typeof record.thinking === "string") {
        textChars += record.thinking.length;
        continue;
      }
      textChars += safeBlockLength(record);
    }
  }

  return Math.ceil(textChars / TEXT_CHARS_PER_TOKEN) + Math.ceil(base64Chars / BASE64_CHARS_PER_TOKEN);
}
