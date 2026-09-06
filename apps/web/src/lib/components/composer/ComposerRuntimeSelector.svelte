<script lang="ts">
import type { LocalAcpRuntimeRecord } from "@neta-art/cohub";
import {
	AlertCircle,
	Check,
	ChevronDown,
	Cloud,
	Laptop,
	LoaderCircle,
} from "lucide-svelte";

type Props = {
	runtimes?: LocalAcpRuntimeRecord[];
	selectedRuntimeId?: string | null;
	disabled?: boolean;
	onSelect: (runtimeId: string | null) => void;
};

let {
	runtimes = [],
	selectedRuntimeId = null,
	disabled = false,
	onSelect,
}: Props = $props();

let open = $state(false);
let rootEl = $state<HTMLDivElement | null>(null);

const selectedRuntime = $derived(
	runtimes.find((runtime) => runtime.id === selectedRuntimeId) ?? null,
);
const label = $derived(selectedRuntime?.displayName?.trim() || "Cloud");

function providerLabel(provider: LocalAcpRuntimeRecord["provider"]) {
	if (provider === "claude_code") return "Claude Code";
	if (provider === "codex") return "Codex";
	return "Pi";
}

function statusLabel(status: LocalAcpRuntimeRecord["status"]) {
	if (status === "ready") return "Ready";
	if (status === "connecting") return "Connecting";
	if (status === "busy") return "Busy";
	if (status === "error") return "Error";
	if (status === "revoked") return "Revoked";
	return "Offline";
}

function canSelect(runtime: LocalAcpRuntimeRecord) {
	return runtime.status === "ready";
}

function select(runtimeId: string | null) {
	if (runtimeId) {
		const runtime = runtimes.find((item) => item.id === runtimeId);
		if (!runtime || !canSelect(runtime)) return;
	}
	onSelect(runtimeId);
	open = false;
}

function closeOnOutside(event: PointerEvent) {
	const target = event.target as Node | null;
	if (target && rootEl?.contains(target)) return;
	open = false;
}

function closeOnEscape(event: KeyboardEvent) {
	if (event.key === "Escape") open = false;
}

$effect(() => {
	if (!open || typeof document === "undefined") return;
	document.addEventListener("pointerdown", closeOnOutside, true);
	window.addEventListener("keydown", closeOnEscape);
	return () => {
		document.removeEventListener("pointerdown", closeOnOutside, true);
		window.removeEventListener("keydown", closeOnEscape);
	};
});
</script>

{#if runtimes.length > 0 || selectedRuntimeId}
	<div class="relative shrink-0" bind:this={rootEl}>
		<button
			type="button"
			class="group flex h-7 max-w-[min(100%,10rem)] items-center gap-1 overflow-hidden sm:max-w-[15rem] rounded-full border border-border-subtle px-2 text-[11px] leading-none text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-50"
			disabled={disabled}
			aria-label={`Execution runtime: ${label}`}
			aria-expanded={open}
			aria-haspopup="menu"
			title={`Execution runtime: ${label}`}
			onclick={() => (open = !open)}
		>
			{#if selectedRuntime}
				<Laptop class="h-3 w-3 shrink-0" />
			{:else}
				<Cloud class="h-3 w-3 shrink-0" />
			{/if}
			<span class="min-w-0 truncate">{label}</span>
			<ChevronDown class="h-3 w-3 shrink-0 opacity-40" />
		</button>

		{#if open}
			<button type="button" class="fixed inset-0 z-30 cursor-default" aria-hidden="true" tabindex="-1" onclick={() => (open = false)}></button>
			<div
				class="absolute bottom-full left-0 z-40 mb-1.5 w-64 max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border border-border-subtle bg-bg-primary p-1 shadow-lg"
				role="menu"
				aria-label="Execution runtime"
			>
				<button
					type="button"
					class={`flex min-h-10 w-full items-center gap-2 rounded px-2 text-left text-[12px] transition-colors hover:bg-bg-hover ${selectedRuntimeId === null ? "text-text-primary" : "text-text-secondary"}`}
					role="menuitemradio"
					aria-checked={selectedRuntimeId === null}
					onclick={() => select(null)}
				>
					<Cloud class="h-4 w-4 shrink-0 text-text-tertiary" />
					<span class="min-w-0 flex-1 truncate">Cloud</span>
					{#if selectedRuntimeId === null}<Check class="h-3.5 w-3.5 shrink-0 text-brand" />{/if}
				</button>

				{#each runtimes as runtime (runtime.id)}
					<button
						type="button"
						class={`flex min-h-10 w-full items-center gap-2 rounded px-2 text-left text-[12px] transition-colors ${canSelect(runtime) ? "hover:bg-bg-hover" : "cursor-not-allowed opacity-55"} ${selectedRuntimeId === runtime.id ? "text-text-primary" : "text-text-secondary"}`}
						role="menuitemradio"
						aria-checked={selectedRuntimeId === runtime.id}
						disabled={!canSelect(runtime)}
						onclick={() => select(runtime.id)}
					>
						{#if runtime.status === "connecting"}
							<LoaderCircle class="h-4 w-4 shrink-0 animate-spin text-text-tertiary" />
						{:else if runtime.status === "error" || runtime.status === "revoked"}
							<AlertCircle class="h-4 w-4 shrink-0 text-warning" />
						{:else}
							<Laptop class="h-4 w-4 shrink-0 text-text-tertiary" />
						{/if}
						<span class="min-w-0 flex-1">
							<span class="block truncate">{runtime.displayName || providerLabel(runtime.provider)}</span>
							<span class="mt-0.5 block truncate text-[10px] text-text-placeholder">{providerLabel(runtime.provider)} · {statusLabel(runtime.status)}</span>
						</span>
						{#if selectedRuntimeId === runtime.id}<Check class="h-3.5 w-3.5 shrink-0 text-brand" />{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>
{/if}
