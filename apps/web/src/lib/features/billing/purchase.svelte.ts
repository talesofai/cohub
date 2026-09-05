import type {
	BillingCatalog,
	BillingCatalogProduct,
	BillingCheckoutConfirmation,
	BillingPromotionCodePreview,
} from "@neta-art/cohub";
import { HttpError } from "@neta-art/cohub";
import { handleUnauthorizedError } from "$lib/auth-redirect";
import { sdk } from "$lib/sdk";
import { billingCatalogStore } from "$lib/stores/billing-catalog.svelte";
import { checkoutReturnUrl } from "./checkout-return";
import { trackPurchase } from "./funnel";
import {
	type CatalogView,
	catalogView,
	type PlanInterval,
	type PurchaseFocus,
	plansForInterval,
	planTier,
	purchaseFocus,
	recommendedPack,
	recommendedPlan,
} from "./product";

export type PurchaseSource =
	| "pricing"
	| "settings"
	| "conversion-hard"
	| "conversion-soft";

const CHECKOUT_ID_PREFIX = "cohub:billing:checkout:";

function checkoutStorageKey(productKey: string) {
	return `${CHECKOUT_ID_PREFIX}${productKey}`;
}

export function takeCheckoutId(productKey: string): string | null {
	try {
		if (typeof sessionStorage === "undefined") return null;
		const key = checkoutStorageKey(productKey);
		const value = sessionStorage.getItem(key);
		sessionStorage.removeItem(key);
		return value;
	} catch {
		return null;
	}
}

export type PurchaseError = {
	message: string;
	/** Offer no longer valid — the catalog was refreshed, ask to reconfirm. */
	offerChanged: boolean;
};

const OFFER_STALE_CODES = new Set([
	"first_purchase_offer_changed",
	"first_subscription_required",
	"discount_customer_limit_reached",
	"discount_ended",
	"discount_inactive",
]);

/**
 * One controller for every purchase surface: the public pricing page, the
 * billing settings tab and the in-app conversion sheet. Holds selection,
 * interval and checkout state; the surfaces are just different shells around
 * the same flow so that a fix or an experiment lands everywhere at once.
 */
export class PurchaseFlow {
	catalog = $state<BillingCatalog | null>(billingCatalogStore.catalog);
	loading = $state(false);
	loadError = $state<string | null>(null);
	interval = $state<PlanInterval>("monthly");
	selectedKey = $state<string | null>(null);
	promotionCode = $state("");
	promotionPreview = $state<BillingPromotionCodePreview | null>(null);
	promotionLoading = $state(false);
	checkoutLoading = $state(false);
	error = $state<PurchaseError | null>(null);

	readonly view = $derived<CatalogView | null>(
		this.catalog ? catalogView(this.catalog) : null,
	);
	readonly plans = $derived<BillingCatalogProduct[]>(
		this.view ? plansForInterval(this.view, this.interval) : [],
	);
	readonly packs = $derived<BillingCatalogProduct[]>(this.view?.packs ?? []);
	readonly hasYearly = $derived((this.view?.yearlyPlans.length ?? 0) > 0);
	readonly selected = $derived<BillingCatalogProduct | null>(
		this.catalog?.products.find(
			(product) => product.key === this.selectedKey,
		) ?? null,
	);
	readonly appliedCode = $derived(
		this.promotionPreview?.eligible ? this.promotionPreview : null,
	);
	/** Pricing that will actually be charged for the selection. */
	readonly activePricing = $derived(
		this.appliedCode?.pricing ?? this.selected?.offer?.pricing ?? null,
	);
	readonly dueTodayUsd = $derived(
		this.activePricing?.paidAmountUsd ?? this.selected?.pricing.amountUsd ?? 0,
	);

	constructor(readonly source: PurchaseSource) {}

	focus(intent: Parameters<typeof purchaseFocus>[1] = null): PurchaseFocus {
		return this.view ? purchaseFocus(this.view, intent) : "plans";
	}

	async load(options: { force?: boolean } = {}) {
		this.catalog = billingCatalogStore.catalog;
		this.loading = !this.catalog;
		this.loadError = null;
		try {
			this.catalog = await billingCatalogStore.load({
				force: options.force,
				silent: !!this.catalog,
			});
			this.ensureSelection();
		} catch (error) {
			this.loadError =
				error instanceof Error ? error.message : "Failed to load pricing";
		} finally {
			this.loading = false;
		}
	}

	/** Pre-selects the recommended product if nothing (valid) is selected. */
	ensureSelection(focus: PurchaseFocus = this.focus()) {
		if (this.selected) return;
		const pick =
			focus === "packs"
				? recommendedPack(this.packs)
				: recommendedPlan(this.plans);
		this.selectedKey = pick?.key ?? null;
	}

	select(product: BillingCatalogProduct) {
		if (this.selectedKey === product.key) return;
		this.selectedKey = product.key;
		this.clearPromotion();
		this.error = null;
		trackPurchase({
			name: "purchase_select",
			source: this.source,
			productKey: product.key,
			hasOffer: !!product.offer,
		});
	}

	setInterval(interval: PlanInterval) {
		if (this.interval === interval) return;
		const previous = this.selected;
		this.interval = interval;
		// Keep the same tier selected across the toggle when it exists.
		if (previous?.kind === "plan") {
			const view = this.view;
			const candidates = view ? plansForInterval(view, interval) : [];
			const tierMatch = candidates.find(
				(plan) => planTier(plan) === planTier(previous),
			);
			this.selectedKey =
				tierMatch?.key ?? recommendedPlan(candidates)?.key ?? null;
			this.clearPromotion();
		}
	}

	canBuy(product: BillingCatalogProduct): boolean {
		const view = this.view;
		if (!view?.paymentAvailable) return false;
		if (product.kind === "addon") return true;
		if (view.currentPlan?.key === product.key) return false;
		return !view.hasActiveSubscription;
	}

	async applyPromotionCode() {
		const product = this.selected;
		const code = this.promotionCode.trim();
		if (!product || !code || this.promotionLoading) return;
		this.promotionLoading = true;
		this.error = null;
		this.promotionPreview = null;
		try {
			const { preview } = await sdk.billing.previewPromotionCode({
				productKey: product.key,
				promotionCode: code,
			});
			if (this.selectedKey !== product.key) return;
			this.promotionCode = preview.promotionCode;
			if (!preview.eligible) {
				this.error = {
					message: preview.message ?? "This code does not apply here.",
					offerChanged: false,
				};
				return;
			}
			this.promotionPreview = preview;
		} catch (error) {
			if (await handleUnauthorizedError(error)) return;
			this.error = {
				message:
					error instanceof Error ? error.message : "Could not apply code.",
				offerChanged: false,
			};
		} finally {
			this.promotionLoading = false;
		}
	}

	clearPromotion() {
		this.promotionCode = "";
		this.promotionPreview = null;
	}

	/**
	 * Starts checkout for the selection and hands off to the payment page.
	 * Returns false when nothing happened (caller keeps the UI open).
	 */
	async checkout(input: { returnTo: string | URL }): Promise<boolean> {
		const product = this.selected;
		if (!product || this.checkoutLoading || !this.canBuy(product)) return false;
		this.checkoutLoading = true;
		this.error = null;
		const selection = this.appliedCode
			? { promotionCode: this.appliedCode.promotionCode }
			: product.offer
				? { offer: product.offer.ref }
				: {};
		// The server appends the product key and the outcome; the client only
		// supplies where the payment page should send the user back.
		const returnUrl = checkoutReturnUrl(input.returnTo);
		trackPurchase({
			name: "purchase_checkout_start",
			source: this.source,
			productKey: product.key,
			hasOffer: !!product.offer,
			dueTodayUsd: this.dueTodayUsd,
		});
		try {
			const { checkout } =
				product.kind === "plan"
					? await sdk.billing.createSubscription(product.key, {
							returnUrl,
							...selection,
						})
					: await sdk.billing.createOrder(product.key, {
							returnUrl,
							...selection,
						});
			if (checkout.checkoutUsable && checkout.checkoutUrl) {
				const checkoutId = checkout.orderId ?? checkout.subscriptionId;
				if (checkoutId) {
					try {
						sessionStorage.setItem(checkoutStorageKey(product.key), checkoutId);
					} catch {
						// Storage is only a confirmation aid; never block a created checkout.
					}
				}
				window.location.assign(checkout.checkoutUrl);
				return true;
			}
			this.error = {
				message:
					checkout.payment.reason ??
					checkout.message ??
					"Checkout is not available right now.",
				offerChanged: false,
			};
			return false;
		} catch (error) {
			if (await handleUnauthorizedError(error)) return false;
			const code = error instanceof HttpError ? error.code : null;
			const offerChanged = !!code && OFFER_STALE_CODES.has(code);
			this.error = {
				message:
					error instanceof Error ? error.message : "Checkout is not available.",
				offerChanged,
			};
			if (offerChanged) void this.load({ force: true });
			return false;
		} finally {
			this.checkoutLoading = false;
		}
	}

	/**
	 * Confirms a returned checkout against the provider's order/subscription
	 * state before any success UI is shown. `settled: true` is the only signal
	 * that carries a real purchase; a pending or failed record never does.
	 */
	async confirmCheckout(
		productKey: string,
		checkoutId: string,
	): Promise<BillingCheckoutConfirmation | null> {
		try {
			const { confirmation } = await sdk.billing.confirmCheckout(
				productKey,
				checkoutId,
			);
			return confirmation;
		} catch (error) {
			if (await handleUnauthorizedError(error)) return null;
			console.warn("[billing] Checkout confirmation failed", error);
			return null;
		}
	}
}
