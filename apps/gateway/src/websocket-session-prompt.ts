import { randomUUID } from "node:crypto";
import type { ContentBlock } from "@cohub/protocol/core";

const trimmedString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export function normalizeWebsocketSessionPromptPayload(
  payload: Record<string, unknown>,
) {
  return {
    spaceId: trimmedString(payload.spaceId) ?? "",
    sessionId: trimmedString(payload.sessionId) ?? "",
    clientMessageId: trimmedString(payload.clientMessageId) ?? randomUUID(),
    content: Array.isArray(payload.content)
      ? (payload.content as ContentBlock[])
      : [],
    model: trimmedString(payload.model),
    provider: trimmedString(payload.provider),
    thinkingLevel: trimmedString(payload.thinkingLevel),
    systemInstructions: trimmedString(payload.systemInstructions),
  };
}

export function buildWebsocketSessionPromptRequest(input: {
  prompt: ReturnType<typeof normalizeWebsocketSessionPromptPayload>;
  userId: string;
  authToken?: string | null;
  requestId: string;
  connectionId: string;
}) {
  return {
    ...input.prompt,
    userId: input.userId,
    authToken: input.authToken,
    source: "websocket",
    context: {
      kind: "websocket",
      requestId: input.requestId,
      connectionId: input.connectionId,
    },
  };
}
