import { BillingAccessBlockedError, type BillingAccessDecision, type BillingUsageGate } from "@cohub/billing";
import { createHash } from "node:crypto";
import type { ContentBlock } from "@cohub/protocol/core";
import type { GenerationPolicy } from "@cohub/protocol/generation";
import type { SessionTurnIntent } from "@cohub/protocol/model";
import { normalizeContentBlocks } from "../content/normalize.js";
import type { PromptEnv } from "./prompt-env.js";
import { parsePromptSystemInstructions } from "./system-instructions.js";

export type PromptSource =
  | "web_app"
  | "public_api"
  | "scheduled_task"
  | "websocket"
  | string;

export type WebAppPromptContext = {
  kind: "web_app";
  requestId?: string | null;
};

export type WebsocketPromptContext = {
  kind: "websocket";
  requestId?: string | null;
  connectionId?: string | null;
  auth?: PromptAuthContext | null;
};

export type WorkSessionPromptAuthContext = {
  type: "work_session";
  workId: string;
  spaceId: string;
  scopes: string[];
  workScopes: string[];
  viewerScopes: string[];
  exp: number;
  workViewerGrantId?: string | null;
};

export type DelegatedPromptAuthContext = {
  type: "delegated_prompt";
  source: "work_session" | string;
  actorUserId: string;
  workId?: string | null;
  spaceId: string;
  scopes: string[];
  workScopes: string[];
  viewerScopes: string[];
  delegatedAt: string;
  exp: number;
  workViewerGrantId?: string | null;
};

export type PromptAuthContext = WorkSessionPromptAuthContext | DelegatedPromptAuthContext;

export type PublicApiPromptContext = {
  kind: "public_api";
  requestId?: string | null;
  auth?: PromptAuthContext | null;
};

export type ScheduledTaskPromptContext = {
  kind: "scheduled_task";
  taskRunId: string;
  cronJobId?: string | null;
  auth?: PromptAuthContext | null;
};

export type BackgroundBashTaskPromptContext = {
  kind: "background_bash_task";
  taskRunId: string;
  auth?: PromptAuthContext | null;
  origin?: {
    kind: "bash_tool_call";
    sessionId: string;
    turnId: string;
    toolCallId: string;
    requestId?: string | null;
  } | null;
};

export type SpaceHookPromptContext = {
  kind: "space_hook";
  taskRunId: string;
  hookPath: string;
  eventId: string;
  eventType: string;
  eventActorUserId?: string | null;
  /** Shared curated hook env (COHUB_HOOK_*), also used for tool injection. */
  env?: Record<string, string> | null;
};

export type ChannelPromptContext = {
  kind: "channel";
  provider: string;
  spaceChannelId: string;
  requestId?: string | null;
  externalConversationId?: string | null;
  externalMessageId: string;
  providerContext?: Record<string, unknown> | null;
};

export type SubmitSessionPromptContext =
  | WebAppPromptContext
  | WebsocketPromptContext
  | PublicApiPromptContext
  | ScheduledTaskPromptContext
  | BackgroundBashTaskPromptContext
  | SpaceHookPromptContext
  | ChannelPromptContext;

export type PromptTemplateUsageMeta = {
  name: string;
  description: string;
  argumentHint: string | null;
  category: string | null;
  scope: "platform" | "mod" | "user" | "project";
  rawInput: string;
  args: string[];
};

export type SkillUsageMeta = {
  name: string;
  description: string;
  scope: "platform" | "mod" | "user" | "project";
  sandboxFilePath: string;
  sandboxBaseDir: string;
  rawInput: string;
  argsText: string;
};

export type PromptAccessMode = "read_only" | "full_access";

export type SubmitSessionPromptInput = {
  spaceId: string;
  sessionId: string;
  userId: string;
  clientMessageId: string;
  content: ContentBlock[];
  source: PromptSource;
  model?: string | null;
  provider?: string | null;
  /** Optional thinking level override for this turn. Omit to inherit session default. */
  thinkingLevel?: string | null;
  generationPolicy?: GenerationPolicy | null;
  accessMode?: PromptAccessMode | null;
  env?: PromptEnv | null;
  systemInstructions?: string | null;
  intent?: SessionTurnIntent | null;
  context?: SubmitSessionPromptContext | null;
};

export type SubmitSessionPromptResult = {
  turnId: string;
  userMessageId: string;
};

export type SubmitSessionPromptHooks = {
  beforeEnqueue?: (input: {
    turnId: string;
    userMessageId: string;
    content: ContentBlock[];
    meta: Record<string, unknown>;
  }) => Promise<void>;
};

export class SessionPromptIdempotencyConflictError extends Error {
  readonly code = "session_prompt_idempotency_conflict";

  constructor() {
    super("Session prompt idempotency key was reused with a different request.");
    this.name = "SessionPromptIdempotencyConflictError";
  }
}

export type ExpandedPromptTemplate = {
  renderedText: string;
  template: {
    name: string;
    description: string;
    argumentHint?: string | null;
    category?: string | null;
    scope: "platform" | "mod" | "user" | "project";
  };
  args: string[];
  rawInput: string;
};

export type ExpandedSkillCommand = {
  renderedText: string;
  skill: {
    name: string;
    description: string;
    scope: "platform" | "mod" | "user" | "project";
    sandboxFilePath: string;
    sandboxBaseDir: string;
  };
  argsText: string;
  rawInput: string;
};

export type SessionPromptDependencies = {
  randomUUID(): string;
  findSessionTurnByClientMessageId(input: {
    sessionId: string;
    userUuid: string;
    clientMessageId: string;
  }): Promise<{
    id: string;
    userMessageId: string;
    requestFingerprint?: string | null;
    enqueueRecovery?: {
      content: ContentBlock[];
      meta: Record<string, unknown>;
    };
  } | null>;
  recoverSessionTurnForEnqueue(input: {
    sessionId: string;
    turnId: string;
  }): Promise<boolean>;
  expandPromptTemplate(input: {
    text: string;
    userId: string;
    spaceId: string;
  }): Promise<ExpandedPromptTemplate | null>;
  expandSkillCommand?(input: {
    text: string;
    userId: string;
    spaceId: string;
  }): Promise<ExpandedSkillCommand | null>;
  sandboxRecovery?: {
    maybeRecoverForPrompt(input: {
      spaceId: string;
      sessionId: string;
      userId: string;
      source: PromptSource;
      context?: SubmitSessionPromptContext | null;
    }): void | Promise<void>;
  };
  createSessionTurn(input: {
    sessionId: string;
    userUuid: string;
    userContent: ContentBlock[];
    intent: SessionTurnIntent;
    meta: Record<string, unknown>;
  }): Promise<{
    id: string;
    idempotent?: boolean;
    userMessageId?: string;
    enqueueRecovery?: {
      content: ContentBlock[];
      meta: Record<string, unknown>;
    };
  }>;
  enqueueSpacePrompt(input: {
    spaceId: string;
    sessionId: string;
    turnId: string;
    userMessageId: string;
    content: ContentBlock[];
    meta: Record<string, unknown>;
  }): Promise<void>;
  failSessionTurn(input: {
    sessionId: string;
    turnId: string;
    errorMessage: string;
  }): Promise<unknown>;
  billingUsageGate?: BillingUsageGate;
};

export class SubmitSessionPromptError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown,
  ) {
    super(message);
    this.name = "SubmitSessionPromptError";
  }
}

function normalizeDirectShellCommandContent(content: ContentBlock[]): ContentBlock[] {
  if (content.length !== 1) return content;
  const first = content[0];
  if (first?.type !== "text") return content;
  const rawText = first.text.trimStart();
  if (!rawText.startsWith("!")) return content;
  const command = rawText.slice(1);
  if (!command.trim()) throw new Error("shell command is empty");
  return [{ type: "shell_command", command, rawText } satisfies ContentBlock];
}

function normalizePromptModelProvider(input: Pick<SubmitSessionPromptInput, "model" | "provider">): {
  model: string | null;
  provider: string | null;
} {
  const model = input.model?.trim() || null;
  const provider = input.provider?.trim() || null;
  return {
    model,
    provider: provider ?? (model ? "cohub" : null),
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizePromptAuthForFingerprint(auth: unknown) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return null;
  const record = auth as Record<string, unknown>;
  const normalizeScopes = (value: unknown) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).sort()
    : [];
  return {
    type: typeof record.type === "string" ? record.type : null,
    source: typeof record.source === "string" ? record.source : null,
    actorUserId: typeof record.actorUserId === "string" ? record.actorUserId : null,
    workId: typeof record.workId === "string" ? record.workId : null,
    spaceId: typeof record.spaceId === "string" ? record.spaceId : null,
    scopes: normalizeScopes(record.scopes),
    workScopes: normalizeScopes(record.workScopes),
    viewerScopes: normalizeScopes(record.viewerScopes),
    workViewerGrantId: typeof record.workViewerGrantId === "string" ? record.workViewerGrantId : null,
  };
}

function normalizePromptContextForFingerprint(context: SubmitSessionPromptContext | null | undefined) {
  if (!context) return null;
  const record = context as Record<string, unknown>;
  const kind = context.kind;
  const auth = normalizePromptAuthForFingerprint(record.auth);
  if (kind === "space_hook") {
    return {
      kind,
      taskRunId: context.taskRunId,
      hookPath: context.hookPath,
      eventId: context.eventId,
      eventType: context.eventType,
      eventActorUserId: context.eventActorUserId ?? null,
      env: context.env ?? null,
    };
  }
  if (kind === "channel") {
    return {
      kind,
      provider: context.provider,
      spaceChannelId: context.spaceChannelId,
      externalConversationId: context.externalConversationId ?? null,
      externalMessageId: context.externalMessageId,
      providerContext: context.providerContext ?? null,
    };
  }
  if (kind === "scheduled_task") {
    return { kind, taskRunId: context.taskRunId, cronJobId: context.cronJobId ?? null, auth };
  }
  if (kind === "background_bash_task") {
    return {
      kind,
      taskRunId: context.taskRunId,
      auth,
      origin: context.origin
        ? { ...context.origin, requestId: undefined }
        : null,
    };
  }
  return { kind, auth };
}

export function createSessionPromptFingerprint(input: SubmitSessionPromptInput): string {
  const modelProvider = normalizePromptModelProvider(input);
  return createHash("sha256").update(stableStringify({
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    userId: input.userId,
    content: input.content,
    source: input.source.trim(),
    model: modelProvider.model,
    provider: modelProvider.provider,
    thinkingLevel: input.thinkingLevel?.trim() || null,
    generationPolicy: input.generationPolicy ?? null,
    accessMode: input.accessMode ?? "full_access",
    env: input.env ?? null,
    systemInstructions: input.systemInstructions ?? null,
    intent: input.intent ?? "followup",
    context: normalizePromptContextForFingerprint(input.context),
  })).digest("hex");
}

export const expandPromptContent = async (
  deps: Pick<SessionPromptDependencies, "expandPromptTemplate" | "expandSkillCommand">,
  input: {
    content: ContentBlock[];
    userId: string;
    spaceId: string;
  },
) => {
  let content = input.content;
  let promptTemplate: PromptTemplateUsageMeta | null = null;
  let skillUsage: SkillUsageMeta | null = null;

  if (content.length === 1 && content[0]?.type === "text") {
    const originalText = typeof content[0].text === "string" ? content[0].text : "";
    const rawText = originalText.trim();
    if (rawText.startsWith("/skill:") && deps.expandSkillCommand) {
      const expanded = await deps.expandSkillCommand({
        text: rawText,
        userId: input.userId,
        spaceId: input.spaceId,
      });
      if (expanded) {
        content = [{ type: "text", text: expanded.renderedText } satisfies ContentBlock];
        skillUsage = {
          name: expanded.skill.name,
          description: expanded.skill.description,
          scope: expanded.skill.scope,
          sandboxFilePath: expanded.skill.sandboxFilePath,
          sandboxBaseDir: expanded.skill.sandboxBaseDir,
          rawInput: expanded.rawInput,
          argsText: expanded.argsText,
        };
      }
    } else if (rawText.startsWith("/")) {
      const expanded = await deps.expandPromptTemplate({
        text: rawText,
        userId: input.userId,
        spaceId: input.spaceId,
      });
      if (expanded) {
        content = [{ type: "text", text: expanded.renderedText } satisfies ContentBlock];
        promptTemplate = {
          name: expanded.template.name,
          description: expanded.template.description,
          argumentHint: expanded.template.argumentHint ?? null,
          category: expanded.template.category ?? null,
          scope: expanded.template.scope,
          rawInput: expanded.rawInput,
          args: expanded.args,
        };
      }
    }

    content = normalizeDirectShellCommandContent(content);
  }

  return { content, promptTemplate, skillUsage };
};

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const submitSessionPrompt = async (
  deps: SessionPromptDependencies,
  input: SubmitSessionPromptInput,
  hooks: SubmitSessionPromptHooks = {},
): Promise<SubmitSessionPromptResult> => {
  const userId = input.userId.trim();
  if (!userId) throw new Error("userId is required");
  const clientMessageId = input.clientMessageId.trim();
  if (!clientMessageId) throw new Error("clientMessageId is required");
  if (!Array.isArray(input.content) || input.content.length === 0) throw new Error("content is required");
  const systemInstructions = parsePromptSystemInstructions(input.systemInstructions);
  const requestFingerprint = createSessionPromptFingerprint({
    ...input,
    systemInstructions,
  });

  const recoverIdempotentTurn = async (turn: {
    id: string;
    userMessageId: string;
    enqueueRecovery?: { content: ContentBlock[]; meta: Record<string, unknown> };
  }) => {
    if (!turn.enqueueRecovery) return;
    const recovered = await deps.recoverSessionTurnForEnqueue({
      sessionId: input.sessionId,
      turnId: turn.id,
    });
    if (!recovered) return;
    const { content, meta } = turn.enqueueRecovery;
    try {
      await hooks.beforeEnqueue?.({ turnId: turn.id, userMessageId: turn.userMessageId, content, meta });
    } catch (error) {
      await deps.failSessionTurn({
        sessionId: input.sessionId,
        turnId: turn.id,
        errorMessage: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      throw error;
    }
    await deps.enqueueSpacePrompt({
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      turnId: turn.id,
      userMessageId: turn.userMessageId,
      content,
      meta,
    });
  };

  const existingTurn = await deps.findSessionTurnByClientMessageId({
    sessionId: input.sessionId,
    userUuid: userId,
    clientMessageId,
  });
  if (existingTurn) {
    if (existingTurn.requestFingerprint && existingTurn.requestFingerprint !== requestFingerprint) {
      throw new SessionPromptIdempotencyConflictError();
    }
    await recoverIdempotentTurn(existingTurn);
    return { turnId: existingTurn.id, userMessageId: existingTurn.userMessageId };
  }

  if (deps.sandboxRecovery) {
    void Promise.resolve(deps.sandboxRecovery.maybeRecoverForPrompt({
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      userId,
      source: input.source,
      context: input.context ?? null,
    })).catch((error: unknown) => {
      console.warn(`[SandboxResume] failed to resume sandbox for prompt spaceId=${input.spaceId}:`, error);
    });
  }

  const { content: expandedContent, promptTemplate, skillUsage } = await expandPromptContent(deps, {
    content: input.content,
    userId,
    spaceId: input.spaceId,
  });
  const content = normalizeContentBlocks(expandedContent);
  const accessMode = input.accessMode ?? "full_access";

  const isDirectShellCommand = content.length === 1 && content[0]?.type === "shell_command";
  if (accessMode === "read_only" && isDirectShellCommand) {
    throw new Error("shell_command is not allowed in read_only accessMode");
  }
  const inputIntent = isDirectShellCommand ? "shell_command" : "prompt";
  const turnIntent: SessionTurnIntent = isDirectShellCommand ? "steer" : (input.intent ?? "followup");
  const userMessageId = deps.randomUUID();
  const modelProvider = normalizePromptModelProvider(input);

  const requestedThinkingLevel = typeof input.thinkingLevel === "string" && VALID_THINKING_LEVELS.has(input.thinkingLevel.trim()) ? input.thinkingLevel.trim() : undefined;
  const billingDecision: BillingAccessDecision | null = isDirectShellCommand
    ? null
    : (await deps.billingUsageGate?.evaluate({
      userId,
      usageKind: "llm.turn",
      source: input.context?.kind === "scheduled_task" ? "scheduled_prompt" : "session_prompt",
      model: modelProvider.model,
      provider: modelProvider.provider,
      spaceId: input.spaceId,
      sessionId: input.sessionId,
    })) ?? null;
  if (billingDecision?.status === "blocked") {
    throw new BillingAccessBlockedError(billingDecision);
  }
  const baseMeta = {
    source: input.source,
    userId,
    clientMessageId,
    requestFingerprint,
    userMessageId,
    intent: inputIntent,
    dispatchIntent: turnIntent,
    llm: isDirectShellCommand ? false : undefined,
    model: modelProvider.model,
    provider: modelProvider.provider,
    requestedThinkingLevel,
    promptTemplate,
    skillUsage,
    generationPolicy: input.generationPolicy ?? null,
    accessMode,
    env: input.env ?? null,
    ...(systemInstructions ? { systemInstructions } : {}),
    billing: billingDecision?.status === "allowed_with_debt" ? billingDecision : null,
    context: input.context ?? null,
  };

  const turn = await deps.createSessionTurn({
    sessionId: input.sessionId,
    userUuid: userId,
    userContent: content,
    intent: turnIntent,
    meta: baseMeta,
  }).catch((error: unknown) => {
    if (error instanceof SessionPromptIdempotencyConflictError) throw error;
    throw new SubmitSessionPromptError("failed to create session turn", error);
  });

  if (turn.idempotent) {
    if (!turn.userMessageId) {
      throw new SubmitSessionPromptError("idempotent session turn is missing userMessageId", undefined);
    }
    await recoverIdempotentTurn({
      id: turn.id,
      userMessageId: turn.userMessageId,
      enqueueRecovery: turn.enqueueRecovery,
    });
    return { turnId: turn.id, userMessageId: turn.userMessageId };
  }

  const turnId = turn.id;
  const meta = {
    ...baseMeta,
    turnId,
  };

  try {
    await hooks.beforeEnqueue?.({ turnId, userMessageId, content, meta });
  } catch (error) {
    await deps.failSessionTurn({
      sessionId: input.sessionId,
      turnId,
      errorMessage: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);

    throw error;
  }
  await deps.enqueueSpacePrompt({
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    turnId,
    userMessageId,
    content,
    meta,
  });

  return { turnId, userMessageId };
};
