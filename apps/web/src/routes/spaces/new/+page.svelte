<script lang="ts">
import { goto } from "$app/navigation";
import { onMount } from "svelte";
import { ArrowLeft, Plus, Loader2, Sparkles } from "lucide-svelte";
import {
  getChannels,
  createSpace,
  type Channel,
  type SpaceChannelBindingInput,
  type ChannelConfig,
  type DiscordChannelConfig,
  type SpaceEnvInput,
} from "$lib/api";
import { ensureAuth } from "$lib/auth";

let channels = $state<Channel[]>([]);
let isLoading = $state(true);
let isSubmitting = $state(false);
let loadError = $state("");
let submitError = $state("");

let name = $state("");
let description = $state("");
let selectedChannelIds = $state<string[]>([]);
let extraEnv = $state<SpaceEnvInput[]>([]);
let channelConfigById = $state<Record<string, ChannelConfig>>({});

const getDefaultChannelConfig = (channel: Channel): ChannelConfig => {
  if (channel.provider === "discord") {
    return {
      inbound: { requireMentionInGuild: false },
      outbound: { showThinking: true, showToolCalls: true },
    };
  }
  return {};
};

async function loadPage() {
  if (!(await ensureAuth())) return;
  isLoading = true;
  loadError = "";

  try {
    const channelsData = await getChannels();
    channels = channelsData;
    channelConfigById = Object.fromEntries(
      channelsData.map((ch) => [ch.id, getDefaultChannelConfig(ch)]),
    );
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load form data";
  } finally {
    isLoading = false;
  }
}

onMount(() => {
  void loadPage();
});

function toggleChannel(channelId: string, checked: boolean) {
  if (checked) {
    if (!selectedChannelIds.includes(channelId)) selectedChannelIds = [...selectedChannelIds, channelId];
    return;
  }
  selectedChannelIds = selectedChannelIds.filter((id) => id !== channelId);
}

function addEnvRow() {
  extraEnv = [...extraEnv, { name: "", value: "" }];
}

function removeEnvRow(index: number) {
  extraEnv = extraEnv.filter((_, idx) => idx !== index);
}

function updateEnvName(index: number, value: string) {
  extraEnv = extraEnv.map((item, idx) => idx === index ? { ...item, name: value } : item);
}

function updateEnvValue(index: number, value: string) {
  extraEnv = extraEnv.map((item, idx) => idx === index ? { ...item, value } : item);
}

function updateDiscordConfig(channelId: string, updater: (config: DiscordChannelConfig) => DiscordChannelConfig) {
  channelConfigById = {
    ...channelConfigById,
    [channelId]: updater((channelConfigById[channelId] ?? {}) as DiscordChannelConfig),
  };
}

async function handleSubmit(event: SubmitEvent) {
  event.preventDefault();
  if (!name.trim() || isSubmitting) return;

  submitError = "";
  isSubmitting = true;

  try {
    const channelBindings: SpaceChannelBindingInput[] = selectedChannelIds.map((channelId) => ({
      channelId,
      config: channelConfigById[channelId] ?? null,
    }));
    const normalizedExtraEnv: SpaceEnvInput[] = extraEnv
      .map((item) => ({ name: item.name.trim(), value: item.value }))
      .filter((item) => item.name.length > 0);

    const result = await createSpace({
      name: name.trim(),
      description: description.trim() || null,
      source: "web",
      meta: { createdFrom: "spaces/new" },
      extraEnv: normalizedExtraEnv,
      channelBindings,
    });

    window.dispatchEvent(new CustomEvent("cohub:space-created"));
    await goto(`/spaces/${result.space.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create space";
    if (message.includes("channel binding already exists") || message.includes("409")) {
      submitError = "This channel is already bound to another space.";
    } else {
      submitError = message;
    }
  } finally {
    isSubmitting = false;
  }
}
</script>

<div class="flex-1 flex flex-col min-h-0 overflow-y-auto">
  <div class="h-[40px] flex items-center px-4 border-b border-border-subtle shrink-0 bg-bg-primary">
    <div class="flex items-center gap-3 min-w-0">
      <a href="/spaces" class="text-text-tertiary hover:text-text-primary transition-colors shrink-0" onclick={(e) => { e.preventDefault(); goto('/spaces'); }}>
        <ArrowLeft class="w-4 h-4" />
      </a>
      <div class="w-[1px] h-4 bg-border-subtle shrink-0"></div>
      <span class="text-[11px] font-medium text-text-secondary">New Space</span>
    </div>
  </div>

  <div class="flex-1 p-4 overflow-y-auto max-w-2xl">
    {#if isLoading}
      <div class="flex items-center justify-center py-12 text-[12px] text-text-tertiary">
        <Loader2 class="w-4 h-4 animate-spin mr-2" />
        Loading form...
      </div>
    {:else if loadError}
      <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{loadError}</div>
    {:else}
      <form onsubmit={handleSubmit} class="space-y-3">
        <div class="border border-border-subtle rounded-md bg-bg-surface p-4 space-y-3">
          <div>
            <div class="text-[10px] uppercase tracking-wider text-text-placeholder font-medium">Space</div>
            <p class="text-[13px] text-text-tertiary mt-1">Create a new collaboration space.</p>
          </div>

          <div>
            <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary mb-1.5" for="space-name">Name</label>
            <input
              id="space-name"
              bind:value={name}
              type="text"
              placeholder="e.g. Marketing site"
              class="w-full px-3 py-[6px] rounded-[5px] bg-bg-input border border-border-subtle text-[13px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none font-mono transition-colors"
            />
          </div>

          <div>
            <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary mb-1.5" for="space-description">Description</label>
            <textarea
              id="space-description"
              bind:value={description}
              rows="3"
              placeholder="Optional description"
              class="w-full px-3 py-[6px] rounded-[5px] bg-bg-input border border-border-subtle text-[13px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none transition-colors resize-none"
            ></textarea>
          </div>
        </div>

        <div class="border border-border-subtle rounded-md bg-bg-surface p-4 space-y-3">
          <div>
            <div class="text-[10px] uppercase tracking-wider text-text-placeholder font-medium">Environment Variables</div>
            <p class="text-[13px] text-text-tertiary mt-1">Extra env vars injected into the space.</p>
          </div>

          {#if extraEnv.length === 0}
            <div class="text-[13px] text-text-placeholder py-1">No extra env configured</div>
          {:else}
            <div class="space-y-2">
              {#each extraEnv as envItem, index}
                <div class="flex flex-col sm:flex-row gap-2">
                  <input type="text" value={envItem.name} placeholder="ENV_NAME" oninput={(event) => updateEnvName(index, (event.currentTarget as HTMLInputElement).value)} class="flex-1 px-3 py-[6px] rounded-[5px] bg-bg-input border border-border-subtle text-[13px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none font-mono transition-colors" />
                  <input type="text" value={envItem.value} placeholder="value" oninput={(event) => updateEnvValue(index, (event.currentTarget as HTMLInputElement).value)} class="flex-1 px-3 py-[6px] rounded-[5px] bg-bg-input border border-border-subtle text-[13px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none font-mono transition-colors" />
                  <button type="button" onclick={() => removeEnvRow(index)} class="flex items-center justify-center px-3 py-[6px] rounded-[5px] bg-bg-hover hover:bg-bg-hover-strong border border-border-subtle text-[12px] text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer sm:w-auto">✕</button>
                </div>
              {/each}
            </div>
          {/if}

          <button type="button" onclick={addEnvRow} class="flex items-center gap-1.5 px-3 py-[6px] rounded-[5px] bg-bg-hover hover:bg-bg-hover-strong border border-border-subtle text-[12px] text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer">
            <Plus class="w-3.5 h-3.5" />
            Add env
          </button>
        </div>

        <div class="border border-border-subtle rounded-md bg-bg-surface p-4 space-y-3">
          <div>
            <div class="text-[10px] uppercase tracking-wider text-text-placeholder font-medium">Channel Bindings</div>
            <p class="text-[13px] text-text-tertiary mt-1">Connect channels to this space.</p>
          </div>

          {#if channels.length === 0}
            <div class="text-[13px] text-text-placeholder py-1">No channels available</div>
          {:else}
            <div class="space-y-2">
              {#each channels as channel (channel.id)}
                <div class="rounded-[5px] border border-border-subtle bg-bg-code p-3">
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={selectedChannelIds.includes(channel.id)} onchange={(event) => toggleChannel(channel.id, (event.currentTarget as HTMLInputElement).checked)} class="rounded-sm bg-bg-input border-border-subtle checked:bg-brand" />
                    <div class="min-w-0 flex-1">
                      <div class="text-[13px] text-text-secondary">{channel.name || channel.provider}</div>
                      <div class="text-[10px] uppercase tracking-wider text-text-tertiary">{channel.provider}</div>
                    </div>
                  </label>

                  {#if selectedChannelIds.includes(channel.id) && channel.provider === "discord"}
                    <div class="mt-3 ml-5 space-y-2 rounded-[5px] bg-bg-code border border-border-subtle p-3">
                      <label class="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={(channelConfigById[channel.id] as DiscordChannelConfig)?.inbound?.requireMentionInGuild !== false} onchange={(event) => updateDiscordConfig(channel.id, (config) => ({ ...config, inbound: { ...(config.inbound ?? {}), requireMentionInGuild: (event.currentTarget as HTMLInputElement).checked } }))} class="rounded-sm bg-bg-input border-border-subtle checked:bg-brand" />
                        <span class="text-[12px] text-text-tertiary">Require mention in non-DM</span>
                      </label>
                      <label class="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={(channelConfigById[channel.id] as DiscordChannelConfig)?.outbound?.showThinking === true} onchange={(event) => updateDiscordConfig(channel.id, (config) => ({ ...config, outbound: { ...(config.outbound ?? {}), showThinking: (event.currentTarget as HTMLInputElement).checked } }))} class="rounded-sm bg-bg-input border-border-subtle checked:bg-brand" />
                        <span class="text-[12px] text-text-tertiary">Show thinking</span>
                      </label>
                      <label class="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={(channelConfigById[channel.id] as DiscordChannelConfig)?.outbound?.showToolCalls === true} onchange={(event) => updateDiscordConfig(channel.id, (config) => ({ ...config, outbound: { ...(config.outbound ?? {}), showToolCalls: (event.currentTarget as HTMLInputElement).checked } }))} class="rounded-sm bg-bg-input border-border-subtle checked:bg-brand" />
                        <span class="text-[12px] text-text-tertiary">Show tool calls</span>
                      </label>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>

        {#if submitError}
          <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{submitError}</div>
        {/if}

        <div class="flex items-center justify-end gap-2 pt-2">
          <button type="button" onclick={() => goto('/spaces')} class="px-4 py-[6px] rounded-[5px] bg-bg-hover hover:bg-bg-hover-strong border border-border-subtle text-[12px] text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer">Cancel</button>
          <button type="submit" disabled={isSubmitting || !name.trim()} class="px-4 py-[6px] rounded-[5px] bg-[#FF3E00] hover:bg-brand-hover text-[12px] text-white font-medium transition-colors disabled:opacity-50 cursor-pointer">
            {#if isSubmitting}
              <Loader2 class="w-3.5 h-3.5 animate-spin inline mr-1.5" />
              Creating...
            {:else}
              Create Space
            {/if}
          </button>
        </div>
      </form>
    {/if}
  </div>
</div>
