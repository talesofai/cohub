import type { ProviderHeaders, ProviderResponse } from "@earendil-works/pi-ai";

export type CodexRequestContext = {
  sessionId: string;
  windowId: string;
  turnId?: string;
  turnStartedAtUnixMs?: number;
  turnState?: string;
};

export type CodexTurnSnapshot = {
  turnId: string;
  turnStartedAtUnixMs: number;
  turnState?: string;
};

export class CodexTurnStateTracker {
  private activeTurn: CodexTurnSnapshot | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  current(turnId: string | undefined): CodexTurnSnapshot | undefined {
    if (!turnId) return undefined;
    if (this.activeTurn?.turnId !== turnId) {
      this.activeTurn = {
        turnId,
        turnStartedAtUnixMs: this.now(),
      };
    }
    return { ...this.activeTurn };
  }

  capture(turnId: string | undefined, response: ProviderResponse): void {
    if (!turnId || this.activeTurn?.turnId !== turnId) return;
    const turnState = getCodexTurnState(response);
    if (turnState) this.activeTurn.turnState = turnState;
  }
}

function setHeader(
  headers: ProviderHeaders,
  name: string,
  value: string,
): void {
  const lowerName = name.toLowerCase();
  for (const existingName of Object.keys(headers)) {
    if (existingName.toLowerCase() === lowerName) delete headers[existingName];
  }
  headers[name] = value;
}

function buildTurnMetadata(context: CodexRequestContext): string | undefined {
  if (!context.turnId || context.turnStartedAtUnixMs === undefined) return undefined;
  return JSON.stringify({
    session_id: context.sessionId,
    thread_id: context.sessionId,
    turn_id: context.turnId,
    window_id: context.windowId,
    request_kind: "turn",
    turn_started_at_unix_ms: context.turnStartedAtUnixMs,
  });
}

export function withCodexRequestHeaders(
  configuredHeaders: ProviderHeaders | undefined,
  context: CodexRequestContext,
): ProviderHeaders {
  const headers = { ...(configuredHeaders ?? {}) };
  setHeader(headers, "Session-Id", context.sessionId);
  setHeader(headers, "Thread-Id", context.sessionId);
  setHeader(headers, "X-Client-Request-Id", context.sessionId);
  setHeader(headers, "X-Codex-Window-Id", context.windowId);

  const turnMetadata = buildTurnMetadata(context);
  if (turnMetadata) {
    setHeader(headers, "X-Codex-Turn-Metadata", turnMetadata);
  }
  if (context.turnState) {
    setHeader(headers, "X-Codex-Turn-State", context.turnState);
  }
  return headers;
}

export function withCodexClientMetadata(
  payload: unknown,
  context: CodexRequestContext,
): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;

  const request = payload as Record<string, unknown>;
  const existingClientMetadata = request.client_metadata;
  const clientMetadata = existingClientMetadata
    && typeof existingClientMetadata === "object"
    && !Array.isArray(existingClientMetadata)
    ? { ...(existingClientMetadata as Record<string, unknown>) }
    : {};

  clientMetadata.session_id = context.sessionId;
  clientMetadata.thread_id = context.sessionId;
  clientMetadata["x-codex-window-id"] = context.windowId;
  if (context.turnId) clientMetadata.turn_id = context.turnId;

  const turnMetadata = buildTurnMetadata(context);
  if (turnMetadata) {
    clientMetadata["x-codex-turn-metadata"] = turnMetadata;
  }

  return { ...request, client_metadata: clientMetadata };
}

export function getCodexTurnState(response: ProviderResponse): string | undefined {
  for (const [name, value] of Object.entries(response.headers)) {
    if (name.toLowerCase() === "x-codex-turn-state") {
      return value.trim() || undefined;
    }
  }
  return undefined;
}
