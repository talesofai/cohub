export { claudeAdapter, ClaudeAdapter, mapClaudeMessage, createClaudeEventContext } from "./claude.js";
export type { ClaudeAdapterOptions, ClaudePermissionRequest, ClaudePermissionResolver, ClaudeQueryFactory } from "./claude.js";
export { codexAdapter, CodexAdapter, mapCodexEvent, createCodexEventContext } from "./codex.js";
export { piProviderAdapter, PiProviderAdapter, PiProviderSession } from "./pi.js";

import type { LocalProviderAdapter } from "@cohub/protocol";
import type { LocalRuntimeAdapterFactory } from "../types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { PiProviderAdapter } from "./pi.js";

/** The host owns one registry; provider SDK objects never cross the wire. */
export function createDefaultLocalRuntimeAdapters(): ReadonlyMap<LocalProviderAdapter["provider"], LocalRuntimeAdapterFactory> {
  return new Map<LocalProviderAdapter["provider"], LocalRuntimeAdapterFactory>([
    ["codex", () => new CodexAdapter()],
    ["claude_code", () => new ClaudeAdapter()],
    ["pi", () => new PiProviderAdapter()],
  ]);
}
