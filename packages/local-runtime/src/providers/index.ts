export { ClaudeAdapter, mapClaudeMessage, createClaudeEventContext } from "./claude.js";
export type { ClaudeAdapterOptions, ClaudePermissionRequest, ClaudePermissionResolver, ClaudeQueryFactory } from "./claude.js";
export { CodexAdapter, mapCodexEvent, createCodexEventContext } from "./codex.js";
export { PiProviderAdapter, PiProviderSession } from "./pi.js";

import type { LocalProviderAdapter } from "../types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { PiProviderAdapter } from "./pi.js";

export function createDefaultLocalRuntimeAdapter(provider: LocalProviderAdapter["provider"]): LocalProviderAdapter {
  switch (provider) {
    case "codex": return new CodexAdapter();
    case "claude_code": return new ClaudeAdapter();
    case "pi": return new PiProviderAdapter();
  }
}
