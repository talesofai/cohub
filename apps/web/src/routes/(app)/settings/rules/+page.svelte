<script lang="ts">
import type { SpaceRecord } from "@neta-art/cohub";
import {
	ArrowUpRight,
	CheckCircle2,
	FileText,
	Loader2,
	Plus,
	RefreshCw,
	ShieldAlert,
} from "lucide-svelte";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { ensureAuth } from "$lib/auth";
import { handleUnauthorizedError } from "$lib/auth-redirect";
import { sdk } from "$lib/sdk";
import { buildSpaceLandingRoute } from "$lib/space-routes";
import { authStore } from "$lib/stores/auth.svelte";
import { billingConversion } from "$lib/stores/billing-conversion.svelte";
import { setCachedSpaceList } from "$lib/stores/space-list-cache";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";

const currentPath = $derived(page.url.pathname);
const currentSearch = $derived(page.url.search);

let userUuid = $state("");
let rulesContent = $state("");
let updatedAt = $state<string | null>(null);
let configSpace = $state<SpaceRecord | null>(null);
let isLoading = $state(true);
let isCreating = $state(false);
let loadError = $state("");
let actionMessage = $state("");

const hasPublishedRules = $derived(rulesContent.trim().length > 0);

function formatUpdatedAt(value: string | null) {
	if (!value) return "Not published yet";
	try {
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(new Date(value));
	} catch {
		return value;
	}
}

function findConfigSpace(spaces: SpaceRecord[]) {
	return (
		spaces.find(
			(space) =>
				space.name === "config" && authStore.matchesUserId(space.userUuid),
		) ?? null
	);
}

async function loadRulesPage() {
	if (!(await ensureAuth({ redirectPath: `${currentPath}${currentSearch}` })))
		return;
	isLoading = true;
	loadError = "";
	actionMessage = "";
	try {
		await authStore.ensureLoaded();
		userUuid = authStore.userUuid ?? "";
		const [rules, spacesResult] = await Promise.all([
			sdk.user.getRules(),
			sdk.spaces.list(),
		]);
		const spaces = setCachedSpaceList(spacesResult);
		rulesContent = rules.content;
		updatedAt = rules.updatedAt;
		configSpace = userUuid ? findConfigSpace(spaces) : null;
	} catch (error) {
		if (
			await handleUnauthorizedError(error, `${currentPath}${currentSearch}`)
		) {
			return;
		}
		loadError =
			error instanceof Error ? error.message : "Failed to load user rules";
	} finally {
		isLoading = false;
	}
}

async function createConfigSpace() {
	if (isCreating) return;
	isCreating = true;
	actionMessage = "";
	try {
		const result = await sdk.spaces.create({
			name: "config",
			description:
				"Personal Cohub configuration. Edit AGENTS.md here, then create a Save to publish user rules.",
		});
		cacheSpaceRecordSoon(result.space);
		configSpace = result.space;
		actionMessage = "Config Space created";
		await goto(buildSpaceLandingRoute(result.space.id));
	} catch (error) {
		if (
			await handleUnauthorizedError(error, `${currentPath}${currentSearch}`)
		) {
			return;
		}
		if (billingConversion.handleHttpError(error)) return;
		actionMessage =
			error instanceof Error ? error.message : "Failed to create config Space";
	} finally {
		isCreating = false;
	}
}

function openConfigSpace() {
	if (!configSpace) return;
	void goto(buildSpaceLandingRoute(configSpace.id));
}

onMount(() => {
	void loadRulesPage();
});
</script>

<svelte:head>
	<title>User rules — Cohub</title>
</svelte:head>

<div class="flex-1 flex flex-col min-h-0 overflow-y-auto">
  <div class="flex-1 p-6 overflow-y-auto">
    <section class="max-w-3xl">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 class="text-[18px] font-semibold text-text-primary tracking-tight">User Rules</h1>
          <p class="mt-1 text-[13px] text-text-tertiary max-w-2xl leading-5">
            User Rules are published from your personal <span class="font-mono text-text-secondary">config</span> Space and automatically included in every new Chat context.
          </p>
          <ol class="mt-2 space-y-1 text-[13px] text-text-tertiary max-w-2xl leading-5">
            <li><span class="font-medium text-text-secondary">1.</span> Open or create your personal <span class="font-mono text-text-secondary">config</span> Space.</li>
            <li><span class="font-medium text-text-secondary">2.</span> Create or edit <span class="font-mono text-text-secondary">AGENTS.md</span>.</li>
            <li><span class="font-medium text-text-secondary">3.</span> Create a Save to publish it into every new Chat context.</li>
          </ol>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onclick={loadRulesPage}
            class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[5px] border border-border-subtle bg-bg-surface text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50"
            disabled={isLoading || isCreating}
          >
            <RefreshCw class="w-3.5 h-3.5" />
            Refresh
          </button>
          {#if configSpace}
            <button
              type="button"
              onclick={openConfigSpace}
              class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[5px] bg-brand-muted border border-brand-border text-brand text-[12px] font-medium hover:bg-brand-muted-hover transition-colors"
            >
              <ArrowUpRight class="w-3.5 h-3.5" />
              Open config Space
            </button>
          {:else}
            <button
              type="button"
              onclick={createConfigSpace}
              class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[5px] bg-brand-muted border border-brand-border text-brand text-[12px] font-medium hover:bg-brand-muted-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isLoading || isCreating}
            >
              {#if isCreating}
                <Loader2 class="w-3.5 h-3.5 animate-spin" />
              {:else}
                <Plus class="w-3.5 h-3.5" />
              {/if}
              Create config Space
            </button>
          {/if}
        </div>
      </div>

      <div class="mt-5 rounded-md border border-warning-bg bg-warning-bg p-3 flex gap-2.5">
        <ShieldAlert class="w-4 h-4 text-warning shrink-0 mt-0.5" />
        <p class="text-[12px] leading-5 text-text-tertiary">
          Do not put tokens, passwords, private keys, or sensitive personal data in User Rules. Published rules are sent to the model as part of the system context.
        </p>
      </div>

      {#if loadError}
        <div class="mt-6 rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{loadError}</div>
      {:else if isLoading}
        <div class="mt-6 space-y-3" aria-hidden="true">
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="h-16 rounded-md bg-bg-hover-strong"></div>
            <div class="h-16 rounded-md bg-bg-hover-strong"></div>
            <div class="h-16 rounded-md bg-bg-hover-strong"></div>
          </div>
          <div class="h-40 rounded-md bg-bg-hover-strong"></div>
        </div>
      {:else}
        <div class="mt-6 grid gap-3 sm:grid-cols-3">
          <div class="rounded-md border border-border-subtle bg-bg-surface p-3">
            <div class="text-[10px] uppercase tracking-[0.14em] text-text-placeholder">Config Space</div>
            <div class="mt-2 flex items-center gap-2 text-[13px] text-text-primary">
              {#if configSpace}
                <CheckCircle2 class="w-4 h-4 text-status-running" />
                <span class="font-medium">Ready</span>
              {:else}
                <FileText class="w-4 h-4 text-text-placeholder" />
                <span class="font-medium">Not created</span>
              {/if}
            </div>
          </div>
          <div class="rounded-md border border-border-subtle bg-bg-surface p-3">
            <div class="text-[10px] uppercase tracking-[0.14em] text-text-placeholder">Published File</div>
            <div class="mt-2 text-[13px] text-text-primary font-mono truncate">/configs/user/AGENTS.md</div>
          </div>
          <div class="rounded-md border border-border-subtle bg-bg-surface p-3">
            <div class="text-[10px] uppercase tracking-[0.14em] text-text-placeholder">Updated</div>
            <div class="mt-2 text-[13px] text-text-primary truncate">{formatUpdatedAt(updatedAt)}</div>
          </div>
        </div>

        {#if actionMessage}
          <div class={actionMessage.includes("Failed") ? "mt-3 text-[12px] text-error-soft" : "mt-3 text-[12px] text-status-running"}>{actionMessage}</div>
        {/if}

        <div class="mt-6 rounded-md border border-border-subtle bg-bg-surface overflow-hidden">
          <div class="flex items-center justify-between gap-3 px-3 py-2 border-b border-border-subtle bg-bg-header-alt">
            <div class="text-[12px] font-medium text-text-secondary">Published User Rules preview</div>
            <div class="text-[11px] text-text-tertiary">Read-only</div>
          </div>
          {#if hasPublishedRules}
            <pre class="max-h-[520px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-5 text-text-primary">{rulesContent}</pre>
          {:else}
            <div class="p-8 text-center">
              <div class="mx-auto w-11 h-11 rounded-md bg-bg-hover border border-border-subtle flex items-center justify-center mb-3">
                <FileText class="w-5 h-5 text-text-placeholder" />
              </div>
              <p class="text-[14px] text-text-tertiary">No published User Rules yet</p>
              <p class="text-[12px] text-text-placeholder mt-1 max-w-md mx-auto">
                {#if configSpace}
                  Open your config Space, create or edit AGENTS.md, then create a Save to publish it here.
                {:else}
                  Create a config Space first, then add AGENTS.md and create a Save to publish it here.
                {/if}
              </p>
            </div>
          {/if}
        </div>
      {/if}
    </section>
  </div>
</div>
