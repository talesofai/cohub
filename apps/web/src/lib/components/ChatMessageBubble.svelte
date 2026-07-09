<script lang="ts">
import type { ContentBlock } from "@cohub/protocol/core";
import { Check, Copy, GitFork, Loader2 } from "lucide-svelte";
import MessageContentFlow from "$lib/components/MessageContentFlow.svelte";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import {
	formatDurationDetail,
	formatDurationMs,
	isDisplayableDurationMs,
} from "$lib/format-duration";
import {
	findModelCatalogItem,
	getModelDisplayName,
	type ModelCatalogItem,
} from "$lib/model-catalog";
import type { ChatMessage } from "$lib/session-tree";
import {
	formatCompactAbsoluteTime,
	formatFullAbsoluteTime,
} from "$lib/time-format";
import type { OpenWorkspaceFileTarget } from "$lib/workspace-file-links";

type Props = {
	message: ChatMessage;
	modelsCatalog?: ModelCatalogItem[];
	onMarkdownRenderStart?: (message: ChatMessage) => void;
	onMarkdownRendered?: (message: ChatMessage) => void;
	showToolCalls?: boolean;
	onOpenFile?: (target: OpenWorkspaceFileTarget) => void;
	onForkTurn?: () => void;
	forkDisabled?: boolean;
	forking?: boolean;
};

const {
	message,
	modelsCatalog,
	onMarkdownRenderStart,
	onMarkdownRendered,
	showToolCalls = true,
	onOpenFile,
	onForkTurn,
	forkDisabled = false,
	forking = false,
}: Props = $props();
let pendingMarkdownSegments = $state(0);
let markdownStartedForSignature = $state("");

// Thinking state: track user manual toggle to avoid overriding
let thinkingExpanded = $state(false);
let thinkingUserToggled = $state(false);
// Auto-expand during streaming, auto-collapse after (unless user toggled)
const isStreaming = $derived(
	message.meta?.messageKind === "assistant_streaming_preview" ||
		message.meta?.streaming === true ||
		message.id.startsWith("assistant-streaming:") ||
		message.id === "assistant-streaming" ||
		message.id === "assistant-thinking",
);

$effect(() => {
	if (isStreaming && !thinkingUserToggled) {
		thinkingExpanded = true;
	} else if (!isStreaming && !thinkingUserToggled) {
		thinkingExpanded = false;
	}
});

const textSignature = $derived(
	(message.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n\n"),
);

function handleMarkdownSegmentRendered() {
	pendingMarkdownSegments = Math.max(0, pendingMarkdownSegments - 1);
	if (pendingMarkdownSegments === 0) onMarkdownRendered?.(message);
}

function handleMarkdownSegmentStart() {
	if (markdownStartedForSignature !== textSignature) {
		markdownStartedForSignature = textSignature;
		pendingMarkdownSegments = 0;
		onMarkdownRenderStart?.(message);
	}
	pendingMarkdownSegments += 1;
}

const assistantAbortMessage = $derived(
	message.role === "assistant" && message.meta?.stopReason === "aborted"
		? "Generation was stopped by a user"
		: "",
);

const assistantErrorMessage = $derived(
	message.role === "assistant" &&
		!assistantAbortMessage &&
		(message.meta?.messageKind === "assistant_error" ||
			message.meta?.stopReason === "error")
		? (message.meta?.errorMessage ?? "Unknown error")
		: "",
);

const isCancelledBeforeDispatch = $derived(
	message.role === "user" &&
		message.meta?.turn?.status === "cancelled" &&
		message.meta?.turn?.meta?.cancelledBeforeDispatch === true,
);

const cancelledByDisplay = $derived.by(() => {
	const userId = message.meta?.turn?.meta?.cancelledByUserId;
	if (typeof userId !== "string" || !userId.trim()) return "";
	if (message.authorProfile?.userUuid === userId)
		return message.authorProfile.displayName;
	return userId.replaceAll("-", "").slice(0, 8);
});

const isUserMessage = $derived(message.role === "user");

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

const turnMeta = $derived(asRecord(message.meta?.turn?.meta));
const turnContext = $derived(asRecord(turnMeta?.context));
const turnClientMessageId = $derived.by(() => {
	const value = turnMeta?.clientMessageId;
	return typeof value === "string" && value.trim() ? value.trim() : "";
});

const isBackgroundTaskUserMessage = $derived(
	message.role === "user" &&
		(turnContext?.kind === "background_bash_task" ||
			turnClientMessageId.startsWith("background-bash-task:")),
);

const backgroundTaskRunId = $derived.by(() => {
	const value = turnContext?.taskRunId;
	return typeof value === "string" && value.trim() ? value.trim() : "";
});

const backgroundTaskDetail = $derived(
	backgroundTaskRunId
		? `Background bash task ${backgroundTaskRunId}`
		: "Background bash task",
);

const messageContainerClass = $derived(
	message.role === "user"
		? "ml-auto max-w-[var(--chat-user-message-max-width)]"
		: "",
);

const messageBubbleClass = $derived.by(() => {
	const base = "px-2 py-2 text-[14px] leading-[1.7]";
	if (message.role === "user") {
		if (isCancelledBeforeDispatch)
			return `${base} rounded-xl rounded-br-md bg-bg-hover/60 text-text-tertiary`;
		if (isBackgroundTaskUserMessage)
			return `${base} rounded-xl rounded-br-md border border-border-subtle/70 bg-bg-hover/45 text-text-secondary`;
		return `${base} rounded-[var(--chat-user-message-radius)] rounded-br-[var(--chat-user-message-tail-radius)] bg-[var(--chat-user-message-bg)] text-[var(--chat-user-message-fg)]`;
	}
	if (message.role === "assistant") {
		return assistantErrorMessage
			? `${base} rounded-xl bg-status-error/5 text-text-primary`
			: `${base} text-text-primary`;
	}
	if (message.role === "system") return `${base} bg-info-bg text-info-soft`;
	return `${base} bg-error-bg text-error-soft`;
});

const defaultExpandToolCalls = $derived(
	message.role === "assistant" &&
		message.meta?.messageKind === "assistant_final" &&
		message.meta?.streaming !== true &&
		(message.content ?? []).some((block) => block.type === "tool_use"),
);

const hasForkCheckpoint = $derived(
	Boolean(
		message.meta?.turn &&
			(typeof message.meta.turn.meta?.agentSessionEntryId === "string" ||
				(message.meta.turn.meta?.agent &&
					typeof message.meta.turn.meta.agent === "object" &&
					!Array.isArray(message.meta.turn.meta.agent) &&
					typeof (message.meta.turn.meta.agent as Record<string, unknown>)
						.leafEntryId === "string")),
	),
);

const canFork = $derived(
	Boolean(
		onForkTurn &&
			hasForkCheckpoint &&
			message.role === "assistant" &&
			message.meta?.messageKind &&
			["assistant_final", "assistant_error", "assistant_interrupted"].includes(
				message.meta.messageKind,
			) &&
			message.meta?.streaming !== true,
	),
);

function fallbackUserName(uuid?: string | null): string {
	if (!uuid) return "User";
	const compact = uuid.replaceAll("-", "");
	return compact.slice(0, 8) || "User";
}

const userDisplayName = $derived(
	message.authorProfile?.displayName?.trim() ||
		fallbackUserName(message.authorUuid),
);

function toggleThinking() {
	thinkingExpanded = !thinkingExpanded;
	thinkingUserToggled = true;
}

// ─── Meta bar: time, model, tokens, copy ───

const timeDisplay = $derived(formatCompactAbsoluteTime(message.createdAt));
const fullDateTime = $derived(
	formatFullAbsoluteTime(message.createdAt, { seconds: true }),
);

// Model display: default show model name (matched from catalog), fallback to model id
const modelMatch = $derived(
	findModelCatalogItem(modelsCatalog, {
		provider: message.meta?.provider,
		model: message.meta?.model,
	}),
);

const modelName = $derived(
	getModelDisplayName(modelsCatalog, {
		provider: message.meta?.provider,
		model: message.meta?.model,
	}),
);

const modelDisplayName = $derived(message.meta?.model ? modelName : "");

const modelHoverText = $derived(
	message.meta?.provider && message.meta?.model
		? `${message.meta.provider}/${modelName}`
		: "",
);

// Token display
function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

function formatCost(n: number): string {
	const formatted =
		n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n.toFixed(4);
	return `$${formatted}`;
}

const hasDuration = $derived.by(() => {
	const durationMs = message.meta?.durationMs;
	return (
		message.role === "assistant" &&
		message.meta?.streaming !== true &&
		message.meta?.messageKind !== "assistant_streaming_preview" &&
		isDisplayableDurationMs(durationMs)
	);
});

const durationDisplay = $derived(
	hasDuration ? formatDurationMs(message.meta?.durationMs ?? 0) : "",
);

const durationDetailText = $derived.by(() => {
	const durationMs = message.meta?.durationMs;
	if (!hasDuration || typeof durationMs !== "number") return "";
	return formatDurationDetail(durationMs);
});

const hasUsage = $derived.by(() => {
	const u = message.meta?.usage;
	if (!u) return false;
	return Boolean(
		u.input ||
			u.output ||
			u.cacheRead ||
			u.cacheWrite ||
			u.totalTokens ||
			u.cost?.input ||
			u.cost?.output ||
			u.cost?.cacheRead ||
			u.cost?.cacheWrite ||
			u.cost?.total,
	);
});

const displayInputTokens = $derived.by(() => {
	const u = message.meta?.usage;
	if (!u) return 0;
	return (u.input ?? 0) + (u.cacheRead ?? 0);
});

const cachedInputTokens = $derived.by(
	() => message.meta?.usage?.cacheRead ?? 0,
);

const tokenDisplay = $derived.by(() => {
	const u = message.meta?.usage;
	if (!u) return "";
	const parts = [];
	if (displayInputTokens > 0) {
		const inputLabel = `↑${formatTokenCount(displayInputTokens)}`;
		parts.push(
			cachedInputTokens > 0
				? `${inputLabel} (${formatTokenCount(cachedInputTokens)} cached)`
				: inputLabel,
		);
	}
	if (u.output) parts.push(`↓${formatTokenCount(u.output)}`);
	if (parts.length > 0) return parts.join(" ");
	if (u.totalTokens) return `${formatTokenCount(u.totalTokens)} tokens`;
	if (u.cacheRead) return `cache ${formatTokenCount(u.cacheRead)}`;
	if (u.cacheWrite) return `cache write ${formatTokenCount(u.cacheWrite)}`;
	if (u.cost?.total) return formatCost(u.cost.total);
	return "";
});

const tokenDetailText = $derived.by(() => {
	const u = message.meta?.usage;
	if (!u) return "";
	const parts = [];
	if (displayInputTokens > 0) {
		parts.push(
			cachedInputTokens > 0
				? `Input: ${formatTokenCount(displayInputTokens)} (${formatTokenCount(cachedInputTokens)} cached)`
				: `Input: ${formatTokenCount(displayInputTokens)}`,
		);
	}
	if (u.output) parts.push(`Output: ${formatTokenCount(u.output)}`);
	if (u.cacheWrite)
		parts.push(`Cache write: ${formatTokenCount(u.cacheWrite)}`);
	if (u.totalTokens) parts.push(`Total: ${formatTokenCount(u.totalTokens)}`);
	if (u.cost?.total) parts.push(`Cost: ${formatCost(u.cost.total)}`);
	return parts.join("  ·  ");
});

const modelContextWindow = $derived.by(() => {
	const contextWindow =
		(message.meta?.contextWindow as number | null | undefined) ??
		modelMatch?.model?.contextWindow;
	return typeof contextWindow === "number" && contextWindow > 0
		? contextWindow
		: null;
});

const inputContextPercent = $derived.by(() => {
	if (!displayInputTokens || !modelContextWindow) return null;
	return Math.max(
		0,
		Math.min(100, (displayInputTokens / modelContextWindow) * 100),
	);
});

function getTokenDisplayClass(percent: number | null) {
	const base = "tabular-nums shrink-0 cursor-default transition-colors";
	if (percent === null || percent < 60)
		return `${base} text-text-placeholder/65`;
	if (percent < 85) return `${base} text-warning-soft/85`;
	return `${base} text-error-soft/90`;
}

// Copy
let copied = $state(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

function handleCopy() {
	const text =
		message.content
			?.filter((block) => block.type === "text")
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("\n\n")
			.trim() || message.text;

	navigator.clipboard.writeText(text).then(() => {
		copied = true;
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => {
			copied = false;
		}, 1800);
	});
}
</script>

{#if message.role === 'system' && message.content?.some(b => b.type === 'thinking')}
  <MessageContentFlow
    content={message.content ?? []}
    {thinkingExpanded}
    {isStreaming}
    showToolCalls={false}
    onToggleThinking={toggleThinking}
    {onOpenFile}
  />
{:else}
  <div class={`w-full ${messageContainerClass}`}>
    <div class={messageBubbleClass}>

      <MessageContentFlow
        content={message.content?.length ? message.content : [{ type: 'text', text: message.text }]}
        {isUserMessage}
        {thinkingExpanded}
        {isStreaming}
        {showToolCalls}
        defaultExpandToolCalls={defaultExpandToolCalls}
        onToggleThinking={toggleThinking}
        onMarkdownSegmentRendered={handleMarkdownSegmentRendered}
        onMarkdownSegmentStart={handleMarkdownSegmentStart}
        onLoadToolCalls={message.toolCallsLoader ?? undefined}
        {onOpenFile}
      />

      {#if assistantErrorMessage}
        <div class="mt-3 rounded-lg border border-status-error/30 bg-status-error/8 px-3 py-2 text-[12px] text-status-error whitespace-pre-wrap break-words">
          <div class="font-medium">Error</div>
          <div class="mt-1">{assistantErrorMessage}</div>
        </div>
      {/if}

    </div>

    {#if (message.role === 'assistant' && (message.meta?.model || timeDisplay)) || (message.role === 'user' && timeDisplay)}
      <!-- Meta bar: copy | identity/model | tokens | time -->
      <div class="mt-1 flex items-center gap-1 px-2 text-[11px] text-text-placeholder/50 select-none">
        <!-- Copy button -->
        <button
          type="button"
          class="shrink-0 inline-flex items-center p-1 rounded cursor-pointer opacity-60 hover:opacity-100 transition-opacity"
          onclick={(e) => { e.stopPropagation(); handleCopy(); }}
          title="Copy message"
        >
          {#if copied}
            <Check class="w-3.5 h-3.5 text-status-running" />
          {:else}
            <Copy class="w-3.5 h-3.5" />
          {/if}
        </button>

        {#if canFork}
          <button
            type="button"
            class="shrink-0 inline-flex items-center p-1 rounded cursor-pointer opacity-60 hover:opacity-100 transition-opacity disabled:cursor-default disabled:opacity-50"
            onclick={(e) => { e.stopPropagation(); if (!forkDisabled) onForkTurn?.(); }}
            title="Fork from here"
            disabled={forkDisabled}
          >
            {#if forking}
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
            {:else}
              <GitFork class="w-3.5 h-3.5" />
            {/if}
          </button>
        {/if}

        {#if message.role === 'user'}
          {#if isBackgroundTaskUserMessage}
            <span class="inline-flex min-w-0 items-center gap-1.5 cursor-default text-text-placeholder/70" title={backgroundTaskDetail}>
              <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-text-placeholder/55"></span>
              <span class="min-w-0 truncate font-medium">Background task</span>
            </span>
          {:else}
            <!-- User identity -->
            <span class="inline-flex min-w-0 items-center gap-1.5 cursor-default" title={userDisplayName}>
              <UserAvatar name={userDisplayName} avatarUrl={message.authorProfile?.avatarUrl} size="xxs" class="border-0 bg-brand/15 text-brand" />
              <span class="min-w-0 truncate">{userDisplayName}</span>
            </span>
          {/if}
          {#if isCancelledBeforeDispatch}
            <span class="shrink-0 text-[11px] font-medium text-text-placeholder/65" title={cancelledByDisplay ? `Cancelled by ${cancelledByDisplay}. Not sent to agent.` : 'Not sent to agent.'}>cancelled</span>
          {/if}
        {:else}
          <!-- Model (truncates when space is tight) -->
          {#if modelDisplayName}
            <span class="min-w-0 truncate cursor-default" title={modelHoverText}>
              {modelDisplayName}
            </span>
          {/if}

          <!-- Tokens -->
          {#if hasUsage}
            <span class={getTokenDisplayClass(inputContextPercent)} title={tokenDetailText}>
              {tokenDisplay}
            </span>
          {/if}

          {#if hasDuration}
            <span class="shrink-0 tabular-nums cursor-default text-text-placeholder/65" title={durationDetailText}>
              {durationDisplay}
            </span>
          {/if}

          {#if assistantAbortMessage}
            <span class="shrink-0 text-[11px] font-medium text-warning-soft/75" title={assistantAbortMessage}>user stopped</span>
          {/if}
        {/if}

        <!-- Time (always visible on the right) -->
        {#if timeDisplay}
          <time datetime={message.createdAt} class="ml-auto shrink-0 tabular-nums cursor-default" title={fullDateTime}>
            {timeDisplay}
          </time>
        {/if}
      </div>
    {/if}
  </div>
{/if}
