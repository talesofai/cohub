<script lang="ts">
import type {
	MessageToolCallsFile,
	SessionTurnIntermediateSummary,
	SessionTurnRecord,
	StoredIntermediateMessage,
} from "@cohub/protocol/model";
import { ChevronDown, ChevronRight, Loader2, RotateCw } from "lucide-svelte";
import GenerationRuntimeStatusRow from "$lib/components/GenerationRuntimeStatusRow.svelte";
import IntermediateMessageBubble from "$lib/components/IntermediateMessageBubble.svelte";
import {
	formatDurationDetail,
	formatDurationMs,
	isDisplayableDurationMs,
} from "$lib/format-duration";
import { getModelDisplayName, type ModelCatalogItem } from "$lib/model-catalog";
import type { OpenWorkspaceFileTarget } from "$lib/workspace-file-links";

type IntermediateLoadState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "syncing" }
	| { status: "ready"; messages: StoredIntermediateMessage[] }
	| { status: "error"; message: string };

type Props = {
	turn: SessionTurnRecord;
	summary?: SessionTurnIntermediateSummary;
	intermediateMessages?: StoredIntermediateMessage[] | null;
	streaming?: boolean;
	runtimePhase?: "llm_call_started" | null;
	runtimeProvider?: string | null;
	runtimeModel?: string | null;
	modelsCatalog?: ModelCatalogItem[];
	onLoadIntermediate?: (
		turn: SessionTurnRecord,
	) => Promise<StoredIntermediateMessage[]>;
	onRequestIntermediateSync?: (
		turn: SessionTurnRecord,
	) => Promise<boolean | undefined>;
	onLoadToolCalls?: (input: {
		turn: SessionTurnRecord;
		message: StoredIntermediateMessage;
	}) => Promise<MessageToolCallsFile | null>;
	onOpenFile?: (target: OpenWorkspaceFileTarget) => void;
};

const {
	turn,
	summary,
	intermediateMessages: liveIntermediateMessages = null,
	streaming = false,
	runtimePhase = null,
	runtimeProvider = null,
	runtimeModel = null,
	modelsCatalog,
	onLoadIntermediate,
	onRequestIntermediateSync,
	onLoadToolCalls,
	onOpenFile,
}: Props = $props();

let expanded = $state(false);
let loadState = $state<IntermediateLoadState>({ status: "idle" });

const persistedMessagesAvailable = $derived(
	Boolean(turn.intermediateIndex?.messagesObjectKey),
);
const liveMessages = $derived(liveIntermediateMessages ?? []);
const readyMessages = $derived(
	loadState.status === "ready" ? loadState.messages : null,
);
const effectiveMessages = $derived(
	streaming
		? liveMessages.length > 0
			? liveMessages
			: (readyMessages ?? [])
		: (readyMessages ?? []),
);
const expandedMessages = $derived(effectiveMessages);

// DEBUG(each_key_duplicate 排查): 核心疑点——这里是 {#each expandedMessages as msg (msg.id)}
// 实际拿到的数据，最贴近崩溃现场的一层。上游疑点是：页面刷新重连时，快照恢复
// (seedFromSnapshot,SDK session-generation-stream.ts) 与 WebSocket 补发的 patch 事件
// (prepareMessageBoundary -> appendCurrentMessage) 之间存在竟态,可能把同一个
// ordinal/tool_use.id 的中间消息以不同形态写入两次,导致这里 msg.id 重复,
// 触发 Svelte each_key_duplicate 崩溃且无法展开。
$effect(() => {
	const ids = expandedMessages.map((m) => m.id);
	const seen = new Map<string, number>();
	const duplicates: string[] = [];
	for (const id of ids) {
		seen.set(id, (seen.get(id) ?? 0) + 1);
	}
	for (const [id, count] of seen) {
		if (count > 1) duplicates.push(id);
	}
	if (duplicates.length > 0) {
		console.log(
			"[each_key_duplicate DEBUG] ProcessCard expandedMessages has duplicate msg.id",
			{
				turnId: turn.id,
				streaming,
				duplicateIds: duplicates,
				allIds: ids,
				allOrdinals: expandedMessages.map(
					(m) => m.meta?.messageOrdinal ?? null,
				),
				allToolUseIds: expandedMessages.map((m) =>
					(m.content ?? [])
						.filter(
							(b): b is Extract<typeof b, { type: "tool_use" }> =>
								b.type === "tool_use",
						)
						.map((b) => b.id),
				),
			},
		);
	}
});
const hasLiveMessages = $derived(liveMessages.length > 0);
const hasPersistedMessages = $derived(
	summary?.messageCount != null && summary.messageCount > 0,
);
const shouldShowSyncingState = $derived(
	streaming &&
		!hasLiveMessages &&
		hasPersistedMessages &&
		!persistedMessagesAvailable,
);
const syncUnavailableMessage =
	"Process details are still syncing. Please retry";
const isLoading = $derived(loadState.status === "loading");
const isSyncing = $derived(loadState.status === "syncing");
const loadError = $derived(
	loadState.status === "error" ? loadState.message : null,
);

async function requestIntermediateSync(force = false) {
	if (!onRequestIntermediateSync) return false;
	if (!force && loadState.status === "syncing") return true;
	loadState = { status: "syncing" };
	try {
		const restored = await onRequestIntermediateSync(turn);
		if (liveMessages.length > 0) {
			loadState = { status: "ready", messages: liveMessages };
			return true;
		}
		if (restored === false) {
			loadState = {
				status: "error",
				message: syncUnavailableMessage,
			};
			return false;
		}
		loadState = { status: "syncing" };
		return true;
	} catch (error) {
		loadState = {
			status: "error",
			message:
				error instanceof Error
					? error.message
					: "Failed to sync process details. Please retry",
		};
		return false;
	}
}

async function ensureLoaded() {
	if (streaming && liveMessages.length > 0) {
		loadState = { status: "ready", messages: liveMessages };
		return;
	}
	if (loadState.status === "loading") return;
	if (loadState.status === "ready") return;
	if (shouldShowSyncingState) {
		await requestIntermediateSync();
		return;
	}
	if (!onLoadIntermediate) return;
	loadState = { status: "loading" };
	try {
		const messages = await onLoadIntermediate(turn);
		if (messages.length === 0 && streaming && shouldShowSyncingState) {
			loadState = { status: "syncing" };
			await requestIntermediateSync(true);
			return;
		}
		loadState = { status: "ready", messages };
	} catch (error) {
		loadState = {
			status: "error",
			message:
				error instanceof Error
					? error.message
					: "Failed to load process details. Please retry",
		};
	}
}

$effect(() => {
	if (streaming && liveMessages.length > 0) {
		loadState = { status: "ready", messages: liveMessages };
		return;
	}
	if (loadState.status === "ready" && !streaming) return;
	if (shouldShowSyncingState && loadState.status === "idle") {
		loadState = { status: "syncing" };
	}
});

async function toggle() {
	if (!expanded) await ensureLoaded();
	expanded = !expanded;
}

function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

const toolCallCount = $derived(summary?.toolCallCount ?? 0);
const messageCount = $derived(
	Math.max(summary?.messageCount ?? 0, effectiveMessages.length),
);
const usageInputTokens = $derived.by(() => {
	const usage = summary?.usage;
	if (!usage) return 0;
	return (usage.input ?? 0) + (usage.cacheRead ?? 0);
});
const usageCachedTokens = $derived.by(() => summary?.usage?.cacheRead ?? 0);
const usageOutputTokens = $derived.by(() => summary?.usage?.output ?? 0);
const usageTokens = $derived(
	summary?.usage?.totalTokens ??
		((summary?.usage?.input ?? 0) + (summary?.usage?.output ?? 0) || 0),
);
const usageBreakdownLabel = $derived.by(() => {
	if (usageInputTokens <= 0 && usageOutputTokens <= 0) return "";
	const inputLabel =
		usageInputTokens > 0 ? `↑${formatTokenCount(usageInputTokens)}` : "";
	const cachedLabel =
		usageCachedTokens > 0
			? `(${formatTokenCount(usageCachedTokens)} cached)`
			: "";
	const outputLabel =
		usageOutputTokens > 0 ? `↓${formatTokenCount(usageOutputTokens)}` : "";
	return [inputLabel, cachedLabel, outputLabel].filter(Boolean).join(" ");
});
const durationLabel = $derived(
	isDisplayableDurationMs(summary?.durationMs)
		? formatDurationMs(summary.durationMs)
		: "",
);
const durationTitle = $derived(
	isDisplayableDurationMs(summary?.durationMs)
		? formatDurationDetail(summary.durationMs)
		: "",
);
const usageTitle = $derived.by(() => {
	if (!summary?.usage && !durationTitle) return "";
	const parts = [];
	if (usageInputTokens > 0) {
		parts.push(
			usageCachedTokens > 0
				? `Input: ${formatTokenCount(usageInputTokens)} (${formatTokenCount(usageCachedTokens)} cached)`
				: `Input: ${formatTokenCount(usageInputTokens)}`,
		);
	}
	if (usageOutputTokens > 0)
		parts.push(`Output: ${formatTokenCount(usageOutputTokens)}`);
	if (summary?.usage?.cacheWrite)
		parts.push(`Cache write: ${formatTokenCount(summary.usage.cacheWrite)}`);
	if (usageTokens > 0) parts.push(`Total: ${formatTokenCount(usageTokens)}`);
	if (durationTitle) parts.push(durationTitle);
	return parts.join(" · ");
});
const runtimeModelDisplayName = $derived(
	getModelDisplayName(modelsCatalog, {
		provider: runtimeProvider ?? turn.provider,
		model: runtimeModel,
	}),
);
const waitingLabel = $derived(
	runtimePhase === "llm_call_started"
		? runtimeModelDisplayName
			? `waiting ${runtimeModelDisplayName}`
			: "waiting model"
		: "",
);
const startingLabel = $derived(
	streaming && !waitingLabel && effectiveMessages.length === 0
		? "starting agent"
		: "",
);
const runtimeLabel = $derived(waitingLabel || startingLabel);
const runtimeDisplayLabel = $derived(runtimeLabel ? `${runtimeLabel}...` : "");
const isRuntimeOnly = $derived(
	Boolean(runtimeLabel && messageCount === 0 && toolCallCount === 0),
);
const labelParts = $derived(
	[
		messageCount > 0
			? `${messageCount} step${messageCount > 1 ? "s" : ""}`
			: runtimeLabel
				? ""
				: streaming
					? "starting agent"
					: "",
		toolCallCount > 0
			? `${toolCallCount} tool${toolCallCount > 1 ? "s" : ""}`
			: "",
		runtimeLabel,
		usageBreakdownLabel ||
			(usageTokens > 0 ? `${formatTokenCount(usageTokens)} tokens` : ""),
		durationLabel,
	].filter(Boolean),
);
const summaryLabel = $derived(
	labelParts.join(" · ") || (streaming ? "Running…" : "Process"),
);
</script>

{#if !expanded}
	{#if isRuntimeOnly}
		<div class="px-2 py-1.5">
			<GenerationRuntimeStatusRow label={runtimeDisplayLabel} compact />
		</div>
	{:else}
		<button type="button" class="flex w-full items-center gap-2 px-2 py-2 text-left transition-colors hover:bg-bg-hover/50 cursor-pointer rounded-md disabled:cursor-wait disabled:opacity-75" disabled={isLoading} onclick={() => void toggle()} title={usageTitle || undefined}>
			{#if isLoading}<Loader2 class="w-3.5 h-3.5 text-text-tertiary shrink-0 animate-spin" />{:else}<ChevronRight class="w-3.5 h-3.5 text-text-tertiary shrink-0" />{/if}
			<span class="text-[13px] text-text-tertiary tabular-nums">{summaryLabel}</span>
		</button>
	{/if}
{:else}
	<div class="flex flex-col gap-0">
		<button type="button" class="flex w-full items-center gap-2 px-2 py-2 text-left transition-colors hover:bg-bg-hover/50 cursor-pointer rounded-md" onclick={() => void toggle()} title={usageTitle || undefined}>
			<ChevronDown class="w-3.5 h-3.5 text-text-tertiary shrink-0" />
			<span class="text-[13px] text-text-tertiary tabular-nums">{summaryLabel}</span>
		</button>
		<div class="flex flex-col gap-2">
			{#if loadError}
				<button type="button" class="mx-2 rounded-md border border-status-error/30 bg-status-error/5 px-3 py-2 text-left text-[12px] text-status-error hover:bg-status-error/10" onclick={() => void ensureLoaded()}>
					{loadError} · Click to retry
				</button>
			{:else if isSyncing && expandedMessages.length === 0}
				<button type="button" class="mx-2 flex items-center gap-2 rounded-md border border-border-subtle/80 bg-bg-surface px-3 py-2 text-left text-[12px] text-text-tertiary hover:bg-bg-hover/60" onclick={() => void requestIntermediateSync(true)}>
					<RotateCw class="h-3.5 w-3.5 shrink-0" />
					<span>Syncing steps…</span>
				</button>
			{/if}
			{#each expandedMessages as msg (msg.id)}
				<IntermediateMessageBubble message={msg} streaming={streaming} {modelsCatalog} onLoadToolCalls={onLoadToolCalls ? () => onLoadToolCalls({ turn, message: msg }) : undefined} {onOpenFile} />
			{/each}
			{#if runtimeLabel}
				<div class="pl-5">
					<GenerationRuntimeStatusRow label={runtimeDisplayLabel} />
				</div>
			{/if}
		</div>
		<button type="button" class="flex items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-bg-hover/50 cursor-pointer text-text-placeholder hover:text-text-tertiary rounded-md self-start" onclick={() => void toggle()}>
			<ChevronRight class="w-3 h-3" />
			<span class="text-[11px]">Collapse</span>
		</button>
	</div>
{/if}
