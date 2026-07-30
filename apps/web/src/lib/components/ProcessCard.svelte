<script lang="ts">
import type {
	MessageToolCallsFile,
	SessionTurnIntermediateSummary,
	SessionTurnRecord,
	StoredIntermediateMessage,
} from "@cohub/protocol/model";
import { ChevronDown, ChevronRight, Loader2, RotateCw } from "lucide-svelte";
import IntermediateMessageBubble from "$lib/components/IntermediateMessageBubble.svelte";
import {
	formatDurationDetail,
	formatDurationMs,
	isDisplayableDurationMs,
} from "$lib/format-duration";
import {
	formatTokenCount,
	formatUsageCost,
	getDisplayInputTokens,
	getUsageCostTotal,
	getUsageTotalTokens,
	sumUsages,
} from "$lib/format-usage";
import type { ModelCatalogItem } from "$lib/model-catalog";
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

const toolCallCount = $derived(summary?.toolCallCount ?? 0);
const useLiveMetrics = $derived(streaming && effectiveMessages.length > 0);
const messageCount = $derived(
	useLiveMetrics
		? effectiveMessages.length
		: Math.max(summary?.messageCount ?? 0, effectiveMessages.length),
);
const liveCompactionMessages = $derived(
	effectiveMessages.filter(
		(message) => message.meta?.messageKind === "compacted",
	),
);
const compactionCount = $derived(
	useLiveMetrics
		? liveCompactionMessages.length
		: Math.max(summary?.compaction?.count ?? 0, liveCompactionMessages.length),
);
const stepCount = $derived(Math.max(0, messageCount - compactionCount));
const compactionUsage = $derived.by(() => {
	if (useLiveMetrics)
		return liveCompactionMessages.length > 0
			? sumUsages(liveCompactionMessages.map((message) => message.usage))
			: null;
	if (summary?.compaction?.usage) return summary.compaction.usage;
	if (liveCompactionMessages.length === 0) return null;
	return sumUsages(liveCompactionMessages.map((message) => message.usage));
});
const compactionDurationMs = $derived.by(() => {
	if (!useLiveMetrics && summary?.compaction?.durationMsTotal != null)
		return summary.compaction.durationMsTotal;
	const durations = liveCompactionMessages
		.map((message) => message.durationMs)
		.filter((duration): duration is number => typeof duration === "number");
	return durations.length > 0
		? durations.reduce((total, duration) => total + duration, 0)
		: null;
});
const compactionDetailLabel = $derived.by(() => {
	if (compactionCount === 0) return "";
	const tokens = getUsageTotalTokens(compactionUsage);
	const cost = getUsageCostTotal(compactionUsage);
	const parts = [
		tokens > 0 ? `${formatTokenCount(tokens)} tokens` : "",
		cost != null ? formatUsageCost(cost) : "",
		isDisplayableDurationMs(compactionDurationMs)
			? formatDurationDetail(compactionDurationMs ?? 0)
			: "",
	].filter(Boolean);
	return parts.length > 0 ? `Compaction: ${parts.join(" · ")}` : "";
});
// Intermediate-only usage. While streaming, live messages are authoritative;
// persisted summaries may lag behind the current turn.
const intermediateUsage = $derived.by(() => {
	if (useLiveMetrics)
		return sumUsages(effectiveMessages.map((message) => message.usage));
	if (summary?.usage) return summary.usage;
	if (effectiveMessages.length === 0) return null;
	return sumUsages(effectiveMessages.map((message) => message.usage));
});
const usageInputTokens = $derived(getDisplayInputTokens(intermediateUsage));
const usageCachedTokens = $derived(intermediateUsage?.cacheRead ?? 0);
const usageOutputTokens = $derived(intermediateUsage?.output ?? 0);
const usageTokens = $derived(getUsageTotalTokens(intermediateUsage));
const usageCostTotal = $derived(getUsageCostTotal(intermediateUsage));
const usageCostLabel = $derived(
	usageCostTotal == null ? "" : formatUsageCost(usageCostTotal),
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
const intermediateDurationMs = $derived.by(() => {
	if (!useLiveMetrics) return summary?.durationMs ?? null;
	const durations = effectiveMessages
		.map((message) => message.durationMs)
		.filter((duration): duration is number => typeof duration === "number");
	return durations.length > 0
		? durations.reduce((total, duration) => total + duration, 0)
		: null;
});
const durationLabel = $derived(
	isDisplayableDurationMs(intermediateDurationMs)
		? formatDurationMs(intermediateDurationMs ?? 0)
		: "",
);
const durationTitle = $derived(
	isDisplayableDurationMs(intermediateDurationMs)
		? formatDurationDetail(intermediateDurationMs ?? 0)
		: "",
);
const usageTitle = $derived.by(() => {
	if (!intermediateUsage && !durationTitle && !compactionDetailLabel) return "";
	const parts: string[] = [];
	if (usageInputTokens > 0) {
		parts.push(
			usageCachedTokens > 0
				? `Input: ${formatTokenCount(usageInputTokens)} (${formatTokenCount(usageCachedTokens)} cached)`
				: `Input: ${formatTokenCount(usageInputTokens)}`,
		);
	}
	if (usageOutputTokens > 0)
		parts.push(`Output: ${formatTokenCount(usageOutputTokens)}`);
	if (intermediateUsage?.cacheWrite)
		parts.push(
			`Cache write: ${formatTokenCount(intermediateUsage.cacheWrite)}`,
		);
	if (usageTokens > 0) parts.push(`Total: ${formatTokenCount(usageTokens)}`);
	if (usageCostLabel) parts.push(`Cost: ${usageCostLabel}`);
	if (durationTitle) parts.push(durationTitle);
	if (compactionDetailLabel) parts.push(compactionDetailLabel);
	return parts.join(" · ");
});
const labelParts = $derived(
	[
		stepCount > 0
			? `${stepCount} step${stepCount > 1 ? "s" : ""}`
			: streaming
				? "Running…"
				: "",
		toolCallCount > 0
			? `${toolCallCount} tool${toolCallCount > 1 ? "s" : ""}`
			: "",
		compactionCount > 0
			? `${compactionCount} compaction${compactionCount > 1 ? "s" : ""}`
			: "",
		usageBreakdownLabel ||
			(usageTokens > 0 ? `${formatTokenCount(usageTokens)} tokens` : ""),
		usageCostLabel,
		durationLabel,
	].filter(Boolean),
);
const summaryLabel = $derived(
	labelParts.join(" · ") || (streaming ? "Running…" : "Process"),
);
</script>

{#if !expanded}
	<button type="button" class="flex w-full items-center gap-2 px-2 py-2 text-left transition-colors hover:bg-bg-hover/50 cursor-pointer rounded-md disabled:cursor-wait disabled:opacity-75" disabled={isLoading} onclick={() => void toggle()} title={usageTitle || undefined}>
		{#if isLoading}<Loader2 class="w-3.5 h-3.5 text-text-tertiary shrink-0 animate-spin" />{:else}<ChevronRight class="w-3.5 h-3.5 text-text-tertiary shrink-0" />{/if}
		<span class="text-[13px] text-text-tertiary tabular-nums">{summaryLabel}</span>
	</button>
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
		</div>
		<button type="button" class="flex items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-bg-hover/50 cursor-pointer text-text-placeholder hover:text-text-tertiary rounded-md self-start" onclick={() => void toggle()}>
			<ChevronRight class="w-3 h-3" />
			<span class="text-[11px]">Collapse</span>
		</button>
	</div>
{/if}
