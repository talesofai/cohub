<script lang="ts">
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import type { ActivityDay } from "$lib/user-activity";
import {
	formatCompact,
	formatCost,
	getActivityStats,
} from "$lib/user-activity";

type Props = {
	days: ActivityDay[];
	/** Cost reads as commercial data — hide it for non space managers. */
	showCost: boolean;
	extra?: Array<{ label: string; value: string }>;
};

const { days, showCost, extra = [] }: Props = $props();

const locale = $derived(getLocale());
const stats = $derived(getActivityStats(days));
</script>

<section
	class="grid grid-cols-2 border-b border-border-subtle py-6 sm:grid-cols-4"
	aria-label={m.activity_summary_aria({}, { locale })}
>
	<div class="border-r border-border-subtle pr-3 sm:pr-5">
		<div class="font-mono text-[20px] text-text-primary sm:text-[22px]">{formatCompact(stats.totalTokens, locale)}</div>
		<div class="mt-1 text-[11px] text-text-placeholder">{m.activity_tokens({}, { locale })}</div>
	</div>
	<div class="pl-3 sm:border-r sm:border-border-subtle sm:px-5">
		<div class="font-mono text-[20px] text-text-primary sm:text-[22px]">{formatCompact(stats.totalRequests, locale)}</div>
		<div class="mt-1 text-[11px] text-text-placeholder">{m.activity_requests({}, { locale })}</div>
	</div>
	<div class="mt-5 border-r border-border-subtle pr-3 sm:mt-0 sm:px-5">
		<div class="font-mono text-[20px] text-text-primary sm:text-[22px]">{stats.activeDays}</div>
		<div class="mt-1 text-[11px] text-text-placeholder">{m.activity_active_days({}, { locale })}</div>
	</div>
	{#if showCost}
		<div class="mt-5 pl-3 sm:mt-0 sm:pl-5">
			<div class="font-mono text-[20px] text-text-primary sm:text-[22px]">{formatCost(stats.totalCost, locale)}</div>
			<div class="mt-1 text-[11px] text-text-placeholder">{m.activity_cost({}, { locale })}</div>
		</div>
	{:else if extra.length}
		{#each extra as item (item.label)}
			<div class="mt-5 pl-3 sm:mt-0 sm:pl-5">
				<div class="font-mono text-[20px] text-text-primary sm:text-[22px]">{item.value}</div>
				<div class="mt-1 text-[11px] text-text-placeholder">{item.label}</div>
			</div>
		{/each}
	{/if}
</section>
