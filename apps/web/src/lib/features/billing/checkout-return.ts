/**
 * Round-trip contract with the hosted payment page.
 *
 * The client hands over a plain return URL. The server appends the outcome
 * (`cohub_billing=success|failed|cancel`) and the authoritative product key
 * (`cohub_billing_product`) on every redirect, and the payment gateway echoes
 * them back. The client never supplies these values itself, so a forged URL
 * cannot name a product or claim a success the provider did not record.
 */

export type CheckoutOutcome = "success" | "failed" | "cancel";

export const CHECKOUT_PARAM = "cohub_billing";
export const CHECKOUT_PRODUCT_PARAM = "cohub_billing_product";

export type CheckoutReturn = {
	outcome: CheckoutOutcome;
	productKey: string | null;
};

/** Base URL the payment page should send the user back to. */
export function checkoutReturnUrl(base: string | URL): string {
	const url = new URL(base);
	url.searchParams.delete(CHECKOUT_PARAM);
	url.searchParams.delete(CHECKOUT_PRODUCT_PARAM);
	url.hash = "";
	return url.toString();
}

export function readCheckoutReturn(url: URL): CheckoutReturn | null {
	const outcome = url.searchParams.get(CHECKOUT_PARAM);
	if (outcome !== "success" && outcome !== "failed" && outcome !== "cancel") {
		return null;
	}
	return {
		outcome,
		productKey: url.searchParams.get(CHECKOUT_PRODUCT_PARAM)?.trim() || null,
	};
}

/** The same URL with the round-trip parameters removed. */
export function stripCheckoutReturn(url: URL): URL {
	const next = new URL(url);
	next.searchParams.delete(CHECKOUT_PARAM);
	next.searchParams.delete(CHECKOUT_PRODUCT_PARAM);
	return next;
}
