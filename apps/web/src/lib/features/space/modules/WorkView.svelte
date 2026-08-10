<script lang="ts">
import type { WorkRecord } from "@neta-art/cohub";
import {
	Check,
	Copy,
	ExternalLink,
	Loader2,
	PanelRight,
	Pencil,
	Power,
	Rocket,
	Trash2,
} from "lucide-svelte";
import { onDestroy, onMount } from "svelte";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import {
	WORKS_CHANGED_EVENT,
	type WorksChangedDetail,
} from "$lib/features/work/work-realtime";
import { formatDateTime } from "../space-utils";
import WorkViewStats from "./WorkViewStats.svelte";
import { createWorkDetailController } from "./work-detail-controller.svelte";
import {
	WORK_SCOPE_OPTIONS,
	WORK_VIEWER_SCOPE_OPTIONS,
	workStatusTone,
} from "./work-utils";

type Props = {
	spaceId: string;
	routeWorkId: string | null;
	ownerUsername: string | null;
	spaceSlug: string | null;
	canEditSpace: boolean;
	onDetailLoaded?: (work: WorkRecord | null) => void;
	/** Show this Work in the workspace preview pane, beside the detail page. */
	onPreviewWork?: (work: WorkRecord) => void;
};

let {
	spaceId,
	routeWorkId,
	ownerUsername,
	spaceSlug,
	canEditSpace,
	onDetailLoaded,
	onPreviewWork,
}: Props = $props();

const workDetailController = createWorkDetailController({
	getSpaceId: () => spaceId,
	getRouteWorkId: () => routeWorkId,
	getOwnerUsername: () => ownerUsername,
	getSpaceSlug: () => spaceSlug,
	getCanViewStats: () => canEditSpace,
	onDetailLoaded: (work) => onDetailLoaded?.(work),
});

const workDetail = $derived(workDetailController.detail);
const workDetailLoading = $derived(workDetailController.loading);
const workDetailError = $derived(workDetailController.error);
const workActionInProgress = $derived(workDetailController.actionInProgress);
const workDeleteInProgress = $derived(workDetailController.deleteInProgress);
const workFormSubmitting = $derived(workDetailController.formSubmitting);
const workFormError = $derived(workDetailController.formError);
const workCopiedId = $derived(workDetailController.copiedId);
const workCopiedPublicRoute = $derived(workDetailController.copiedPublicRoute);
const workVersions = $derived(workDetailController.versions);
const workVersionsLoading = $derived(workDetailController.versionsLoading);
const workVersionsError = $derived(workDetailController.versionsError);
const workPublishSubmitting = $derived(workDetailController.publishSubmitting);
const workPublishError = $derived(workDetailController.publishError);
const workHideCohubBar = $derived(
	workDetail?.meta?.presentation?.hideCohubBar === true,
);
const workCanToggleHideCohubBar = $derived(
	workDetailController.hideCohubBarAllowed ||
		workDetailController.formHideCohubBar,
);
const workStats = $derived(workDetailController.stats);
const workStatsLoading = $derived(workDetailController.statsLoading);
const workStatsError = $derived(workDetailController.statsError);

$effect(() => {
	workDetailController.syncRoute();
});

onMount(() => {
	const handleWorksChanged = (event: Event) => {
		const detail = (event as CustomEvent<WorksChangedDetail>).detail;
		if (detail?.spaceId !== spaceId) return;
		if (detail.work || detail.version || detail.deletedWorkId) {
			workDetailController.applyWorksChanged(detail);
			return;
		}
		workDetailController.refresh();
	};
	window.addEventListener(WORKS_CHANGED_EVENT, handleWorksChanged);
	return () =>
		window.removeEventListener(WORKS_CHANGED_EVENT, handleWorksChanged);
});

onDestroy(() => {
	workDetailController.dispose();
});
</script>

{#snippet CopyIdMetaItem(id: string, copied: boolean, onCopy: () => void, label = "Copy ID")}
	<button
		type="button"
		class="inline-flex min-h-6 min-w-0 max-w-full items-center gap-1.5 font-mono text-[11px] text-text-placeholder transition-colors hover:text-text-secondary"
		onclick={onCopy}
		title={label}
	>
		<span class="truncate">{id}</span>
		{#if copied}
			<Check class="h-3 w-3 shrink-0 text-success-soft" />
		{:else}
			<Copy class="h-3 w-3 shrink-0" />
		{/if}
	</button>
{/snippet}

<div class="flex-1 min-h-0 overflow-y-auto px-4 py-5 sm:px-6 lg:px-8">
  <div class="max-w-5xl">
  {#if workDetailLoading && workDetail?.id !== routeWorkId}
    <CenteredLoading label="Loading work…" size="panel" />
  {:else if workDetailError}
    <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{workDetailError}</div>
  {:else if workDetail && workDetail.id === routeWorkId}
    {@const publicRoute = workDetailController.publicRoute(workDetail)}
    <div class="space-y-6 sm:space-y-8">
      <header class="flex flex-col gap-4 border-b border-border-subtle/70 pb-5 lg:flex-row lg:items-start lg:justify-between">
        <div class="min-w-0 space-y-3">
          <div>
            <h1 class="font-mono text-[24px] font-semibold tracking-tight text-text-primary break-all sm:text-[30px]">{workDetail.slug}</h1>
            <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span class="inline-flex items-center gap-1.5 text-[11px] font-medium {workStatusTone(workDetail.status)}">
                <span class="h-1.5 w-1.5 rounded-full {workDetail.status === 'published' ? 'bg-status-running' : workDetail.status === 'disabled' ? 'bg-status-error' : 'bg-text-placeholder'}"></span>
                {workDetail.status}
              </span>
              <span class="inline-flex items-center gap-1.5 text-[11px] font-medium text-text-tertiary">
                <span class="h-1.5 w-1.5 rounded-full {workDetail.visibility === 'public' ? 'bg-brand' : 'bg-text-placeholder'}"></span>
                {workDetail.visibility === 'public' ? 'public' : 'space access'}
              </span>
              {@render CopyIdMetaItem(workDetail.id, workCopiedId, () => void workDetailController.copyId(workDetail!.id), 'Copy work ID')}
              <span class="font-mono text-[11px] text-text-placeholder">{workDetail.targetType}:{workDetail.targetRef}</span>
            </div>
          </div>
        </div>
        <div class="flex shrink-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {#if onPreviewWork && workDetail.status === 'published'}
            <button type="button" class="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-[5px] bg-brand-muted px-3 py-2 text-[12px] font-medium text-brand transition-colors hover:bg-brand-muted-hover sm:w-auto" onclick={() => onPreviewWork?.(workDetail!)}>
              <PanelRight class="h-3.5 w-3.5" />
              <span>Preview</span>
            </button>
          {/if}
          {#if publicRoute && workDetail.status === 'published'}
            <a href={publicRoute} target="_blank" rel="noopener" class="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-[5px] bg-bg-elevated px-3 py-2 text-[12px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary sm:w-auto">
              <ExternalLink class="h-3.5 w-3.5" />
              <span>New tab</span>
            </a>
          {/if}
          <button type="button" class="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-[5px] bg-bg-elevated px-3 py-2 text-[12px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary sm:w-auto" onclick={() => { workDetailController.syncFormFromDetail(); workDetailController.editMode = !workDetailController.editMode; }}>
            <Pencil class="h-3.5 w-3.5" />
            <span>{workDetailController.editMode ? 'Close edit' : 'Edit'}</span>
          </button>
          <button type="button" class="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-[5px] bg-bg-elevated px-3 py-2 text-[12px] font-medium transition-colors hover:bg-bg-hover disabled:opacity-50 sm:w-auto {workDetail.status === 'published' ? 'text-status-running' : 'text-text-secondary'}" onclick={() => workDetailController.toggleStatus(workDetail!.status === 'published' ? 'disabled' : 'published')} disabled={workActionInProgress}>
            {#if workActionInProgress}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else if workDetail.status === 'published'}<Power class="h-3.5 w-3.5" />{:else}<Rocket class="h-3.5 w-3.5" />{/if}
            <span>{workDetail.status === 'published' ? 'Disable' : 'Publish'}</span>
          </button>
          <button type="button" class="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-[5px] px-3 py-2 text-[12px] font-medium text-text-tertiary transition-colors hover:bg-bg-hover hover:text-error-soft disabled:opacity-50 sm:w-auto" onclick={workDetailController.deleteWork} disabled={workActionInProgress || workDeleteInProgress}>
            {#if workDeleteInProgress}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 class="h-3.5 w-3.5" />{/if}
            <span>{workDeleteInProgress ? 'Deleting…' : 'Delete'}</span>
          </button>
        </div>
      </header>

      {#if canEditSpace && !workDetailController.editMode}
        <WorkViewStats
          stats={workStats}
          loading={workStatsLoading}
          error={workStatsError}
          onRetry={() => void workDetailController.loadStats(workDetail.id)}
        />
      {/if}

      {#if workDetailController.editMode}
        <form onsubmit={workDetailController.submitUpdate} class="space-y-6">
          <section class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div class="min-w-0 space-y-5">
              <div class="space-y-1.5">
                <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary" for="work-edit-slug">Slug</label>
                <input id="work-edit-slug" type="text" bind:value={workDetailController.formSlug} class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 font-mono text-[13px] text-text-primary transition-colors focus:border-brand/50 focus:outline-none" />
              </div>
              <div class="grid gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
                <div class="space-y-1.5">
                  <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary" for="work-edit-target-type">Target</label>
                  <select id="work-edit-target-type" bind:value={workDetailController.formTargetType} class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] text-text-primary transition-colors focus:border-brand/50 focus:outline-none">
                    <option value="file">File</option>
                    <option value="directory">Directory</option>
                    <option value="port">Port</option>
                  </select>
                </div>
                <div class="space-y-1.5">
                  <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary" for="work-edit-target-ref">Reference</label>
                  <input id="work-edit-target-ref" type="text" bind:value={workDetailController.formTargetRef} class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 font-mono text-[13px] text-text-primary transition-colors focus:border-brand/50 focus:outline-none" />
                </div>
              </div>
              <div class="grid gap-4 sm:grid-cols-2">
                <div class="space-y-1.5">
                  <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary" for="work-edit-status">Status</label>
                  <select id="work-edit-status" bind:value={workDetailController.formStatus} class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] text-text-primary transition-colors focus:border-brand/50 focus:outline-none">
                    <option value="published">Published</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </div>
                <div class="space-y-1.5">
                  <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary" for="work-edit-visibility">Access</label>
                  <select id="work-edit-visibility" bind:value={workDetailController.formVisibility} class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] text-text-primary transition-colors focus:border-brand/50 focus:outline-none">
                    <option value="public">Anyone with the link</option>
                    <option value="space">Use space access</option>
                  </select>
                  <div class="text-[11px] leading-5 text-text-placeholder">Space access follows this Space's permissions.</div>
                </div>
              </div>
              <div class="space-y-1.5">
                <div class="text-[10px] font-medium uppercase tracking-wider text-text-tertiary">Presentation</div>
                <label class="flex min-h-11 gap-3 rounded-[6px] border border-border-subtle bg-bg-elevated/25 px-3 py-2.5 text-text-secondary transition-colors hover:border-border-default hover:bg-bg-elevated/40" class:opacity-60={!workCanToggleHideCohubBar}>
                  <input type="checkbox" bind:checked={workDetailController.formHideCohubBar} disabled={!workCanToggleHideCohubBar || workDetailController.hideCohubBarLoading} class="mt-0.5" />
                  <span class="min-w-0">
                    <span class="block text-[12px] text-text-primary">Hide Cohub bar</span>
                    <span class="block text-[11px] leading-5 text-text-placeholder">Remove the Cohub footer from the public page.</span>
                  </span>
                </label>
                {#if workDetailController.hideCohubBarLoading}
                  <div class="text-[11px] text-text-tertiary">Checking availability…</div>
                {:else if !workDetailController.hideCohubBarAllowed}
                  <div class="text-[11px] text-text-tertiary">Included with Pro and Max.</div>
                {/if}
              </div>
            </div>
            <aside class="space-y-5 text-[13px]">
              <div class="space-y-3">
                <div class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">Work can</div>
                {#each WORK_SCOPE_OPTIONS as option (option.scope)}
                  <label class="flex gap-3 rounded-[6px] bg-bg-elevated/30 px-3 py-2.5 text-text-secondary">
                    <input type="checkbox" bind:checked={workDetailController.formScopes[option.scope]} class="mt-0.5" />
                    <span class="min-w-0"><span class="block text-[12px] text-text-primary">{option.label}</span><span class="block text-[11px] leading-5 text-text-placeholder">{option.description}</span></span>
                  </label>
                {/each}
              </div>
              <div class="space-y-3">
                <div class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">Viewers can allow</div>
                {#each WORK_VIEWER_SCOPE_OPTIONS as option (option.scope)}
                  <label class="flex gap-3 rounded-[6px] bg-bg-elevated/30 px-3 py-2.5 text-text-secondary">
                    <input type="checkbox" bind:checked={workDetailController.formViewerScopes[option.scope]} class="mt-0.5" />
                    <span class="min-w-0"><span class="block text-[12px] text-text-primary">{option.label}</span><span class="block text-[11px] leading-5 text-text-placeholder">{option.description}</span></span>
                  </label>
                {/each}
              </div>
            </aside>
          </section>
          {#if workFormError}
            <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{workFormError}</div>
          {/if}
          <div class="sticky bottom-0 z-10 -mx-4 -mb-5 flex flex-col-reverse gap-2 border-t border-border-subtle/70 bg-bg-primary/95 px-4 py-4 backdrop-blur sm:-mx-6 sm:-mb-5 sm:flex-row sm:justify-end sm:px-6 lg:-mx-8 lg:px-8">
            <button type="button" class="inline-flex min-h-10 items-center justify-center rounded-[5px] border border-border-subtle px-3 py-2 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary" onclick={() => { workDetailController.editMode = false; workDetailController.syncFormFromDetail(); }}>Cancel</button>
            <button type="submit" class="inline-flex min-h-10 items-center justify-center gap-2 rounded-[5px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover disabled:opacity-50" disabled={workFormSubmitting}>
              {#if workFormSubmitting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Check class="h-3.5 w-3.5" />{/if}
              <span>Save changes</span>
            </button>
          </div>
        </form>
      {:else}
        <section class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-8">
          <div class="min-w-0 space-y-6">
            <section class="space-y-3">
              <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div class="min-w-0">
                  <div class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">Target</div>
                  <div class="mt-1 font-mono text-[11px] text-text-placeholder">Current v{workDetail.latestVersion || 0}</div>
                </div>
                {#if workDetail.status === 'published'}
                  <button type="button" class="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-[5px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover disabled:opacity-50 sm:w-auto" onclick={() => void workDetailController.publishVersion()} disabled={workPublishSubmitting}>
                    {#if workPublishSubmitting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Rocket class="h-3.5 w-3.5" />{/if}
                    <span>{workPublishSubmitting ? 'Updating…' : 'Update version'}</span>
                  </button>
                {/if}
              </div>
              <div class="relative overflow-hidden rounded-[8px] bg-bg-elevated/40 ring-1 ring-border-subtle/60">
                <div class="absolute left-0 top-0 h-full w-[3px] bg-brand"></div>
                <div class="px-5 py-4 pl-6">
                  <div class="font-mono text-[13px] text-text-primary break-all">{workDetail.targetRef}</div>
                  <div class="mt-2 text-[12px] text-text-tertiary">{workDetail.targetType}</div>
                </div>
              </div>
              {#if workPublishError}
                <div class="rounded-[6px] border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] font-mono text-error-soft break-all">{workPublishError}</div>
              {/if}
            </section>
            <section class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px]">
              <div class="rounded-[7px] bg-bg-elevated/30 px-3 py-2.5">
                <div class="text-[10px] font-medium uppercase tracking-wider text-text-placeholder">Work permissions</div>
                <div class="mt-1 text-[13px] text-text-primary">{workDetail.workScopes.length ? workDetail.workScopes.join(', ') : 'None'}</div>
              </div>
              <div class="rounded-[7px] bg-bg-elevated/30 px-3 py-2.5">
                <div class="text-[10px] font-medium uppercase tracking-wider text-text-placeholder">Viewer grants</div>
                <div class="mt-1 text-[13px] text-text-primary">{workDetail.allowedViewerScopes.length ? workDetail.allowedViewerScopes.join(', ') : 'None'}</div>
              </div>
              <div class="rounded-[7px] bg-bg-elevated/30 px-3 py-2.5">
                <div class="text-[10px] font-medium uppercase tracking-wider text-text-placeholder">Cohub bar</div>
                <div class="mt-1 inline-flex items-center gap-1.5 text-[13px] text-text-primary">
                  <span class="h-1.5 w-1.5 rounded-full {workHideCohubBar ? 'bg-text-placeholder' : 'bg-status-running'}"></span>
                  <span>{workHideCohubBar ? 'Hidden' : 'Shown'}</span>
                </div>
              </div>
            </section>
          </div>
          <aside class="space-y-5 text-[13px]">
            {#if publicRoute && workDetail.status === 'published'}
              <div class="space-y-2">
                <div class="flex items-center justify-between gap-3">
                  <div class="text-[10px] font-medium uppercase tracking-wider text-text-placeholder">Public path</div>
                  <button type="button" class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary" onclick={() => void workDetailController.copyPublicRoute(publicRoute)} title={workCopiedPublicRoute ? 'Copied' : 'Copy public link'} aria-label={workCopiedPublicRoute ? 'Copied' : 'Copy public link'}>
                    {#if workCopiedPublicRoute}<Check class="h-3.5 w-3.5 text-success-soft" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
                  </button>
                </div>
                <div class="rounded-[6px] bg-bg-elevated/30 px-3 py-2 font-mono text-[12px] text-text-secondary break-all">{publicRoute}</div>
              </div>
              <div class="h-px bg-border-subtle/70"></div>
            {/if}
            <div class="space-y-3">
              <div class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">Metadata</div>
              <div class="grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12px]">
                <div class="text-text-placeholder">Created</div><div class="text-text-secondary">{formatDateTime(workDetail.createdAt)}</div>
                <div class="text-text-placeholder">Updated</div><div class="text-text-secondary">{formatDateTime(workDetail.updatedAt)}</div>
                <div class="text-text-placeholder">Published</div><div class="text-text-secondary">{formatDateTime(workDetail.publishedAt)}</div>
                <div class="text-text-placeholder">Owner</div><div class="font-mono text-text-secondary break-all">{workDetail.userUuid}</div>
              </div>
            </div>
          </aside>
        </section>
        <section class="border-t border-border-subtle/70 pt-6">
          <div class="mb-3 flex items-center justify-between gap-3">
            <div class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">Versions</div>
            {#if workVersionsLoading}<Loader2 class="h-3.5 w-3.5 animate-spin text-text-placeholder" />{/if}
          </div>
          {#if workVersionsError}
            <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{workVersionsError}</div>
          {:else if workVersionsLoading && workVersions.length === 0}
            <CenteredLoading label="Loading versions…" size="panel" />
          {:else if workVersions.length}
            <div class="divide-y divide-border-subtle/60">
              {#each workVersions as version (version.id)}
                <div class="py-3 text-[12px] sm:grid sm:grid-cols-[96px_minmax(0,1fr)_180px] sm:items-center sm:gap-3 sm:py-2.5">
                  <div class="flex items-center gap-2 px-1">
                    <span class="font-mono text-text-primary">v{version.version}</span>
                    {#if version.id === workDetail.currentVersionId}<span class="rounded-full bg-brand-muted px-2 py-0.5 text-[10px] font-medium text-brand">Current</span>{/if}
                  </div>
                  <div class="mt-1 truncate font-mono text-text-tertiary sm:mt-0" title={`${version.targetType}:${version.targetRef}`}>{version.targetType}:{version.targetRef}</div>
                  <div class="mt-1 font-mono text-text-placeholder sm:mt-0">{formatDateTime(version.createdAt)}</div>
                </div>
              {/each}
            </div>
          {:else}
            <div class="py-6 text-[13px] text-text-tertiary">Publish creates v1.</div>
          {/if}
        </section>
      {/if}
    </div>
  {:else}
    <div class="text-[12px] text-text-tertiary">Work not found.</div>
  {/if}
  </div>
</div>
