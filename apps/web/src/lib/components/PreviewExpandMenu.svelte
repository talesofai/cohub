<script lang="ts">
import { Expand, Layers2, Maximize2, Minimize2 } from "lucide-svelte";
import { onDestroy } from "svelte";
import { floatNear } from "$lib/actions/portal";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	focused = false,
	immersive = false,
	size = "md",
	onToggleFocus,
	onToggleImmersive,
	onToggleFullCanvas,
}: {
	focused?: boolean;
	immersive?: boolean;
	/** md = standard 32px chrome button, sm = compact 28px (board toolbar). */
	size?: "md" | "sm";
	onToggleFocus: () => void | Promise<void>;
	onToggleImmersive: () => void | Promise<void>;
	onToggleFullCanvas: () => void | Promise<void>;
} = $props();

const locale = $derived(getLocale());

let open = $state(false);
let rootEl = $state<HTMLDivElement | null>(null);
const expanded = $derived(focused || immersive);
const iconClass = $derived(size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4");
const title = $derived(
	immersive
		? m.preview_exit_immersive({}, { locale })
		: focused
			? m.preview_exit_focus({}, { locale })
			: m.preview_expand({}, { locale }),
);

function runAction(action: () => void | Promise<void>) {
	Promise.resolve(action()).catch((error) => {
		console.error("Preview expand action failed", error);
	});
}

function toggleMenu(event: MouseEvent) {
	event.stopPropagation();
	if (expanded) {
		runAction(immersive ? onToggleImmersive : onToggleFocus);
		open = false;
		return;
	}
	open = !open;
}

function choose(action: () => void | Promise<void>) {
	open = false;
	runAction(action);
}

function handleDocumentPointerDown(event: PointerEvent) {
	if (!open) return;
	const target = event.target;
	// Popover is portaled to body; treat it as inside the menu.
	if (
		target instanceof Node &&
		(rootEl?.contains(target) ||
			(target instanceof Element && target.closest(".preview-expand-popover")))
	) {
		return;
	}
	open = false;
}

function handleDocumentKeydown(event: KeyboardEvent) {
	if (!open) return;
	if (event.key === "Escape") open = false;
}

$effect(() => {
	if (!open) return;
	document.addEventListener("pointerdown", handleDocumentPointerDown, true);
	document.addEventListener("keydown", handleDocumentKeydown);
	return () => {
		document.removeEventListener(
			"pointerdown",
			handleDocumentPointerDown,
			true,
		);
		document.removeEventListener("keydown", handleDocumentKeydown);
	};
});

onDestroy(() => {
	document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
	document.removeEventListener("keydown", handleDocumentKeydown);
});
</script>

<div bind:this={rootEl} class="preview-expand-menu relative shrink-0">
	<button
		type="button"
		class="preview-expand-trigger"
		class:preview-expand-trigger--sm={size === "sm"}
		onclick={toggleMenu}
		title={title}
		aria-label={title}
		aria-haspopup="menu"
		aria-expanded={open}
	>
		{#if expanded}
			<Minimize2 class={iconClass} />
		{:else}
			<Maximize2 class={iconClass} />
		{/if}
	</button>
	{#if open}
		<div
			class="preview-expand-popover"
			role="menu"
			tabindex="-1"
			use:floatNear={{
				getAnchor: () => rootEl,
				placement: "bottom-end",
				gap: 6,
				width: 168,
				zIndex: 120,
			}}
			onpointerdown={(event) => event.stopPropagation()}
		>
			<button type="button" class="preview-expand-item" onclick={() => choose(onToggleFullCanvas)} role="menuitem">
				<Expand class="h-3.5 w-3.5" />
				<span>{m.preview_full_canvas({}, { locale })}</span>
			</button>
			<button type="button" class="preview-expand-item" onclick={() => choose(onToggleFocus)} role="menuitem">
				<Maximize2 class="h-3.5 w-3.5" />
				<span>{m.preview_focus({}, { locale })}</span>
			</button>
			<button type="button" class="preview-expand-item" onclick={() => choose(onToggleImmersive)} role="menuitem">
				<Layers2 class="h-3.5 w-3.5" />
				<span>{m.preview_float({}, { locale })}</span>
			</button>
		</div>
	{/if}
</div>

<style>
	/* Self-contained chrome button: parent scoped classes cannot reach
	   across the component boundary, so alignment must not depend on them. */
	.preview-expand-trigger {
		display: inline-flex;
		width: 32px;
		height: 32px;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-tertiary);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease, transform 120ms ease;
	}

	.preview-expand-trigger:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.preview-expand-trigger:active {
		transform: scale(0.96);
	}

	.preview-expand-trigger--sm {
		width: 28px;
		height: 28px;
	}

	.preview-expand-popover {
		width: 168px;
		overflow: hidden;
		border-radius: 8px;
		border: 1px solid var(--border-subtle);
		background: var(--bg-elevated);
		padding: 4px;
		box-shadow: 0 10px 24px color-mix(in srgb, var(--overlay-scrim-strong) 16%, transparent);
	}

	.preview-expand-item {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 7px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		padding: 7px 8px;
		color: var(--text-secondary);
		font-size: 12px;
		font-weight: 500;
		line-height: 1.2;
		text-align: left;
		cursor: pointer;
	}

	.preview-expand-item:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}
</style>
