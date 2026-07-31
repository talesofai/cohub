import {
  parsePromptEnv,
  parsePromptSystemInstructions,
  type PromptAccessMode,
  type PromptEnv,
  type SubmitSessionPromptContext,
} from "@cohub/core/sessions";
import type { ContentBlock } from "@cohub/protocol/core";
import type { GenerationPolicy } from "@cohub/protocol/generation";
import type { SessionTurnIntent } from "@cohub/protocol/model";
import { createHash } from "node:crypto";

export function parseScheduledSendMessagePromptOptions(input: {
  env?: unknown;
  systemInstructions?: unknown;
}) {
  return {
    env: parsePromptEnv(input.env),
    systemInstructions: parsePromptSystemInstructions(input.systemInstructions),
  };
}

export function buildScheduledSendMessagePromptInput(input: {
  spaceId: string;
  sessionId: string;
  userId: string;
  clientMessageId: string;
  content: ContentBlock[];
  source: string;
  model?: string | null;
  provider?: string | null;
  thinkingLevel?: string | null;
  generationPolicy?: GenerationPolicy | null;
  accessMode?: PromptAccessMode | null;
  env?: PromptEnv | null;
  systemInstructions?: string | null;
  intent?: SessionTurnIntent | null;
  context: SubmitSessionPromptContext;
}) {
  return {
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    userId: input.userId,
    clientMessageId: input.clientMessageId,
    content: input.content,
    source: input.source,
    model: input.model ?? null,
    provider: input.provider ?? null,
    thinkingLevel: input.thinkingLevel ?? null,
    generationPolicy: input.generationPolicy ?? null,
    accessMode: input.accessMode ?? "full_access",
    env: input.env ?? null,
    systemInstructions: input.systemInstructions ?? null,
    intent: input.intent ?? null,
    context: input.context,
  };
}

export function scheduledPromptSessionId(input: {
  spaceId: string;
  userId: string;
  taskRunId: string;
}) {
  const hex = createHash("sha256").update(JSON.stringify([
    "scheduled_prompt_session",
    input.spaceId,
    input.userId,
    input.taskRunId,
  ])).digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
