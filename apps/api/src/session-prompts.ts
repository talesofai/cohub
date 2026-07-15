import type {
  ChannelPromptContext,
  AgentPromptAccessMode,
  PromptAccessMode,
  PromptSource,
  PromptTemplateUsageMeta,
  PublicApiPromptContext,
  ScheduledTaskPromptContext,
  SubmitSessionPromptContext,
  SubmitSessionPromptError,
  SubmitSessionPromptHooks,
  SubmitSessionPromptInput,
  SubmitSessionPromptResult,
  WebAppPromptContext,
  WebsocketPromptContext,
} from "@cohub/core/sessions";
import type { ContentBlock } from "@cohub/protocol/core";
import { getSessionDomainServices } from "./session-services.js";
import { assertIsolatedWorkerDisposableOperationAllowed } from "./isolated-worker-disposable-guard.js";

export type {
  ChannelPromptContext,
  AgentPromptAccessMode,
  PromptAccessMode,
  PromptSource,
  PromptTemplateUsageMeta,
  PublicApiPromptContext,
  ScheduledTaskPromptContext,
  SubmitSessionPromptContext,
  SubmitSessionPromptError,
  SubmitSessionPromptHooks,
  SubmitSessionPromptInput,
  SubmitSessionPromptResult,
  WebAppPromptContext,
  WebsocketPromptContext,
};

export const expandPromptContent = async (input: {
  content: ContentBlock[];
  userId: string;
  spaceId: string;
}) => getSessionDomainServices().expandPromptContent(input);

export const submitSessionPrompt = async (
  input: SubmitSessionPromptInput,
  hooks: SubmitSessionPromptHooks = {},
): Promise<SubmitSessionPromptResult> => {
  await assertIsolatedWorkerDisposableOperationAllowed(
    input.spaceId,
    input.accessMode === "isolated_worker" ? "isolated_worker_dispatch" : "generic_prompt",
  );
  return getSessionDomainServices().submitPrompt(input, {
    ...hooks,
    beforeEnqueue: hooks.beforeEnqueue,
  });
};
