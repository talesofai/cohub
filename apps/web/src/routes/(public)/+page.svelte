<script lang="ts">
import { ArrowRight } from "lucide-svelte";
import { onMount } from "svelte";
import { browser } from "$app/environment";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { hasLocalSessionHint, signInWithRedirectPath } from "$lib/auth";
import LandingConcepts from "$lib/components/landing/LandingConcepts.svelte";
import LandingIdeaArt from "$lib/components/landing/LandingIdeaArt.svelte";
import LandingSpaceDemo from "$lib/components/landing/LandingSpaceDemo.svelte";
import PublicHeader from "$lib/components/PublicHeader.svelte";
import { sdk } from "$lib/sdk";
import { canonicalUrl as buildCanonical } from "$lib/seo";
import { buildSpaceLandingRoute } from "$lib/space-routes";
import { authStore } from "$lib/stores/auth.svelte";
import { getRecentSpace } from "$lib/stores/recent-space";
import {
	getCachedSpaceList,
	setCachedSpaceList,
} from "$lib/stores/space-list-cache";
import { getResolvedTheme } from "$lib/theme.svelte";

// Home marketing is always dark (app.html also forces it for first paint).
if (browser) {
	document.documentElement.setAttribute("data-theme", "dark");
}

/**
 * SSR always emits marketing HTML (SEO / no-JS).
 * Client: FOUC script may set data-home-redirect; we adopt that for UI state
 * without changing SSR markup structure (overlay + visibility, not if/else).
 */
function initialRedirectIntent(): boolean {
	if (!browser) return false;
	if (document.documentElement.getAttribute("data-home-redirect") === "1") {
		return true;
	}
	return hasLocalSessionHint();
}

let redirecting = $state(initialRedirectIntent());

const canonical = $derived(buildCanonical(page.url.origin, "/"));

function clearHomeRedirectAttr() {
	if (!browser) return;
	document.documentElement.removeAttribute("data-home-redirect");
}

async function handlePrimaryCta() {
	try {
		await authStore.ensureLoaded(true);
		if (authStore.isAuthenticated) {
			await goto("/spaces/new");
			return;
		}
		await signInWithRedirectPath("/spaces/new");
	} catch (error) {
		console.error("[home] Failed to start Cohub:", error);
	}
}

async function resolveHomeDestination(): Promise<string> {
	const userKey = authStore.userUuid;
	if (userKey) {
		const recent = getRecentSpace(userKey);
		if (recent?.spaceId) return buildSpaceLandingRoute(recent.spaceId);
	}

	const cached = getCachedSpaceList();
	if (cached?.[0]?.id) return buildSpaceLandingRoute(cached[0].id);

	try {
		const spaces = setCachedSpaceList(await sdk.spaces.list());
		const defaultResult = await sdk.spaces.getDefault().catch(() => null);
		const targetSpace = defaultResult?.space ?? spaces[0] ?? null;
		if (targetSpace) return buildSpaceLandingRoute(targetSpace.id);
	} catch {
		// Authenticated with no reachable space → create flow.
	}

	return "/spaces/new";
}

onMount(() => {
	// Keep dark while on home; restore visitor theme when leaving.
	document.documentElement.setAttribute("data-theme", "dark");

	void (async () => {
		const maybeSession = redirecting || hasLocalSessionHint();
		if (!maybeSession) {
			clearHomeRedirectAttr();
			// Warm auth so Start is snappy; don't block marketing paint.
			void authStore.ensureLoaded(true);
			return;
		}

		redirecting = true;
		document.documentElement.setAttribute("data-home-redirect", "1");
		try {
			await authStore.ensureLoaded(true);
			if (!authStore.isAuthenticated) {
				redirecting = false;
				clearHomeRedirectAttr();
				return;
			}
			const dest = await resolveHomeDestination();
			await goto(dest);
		} catch (error) {
			console.warn("[home] Session redirect failed:", error);
			redirecting = false;
			clearHomeRedirectAttr();
		}
	})();

	return () => {
		document.documentElement.setAttribute("data-theme", getResolvedTheme());
	};
});

/**
 * Reveal-on-scroll action. Adds `.in-view` when the element first enters the
 * viewport, then unobserves. Honors reduced-motion by revealing immediately.
 */
function reveal(node: HTMLElement) {
	if (!browser) return;
	const prefersReduced = window.matchMedia(
		"(prefers-reduced-motion: reduce)",
	).matches;
	if (prefersReduced || typeof IntersectionObserver === "undefined") {
		node.classList.add("in-view");
		return;
	}
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					entry.target.classList.add("in-view");
					observer.unobserve(entry.target);
				}
			}
		},
		{ threshold: 0.16, rootMargin: "0px 0px -8% 0px" },
	);
	observer.observe(node);
	return { destroy: () => observer.disconnect() };
}

// Static marketing content — no dynamic data.
const mediums = ["Text", "Images", "Video", "Music", "Code & apps"];

const ideas = [
	{
		num: "01",
		title: "Fun to start",
		body: "Open a Space and play with ideas, prompts, files, and agents. No setup, no blank-page dread — just start typing and watch things take shape.",
		kind: "spark" as const,
	},
	{
		num: "02",
		title: "Build together",
		body: "People and agents share one context. Everyone sees the same conversation, files, and tool calls in realtime — co-create, save, and share without losing the thread.",
		kind: "build" as const,
	},
	{
		num: "03",
		title: "Open everywhere",
		body: "Web, mobile, CLI, Discord, WeChat, Feishu. The Space follows you — talk from any channel and the agent replies back through the same one.",
		kind: "open" as const,
	},
	{
		num: "04",
		title: "Powerful for real work",
		body: "Games, apps, media, automations — from playful to production. Preview a running app in the workspace, then publish it as a public Work with one click.",
		kind: "work" as const,
	},
	{
		num: "05",
		title: "Never start blank",
		body: "Fork a checkpoint into a new Space, or reference any Space with @space as context. Every project stands on the shoulders of another.",
		kind: "fork" as const,
	},
];
</script>

<svelte:head>
	<title>Cohub — create, play, and build with people and agents</title>
	<meta
		name="description"
		content="A living Space for people and agents to create, play, and build together. Start anywhere, make in any medium, share as Works."
	/>
	<link rel="canonical" href={canonical} />
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content="Cohub" />
	<meta property="og:title" content="Cohub — create, play, and build with people and agents" />
	<meta
		property="og:description"
		content="A living Space for people and agents. Start anywhere, make in any medium, share as Works."
	/>
	<meta property="og:url" content={canonical} />
	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content="Cohub — create, play, and build with people and agents" />
	<meta
		name="twitter:description"
		content="A living Space for people and agents. Start anywhere, make in any medium, share as Works."
	/>
</svelte:head>

<div class="relative min-h-screen">
	<!-- Always in DOM for crawlers; FOUC + redirecting hide for returning users. -->
	<div
		class="home-marketing flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg-primary {redirecting
			? 'invisible pointer-events-none'
			: ''}"
		aria-hidden={redirecting ? "true" : undefined}
	>
		<!-- Ambient brand glow -->
		<div
			aria-hidden="true"
			class="pointer-events-none fixed inset-x-0 top-0 h-[480px] bg-[radial-gradient(circle_at_18%_-8%,color-mix(in_srgb,var(--brand)_14%,transparent),transparent_55%)]"
		></div>

		<!-- Header -->
		<PublicHeader sticky cta="start" onStart={handlePrimaryCta} />

		<main class="relative flex-1">
			<!-- Hero -->
			<section class="relative overflow-hidden">
				<div
					class="mx-auto grid w-full max-w-6xl items-center gap-11 px-5 pb-20 pt-12 sm:px-8 sm:pt-16 lg:grid-cols-[1.02fr_0.98fr] lg:gap-14 lg:pb-24 lg:pt-24"
				>
					<div class="relative max-w-xl">
						<div
							class="rise rise-1 inline-flex items-center gap-2 rounded-full border border-brand-border bg-brand-muted px-3 py-1 text-[11px] font-medium text-brand"
						>
							<span class="live-dot h-1.5 w-1.5 rounded-full bg-brand"></span>
							people + agents welcome
						</div>
						<h1
							class="rise rise-2 mt-6 text-[clamp(2.3rem,5.6vw,3.9rem)] font-semibold leading-[0.99] tracking-[-0.04em] text-text-primary"
						>
							Your own space to <span class="accent">create</span>, play, and build with people and
							agents.
						</h1>
						<p class="rise rise-3 mt-5 max-w-md text-[15px] leading-7 text-text-tertiary sm:text-[16px]">
							A living Space where people and agents work in one context. Start anywhere, make in
							any medium, save the moments that matter, and share them as Works.
						</p>
						<div class="rise rise-4 mt-8 flex flex-wrap items-center gap-x-4 gap-y-3">
							<button
								type="button"
								onclick={handlePrimaryCta}
								class="cta-btn group inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-brand px-5 py-3 text-[13px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover"
							>
								Start a Space
								<ArrowRight class="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
							</button>
							<span class="inline-flex items-center gap-2 text-[12.5px] text-text-placeholder">
								or reference any space with
								<code
									class="rounded-[5px] border border-border-subtle bg-bg-code px-1.5 py-0.5 font-mono text-[11.5px] text-text-secondary"
									>@space</code
								>
							</span>
						</div>
					</div>

					<div class="rise rise-5 relative lg:pt-2">
						<LandingSpaceDemo />
					</div>
				</div>
			</section>

			<!-- Medium strip -->
			<section class="border-y border-border-subtle">
				<div
					class="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-8 gap-y-3.5 px-5 py-5 sm:px-8"
				>
					<span
						class="text-[11px] font-medium uppercase tracking-[0.14em] text-text-placeholder"
						>Make in any medium</span
					>
					<div class="flex flex-wrap gap-2.5">
						{#each mediums as medium (medium)}
							<span
								class="medium-chip inline-flex items-center gap-2 rounded-full border border-border-subtle bg-[color-mix(in_srgb,var(--bg-surface)_45%,transparent)] px-3 py-1.5 text-[13px] text-text-secondary"
							>
								<span class="h-1.5 w-1.5 rounded-full bg-brand"></span>
								{medium}
							</span>
						{/each}
					</div>
				</div>
			</section>

			<!-- Ideas -->
			<section class="mx-auto w-full max-w-6xl px-5 pb-4 pt-20 sm:px-8 lg:pt-24">
				<div class="max-w-2xl">
					<div class="text-[12px] font-semibold uppercase tracking-[0.16em] text-brand">
						One surface, from play to production
					</div>
					<h2
						class="mt-3 text-[clamp(1.7rem,3.2vw,2.5rem)] font-semibold leading-tight tracking-[-0.03em] text-text-primary"
					>
						Everything happens inside a Space.
					</h2>
					<p class="mt-3.5 max-w-xl text-[15px] leading-7 text-text-tertiary">
						A Space is a live, isolated environment where people and agents create together —
						conversations, files, generations, previews, and automations in one place.
					</p>
				</div>

				<div class="mt-8 flex flex-col gap-6 sm:gap-2">
					{#each ideas as idea, index (idea.title)}
						<div
							use:reveal
							class="reveal-row grid items-center gap-9 py-8 lg:grid-cols-2 lg:gap-14 lg:py-10"
						>
							<div class={index % 2 === 1 ? "lg:order-2" : ""}>
								<span class="font-mono text-[12px] text-brand">{idea.num}</span>
								<h3
									class="mt-1.5 text-[clamp(1.4rem,2.3vw,1.9rem)] font-semibold tracking-[-0.02em] text-text-primary"
								>
									{idea.title}
								</h3>
								<p class="mt-3 max-w-md text-[15px] leading-7 text-text-tertiary">
									{#if idea.kind === "fork"}
										Fork a checkpoint into a new Space, or reference any Space with
										<code
											class="rounded-[5px] bg-brand-muted px-1.5 py-0.5 font-mono text-[0.92em] text-brand"
											>@space</code
										> as context. Every project stands on the shoulders of another.
									{:else}
										{idea.body}
									{/if}
								</p>
							</div>
							<div class={index % 2 === 1 ? "lg:order-1" : ""}>
								<LandingIdeaArt kind={idea.kind} />
							</div>
						</div>
					{/each}
				</div>
			</section>

			<!-- Concepts -->
			<section class="mx-auto w-full max-w-6xl px-5 pb-8 pt-20 sm:px-8 lg:pt-24">
				<div class="mx-auto max-w-2xl text-center">
					<div class="text-[12px] font-semibold uppercase tracking-[0.16em] text-brand">
						The mental model
					</div>
					<h2
						class="mt-3 text-[clamp(1.7rem,3.2vw,2.5rem)] font-semibold leading-tight tracking-[-0.03em] text-text-primary"
					>
						A few ideas, endlessly composable.
					</h2>
					<p class="mt-3.5 text-[15px] leading-7 text-text-tertiary">
						Cohub is built around one idea: people create in Spaces, and useful context gets saved
						as Checkpoints.
					</p>
				</div>
				<div use:reveal class="reveal-row mt-9">
					<LandingConcepts />
				</div>
			</section>

			<!-- CTA -->
			<section class="mx-auto w-full max-w-6xl px-5 pb-24 pt-12 sm:px-8 lg:pb-32">
				<div use:reveal class="cta-card reveal-row relative overflow-hidden rounded-[24px] px-6 py-12 sm:px-12 sm:py-14">
					<div class="relative max-w-2xl">
						<h2
							class="text-[clamp(1.7rem,3.4vw,2.6rem)] font-semibold tracking-[-0.03em] text-brand-contrast-fg"
						>
							Start in seconds. Stay for the context.
						</h2>
						<p
							class="mt-3.5 text-[16px] leading-7 text-[color-mix(in_srgb,var(--brand-contrast-fg)_88%,transparent)]"
						>
							One Space to play, build, and share — with people and agents, from anywhere.
						</p>
						<div class="mt-8">
							<button
								type="button"
								onclick={handlePrimaryCta}
								class="cta-btn cta-btn-invert group inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-brand-contrast-fg px-5 py-3 text-[13px] font-medium text-brand transition hover:brightness-95"
							>
								Start a Space
								<ArrowRight class="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
							</button>
						</div>
					</div>
				</div>
			</section>
		</main>

		<!-- Footer -->
		<footer class="border-t border-border-subtle">
			<div class="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8">
				<div class="grid gap-10 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr]">
					<div>
						<a href="/" class="inline-flex items-center gap-2.5">
							<div
								class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-bg-surface text-[14px] font-semibold text-brand"
							>
								C
							</div>
							<span class="text-[15px] font-semibold tracking-tight text-text-primary"
								>Cohub</span
							>
						</a>
						<p class="mt-4 max-w-xs text-[13px] leading-6 text-text-tertiary">
							A shared creative space for people and agents to create, save, share, and build from
							real context.
						</p>
					</div>

					<div>
						<div class="text-[11px] font-medium uppercase tracking-[0.14em] text-text-placeholder">
							Product
						</div>
						<ul class="mt-4 space-y-2.5 text-[13px]">
							<li>
								<a href="/explore" class="text-text-secondary transition-colors hover:text-text-primary">Explore</a>
							</li>
							<li>
								<a href="/pricing" class="text-text-secondary transition-colors hover:text-text-primary">Pricing</a>
							</li>
							<li>
								<a href="/changelog" class="text-text-secondary transition-colors hover:text-text-primary">Changelog</a>
							</li>
						</ul>
					</div>

					<div>
						<div class="text-[11px] font-medium uppercase tracking-[0.14em] text-text-placeholder">
							Discover
						</div>
						<ul class="mt-4 space-y-2.5 text-[13px]">
							<li>
								<a href="/trending" class="text-text-secondary transition-colors hover:text-text-primary">Trending</a>
							</li>
							<li>
								<a href="/explore?view=wall" class="text-text-secondary transition-colors hover:text-text-primary">Spaces wall</a>
							</li>
						</ul>
					</div>

					<div>
						<div class="text-[11px] font-medium uppercase tracking-[0.14em] text-text-placeholder">
							Contact
						</div>
						<ul class="mt-4 space-y-2.5 text-[13px]">
							<li>
								<a
									href="mailto:dev@talesof.ai"
									class="text-text-secondary transition-colors hover:text-text-primary"
									>dev@talesof.ai</a
								>
							</li>
						</ul>
					</div>
				</div>
				<div
					class="mt-12 flex flex-col items-start justify-between gap-3 border-t border-border-subtle pt-6 text-[12px] text-text-tertiary sm:flex-row sm:items-center"
				>
					<span>© 2026 Cohub. All rights reserved.</span>
				</div>
			</div>
		</footer>
	</div>

	<!--
	  Always mounted so FOUC (data-home-redirect) can show it before hydration.
	  No crawlable copy — spinner only. Hidden unless redirecting / FOUC attr.
	-->
	<div
		class="home-redirect-shell absolute inset-0 z-50 min-h-screen items-center justify-center bg-bg-primary {redirecting
			? 'flex'
			: 'hidden'}"
		role="status"
		aria-live="polite"
		aria-busy={redirecting ? "true" : undefined}
		aria-hidden={redirecting ? undefined : "true"}
	>
		<span
			class="h-5 w-5 animate-spin rounded-full border-2 border-border-subtle border-t-brand"
			aria-label="Loading"
		></span>
	</div>
</div>

<style>
	/* Pre-hydration: app.html sets data-home-redirect when a session may exist. */
	:global(html[data-home-redirect="1"] .home-marketing) {
		visibility: hidden;
		pointer-events: none;
	}
	:global(html[data-home-redirect="1"] .home-redirect-shell) {
		display: flex !important;
	}
	@keyframes live-pulse {
		0%,
		100% {
			opacity: 1;
			transform: scale(1);
		}
		50% {
			opacity: 0.4;
			transform: scale(0.8);
		}
	}
	.live-dot {
		animation: live-pulse 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite;
	}

	@media (prefers-reduced-motion: no-preference) {
		.rise {
			opacity: 0;
			transform: translateY(10px);
			animation: rise-in 0.7s cubic-bezier(0.22, 0.61, 0.36, 1) forwards;
		}
		.rise-1 {
			animation-delay: 0.05s;
		}
		.rise-2 {
			animation-delay: 0.12s;
		}
		.rise-3 {
			animation-delay: 0.19s;
		}
		.rise-4 {
			animation-delay: 0.26s;
		}
		.rise-5 {
			animation-delay: 0.33s;
		}
	}
	@keyframes rise-in {
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.live-dot {
			animation: none;
		}
		.rise {
			opacity: 1;
			transform: none;
			animation: none;
		}
	}

	/* Brand highlight on the hero headline — soft gradient underline. */
	.accent {
		position: relative;
		color: var(--brand);
		white-space: nowrap;
	}
	.accent::after {
		content: "";
		position: absolute;
		left: -0.04em;
		right: -0.04em;
		bottom: 0.08em;
		z-index: -1;
		height: 0.26em;
		border-radius: 999px;
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--brand) 26%, transparent),
			color-mix(in srgb, var(--brand) 10%, transparent)
		);
	}

	/* Scroll-reveal for idea rows, concepts, and CTA. */
	@media (prefers-reduced-motion: no-preference) {
		.reveal-row {
			opacity: 0;
			transform: translateY(18px);
			transition:
				opacity 0.6s cubic-bezier(0.22, 0.61, 0.36, 1),
				transform 0.6s cubic-bezier(0.22, 0.61, 0.36, 1);
		}
		.reveal-row:global(.in-view) {
			opacity: 1;
			transform: none;
		}
	}

	/* Keyboard focus rings on primary CTAs. */
	.cta-btn:focus-visible {
		outline: none;
		box-shadow:
			0 0 0 2px var(--bg-primary),
			0 0 0 4px var(--brand);
	}
	.cta-btn-invert:focus-visible {
		box-shadow:
			0 0 0 2px var(--brand),
			0 0 0 4px var(--brand-contrast-fg);
	}

	/* Medium chips — subtle hover lift. */
	.medium-chip {
		transition:
			border-color 0.2s,
			color 0.2s,
			transform 0.2s;
	}
	.medium-chip:hover {
		transform: translateY(-2px);
		border-color: var(--brand-border);
		color: var(--text-primary);
	}
	@media (prefers-reduced-motion: reduce) {
		.medium-chip:hover {
			transform: none;
		}
	}

	/* Final CTA gradient card. */
	.cta-card {
		background: linear-gradient(135deg, var(--brand), oklch(52% 0.2 40));
		box-shadow: 0 40px 90px -50px var(--brand);
	}
	.cta-card::before {
		content: "";
		position: absolute;
		inset: 0;
		pointer-events: none;
		background:
			radial-gradient(60% 120% at 90% 0%, rgba(255, 255, 255, 0.16), transparent 55%),
			radial-gradient(50% 100% at 0% 100%, rgba(0, 0, 0, 0.16), transparent 60%);
	}
</style>
