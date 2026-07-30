<script lang="ts">
import type { Usage } from "@cohub/protocol/core";
import type { ContextCompactionMeta } from "@cohub/protocol/model";
import { Archive, ChevronDown, ChevronRight } from "lucide-svelte";
import MessageContentFlow from "$lib/components/MessageContentFlow.svelte";
import {
	formatDurationMs,
	isDisplayableDurationMs,
} from "$lib/format-duration";
import {
	formatTokenCount,
	formatUsageCost,
	getUsageCostTotal,
	getUsageTotalTokens,
} from "$lib/format-usage";

type Props = {
	variant: "turn-boundary" | "turn-inline";
	compaction: Partial<ContextCompactionMeta> & Record<string, unknown>;
	summary: string;
	usage?: Usage | null;
	durationMs?: number | null;
};

const {
	variant,
	compaction,
	summary,
	usage = null,
	durationMs = null,
}: Props = $props();

let expanded = $state(false);

const summarizedMessageCount = $derived(
	typeof compaction.summarizedMessageCount === "number"
		? compaction.summarizedMessageCount
		: null,
);
const tokensBefore = $derived(
	typeof compaction.tokensBefore === "number" ? compaction.tokensBefore : null,
);
const estimatedTokensAfter = $derived(
	typeof compaction.estimatedTokensAfter === "number"
		? compaction.estimatedTokensAfter
		: typeof compaction.tokensAfter === "number"
			? compaction.tokensAfter
			: null,
);
const compactionTokens = $derived(getUsageTotalTokens(usage));
const compactionCost = $derived(getUsageCostTotal(usage));
const model = $derived(
	typeof compaction.model === "string" ? compaction.model : "",
);
const triggerLabel = $derived(
	compaction.triggerReason === "overflow_recovery" ? "Overflow recovery" : "",
);
const ordinalLabel = $derived(
	variant === "turn-inline" && typeof compaction.ordinalInTurn === "number"
		? `#${compaction.ordinalInTurn}`
		: "",
);
const contextLabel = $derived.by(() => {
	if (tokensBefore == null) return "";
	if (estimatedTokensAfter == null)
		return `${formatTokenCount(tokensBefore)} context`;
	return `${formatTokenCount(tokensBefore)} → ~${formatTokenCount(estimatedTokensAfter)}`;
});
const rootClass = $derived(
	variant === "turn-boundary"
		? "border-l-2 border-border-subtle pl-3"
		: "ml-5 border-l border-border-subtle pl-3",
);
const workLabel = $derived.by(() => {
	const parts: string[] = [];
	if (compactionTokens > 0)
		parts.push(`${formatTokenCount(compactionTokens)} compact tokens`);
	if (compactionCost != null) parts.push(formatUsageCost(compactionCost));
	if (isDisplayableDurationMs(durationMs))
		parts.push(formatDurationMs(durationMs ?? 0));
	return parts.join(" · ");
});
</script>

<div class={rootClass}>
	<button
		type="button"
		class="flex min-h-8 w-full items-center gap-x-2 gap-y-1 py-1.5 text-left text-[12px] text-text-tertiary transition-colors hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/50"
		onclick={() => (expanded = !expanded)}
		aria-expanded={expanded}
	>
		<Archive class="h-3.5 w-3.5 shrink-0" />
		<span class="shrink-0 font-medium text-text-secondary">Context compacted{ordinalLabel ? ` ${ordinalLabel}` : ""}</span>
		<span class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 tabular-nums">
			{#if summarizedMessageCount != null}
				<span>{summarizedMessageCount} msgs</span>
			{/if}
			{#if contextLabel}<span>{contextLabel}</span>{/if}
			{#if workLabel}<span class="text-text-placeholder">{workLabel}</span>{/if}
			{#if triggerLabel}<span class="text-warning-soft">{triggerLabel}</span>{/if}
			{#if model}<span class="truncate font-mono text-[11px] text-text-placeholder">{model}</span>{/if}
		</span>
		{#if expanded}
			<ChevronDown class="h-3.5 w-3.5 shrink-0" />
		{:else}
			<ChevronRight class="h-3.5 w-3.5 shrink-0" />
		{/if}
	</button>
	{#if expanded && summary}
		<div class="max-h-96 overflow-y-auto pb-3 pl-5 pr-2 text-[13px] leading-6 text-text-secondary [scrollbar-width:thin]">
			<MessageContentFlow content={[{ type: "text", text: summary }]} thinkingExpanded={false} />
		</div>
	{/if}
</div>
