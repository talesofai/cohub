<script lang="ts">
import {
	Check,
	ChevronDown,
	File as FileIcon,
	Globe,
	Minimize2,
	MousePointer2,
	PanelRight,
	Rocket,
	X,
} from "lucide-svelte";
import type { Snippet } from "svelte";
import PreviewSyncStatus from "./PreviewSyncStatus.svelte";
import type { PreviewTab } from "./preview-tabs";

const {
	tabs,
	filesVisible,
	onActivate,
	onClose,
	onToggleFiles,
	onExit,
	context,
}: {
	tabs: PreviewTab[];
	filesVisible: boolean;
	onActivate: (kind: PreviewTab["kind"], key: string) => void;
	onClose: (kind: PreviewTab["kind"], key: string) => void;
	onToggleFiles?: () => void | Promise<void>;
	onExit: () => void | Promise<void>;
	context?: Snippet;
} = $props();

const kindIcon = {
	file: FileIcon,
	board: MousePointer2,
	port: Globe,
	work: Rocket,
} as const;

const activeTab = $derived(tabs.find((tab) => tab.active) ?? tabs[0] ?? null);
let menuOpen = $state(false);
let switcherEl = $state<HTMLDivElement | null>(null);

function run(action: () => void | Promise<void>) {
	Promise.resolve(action()).catch((error) => {
		console.error("Preview float action failed", error);
	});
}

function activate(tab: PreviewTab) {
	menuOpen = false;
	onActivate(tab.kind, tab.key);
}

$effect(() => {
	if (!menuOpen) return;

	const handlePointerDown = (event: PointerEvent) => {
		if (event.target instanceof Node && !switcherEl?.contains(event.target)) {
			menuOpen = false;
		}
	};
	const handleKeydown = (event: KeyboardEvent) => {
		if (event.key === "Escape") menuOpen = false;
	};

	document.addEventListener("pointerdown", handlePointerDown, true);
	document.addEventListener("keydown", handleKeydown);
	return () => {
		document.removeEventListener("pointerdown", handlePointerDown, true);
		document.removeEventListener("keydown", handleKeydown);
	};
});
</script>

<div class="preview-float-chrome" aria-label="Float preview controls">
	<div class="preview-float-bar">
		<div bind:this={switcherEl} class="preview-switcher">
			<button
				type="button"
				class="preview-switcher-trigger"
				title={activeTab?.title ?? "Open previews"}
				aria-label="Switch preview"
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				onclick={() => (menuOpen = !menuOpen)}
			>
				{#if activeTab}
					{@const ActiveIcon = kindIcon[activeTab.kind]}
					<ActiveIcon class="h-3.5 w-3.5 shrink-0" />
					<span class="preview-switcher-label">{activeTab.label}</span>
					{#if activeTab.syncStatus}
						<PreviewSyncStatus status={activeTab.syncStatus} />
					{/if}
				{/if}
				<span class="preview-switcher-chevron">
					<ChevronDown class="h-3.5 w-3.5" />
				</span>
			</button>

			{#if menuOpen}
				<div class="preview-switcher-menu" role="menu" aria-label="Open previews">
					{#each tabs as tab (`${tab.kind}:${tab.key}`)}
						{@const Icon = kindIcon[tab.kind]}
						<div class="preview-switcher-item" class:active={tab.active}>
							<button
								type="button"
								class="preview-switcher-item-main"
								title={tab.title}
								role="menuitem"
								onclick={() => activate(tab)}
							>
								<Icon class="h-3.5 w-3.5 shrink-0" />
								<span class="truncate">{tab.label}</span>
								{#if tab.syncStatus}
									<PreviewSyncStatus status={tab.syncStatus} />
								{/if}
								{#if tab.active}
									<Check class="ml-auto h-3.5 w-3.5 shrink-0" />
								{/if}
							</button>
							<button
								type="button"
								class="preview-switcher-item-close"
								aria-label={`Close ${tab.label}`}
								onclick={() => onClose(tab.kind, tab.key)}
							>
								<X class="h-3 w-3" />
							</button>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		{#if context}
			<div class="preview-float-context">{@render context()}</div>
		{/if}

		<div class="preview-float-divider"></div>
		<button
			type="button"
			class="preview-float-control"
			title="Exit Float"
			aria-label="Exit Float"
			onclick={() => run(onExit)}
		>
			<Minimize2 class="h-4 w-4" />
		</button>
		{#if onToggleFiles}
			<button
				type="button"
				class="preview-float-control"
				class:active={filesVisible}
				title={filesVisible ? "Hide files" : "Show files"}
				aria-label={filesVisible ? "Hide files" : "Show files"}
				aria-pressed={filesVisible}
				onclick={() => run(onToggleFiles)}
			>
				<PanelRight class="h-4 w-4" />
			</button>
		{/if}
	</div>
</div>

<style>
	.preview-float-chrome {
		position: absolute;
		top: 10px;
		left: var(--preview-safe-left, 10px);
		right: var(--preview-safe-right, 10px);
		z-index: 35;
		display: flex;
		min-width: 0;
		justify-content: flex-end;
		pointer-events: none;
		container-type: inline-size;
	}

	.preview-float-bar {
		position: relative;
		display: flex;
		max-width: 100%;
		min-height: 38px;
		align-items: center;
		gap: 2px;
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		background: var(--bg-elevated);
		padding: 3px;
		box-shadow: 0 8px 22px
			color-mix(in srgb, var(--overlay-scrim-strong) 14%, transparent);
		pointer-events: auto;
	}

	.preview-switcher {
		position: relative;
		min-width: 0;
	}

	.preview-switcher-trigger {
		display: flex;
		height: 30px;
		min-width: 0;
		max-width: 168px;
		align-items: center;
		gap: 6px;
		border-radius: 6px;
		padding: 0 7px;
		color: var(--text-secondary);
		font-size: 12px;
	}

	.preview-switcher-trigger:hover,
	.preview-float-control:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.preview-switcher-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.preview-switcher-chevron {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-placeholder);
	}

	.preview-switcher-menu {
		position: absolute;
		top: calc(100% + 7px);
		left: 0;
		width: min(280px, calc(100vw - 24px));
		max-height: min(52dvh, 360px);
		overflow-y: auto;
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		background: var(--bg-elevated);
		padding: 4px;
		box-shadow: 0 12px 28px
			color-mix(in srgb, var(--overlay-scrim-strong) 18%, transparent);
	}

	.preview-switcher-item {
		display: flex;
		align-items: center;
		border-radius: 6px;
		color: var(--text-tertiary);
	}

	.preview-switcher-item:hover,
	.preview-switcher-item.active {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.preview-switcher-item-main {
		display: flex;
		height: 32px;
		min-width: 0;
		flex: 1;
		align-items: center;
		gap: 7px;
		padding: 0 7px;
		font-size: 12px;
		text-align: left;
	}

	.preview-switcher-item-close,
	.preview-float-control {
		display: inline-flex;
		height: 30px;
		width: 30px;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		color: var(--text-tertiary);
	}

	.preview-switcher-item-close {
		height: 26px;
		width: 26px;
		margin-right: 3px;
	}

	.preview-switcher-item-close:hover {
		background: var(--bg-surface);
		color: var(--text-primary);
	}

	.preview-float-context {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 2px;
	}

	.preview-float-divider {
		width: 1px;
		height: 18px;
		margin: 0 2px;
		background: var(--border-subtle);
	}

	.preview-float-control.active {
		background: var(--bg-hover-strong);
		color: var(--text-secondary);
	}

	@container (max-width: 480px) {
		.preview-switcher-label,
		.preview-float-context :global(.preview-context-secondary) {
			display: none;
		}

		.preview-switcher-trigger {
			width: 30px;
			padding: 0;
			justify-content: center;
		}

		.preview-switcher-chevron {
			display: none;
		}
	}
</style>
