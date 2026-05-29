<script lang="ts">
import type { ExploreSection, ExploreSpaceItem } from "@neta-art/cohub";
import {
	FolderKanban,
	GitFork,
	Grid2X2,
	LayoutList,
	Loader2,
	Pin,
	Save,
	Sparkles,
} from "lucide-svelte";
import { page } from "$app/state";
import PageHeader from "$lib/components/PageHeader.svelte";
import { sdk } from "$lib/sdk";

type ExploreView = "list" | "wall";

let sections = $state<ExploreSection[]>([]);
let spaces = $state<ExploreSpaceItem[]>([]);
let loading = $state(true);
let error = $state("");

const activeView = $derived<ExploreView>(
	page.url.searchParams.get("view") === "wall" ? "wall" : "list",
);
const displaySections = $derived<ExploreSection[]>(
	sections.length > 0
		? sections
		: [{ key: "all", title: null, subtitle: null, description: null, spaces }],
);

function formatCount(n: number | null | undefined): string {
	const value = Number.isFinite(n) ? Number(n) : 0;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return String(value);
}

function getInitials(name: string | null | undefined): string {
	const initials = (name ?? "")
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase() ?? "")
		.join("");
	return initials || "S";
}

function getTitle(item: ExploreSpaceItem): string {
	return item.title || item.id;
}

function getPrimaryMeta(item: ExploreSpaceItem): string | null {
	return item.category ?? item.tags?.[0] ?? null;
}

function getSecondaryMeta(item: ExploreSpaceItem): string {
	const signals = [
		item.skillCount != null ? `${formatCount(item.skillCount)} saves` : null,
		item.assetCount != null ? `${formatCount(item.assetCount)} pins` : null,
		item.ownerDisplayName ? `by ${item.ownerDisplayName}` : null,
	].filter(Boolean);
	return signals.slice(0, 2).join(" · ") || item.accessLabel;
}

function getSpaceHref(item: ExploreSpaceItem): string {
	return item.spaceUrl || `/spaces/${item.id}`;
}

function getWallTone(index: number): string {
	return (
		[
			"wall-tone-a",
			"wall-tone-b",
			"wall-tone-c",
			"wall-tone-d",
			"wall-tone-e",
			"wall-tone-f",
		][index % 6] ?? "wall-tone-a"
	);
}

function getWallRatio(index: number): string {
	return (
		[
			"wall-ratio-a",
			"wall-ratio-b",
			"wall-ratio-c",
			"wall-ratio-d",
			"wall-ratio-e",
		][index % 5] ?? "wall-ratio-a"
	);
}

$effect(() => {
	loading = true;
	error = "";
	sdk.explore
		.spaces()
		.then((result) => {
			sections = result.sections ?? [];
			spaces = result.spaces ?? [];
		})
		.catch((err) => {
			error = err instanceof Error ? err.message : "Failed to load Explore";
		})
		.finally(() => {
			loading = false;
		});
});
</script>

<svelte:head>
	<title>Explore — Cohub</title>
</svelte:head>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
	<PageHeader>
		{#snippet left()}
			<div class="flex min-w-0 items-center gap-2">
				<Sparkles class="h-4 w-4 text-brand" />
				<div class="min-w-0">
					<div class="text-[13px] font-medium text-text-primary lg:text-text-secondary">Explore</div>
					<div class="hidden text-[11px] text-text-tertiary lg:block">Curated public spaces</div>
				</div>
			</div>
		{/snippet}
	</PageHeader>

	<div class="flex-1 overflow-y-auto px-3 py-5 sm:px-6 sm:py-8 lg:px-8">
		<div class:wall-shell={activeView === "wall"} class="mx-auto flex w-full max-w-6xl flex-col gap-6 lg:gap-8">
			<section class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
				<div class="max-w-3xl">
					<div class="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-placeholder">Public spaces</div>
					<h1 class="mt-2 text-[clamp(2rem,3vw,3.25rem)] font-semibold tracking-tight text-text-primary">Explore spaces with intent</h1>
					<p class="mt-3 max-w-2xl text-[13px] leading-6 text-text-tertiary sm:text-[14px] sm:leading-7">Discover carefully surfaced spaces, scan the owner profile first, then jump into the workspace when it feels worth opening.</p>
				</div>

				<div class="inline-flex w-fit rounded-full border border-border-subtle bg-bg-surface p-1 text-[12px] font-medium text-text-tertiary lg:mt-2 lg:shrink-0" role="tablist" aria-label="Explore view">
					<a
						href="/explore"
						class="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/70"
						class:bg-bg-primary={activeView !== "wall"}
						class:text-text-primary={activeView !== "wall"}
						class:text-text-tertiary={activeView === "wall"}
						aria-selected={activeView !== "wall"}
						role="tab"
					>
						<LayoutList class="h-3.5 w-3.5" /> List
					</a>
					<a
						href="/explore?view=wall"
						class="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/70"
						class:bg-brand-bg={activeView === "wall"}
						class:text-brand={activeView === "wall"}
						class:text-text-tertiary={activeView !== "wall"}
						aria-selected={activeView === "wall"}
						role="tab"
					>
						<Grid2X2 class="h-3.5 w-3.5" /> Wall
					</a>
				</div>
			</section>

			{#if loading}
				<div class="flex items-center gap-2 rounded-[14px] border border-border-subtle bg-bg-surface px-4 py-4 text-[13px] text-text-tertiary">
					<Loader2 class="h-4 w-4 animate-spin" />
					Loading spaces…
				</div>
			{:else if error}
				<div class="rounded-[14px] border border-error-soft/30 bg-error-bg px-4 py-4 text-[13px] text-error-soft">{error}</div>
			{:else if spaces.length === 0}
				<div class="rounded-[14px] border border-border-subtle bg-bg-surface p-6">
					<div class="text-[15px] font-medium text-text-primary">No spaces listed yet</div>
					<p class="mt-1 text-[13px] text-text-tertiary">Explore is ready. Add public spaces to <code class="font-mono text-text-secondary">platform/.cohub/explore.json</code> to feature them here.</p>
				</div>
			{:else if activeView === "wall"}
				<section class="space-y-4" aria-label="Explore wall">
					<div class="flex items-center justify-between gap-3 border-y border-border-subtle py-2 text-[11px] text-text-tertiary">
						<span>{spaces.length} curated spaces</span>
						<span class="hidden sm:inline">Native masonry view · Cohub routes</span>
					</div>
					<div class="explore-wall columns-2 gap-2 sm:gap-3 lg:columns-5 2xl:columns-6">
						{#each spaces as item, index (item.id)}
							<a
								href={getSpaceHref(item)}
								class="group mb-2 block break-inside-avoid overflow-hidden rounded-[16px] border border-border-subtle bg-bg-surface transition-[border-color,transform,background-color] duration-200 hover:-translate-y-0.5 hover:border-border-primary hover:bg-bg-hover/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary sm:mb-3"
								aria-label={`${getTitle(item)} · ${item.accessLabel}`}
								data-sveltekit-preload-data="hover"
							>
								<div class={`relative overflow-hidden ${getWallRatio(index)} ${getWallTone(index)}`}>
									{#if item.coverUrl}
										<img
											src={item.coverUrl}
											alt={item.coverAlt ?? ""}
											class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.025]"
											loading={index < 10 ? "eager" : "lazy"}
											decoding="async"
										/>
									{:else}
										<div class="flex h-full w-full flex-col justify-between p-3">
											<div class="flex h-9 w-9 items-center justify-center rounded-xl border border-border-subtle bg-bg-surface/60 text-[12px] font-semibold text-text-secondary">{getInitials(item.title)}</div>
											<div class="space-y-2">
												<div class="h-px w-2/3 bg-border-subtle"></div>
												<div class="h-px w-1/2 bg-border-subtle"></div>
											</div>
										</div>
									{/if}
									<div class="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-bg-primary/80 via-bg-primary/20 to-transparent opacity-80"></div>
									{#if getPrimaryMeta(item)}
										<span class="absolute left-2 top-2 rounded-full border border-border-subtle bg-bg-primary/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-text-secondary backdrop-blur-sm">{getPrimaryMeta(item)}</span>
									{/if}
								</div>
								<div class="space-y-2 p-3">
									<h2 class="line-clamp-2 text-[13px] font-semibold leading-4 tracking-tight text-text-primary">{getTitle(item)}</h2>
									<div class="flex items-center gap-2 text-[11px] text-text-tertiary">
										{#if item.ownerAvatarUrl}
											<img src={item.ownerAvatarUrl} alt="" class="h-4 w-4 rounded-full object-cover" loading="lazy" decoding="async" />
										{/if}
										<span class="truncate">{getSecondaryMeta(item)}</span>
									</div>
								</div>
							</a>
						{/each}
					</div>
				</section>
			{:else}
				<div class="space-y-8">
					{#each displaySections as section (section.key)}
						{#if section.spaces.length > 0}
							<section class="space-y-4">
								{#if section.title || section.subtitle || section.description}
									<div class="max-w-3xl">
										{#if section.subtitle}
											<div class="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-placeholder">{section.subtitle}</div>
										{/if}
										{#if section.title}
											<h2 class="mt-1 text-[18px] font-semibold tracking-tight text-text-primary sm:text-[20px]">{section.title}</h2>
										{/if}
										{#if section.description}
											<p class="mt-1 max-w-2xl text-[13px] leading-6 text-text-tertiary">{section.description}</p>
										{/if}
									</div>
								{/if}

								<div class="grid gap-3 sm:gap-4">
									{#each section.spaces as item (item.id)}
										{@const primaryMeta = getPrimaryMeta(item)}
										<a
											href={getSpaceHref(item)}
											class="group block rounded-[18px] border border-border-subtle bg-bg-surface px-4 py-4 transition-[border-color,background-color,transform] duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:bg-bg-hover/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary sm:px-5 sm:py-5"
											data-sveltekit-preload-data="hover"
										>
											<div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
												<div class="flex min-w-0 flex-1 items-start gap-3">
													<div class="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-[14px] border border-border-subtle bg-bg-primary text-[13px] font-semibold text-text-tertiary">
														{#if item.coverUrl}
															<img src={item.coverUrl} alt="" class="h-full w-full object-cover" loading="lazy" decoding="async" />
														{:else}
															{getInitials(item.title)}
														{/if}
													</div>
													<div class="min-w-0 flex-1">
														<div class="flex flex-wrap items-center gap-2">
															<h3 class="truncate text-[16px] font-semibold tracking-tight text-text-primary sm:text-[17px]">{getTitle(item)}</h3>
															{#if primaryMeta}
																<span class="rounded-full border border-border-subtle bg-bg-primary px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-text-tertiary">{primaryMeta}</span>
															{/if}
														</div>
														<div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-text-tertiary">
															{#if item.ownerDisplayName}
																<span class="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-bg-primary/70 px-2 py-1 text-[11px] text-text-secondary">
																	<span class="flex h-4 w-4 items-center justify-center overflow-hidden rounded-full bg-bg-hover-strong text-[8px] font-semibold text-text-tertiary">
																		{#if item.ownerAvatarUrl}
																			<img src={item.ownerAvatarUrl} alt="" class="h-full w-full object-cover" />
																		{:else}
																			{getInitials(item.ownerDisplayName)}
																		{/if}
																	</span>
																	<span class="truncate">{item.ownerDisplayName}</span>
																</span>
															{/if}
															<span class="inline-flex items-center gap-1"><FolderKanban class="h-3.5 w-3.5" /> {item.accessLabel === "public" ? "Public" : "Sign-in required"}</span>
														</div>
														{#if item.summary}
															<p class="mt-3 max-w-3xl text-[13px] leading-6 text-text-tertiary sm:text-[14px]">{item.summary}</p>
														{/if}
														<div class="mt-4 flex flex-wrap items-center gap-2">
															<span class="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg-primary px-2.5 py-1 text-[11px] text-text-secondary"><Pin class="h-3.5 w-3.5 text-text-tertiary" /> {formatCount(item.assetCount)}</span>
															<span class="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg-primary px-2.5 py-1 text-[11px] text-text-secondary"><Save class="h-3.5 w-3.5 text-text-tertiary" /> {formatCount(item.skillCount)}</span>
															<span class="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg-primary px-2.5 py-1 text-[11px] text-text-secondary"><GitFork class="h-3.5 w-3.5 text-text-tertiary" /> {formatCount(item.forkCount)}</span>
														</div>
													</div>
												</div>

												<div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4 text-[11px] text-text-tertiary">
													<div class="flex flex-wrap items-center gap-2">
														{#if item.latestSignal}
															<span class="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg-primary/70 px-2 py-1"><Sparkles class="h-3.5 w-3.5" /> Latest save: {item.latestSignal}</span>
														{/if}
													</div>
													<span class="inline-flex items-center gap-1 font-medium text-text-secondary transition-colors group-hover:text-brand">Open <span aria-hidden="true">→</span></span>
												</div>
											</div>
										</a>
									{/each}
								</div>
							</section>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.wall-shell {
		max-width: 96rem;
	}

	.explore-wall {
		column-fill: balance;
	}

	.wall-ratio-a {
		aspect-ratio: 4 / 5;
	}
	.wall-ratio-b {
		aspect-ratio: 3 / 4;
	}
	.wall-ratio-c {
		aspect-ratio: 5 / 7;
	}
	.wall-ratio-d {
		aspect-ratio: 1 / 1;
	}
	.wall-ratio-e {
		aspect-ratio: 4 / 6;
	}

	.wall-tone-a {
		background: color-mix(in srgb, var(--brand-bg) 45%, var(--bg-surface));
	}
	.wall-tone-b {
		background: color-mix(in srgb, var(--bg-hover) 70%, var(--bg-surface));
	}
	.wall-tone-c {
		background: color-mix(in srgb, var(--bg-elevated) 80%, var(--brand-bg));
	}
	.wall-tone-d {
		background: color-mix(in srgb, var(--bg-primary) 65%, var(--border-subtle));
	}
	.wall-tone-e {
		background: color-mix(in srgb, var(--bg-surface) 78%, var(--brand-muted));
	}
	.wall-tone-f {
		background: color-mix(in srgb, var(--bg-hover-strong) 45%, var(--bg-surface));
	}
</style>
