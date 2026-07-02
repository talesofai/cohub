<script lang="ts">
import { loadStripe, type StripeEmbeddedCheckout } from "@stripe/stripe-js";
import { Loader2, X } from "lucide-svelte";
import { onDestroy, tick } from "svelte";
import { PUBLIC_STRIPE_PUBLISHABLE_KEY } from "$env/static/public";

function portal(node: HTMLElement) {
	if (typeof document === "undefined") return {};
	document.body.appendChild(node);
	return {
		destroy() {
			node.remove();
		},
	};
}

const {
	open,
	clientSecret,
	title = "Checkout",
	onClose,
	onComplete,
}: {
	open: boolean;
	clientSecret: string | null;
	title?: string;
	onClose: () => void;
	onComplete?: () => void;
} = $props();

let mountEl = $state<HTMLDivElement | null>(null);
let checkout: StripeEmbeddedCheckout | null = null;
let loading = $state(false);
let error = $state("");
let generation = 0;

function destroyCheckout() {
	checkout?.destroy();
	checkout = null;
}

async function mountCheckout(runId: number, secret: string) {
	const publishableKey = PUBLIC_STRIPE_PUBLISHABLE_KEY.trim();
	if (!publishableKey) {
		error = "Stripe publishable key is not configured.";
		loading = false;
		return;
	}
	loading = true;
	error = "";
	await tick();
	if (runId !== generation || !mountEl) return;
	try {
		const stripe = await loadStripe(publishableKey);
		if (runId !== generation) return;
		if (!stripe) throw new Error("Stripe.js failed to load.");
		const nextCheckout = await stripe.createEmbeddedCheckoutPage({
			clientSecret: secret,
			onComplete: () => {
				onComplete?.();
			},
		});
		if (runId !== generation) {
			nextCheckout.destroy();
			return;
		}
		destroyCheckout();
		checkout = nextCheckout;
		checkout.mount(mountEl);
	} catch (checkoutError) {
		error =
			checkoutError instanceof Error
				? checkoutError.message
				: "Checkout could not be loaded.";
	} finally {
		if (runId === generation) loading = false;
	}
}

$effect(() => {
	if (!open || !clientSecret) {
		generation += 1;
		destroyCheckout();
		loading = false;
		error = "";
		return;
	}
	const runId = generation + 1;
	generation = runId;
	void mountCheckout(runId, clientSecret);
	return () => {
		generation += 1;
		destroyCheckout();
	};
});

onDestroy(() => {
	generation += 1;
	destroyCheckout();
});
</script>

{#if open && clientSecret}
	<div use:portal class="fixed inset-0 z-[120] flex items-end justify-center lg:items-center lg:p-4" role="dialog" aria-modal="true">
		<button type="button" class="absolute inset-0 cursor-default bg-overlay-scrim" aria-label="Close checkout" onclick={onClose}></button>
		<section class="relative flex h-[92vh] w-full max-w-[840px] flex-col overflow-hidden rounded-t-[12px] border-border-subtle bg-bg-primary shadow-2xl lg:h-[86vh] lg:rounded-[12px] lg:border">
			<header class="flex h-11 shrink-0 items-center justify-between border-b border-border-subtle px-4">
				<h2 class="text-[13px] font-medium text-text-primary">{title}</h2>
				<button type="button" class="flex h-8 w-8 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary" aria-label="Close checkout" onclick={onClose}>
					<X class="h-4 w-4" />
				</button>
			</header>
			<div class="relative min-h-0 flex-1 overflow-y-auto bg-bg-content">
				{#if loading}
					<div class="absolute inset-0 z-[1] flex items-center justify-center bg-bg-content text-text-tertiary">
						<Loader2 class="h-5 w-5 animate-spin" />
					</div>
				{/if}
				{#if error}
					<div class="flex h-full items-center justify-center px-6 text-center text-[13px] text-danger">
						{error}
					</div>
				{:else}
					<div bind:this={mountEl} class="min-h-full px-2 py-3 sm:px-4"></div>
				{/if}
			</div>
		</section>
	</div>
{/if}
