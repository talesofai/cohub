<script lang="ts">
import type {
	SpaceCommerceBenefit,
	SpaceCommerceOrder,
	SpaceCommerceProduct,
	SpaceCommerceProductBenefitBinding,
} from "@neta-art/cohub";
import {
	Archive,
	Link2,
	Loader2,
	Package,
	Pencil,
	Plus,
	Sparkles,
} from "lucide-svelte";
import { goto } from "$app/navigation";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import CommerceBenefitEditor from "$lib/components/commerce/CommerceBenefitEditor.svelte";
import CommerceProductEditor from "$lib/components/commerce/CommerceProductEditor.svelte";
import Dialog from "$lib/components/Dialog.svelte";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import { sdk } from "$lib/sdk";
import {
	buildSpaceSettingsRoute,
	type SpaceRouteTarget,
} from "$lib/space-routes";

type MetaValue = string | number | boolean;

type DialogState =
	| { kind: "none" }
	| { kind: "benefit-create" }
	| { kind: "benefit-edit"; benefit: SpaceCommerceBenefit }
	| { kind: "product-create" }
	| { kind: "product-edit"; product: SpaceCommerceProduct };

const NOT_INITIALIZED_CODE = "space_commerce_not_initialized";

const props = $props<{
	data: { spaceId: string; spaceRouteTarget?: SpaceRouteTarget };
}>();
const spaceId = $derived(props.data.spaceId);
const spaceRouteTarget = $derived(props.data.spaceRouteTarget ?? spaceId);

let loading = $state(true);
let loadError = $state("");
let commerceInitialized = $state(true);
let products = $state<SpaceCommerceProduct[]>([]);
let benefits = $state<SpaceCommerceBenefit[]>([]);
let orders = $state<SpaceCommerceOrder[]>([]);
let productBenefits = $state<SpaceCommerceProductBenefitBinding[]>([]);

let notice = $state("");
let actionError = $state("");

let dialog = $state<DialogState>({ kind: "none" });
let benefitSaving = $state(false);
let productSaving = $state(false);
let setupSaving = $state(false);
let productActionBusyKey = $state<string | null>(null);
let benefitActionBusyKey = $state<string | null>(null);
let bindingSaving = $state(false);
let bindingBusyKey = $state<string | null>(null);
let bindFormOpen = $state(false);
let bindProductKey = $state("");
let bindBenefitKey = $state("");
let ordersLoading = $state(false);
let ordersLoadingMore = $state(false);
let ordersNextPage = $state<number | null>(null);
let ordersHasMore = $state(false);

const SPACE_COMMERCE_FEATURE = "space.commerce";
let canManage = $state(false);
let entitlementLoading = $state(true);

const bindableProducts = $derived(
	products.filter((product) => product.status !== "archived"),
);
const bindableBenefits = $derived(
	benefits.filter((benefit) => benefit.status !== "archived"),
);

const readinessSteps = $derived([
	{ label: "Setup", done: commerceInitialized, count: null as number | null },
	{ label: "Benefits", done: benefits.length > 0, count: benefits.length },
	{ label: "Products", done: products.length > 0, count: products.length },
]);
const productsWithoutBenefitsHint = $derived(
	commerceInitialized && products.length > 0 && benefits.length === 0,
);
const productByKey = $derived(
	new Map(products.map((product) => [product.key, product])),
);
const benefitByKey = $derived(
	new Map(benefits.map((benefit) => [benefit.key, benefit])),
);
const existingBindingKeys = $derived(
	new Set(
		productBenefits.map(
			(binding) => `${binding.productKey}\u0000${binding.benefitKey}`,
		),
	),
);
const bindingCandidates = $derived(
	bindableBenefits.filter(
		(benefit) =>
			!bindProductKey ||
			!existingBindingKeys.has(`${bindProductKey}\u0000${benefit.key}`),
	),
);

function isNotInitializedError(error: unknown): boolean {
	if (error instanceof Error) {
		const code = (error as { code?: unknown }).code;
		if (code === NOT_INITIALIZED_CODE) return true;
		return error.message.includes("not initialized");
	}
	return false;
}

function messageOf(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

async function loadInitial(targetSpaceId: string = spaceId) {
	loading = true;
	loadError = "";
	commerceInitialized = true;
	let stale = false;
	try {
		const [productResult, benefitResult, bindingResult, orderResult] =
			await Promise.all([
				sdk.space(targetSpaceId).commerce.listProducts(),
				sdk.space(targetSpaceId).commerce.listBenefits(),
				sdk.space(targetSpaceId).commerce.listProductBenefits(),
				sdk.space(targetSpaceId).commerce.listOrders({ limit: 20 }),
			]);
		stale = targetSpaceId !== spaceId;
		if (stale) return;
		products = productResult.products;
		benefits = benefitResult.benefits as SpaceCommerceBenefit[];
		productBenefits =
			bindingResult.productBenefits as SpaceCommerceProductBenefitBinding[];
		orders = orderResult.orders as SpaceCommerceOrder[];
		ordersHasMore = orderResult.pagination.hasMore;
		ordersNextPage = orderResult.pagination.nextPage;
	} catch (error) {
		stale = targetSpaceId !== spaceId;
		if (stale) return;
		if (isNotInitializedError(error)) {
			commerceInitialized = false;
			products = [];
			benefits = [];
			orders = [];
			productBenefits = [];
			ordersHasMore = false;
			ordersNextPage = null;
		} else {
			loadError = messageOf(error, "Failed to load commerce.");
		}
	} finally {
		if (!stale) loading = false;
	}
}

async function refreshProducts() {
	try {
		const { products: next } = await sdk.space(spaceId).commerce.listProducts();
		products = next;
	} catch (error) {
		actionError = messageOf(error, "Failed to refresh products.");
	}
}

async function refreshBenefits() {
	try {
		const { benefits: next } = await sdk.space(spaceId).commerce.listBenefits();
		benefits = next as SpaceCommerceBenefit[];
	} catch (error) {
		actionError = messageOf(error, "Failed to refresh benefits.");
	}
}

async function refreshProductBenefits() {
	try {
		const { productBenefits: next } = await sdk
			.space(spaceId)
			.commerce.listProductBenefits();
		productBenefits = next as SpaceCommerceProductBenefitBinding[];
	} catch (error) {
		actionError = messageOf(error, "Failed to refresh bindings.");
	}
}

async function refreshOrders() {
	ordersLoading = true;
	try {
		const { orders: next, pagination } = await sdk
			.space(spaceId)
			.commerce.listOrders({ limit: 20 });
		orders = next as SpaceCommerceOrder[];
		ordersHasMore = pagination.hasMore;
		ordersNextPage = pagination.nextPage;
	} catch (error) {
		actionError = messageOf(error, "Failed to refresh orders.");
	} finally {
		ordersLoading = false;
	}
}

async function loadMoreOrders() {
	if (ordersLoadingMore || !ordersNextPage) return;
	ordersLoadingMore = true;
	clearNotice();
	try {
		const { orders: next, pagination } = await sdk
			.space(spaceId)
			.commerce.listOrders({ page: ordersNextPage, limit: 20 });
		orders = [...orders, ...(next as SpaceCommerceOrder[])];
		ordersHasMore = pagination.hasMore;
		ordersNextPage = pagination.nextPage;
	} catch (error) {
		actionError = messageOf(error, "Failed to load more orders.");
	} finally {
		ordersLoadingMore = false;
	}
}

function clearNotice() {
	notice = "";
	actionError = "";
}

/** Dismiss the editor dialog, but not while a save is in flight so that
 * failures always surface inline instead of being lost on unmount. */
function closeDialog() {
	if (benefitSaving || productSaving) return;
	dialog = { kind: "none" };
}

async function setupCommerce() {
	if (setupSaving) return;
	clearNotice();
	setupSaving = true;
	try {
		await sdk.space(spaceId).commerce.setup();
		commerceInitialized = true;
		notice = "Commerce is ready.";
		await loadInitial();
	} catch (error) {
		actionError = messageOf(error, "Failed to initialize commerce.");
	} finally {
		setupSaving = false;
	}
}

// ---- Benefits ----

async function submitBenefit(
	input:
		| {
				type: "feature";
				name: string;
				description?: string;
				metadata: Record<string, MetaValue>;
		  }
		| {
				type: "credits";
				name: string;
				description?: string;
				amount: number;
				expiresInDays?: number;
		  },
) {
	benefitSaving = true;
	clearNotice();
	try {
		if (dialog.kind === "benefit-edit") {
			await sdk.space(spaceId).commerce.updateBenefit(dialog.benefit.key, {
				name: input.name,
				description: input.description ?? null,
				metadata: input.type === "feature" ? input.metadata : undefined,
			});
			notice = "Benefit updated.";
		} else {
			await sdk.space(spaceId).commerce.createBenefit(input);
			notice = "Benefit created.";
		}
		dialog = { kind: "none" };
		await refreshBenefits();
	} finally {
		benefitSaving = false;
	}
	// Errors propagate to the editor, which shows them inline (the page-level
	// banner is hidden behind the dialog overlay while it is open).
}

async function archiveBenefit(benefit: SpaceCommerceBenefit) {
	if (benefitActionBusyKey || benefit.status === "archived") return;
	if (!window.confirm(`Archive benefit "${benefit.name}"?`)) return;
	benefitActionBusyKey = benefit.key;
	clearNotice();
	try {
		await sdk
			.space(spaceId)
			.commerce.updateBenefit(benefit.key, { status: "archived" });
		notice = "Benefit archived.";
		await refreshBenefits();
	} catch (error) {
		actionError = messageOf(error, "Failed to archive benefit.");
	} finally {
		benefitActionBusyKey = null;
	}
}

// ---- Products ----

async function submitProduct(input: {
	name: string;
	description?: string;
	amountUsd: number;
	status: "draft" | "active";
}) {
	productSaving = true;
	clearNotice();
	try {
		if (dialog.kind === "product-edit") {
			await sdk.space(spaceId).commerce.updateProduct(dialog.product.key, {
				name: input.name,
				description: input.description ?? null,
				status: input.status,
			});
			notice = "Product updated.";
		} else {
			await sdk.space(spaceId).commerce.createProduct({
				name: input.name,
				description: input.description,
				amountUsd: input.amountUsd,
				status: input.status,
				visibility: "public",
			});
			notice = "Product created.";
		}
		dialog = { kind: "none" };
		await refreshProducts();
	} finally {
		productSaving = false;
	}
	// Errors propagate to the editor, which shows them inline (the page-level
	// banner is hidden behind the dialog overlay while it is open).
}

async function archiveProduct(product: SpaceCommerceProduct) {
	if (productActionBusyKey || product.status === "archived") return;
	if (!window.confirm(`Archive product "${product.name}"?`)) return;
	productActionBusyKey = product.key;
	clearNotice();
	try {
		await sdk
			.space(spaceId)
			.commerce.updateProduct(product.key, { status: "archived" });
		notice = "Product archived.";
		await refreshProducts();
	} catch (error) {
		actionError = messageOf(error, "Failed to archive product.");
	} finally {
		productActionBusyKey = null;
	}
}

// ---- Bindings ----

const bindingReady = $derived(
	Boolean(bindProductKey) && Boolean(bindBenefitKey),
);

async function bindBenefit() {
	if (bindingSaving || !bindingReady) return;
	bindingSaving = true;
	clearNotice();
	const productKey = bindProductKey.trim();
	const benefitKey = bindBenefitKey.trim();
	try {
		await sdk.space(spaceId).commerce.bindProductBenefit({
			productKey,
			benefitKey,
		});
		notice = `Benefit “${benefitKey}” bound to “${productKey}”.`;
		bindProductKey = "";
		bindBenefitKey = "";
		bindFormOpen = false;
		await refreshProductBenefits();
	} catch (error) {
		actionError = messageOf(error, "Failed to bind benefit.");
	} finally {
		bindingSaving = false;
	}
}

async function unbindBenefit(binding: SpaceCommerceProductBenefitBinding) {
	const bindingKey = `${binding.productKey}\u0000${binding.benefitKey}`;
	if (bindingBusyKey || !canManage) return;
	bindingBusyKey = bindingKey;
	clearNotice();
	try {
		await sdk.space(spaceId).commerce.unbindProductBenefit({
			productKey: binding.productKey,
			benefitKey: binding.benefitKey,
		});
		notice = `Benefit “${binding.benefitKey}” unbound from “${binding.productKey}”.`;
		await refreshProductBenefits();
	} catch (error) {
		actionError = messageOf(error, "Failed to unbind benefit.");
	} finally {
		bindingBusyKey = null;
	}
}

// ---- Formatting helpers ----

function formatPrice(product: SpaceCommerceProduct): string {
	const price = `${product.pricing.amountUsd.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
	if (
		product.display.creditsAmount != null &&
		product.display.creditsAmount > 0
	) {
		return `${price} · ${product.display.creditsAmount} credits`;
	}
	return price;
}

function metadataEntries(
	benefit: SpaceCommerceBenefit,
): Array<{ key: string; value: string }> {
	if (benefit.type === "credits") {
		const entries: Array<{ key: string; value: string }> = [
			{ key: "amount", value: String(benefit.config.amount) },
		];
		if (benefit.config.expiresInDays != null) {
			entries.push({
				key: "expires",
				value: `${benefit.config.expiresInDays}d`,
			});
		}
		return entries;
	}
	return Object.entries(benefit.config.metadata).map(([key, value]) => ({
		key,
		value:
			typeof value === "boolean" ? (value ? "true" : "false") : String(value),
	}));
}

function orderAmount(order: SpaceCommerceOrder): string {
	const amount =
		order.paidAmountSnapshot > 0
			? order.paidAmountSnapshot
			: order.amountSnapshot;
	return `$${(amount / 100).toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

function formatDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
}

$effect(() => {
	const targetSpaceId = spaceId;
	void loadInitial(targetSpaceId);
});

$effect(() => {
	let cancelled = false;
	entitlementLoading = true;
	void sdk.billing
		.getFeatureEntitlement(SPACE_COMMERCE_FEATURE)
		.then(({ enabled }) => {
			if (cancelled) return;
			canManage = enabled;
		})
		.catch(() => {
			if (cancelled) return;
			canManage = false;
		})
		.finally(() => {
			if (!cancelled) entitlementLoading = false;
		});
	return () => {
		cancelled = true;
	};
});
</script>

<svelte:head><title>Commerce — Cohub</title></svelte:head>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg-primary">
	<header class="flex h-[44px] shrink-0 items-center justify-between border-b border-border-subtle bg-bg-primary px-3 sm:px-4">
		<div class="flex min-w-0 items-center gap-3">
			<button type="button" class="inline-flex h-8 items-center justify-center rounded-[6px] px-2.5 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary" onclick={() => goto(buildSpaceSettingsRoute(spaceRouteTarget))}>Back</button>
			<div class="truncate text-[13px] font-medium text-text-primary">Commerce</div>
		</div>
	</header>

	<main class="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5 sm:py-6">
		<div class="mx-auto w-full max-w-4xl space-y-4 sm:space-y-5">
			{#if !entitlementLoading && !canManage}
				<div class="flex items-center gap-2.5 rounded-[8px] border border-brand/30 bg-brand/5 p-3">
					<Sparkles class="h-4 w-4 shrink-0 text-brand" />
					<div class="min-w-0 flex-1">
						<div class="text-[13px] font-medium text-text-primary">Managing commerce requires a Max plan</div>
						<div class="text-[12px] text-text-tertiary">Upgrade to set up and configure space commerce.</div>
					</div>
					<a href="/settings/billing" class="inline-flex min-h-8 shrink-0 items-center rounded-[6px] bg-brand px-3 text-[12px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand/90">Upgrade</a>
				</div>
			{/if}
			{#if loading}
				<CenteredLoading label="Loading commerce…" size="compact" variant="surface" />
			{:else if loadError}
				<div class="rounded-[8px] border border-error-soft/30 bg-error-bg p-3 text-[12px] text-error-soft">{loadError}</div>
			{:else if !commerceInitialized}
				<section class="overflow-hidden rounded-[10px] border border-border-subtle bg-bg-surface">
					<div class="border-b border-border-subtle px-4 py-3 sm:px-5">
						<div class="flex items-center gap-2.5">
							<Sparkles class="h-4 w-4 text-text-tertiary" />
							<div>
								<div class="text-[15px] font-medium text-text-primary">Commerce is not set up</div>
								<div class="text-[12px] text-text-tertiary">Set up billing for this space to start selling products.</div>
							</div>
						</div>
					</div>
					<div class="flex items-center justify-between gap-3 p-4 sm:p-5">
						<div class="text-[12px] text-text-tertiary">This is a one-time setup for the current space.</div>
						<button type="button" class="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[6px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg disabled:opacity-50" onclick={() => void setupCommerce()} disabled={setupSaving || !canManage}>
							{#if setupSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Sparkles class="h-3.5 w-3.5" />{/if}
							Set up
						</button>
					</div>
				</section>
			{:else}
				<!-- Readiness bar -->
				<div class="rounded-[10px] border border-border-subtle bg-bg-surface px-4 py-3 sm:px-5">
					<div class="flex flex-wrap items-center gap-x-2 gap-y-2">
						{#each readinessSteps as step, i (step.label)}
							<div class="flex items-center gap-2">
								{#if i > 0}
									<span class="mx-1 h-px w-5 bg-border-subtle sm:w-7" aria-hidden="true"></span>
								{/if}
<span class="inline-block h-2 w-2 shrink-0 rounded-full {step.done ? 'bg-brand' : 'border border-border-subtle bg-transparent'}" aria-hidden="true"></span>
								<span class="text-[12px] font-medium {step.done ? 'text-text-primary' : 'text-text-tertiary'}">
									{step.label}{#if step.count !== null && step.count > 0}<span class="ml-1 text-text-tertiary">· {step.count}</span>{/if}
								</span>
							</div>
						{/each}
					</div>
					{#if productsWithoutBenefitsHint}
						<div class="mt-2.5 text-[11px] text-text-tertiary">Tip: add a benefit, then bind it to a product so purchases grant access.</div>
					{/if}
				</div>

				{#if actionError}
					<div class="rounded-[8px] border border-error-soft/30 bg-error-bg p-3 text-[12px] text-error-soft">{actionError}</div>
				{/if}
				{#if notice}
					<div class="rounded-[8px] border border-success-soft/30 bg-success-bg p-3 text-[12px] text-success-soft">{notice}</div>
				{/if}

				<!-- Benefits -->
				<section class="overflow-hidden rounded-[10px] border border-border-subtle bg-bg-surface">
					<div class="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3 sm:px-5">
						<div class="flex items-center gap-2.5">
							<Sparkles class="h-4 w-4 text-text-tertiary" />
							<div>
								<div class="text-[15px] font-medium text-text-primary">Benefits</div>
								<div class="text-[12px] text-text-tertiary">Feature and credit benefits bound to products.</div>
							</div>
						</div>
						<button type="button" class="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-[6px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg disabled:opacity-50" onclick={() => { clearNotice(); dialog = { kind: "benefit-create" }; }} disabled={!canManage}>
							<Plus class="h-3.5 w-3.5" /> New benefit
						</button>
					</div>
					<div class="p-4 sm:p-5">
						{#if benefits.length === 0}
							<div class="rounded-[8px] border border-dashed border-border-subtle px-4 py-6 text-center">
								<div class="text-[13px] font-medium text-text-secondary">No benefits yet</div>
								<div class="mt-1 text-[12px] text-text-tertiary">Create a feature benefit to gate access, or a credits benefit to sell consumable credits.</div>
								<button type="button" class="mt-3 inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[12px] font-medium text-text-primary transition-colors hover:bg-bg-hover" onclick={() => { clearNotice(); dialog = { kind: "benefit-create" }; }} disabled={!canManage}>
									<Plus class="h-3.5 w-3.5" /> Create benefit
								</button>
							</div>
						{:else}
							<div class="grid gap-2.5">
								{#each benefits as benefit (benefit.key)}
									{@const entries = metadataEntries(benefit)}
									{@const archived = benefit.status === "archived"}
									<div class="rounded-[8px] border border-border-subtle bg-bg-primary px-3.5 py-3 {archived ? 'opacity-60' : ''}">
										<div class="flex flex-wrap items-start justify-between gap-3">
											<div class="min-w-0 flex-1">
												<div class="flex flex-wrap items-center gap-2">
													<span class="inline-flex h-1.5 w-1.5 shrink-0 rounded-full {archived ? 'bg-text-placeholder' : 'bg-brand'}" aria-hidden="true"></span>
													<span class="text-[13px] font-medium text-text-primary {archived ? 'line-through' : ''}">{benefit.name}</span>
													<span class="rounded-[4px] border border-border-subtle px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">{benefit.type === 'credits' ? 'Credits' : 'Feature'}</span>
													{#if archived}<span class="rounded-[4px] border border-border-subtle px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-placeholder">Archived</span>{/if}
												</div>
												<div class="mt-0.5 truncate font-mono text-[11px] text-text-tertiary">{benefit.key}</div>
												{#if benefit.description}<div class="mt-1 text-[12px] text-text-secondary">{benefit.description}</div>{/if}
												{#if entries.length > 0}
													<div class="mt-2 flex flex-wrap gap-1.5">
														{#each entries.slice(0, 4) as entry (entry.key)}
															<span class="inline-flex items-center rounded-[4px] bg-bg-subtle px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
																<span class="text-text-tertiary">{entry.key}</span><span class="mx-1 text-text-placeholder">:</span>{entry.value}
															</span>
														{/each}
														{#if entries.length > 4}<span class="inline-flex items-center px-1 py-0.5 text-[10px] text-text-placeholder">+{entries.length - 4} more</span>{/if}
													</div>
												{/if}
											</div>
											<div class="flex shrink-0 items-center gap-1">
												<button type="button" class="inline-flex h-8 items-center justify-center gap-1.5 rounded-[6px] border border-border-subtle bg-bg-input px-2.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50" onclick={() => { clearNotice(); dialog = { kind: "benefit-edit", benefit }; }} disabled={benefitActionBusyKey !== null || archived || !canManage}>
													<Pencil class="h-3 w-3" /> Edit
												</button>
												<button type="button" class="inline-flex h-8 items-center justify-center gap-1.5 rounded-[6px] px-2.5 text-[11px] font-medium text-text-placeholder transition-colors hover:bg-bg-hover hover:text-error-soft disabled:opacity-50" onclick={() => void archiveBenefit(benefit)} disabled={benefitActionBusyKey !== null || archived || !canManage}>
													{#if benefitActionBusyKey === benefit.key}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Archive class="h-3 w-3" />{/if}
													Archive
												</button>
											</div>
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</section>

				<!-- Products -->
				<section class="overflow-hidden rounded-[10px] border border-border-subtle bg-bg-surface">
					<div class="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3 sm:px-5">
						<div class="flex items-center gap-2.5">
							<Package class="h-4 w-4 text-text-tertiary" />
							<div>
								<div class="text-[15px] font-medium text-text-primary">Products</div>
								<div class="text-[12px] text-text-tertiary">Public one-time products for checkout.</div>
							</div>
						</div>
						<button type="button" class="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-[6px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg disabled:opacity-50" onclick={() => { clearNotice(); dialog = { kind: "product-create" }; }} disabled={!canManage}>
							<Plus class="h-3.5 w-3.5" /> New product
						</button>
					</div>
					<div class="p-4 sm:p-5">
						{#if products.length === 0}
							<div class="rounded-[8px] border border-dashed border-border-subtle px-4 py-6 text-center">
								<div class="text-[13px] font-medium text-text-secondary">No products yet</div>
								<div class="mt-1 text-[12px] text-text-tertiary">Create a product to start selling.</div>
								<button type="button" class="mt-3 inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[12px] font-medium text-text-primary transition-colors hover:bg-bg-hover" onclick={() => { clearNotice(); dialog = { kind: "product-create" }; }} disabled={!canManage}>
									<Plus class="h-3.5 w-3.5" /> Create product
								</button>
							</div>
						{:else}
							<div class="grid gap-2.5 sm:grid-cols-2">
								{#each products as product (product.key)}
									{@const archived = product.status === "archived"}
									{@const draft = product.status === "draft"}
									<div class="flex flex-col rounded-[8px] border border-border-subtle bg-bg-primary px-3.5 py-3 {archived ? 'opacity-60' : ''}">
										<div class="flex items-start justify-between gap-2">
											<div class="min-w-0">
												<div class="flex flex-wrap items-center gap-2">
													<span class="text-[13px] font-medium text-text-primary {archived ? 'line-through' : ''}">{product.name}</span>
													<span class="rounded-[4px] border border-border-subtle px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">One-time</span>
												</div>
												<div class="mt-0.5 truncate font-mono text-[11px] text-text-tertiary">{product.key}</div>
											</div>
											<div class="text-right">
												<div class="font-mono text-[14px] font-semibold text-text-primary">{formatPrice(product)}</div>
											</div>
										</div>

										<div class="mt-2 flex flex-wrap items-center gap-1.5">
											<span class="inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide {archived ? 'text-text-placeholder' : draft ? 'text-text-tertiary' : 'text-brand'}">
												<span class="h-1.5 w-1.5 rounded-full {archived ? 'bg-text-placeholder' : draft ? 'bg-text-tertiary' : 'bg-brand'}" aria-hidden="true"></span>
												{product.status}
											</span>
										</div>

										{#if product.description}
											<p class="mt-2 line-clamp-2 text-[12px] leading-5 text-text-secondary">{product.description}</p>
										{/if}

										<div class="mt-3 flex items-center gap-1 border-t border-border-subtle pt-2.5">
											<button type="button" class="inline-flex h-8 items-center justify-center gap-1.5 rounded-[6px] border border-border-subtle bg-bg-input px-2.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50" onclick={() => { clearNotice(); dialog = { kind: "product-edit", product }; }} disabled={productActionBusyKey !== null || archived || !canManage}>
												<Pencil class="h-3 w-3" /> Edit
											</button>
											<button type="button" class="inline-flex h-8 items-center justify-center gap-1.5 rounded-[6px] px-2.5 text-[11px] font-medium text-text-placeholder transition-colors hover:bg-bg-hover hover:text-error-soft disabled:opacity-50" onclick={() => void archiveProduct(product)} disabled={productActionBusyKey !== null || archived || !canManage}>
												{#if productActionBusyKey === product.key}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Archive class="h-3 w-3" />{/if}
												Archive
											</button>
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</section>

				<!-- Bind benefits to products -->
				<section class="overflow-hidden rounded-[10px] border border-border-subtle bg-bg-surface">
					<div class="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3 sm:px-5">
						<div class="flex items-center gap-2.5">
							<Link2 class="h-4 w-4 text-text-tertiary" />
							<div>
								<div class="text-[15px] font-medium text-text-primary">Bindings</div>
								<div class="text-[12px] text-text-tertiary">Benefits currently granted by product purchases.</div>
							</div>
						</div>
						<button type="button" class="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[12px] font-medium text-text-primary transition-colors hover:bg-bg-hover disabled:opacity-50" onclick={() => { bindFormOpen = !bindFormOpen; bindProductKey = ""; bindBenefitKey = ""; }} disabled={!canManage || bindableProducts.length === 0 || bindableBenefits.length === 0}>
							<Plus class="h-3.5 w-3.5" /> Bind benefit
						</button>
					</div>
					<div class="space-y-3 p-4 sm:p-5">
						{#if bindableProducts.length === 0 || bindableBenefits.length === 0}
							<div class="rounded-[8px] border border-dashed border-border-subtle px-4 py-5 text-center text-[12px] text-text-tertiary">
								{#if bindableProducts.length === 0 && bindableBenefits.length === 0}
									Create at least one product and one benefit to bind them.
								{:else if bindableProducts.length === 0}
									Create a product to bind benefits to it.
								{:else}
									Create a benefit to bind it to a product.
								{/if}
							</div>
						{:else}
							{#if bindFormOpen}
								<div class="rounded-[8px] border border-border-subtle bg-bg-primary p-3">
									<div class="mb-3 flex items-center justify-between gap-2">
										<div class="text-[12px] font-medium text-text-primary">New binding</div>
										<button type="button" class="text-[11px] text-text-tertiary transition-colors hover:text-text-primary" onclick={() => { bindFormOpen = false; bindProductKey = ""; bindBenefitKey = ""; }} disabled={bindingSaving}>Cancel</button>
									</div>
									<div class="grid gap-3 sm:grid-cols-2">
										<label class="flex flex-col gap-1.5">
											<span class="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">Product</span>
											<select bind:value={bindProductKey} disabled={bindingSaving || !canManage} class="h-9 w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 text-[13px] text-text-primary transition-colors focus:border-brand/50 focus:outline-none disabled:opacity-60" onchange={() => { bindBenefitKey = ""; }}>
												<option value="">Select a product…</option>
												{#each bindableProducts as product (product.key)}
													<option value={product.key}>{product.name} · {product.key}</option>
												{/each}
											</select>
										</label>
										<label class="flex flex-col gap-1.5">
											<span class="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">Benefit</span>
											<select bind:value={bindBenefitKey} disabled={bindingSaving || !canManage || !bindProductKey} class="h-9 w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 text-[13px] text-text-primary transition-colors focus:border-brand/50 focus:outline-none disabled:opacity-60">
												<option value="">Select a benefit…</option>
												{#each bindingCandidates as benefit (benefit.key)}
													<option value={benefit.key}>{benefit.name} · {benefit.key}</option>
												{/each}
											</select>
										</label>
									</div>
									<div class="mt-3 flex items-center justify-between gap-3">
										<span class="text-[11px] text-text-tertiary">Bindings apply immediately and are verified at checkout.</span>
										<button type="button" class="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[6px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg disabled:opacity-50" onclick={() => void bindBenefit()} disabled={bindingSaving || !bindingReady || !canManage}>
											{#if bindingSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Link2 class="h-3.5 w-3.5" />{/if}
											Bind
										</button>
									</div>
								</div>
							{/if}

							{#if productBenefits.length === 0}
								<div class="rounded-[8px] border border-dashed border-border-subtle px-4 py-5 text-center text-[12px] text-text-tertiary">
									No bindings yet. Bind a benefit to a product to grant access after purchase.
								</div>
							{:else}
								<div class="grid gap-2">
									{#each productBenefits as binding (`${binding.productKey}:${binding.benefitKey}`)}
										{@const product = productByKey.get(binding.productKey)}
										{@const benefit = benefitByKey.get(binding.benefitKey)}
										{@const bindingKey = `${binding.productKey}\u0000${binding.benefitKey}`}
										<div class="flex flex-wrap items-center justify-between gap-3 rounded-[8px] bg-bg-primary px-3 py-2.5">
											<div class="min-w-0 flex-1">
												<div class="flex min-w-0 flex-wrap items-center gap-2 text-[12px]">
													<span class="truncate font-medium text-text-primary">{product?.name ?? binding.productKey}</span>
													<span class="text-text-placeholder">→</span>
													<span class="truncate text-text-secondary">{benefit?.name ?? binding.benefitKey}</span>
												</div>
												<div class="mt-0.5 flex min-w-0 flex-wrap items-center gap-2 font-mono text-[10px] text-text-placeholder">
													<span class="truncate">{binding.productKey}</span>
													<span>→</span>
													<span class="truncate">{binding.benefitKey}</span>
												</div>
											</div>
											<button type="button" class="inline-flex h-8 items-center justify-center gap-1.5 rounded-[6px] px-2.5 text-[11px] font-medium text-text-placeholder transition-colors hover:bg-bg-hover hover:text-error-soft disabled:opacity-50" onclick={() => void unbindBenefit(binding)} disabled={bindingBusyKey !== null || !canManage}>
												{#if bindingBusyKey === bindingKey}<Loader2 class="h-3 w-3 animate-spin" />{/if}
												Unbind
											</button>
										</div>
									{/each}
								</div>
							{/if}
						{/if}
					</div>
				</section>
				<!-- Orders -->
				<section class="overflow-hidden rounded-[10px] border border-border-subtle bg-bg-surface">
					<div class="flex items-center gap-2.5 px-4 py-3 sm:px-5">
						<Package class="h-4 w-4 text-text-tertiary" />
						<div class="text-[15px] font-medium text-text-primary">Orders</div>
					</div>
					<div class="border-t border-border-subtle p-4 sm:p-5">
						{#if ordersLoading}
							<div class="flex items-center gap-2 py-4 text-[12px] text-text-tertiary"><Loader2 class="h-3.5 w-3.5 animate-spin" /> Loading orders…</div>
						{:else if orders.length === 0}
							<div class="py-4 text-center text-[12px] text-text-tertiary">No orders yet.</div>
						{:else}
							<div class="grid gap-2">
								{#each orders as order (order.id)}
									<div class="flex flex-wrap items-center justify-between gap-3 rounded-[7px] bg-bg-primary px-3 py-2">
										<div class="flex min-w-0 items-center gap-2.5">
											{#if order.buyerProfile}
												<UserAvatar
													name={order.buyerProfile.displayName}
													avatarUrl={order.buyerProfile.avatarUrl}
													size="xs"
													class="border-0 bg-bg-surface"
												/>
											{/if}
											<div class="min-w-0">
												<div class="truncate text-[12px] font-medium text-text-primary">{order.productNameSnapshot}</div>
												<div class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-text-tertiary">
													{#if order.buyerProfile}
														<span class="truncate text-text-secondary">{order.buyerProfile.displayName}</span>
													{/if}
													<span class="truncate font-mono text-text-placeholder">{order.productKeySnapshot}</span>
													<span>{formatDate(order.createdAt)}</span>
												</div>
											</div>
										</div>
										<div class="text-right">
											<div class="font-mono text-[12px] text-text-primary">{orderAmount(order)}</div>
											<div class="text-[10px] uppercase tracking-wide text-text-tertiary">{order.status}</div>
										</div>
									</div>
								{/each}
							</div>
							{#if ordersHasMore}
								<div class="mt-3 flex justify-center">
									<button type="button" class="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[12px] font-medium text-text-primary transition-colors hover:bg-bg-hover disabled:opacity-50" onclick={() => void loadMoreOrders()} disabled={ordersLoadingMore}>
										{#if ordersLoadingMore}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
										Load more
									</button>
								</div>
							{/if}
						{/if}
					</div>
				</section>
			{/if}
		</div>
	</main>
</div>

<!-- Dialogs -->
{#if dialog.kind === "benefit-create" || dialog.kind === "benefit-edit"}
	<Dialog
		open
		onClose={closeDialog}
		title={dialog.kind === "benefit-edit" ? "Edit benefit" : "New benefit"}
		maxWidth="520px"
	>
		<CommerceBenefitEditor
			benefit={dialog.kind === "benefit-edit" ? dialog.benefit : null}
			busy={benefitSaving}
			onSubmit={submitBenefit}
			onCancel={() => (dialog = { kind: "none" })}
		/>
	</Dialog>
{:else if dialog.kind === "product-create" || dialog.kind === "product-edit"}
	<Dialog
		open
		onClose={closeDialog}
		title={dialog.kind === "product-edit" ? "Edit product" : "New product"}
		maxWidth="520px"
	>
		<CommerceProductEditor
			product={dialog.kind === "product-edit" ? dialog.product : null}
			busy={productSaving}
			onSubmit={submitProduct}
			onCancel={() => (dialog = { kind: "none" })}
		/>
	</Dialog>
{/if}
