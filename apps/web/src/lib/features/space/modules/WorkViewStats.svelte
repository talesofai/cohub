<script lang="ts">
import type { WorkViewSource, WorkViewStatsResponse } from "@neta-art/cohub";
import { Eye, RefreshCw } from "lucide-svelte";

type Props = {
	stats: WorkViewStatsResponse | null;
	loading: boolean;
	error: string;
	onRetry: () => void;
};

let { stats, loading, error, onRetry }: Props = $props();

const compactFormatter = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});
const exactFormatter = new Intl.NumberFormat("en-US");
const dayFormatter = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});

const maxDailyViews = $derived(
	Math.max(0, ...(stats?.daily.map((point) => point.views) ?? [])),
);
const sourceTotal = $derived(
	stats?.sources.reduce((total, item) => total + item.views, 0) ?? 0,
);
const hasRecentViews = $derived((stats?.summary.views30d ?? 0) > 0);

function compactCount(value: number) {
	return compactFormatter.format(value);
}

function exactCount(value: number) {
	return exactFormatter.format(value);
}

function formatDay(value: string) {
	return dayFormatter.format(new Date(`${value}T00:00:00Z`));
}

function barHeight(value: number) {
	if (value <= 0 || maxDailyViews <= 0) return 2;
	return Math.max(8, Math.round((value / maxDailyViews) * 100));
}

function sourceLabel(source: WorkViewSource) {
	if (source === "cli") return "CLI";
	if (source === "api") return "API";
	return "Web";
}

function sourcePercent(views: number) {
	return sourceTotal > 0 ? (views / sourceTotal) * 100 : 0;
}
</script>

<section class="border-b border-border-subtle/70 pb-5" aria-labelledby="work-views-heading">
	<div class="mb-4 flex items-center justify-between gap-3">
		<div class="flex items-center gap-2">
			<Eye class="h-3.5 w-3.5 text-text-tertiary" />
			<h2 id="work-views-heading" class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">Views</h2>
		</div>
		{#if error && stats}
			<button type="button" class="inline-flex h-7 w-7 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary" onclick={onRetry} title="Retry view stats" aria-label="Retry view stats">
				<RefreshCw class="h-3.5 w-3.5" />
			</button>
		{/if}
	</div>

	{#if loading && !stats}
		<div class="space-y-5" aria-label="Loading view stats">
			<div class="grid grid-cols-3 gap-4">
				{#each Array(3) as _}
					<div class="space-y-2"><div class="h-5 w-16 animate-pulse rounded bg-bg-elevated"></div><div class="h-3 w-12 animate-pulse rounded bg-bg-elevated/70"></div></div>
				{/each}
			</div>
			<div class="h-24 animate-pulse rounded-[4px] bg-bg-elevated/50"></div>
		</div>
	{:else if error && !stats}
		<div class="flex min-h-20 items-center justify-between gap-4 text-[12px] text-text-tertiary">
			<span>View stats are unavailable.</span>
			<button type="button" class="inline-flex min-h-8 items-center gap-1.5 rounded-[5px] px-2.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary" onclick={onRetry}>
				<RefreshCw class="h-3.5 w-3.5" />
				<span>Retry</span>
			</button>
		</div>
	{:else if stats}
		<div class="grid grid-cols-3 gap-4 sm:max-w-xl sm:gap-8">
			<div class="min-w-0" title={`${exactCount(stats.summary.totalViews)} total views`}>
				<div class="truncate font-mono text-[18px] font-semibold text-text-primary">{compactCount(stats.summary.totalViews)}</div>
				<div class="mt-0.5 text-[10px] text-text-placeholder">Total</div>
			</div>
			<div class="min-w-0" title={`${exactCount(stats.summary.views24h)} views in the last 24 hours`}>
				<div class="truncate font-mono text-[18px] font-semibold text-text-primary">{compactCount(stats.summary.views24h)}</div>
				<div class="mt-0.5 text-[10px] text-text-placeholder">Last 24h</div>
			</div>
			<div class="min-w-0" title={`${exactCount(stats.summary.views7d)} views in the last 7 days`}>
				<div class="truncate font-mono text-[18px] font-semibold text-text-primary">{compactCount(stats.summary.views7d)}</div>
				<div class="mt-0.5 text-[10px] text-text-placeholder">Last 7d</div>
			</div>
		</div>

		<div class="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_220px] lg:gap-10">
			<div class="min-w-0">
				<div class="mb-2 flex items-center justify-between gap-3 text-[10px] text-text-placeholder">
					<span>30-day activity</span>
					<span>UTC</span>
				</div>
				{#if hasRecentViews}
					<div class="grid h-24 items-end gap-[2px]" style={`grid-template-columns: repeat(${stats.daily.length}, minmax(0, 1fr));`} role="img" aria-label="Daily Work views over the last 30 days">
						{#each stats.daily as point (point.date)}
							<div class="flex h-full items-end" title={`${formatDay(point.date)}: ${exactCount(point.views)} views`} aria-label={`${formatDay(point.date)}: ${exactCount(point.views)} views`}>
								<div class="w-full rounded-[1px] bg-brand/70 transition-colors hover:bg-brand" style={`height: ${barHeight(point.views)}%;`}></div>
							</div>
						{/each}
					</div>
					<div class="mt-1.5 flex justify-between text-[9px] text-text-placeholder">
						<span>{stats.daily[0] ? formatDay(stats.daily[0].date) : ""}</span>
						<span>Today</span>
					</div>
				{:else}
					<div class="flex h-24 items-center border-b border-border-subtle/70 text-[12px] text-text-placeholder">{stats.summary.totalViews > 0 ? 'No views in the last 30 days.' : 'No views recorded yet.'}</div>
				{/if}
			</div>

			<div class="min-w-0">
				<div class="mb-3 text-[10px] text-text-placeholder">Sources · 30 days</div>
				{#if stats.sources.length}
					<div class="space-y-3">
						{#each stats.sources as item (item.source)}
							{@const percent = sourcePercent(item.views)}
							<div title={`${sourceLabel(item.source)}: ${exactCount(item.views)} views (${percent.toFixed(1)}%)`}>
								<div class="mb-1 flex items-center justify-between gap-3 text-[11px]">
									<span class="text-text-secondary">{sourceLabel(item.source)}</span>
									<span class="font-mono text-text-tertiary">{compactCount(item.views)} · {percent.toFixed(1)}%</span>
								</div>
								<div class="h-1 overflow-hidden rounded-full bg-bg-elevated">
									<div class="h-full rounded-full bg-text-tertiary" style={`width: ${Math.max(2, percent)}%;`}></div>
								</div>
							</div>
						{/each}
					</div>
				{:else}
					<div class="text-[11px] text-text-placeholder">No source data.</div>
				{/if}
			</div>
		</div>
	{/if}
</section>
