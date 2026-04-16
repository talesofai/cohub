<script lang="ts">
import { Sparkles, Plus, Loader2, ArrowRight } from "lucide-svelte";
import { getSpaces, type SpaceListItem } from "$lib/api";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { ensureAuth, logtoClient } from "$lib/auth";
import PageHeader from "$lib/components/PageHeader.svelte";

let spaces = $state<SpaceListItem[]>([]);
let isLoading = $state(true);
let loadError = $state("");

async function loadSpaces() {
  if (!(await ensureAuth())) return;
  isLoading = true;
  loadError = "";
  try {
    spaces = await getSpaces();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load spaces";
    if (message.includes("unauthorized") || message.includes("401")) {
      await logtoClient.signIn(`${window.location.origin}/callback`);
      return;
    }
    loadError = message;
  } finally {
    isLoading = false;
  }
}

onMount(() => {
  void loadSpaces();
});
</script>

<div class="flex-1 flex flex-col min-h-0 overflow-y-auto">
  <PageHeader>
    {#snippet left()}
      <span class="text-[13px] lg:text-[11px] font-medium text-text-primary lg:text-text-secondary">Spaces</span>
    {/snippet}
    {#snippet right()}
      <a
        href="/spaces/new"
        class="flex items-center gap-1.5 px-2.5 py-1 rounded-[5px] text-[12px] bg-[#FF3E00]/10 border border-[#FF3E00]/20 text-brand font-medium hover:bg-[#FF3E00]/15 transition-colors"
      >
        <Plus class="w-3.5 h-3.5" />
        New Space
      </a>
    {/snippet}
  </PageHeader>

  <div class="flex-1 p-4 overflow-y-auto">
    {#if isLoading}
      <div class="flex items-center justify-center py-12 text-[12px] text-text-tertiary">
        <div class="w-4 h-4 rounded-full border-2 border-border-subtle border-t-brand animate-spin mr-2"></div>
        Loading spaces...
      </div>
    {:else if loadError}
      <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{loadError}</div>
    {:else if spaces.length === 0}
      <div class="flex flex-col items-center justify-center py-16 text-center">
        <div class="w-11 h-11 rounded-md bg-bg-surface border border-border-subtle flex items-center justify-center mb-3">
          <Sparkles class="w-5 h-5 text-text-placeholder" />
        </div>
        <p class="text-[14px] text-text-tertiary">No spaces yet</p>
        <p class="text-[12px] text-text-placeholder mt-1">Create a space to start collaborating with sessions and files</p>
        <a href="/spaces/new" class="mt-4 px-3 py-1.5 rounded-[5px] bg-bg-surface hover:bg-bg-surface-hover border border-border-subtle text-[13px] text-text-secondary hover:text-text-primary transition-colors">
          Create your first space
        </a>
      </div>
    {:else}
      <div class="rounded-md border border-border-subtle overflow-hidden divide-y divide-border-subtle">
        {#each spaces as space}
          <a href="/spaces/{space.id}" class="block px-4 py-3 hover:bg-bg-hover transition-colors">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-md bg-brand/10 border border-brand/20 flex items-center justify-center shrink-0">
                <Sparkles class="w-4 h-4 text-brand" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="text-[13px] font-medium text-text-primary truncate">{space.name}</div>
                <div class="text-[11px] text-text-placeholder font-mono truncate">{space.id}</div>
                {#if space.description}
                  <div class="text-[12px] text-text-tertiary truncate mt-0.5">{space.description}</div>
                {/if}
              </div>
              <ArrowRight class="w-3.5 h-3.5 text-text-placeholder shrink-0" />
            </div>
          </a>
        {/each}
      </div>
    {/if}
  </div>
</div>
