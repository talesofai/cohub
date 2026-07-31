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
    env: parsePromptEnv(input.env),
    systemInstructions: parsePromptSystemInstructions(input.systemInstructions),
    intent: input.intent ?? null,
    context: input.context,
  };
}
