<script lang="ts">
import {
	File as FileIcon,
	Globe,
	MousePointer2,
	PanelRightClose,
	PanelRightOpen,
	Rocket,
	X,
} from "lucide-svelte";
import type { Snippet } from "svelte";
import PreviewSyncStatus from "./PreviewSyncStatus.svelte";
import type { PreviewTab } from "./preview-tabs";

type Props = {
	tabs: PreviewTab[];
	onActivate: (kind: PreviewTab["kind"], key: string) => void;
	onClose: (kind: PreviewTab["kind"], key: string) => void;
	/** Compact strip for embedding inside a parent toolbar row. */
	embedded?: boolean;
	/** File tree currently visible. */
	treeVisible?: boolean;
	/** Collapse/expand file tree without closing preview. */
	onToggleTree?: () => void;
	/**
	 * High-priority trailing controls (e.g. Focus/Float). Always visible to the
	 * left of the tree toggle; tab overflow scrolls instead of covering these.
	 */
	trailing?: Snippet;
};

let {
	tabs,
	onActivate,
	onClose,
	embedded = false,
	treeVisible = true,
	onToggleTree,
	trailing,
}: Props = $props();

const kindIcon = {
	file: FileIcon,
	board: MousePointer2,
	port: Globe,
	work: Rocket,
} as const;

const showChrome = $derived(
	tabs.length > 0 || Boolean(onToggleTree) || Boolean(trailing),
);
</script>

{#if showChrome}
	<div
		class="preview-tabs"
		class:preview-tabs--embedded={embedded}
		role="tablist"
		aria-label="Open previews"
	>
		<div class="preview-tabs-scroll">
			{#each tabs as tab (`${tab.kind}:${tab.key}`)}
				{@const Icon = kindIcon[tab.kind]}
				<div class="preview-tab-shell" class:active={tab.active}>
					<button
						type="button"
						class="preview-tab"
						role="tab"
						aria-selected={tab.active}
						title={tab.title}
						onclick={() => onActivate(tab.kind, tab.key)}
					>
						<span class="preview-tab-icon">
							<Icon class="h-3 w-3" />
						</span>
						<span class="truncate">{tab.label}</span>
						{#if tab.syncStatus}
							<PreviewSyncStatus status={tab.syncStatus} />
						{/if}
					</button>
					<button
						type="button"
						class="preview-tab-close"
						aria-label={`Close ${tab.label}`}
						onclick={() => onClose(tab.kind, tab.key)}
					>
						<X class="w-3 h-3" />
					</button>
				</div>
			{/each}
		</div>

		<div class="preview-tabs-trailing">
			{#if trailing}
				{@render trailing()}
			{/if}
			{#if onToggleTree}
				<button
					type="button"
					class="preview-tree-toggle"
					title={treeVisible ? "Collapse file tree" : "Show file tree"}
					aria-label={treeVisible ? "Collapse file tree" : "Show file tree"}
					aria-pressed={treeVisible}
					onclick={onToggleTree}
				>
					{#if treeVisible}
						<PanelRightClose class="h-3.5 w-3.5" />
					{:else}
						<PanelRightOpen class="h-3.5 w-3.5" />
					{/if}
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	.preview-tabs {
		display: flex;
		height: 2.5rem;
		min-width: 0;
		flex: 0 0 auto;
		align-items: stretch;
		gap: 2px;
		overflow: hidden;
		border-bottom: 1px solid var(--border-subtle);
		background: var(--bg-surface);
		padding: 0 0.25rem;
	}

	.preview-tabs--embedded {
		height: 100%;
		flex: 1 1 auto;
		border-bottom: 0;
		background: transparent;
		padding: 0;
	}

	/* Tabs scroll first; trailing actions stay pinned. */
	.preview-tabs-scroll {
		display: flex;
		min-width: 0;
		flex: 1 1 auto;
		align-items: stretch;
		gap: 1px;
		overflow-x: auto;
		scrollbar-width: thin;
	}

	.preview-tabs-trailing {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		align-self: stretch;
		gap: 2px;
		margin-left: 2px;
	}

	.preview-tab-shell {
		display: inline-flex;
		min-width: 0;
		max-width: 12rem;
		height: 100%;
		align-items: center;
		position: relative;
		color: var(--text-tertiary);
	}

	.preview-tab-shell:hover {
		color: var(--text-secondary);
	}

	.preview-tab-shell.active {
		color: var(--text-primary);
	}

	.preview-tab-shell.active::after {
		content: "";
		position: absolute;
		left: 0.25rem;
		right: 0.25rem;
		bottom: 0;
		height: 2px;
		border-radius: 2px 2px 0 0;
		background: var(--brand);
	}

	.preview-tabs--embedded .preview-tab-shell.active::after {
		bottom: 0.125rem;
	}

	.preview-tab {
		display: inline-flex;
		min-width: 0;
		height: 100%;
		align-items: center;
		gap: 0.375rem;
		padding: 0 0.375rem;
		font-size: 0.75rem;
		line-height: 1rem;
		white-space: nowrap;
	}

	.preview-tab-icon {
		display: inline-flex;
		flex: 0 0 auto;
		opacity: 0.6;
	}

	.preview-tab-shell.active .preview-tab-icon {
		opacity: 1;
	}

	.preview-tab-close {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		margin-right: 0.125rem;
		border-radius: 4px;
		opacity: 0;
		color: var(--text-tertiary);
		transition: opacity 120ms ease, background 120ms ease, color 120ms ease;
	}

	.preview-tab-shell:hover .preview-tab-close,
	.preview-tab-shell.active .preview-tab-close {
		opacity: 0.55;
	}

	.preview-tabs--embedded .preview-tab-close {
		opacity: 0.55;
	}

	.preview-tab-close:hover {
		background: var(--bg-hover);
		opacity: 1 !important;
		color: var(--text-secondary);
	}

	.preview-tree-toggle {
		display: inline-flex;
		height: 1.75rem;
		width: 1.75rem;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-tertiary);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}

	.preview-tree-toggle:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	@media (pointer: coarse) {
		.preview-tree-toggle {
			height: 2rem;
			width: 2rem;
		}
		.preview-tab-close {
			opacity: 0.55;
		}
	}
</style>
