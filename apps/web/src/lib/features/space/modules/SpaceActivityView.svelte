<script lang="ts">
import type { SpaceActivityResponse } from "@neta-art/cohub";
import { Loader2 } from "lucide-svelte";
import { onMount } from "svelte";
import { page } from "$app/state";
import { ensureAuth } from "$lib/auth";
import { handleUnauthorizedError } from "$lib/auth-redirect";
import ActivityContributors from "$lib/components/activity/ActivityContributors.svelte";
import ActivityHeatmap from "$lib/components/activity/ActivityHeatmap.svelte";
import ActivityRankings from "$lib/components/activity/ActivityRankings.svelte";
import ActivityStatStrip from "$lib/components/activity/ActivityStatStrip.svelte";
import {
	createSpaceActivityController,
	SPACE_ACTIVITY_RANGES,
	type SpaceActivityRange,
} from "$lib/features/space/modules/space-activity-controller.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { getCachedSpaceRecord } from "$lib/stores/space-record-cache";
import { buildActivityDays } from "$lib/user-activity";

const { data }: { data: { spaceId: string } } = $props();

const locale = $derived(getLocale());
const spaceId = $derived(data.spaceId);
const spaceActivity = createSpaceActivityController({
	spaceId: () => spaceId,
});

const RANGE_LABELS: Record<SpaceActivityRange, string> = {
	7: "7D",
	30: "30D",
	365: "1Y",
};

let heatmapMode = $state<"llm" | "generation">("llm");
let spaceName = $state<string | null>(null);
let canViewCost = $state(false);

const activity = $derived(
	spaceActivity.activity as SpaceActivityResponse | null,
);
const days = $derived.by(() => {
	if (!activity) return [];
	return buildActivityDays(activity, activity.days);
});

function rangeLabel(target: SpaceActivityRange) {
	return target === 365
		? m.activity_last_year({}, { locale })
		: m.activity_last_days({ days: target }, { locale });
}

onMount(async () => {
	if (!(await ensureAuth({ redirectPath: page.url.pathname }))) return;
	void spaceActivity.load();
	const cached = await getCachedSpaceRecord(spaceId);
	const record = cached?.space;
	if (!record) return;
	spaceName = record.name || record.title || spaceId;
	canViewCost =
		record.access?.role === "host" || record.access?.role === "builder";
});
</script>

<svelte:head>
	<title>{spaceName ? `${spaceName} · ` : ""}{m.page_title_activity({}, { locale })} — Cohub</title>
</svelte:head>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
	<div class="w-full max-w-5xl px-4 py-7 sm:px-6 lg:px-8">
		<header class="flex flex-wrap items-end justify-between gap-4 border-b border-border-subtle pb-5">
			<div class="min-w-0">
				<p class="text-[11px] font-semibold text-brand">Cohub</p>
				<h1 class="mt-1 truncate text-[20px] font-semibold text-text-primary">
					{spaceName ?? m.nav_activity({}, { locale })}
				</h1>
				<p class="mt-1 text-[12px] text-text-tertiary">{m.nav_activity({}, { locale })}</p>
			</div>
			<div class="flex rounded-md bg-bg-surface p-0.5" aria-label={m.activity_range_aria({}, { locale })}>
				{#each SPACE_ACTIVITY_RANGES as range (range)}
					<button
						type="button"
						class="min-w-11 rounded-[4px] px-2.5 py-1.5 text-[11px] font-medium transition-colors {spaceActivity.selectedDays === range ? 'bg-bg-active text-text-primary' : 'text-text-placeholder hover:text-text-secondary'}"
						aria-pressed={spaceActivity.selectedDays === range}
						title={rangeLabel(range)}
						onclick={() => spaceActivity.selectRange(range)}
					>{RANGE_LABELS[range]}</button>
				{/each}
			</div>
		</header>

		{#if spaceActivity.loading}
			<div class="flex min-h-72 items-center justify-center">
				<Loader2 class="h-5 w-5 animate-spin text-text-placeholder" />
			</div>
		{:else if !activity}
			<div class="py-16 text-center">
				<p class="text-[13px] text-text-secondary">{m.activity_unavailable({}, { locale })}</p>
				{#if spaceActivity.loadError}
					<p class="mt-2 text-[12px] text-error-soft">{spaceActivity.loadError}</p>
				{/if}
				<button type="button" class="mt-4 text-[12px] font-medium text-brand hover:underline" onclick={() => void spaceActivity.load({ force: true })}>
					{m.activity_try_again({}, { locale })}
				</button>
			</div>
		{:else}
			<ActivityStatStrip {days} showCost={canViewCost} />
			<section class="border-b border-border-subtle py-7">
				<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
					<h2 class="text-[13px] font-medium text-text-primary">{m.activity_daily_activity({}, { locale })}</h2>
					<div class="flex flex-wrap items-center justify-end gap-3">
						<div class="flex rounded-md bg-bg-surface p-0.5" aria-label={m.activity_type_aria({}, { locale })}>
							{#each ["llm", "generation"] as const as mode (mode)}
								<button
									type="button"
									class="rounded-[4px] px-2.5 py-1 text-[10px] font-medium transition-colors {heatmapMode === mode ? 'bg-bg-active text-text-primary' : 'text-text-placeholder hover:text-text-secondary'}"
									aria-pressed={heatmapMode === mode}
									onclick={() => (heatmapMode = mode)}
								>{mode === "generation" ? m.activity_mode_generation({}, { locale }) : "LLM"}</button>
							{/each}
						</div>
					</div>
				</div>
				<ActivityHeatmap {days} mode={heatmapMode} />
			</section>

			<ActivityContributors
				items={activity.contributors.items}
				memberCount={activity.contributors.memberCount}
				showCost={canViewCost}
			/>

			<ActivityRankings spaceId={data.spaceId} rankings={activity.rankings} />

			{#if spaceActivity.loadError}
				<p class="border-t border-border-subtle pt-4 text-[11px] text-text-placeholder">{m.activity_showing_saved({}, { locale })}</p>
			{/if}
			{#if spaceActivity.refreshing}
				<p class="pt-3 text-right text-[10px] text-text-placeholder">{m.activity_refreshing({}, { locale })}</p>
			{/if}
		{/if}
	</div>
</div>
