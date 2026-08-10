<script lang="ts">
import type { WorkComposerChip } from "@cohub/protocol/work-surface";
import { ExternalLink, Loader2, RefreshCw } from "lucide-svelte";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import WorkSurface from "$lib/components/work/WorkSurface.svelte";
import type { WorkSurfaceHost } from "$lib/features/work/surface-host";
import MobilePreviewTabsChrome from "./MobilePreviewTabsChrome.svelte";
import PreviewFloatChrome from "./PreviewFloatChrome.svelte";
import type { PreviewTab } from "./preview-tabs";
import type { InlineWorkPreview } from "./work-preview-controller.svelte";

type Props = {
	preview: InlineWorkPreview;
	previewTabs: PreviewTab[];
	immersive: boolean;
	isMobile: boolean;
	treeVisible?: boolean;
	onToggleTree?: () => void;
	onToggleImmersive: () => void | Promise<void>;
	onActivatePreviewTab: (kind: PreviewTab["kind"], key: string) => void;
	onClosePreviewTab: (kind: PreviewTab["kind"], key: string) => void;
	onRetry: (workId: string) => void;
	onRegisterSurface: (workId: string, host: WorkSurfaceHost | null) => void;
	onComposerChip: (workId: string, chip: WorkComposerChip | null) => void;
};

const {
	preview,
	previewTabs,
	immersive,
	isMobile,
	treeVisible = true,
	onToggleTree,
	onToggleImmersive,
	onActivatePreviewTab,
	onClosePreviewTab,
	onRetry,
	onRegisterSurface,
	onComposerChip,
}: Props = $props();

const detail = $derived(preview.detail);
const publicUrl = $derived(detail?.publicUrl ?? null);
const launchState = $derived({
	search: preview.launch?.search ?? "",
	hash: preview.launch?.hash ?? "",
});
const isDisabled = $derived(detail?.work.status === "disabled");
</script>

{#snippet WorkActions()}
	<button
		type="button"
		class="preview-icon-btn"
		title="Reload Work"
		aria-label="Reload Work"
		onclick={() => onRetry(preview.workId)}
	>
		<RefreshCw class="h-4 w-4" />
	</button>
	{#if publicUrl}
		<a
			class="preview-icon-btn"
			href={publicUrl}
			target="_blank"
			rel="noopener"
			title="Open in a new tab"
			aria-label="Open in a new tab"
		>
			<ExternalLink class="h-4 w-4" />
		</a>
	{/if}
{/snippet}

<div class="flex h-full min-w-0 flex-col bg-bg-content" class:preview-stage--immersive={immersive}>
	{#if isMobile}
		<MobilePreviewTabsChrome
			tabs={previewTabs}
			onActivate={onActivatePreviewTab}
			onClose={onClosePreviewTab}
		/>
	{:else if immersive}
		<PreviewFloatChrome
			tabs={previewTabs}
			filesVisible={treeVisible}
			onActivate={onActivatePreviewTab}
			onClose={onClosePreviewTab}
			onToggleFiles={onToggleTree}
			onExit={onToggleImmersive}
		>
			{#snippet context()}{@render WorkActions()}{/snippet}
		</PreviewFloatChrome>
	{/if}

	<div class="relative min-h-0 flex-1" data-drawer-swipe-ignore>
		{#if preview.error}
			<div class="flex h-full items-center justify-center p-6">
				<div class="max-w-sm text-center">
					<div class="mb-1 text-sm font-medium text-text-primary">Work unavailable</div>
					<div class="mb-4 text-xs leading-5 text-text-tertiary">{preview.error}</div>
					<button
						type="button"
						class="inline-flex min-h-8 items-center rounded-[5px] bg-bg-elevated px-3 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
						onclick={() => onRetry(preview.workId)}
					>
						Try again
					</button>
				</div>
			</div>
		{:else if !detail}
			<CenteredLoading label="Loading Work…" size="panel" />
		{:else if !detail.content}
			<div class="flex h-full items-center justify-center p-6 text-center text-xs leading-5 text-text-tertiary">
				{isDisabled
					? "This Work is disabled. Publish it again to preview."
					: "This Work has no published content yet."}
			</div>
		{:else}
			{#key preview.mountKey}
				<WorkSurface
					mode="preview"
					work={detail.work}
					space={detail.space}
					owner={detail.owner}
					content={detail.content}
					{launchState}
					onSurfaceHost={(host) => onRegisterSurface(preview.workId, host)}
					onComposerChip={(chip) => onComposerChip(preview.workId, chip)}
				/>
			{/key}
		{/if}
		{#if preview.loading && detail}
			<div class="pointer-events-none absolute right-2 top-2 z-10 inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-content/95 px-2 py-1 text-[11px] text-text-tertiary">
				<Loader2 class="h-3 w-3 animate-spin" />
				<span>Refreshing…</span>
			</div>
		{/if}
	</div>
</div>

<style>
	.preview-icon-btn {
		display: inline-flex;
		height: 32px;
		width: 32px;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-tertiary);
		text-decoration: none;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.preview-icon-btn:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}
</style>
