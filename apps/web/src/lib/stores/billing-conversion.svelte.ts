import type {
	BillingConversionIntent,
	BillingResponsePayload,
} from "@neta-art/cohub";
import {
	BILLING_ACCESS_BLOCKED_ERROR_CODE,
	extractBillingPayload,
	HttpError,
	isBillingAccessBlockedCode,
} from "@neta-art/cohub";

type BillingConversionLevel = "soft" | "hard";

type BillingConversionState = {
	open: boolean;
	level: BillingConversionLevel | null;
	intent: BillingConversionIntent | null;
	warning: BillingResponsePayload | null;
	dismissedSoftAt: number | null;
};

function extractIntentFromBody(body: unknown): BillingConversionIntent | null {
	return extractBillingPayload(body)?.conversion ?? null;
}

function extractWarningFromBody(body: unknown): BillingResponsePayload | null {
	const billing = extractBillingPayload(body);
	return billing?.status === "allowed_with_debt" ? billing : null;
}

export const BILLING_ACCESS_BLOCKED_CODE = BILLING_ACCESS_BLOCKED_ERROR_CODE;

export { isBillingAccessBlockedCode };

function defaultHardIntent(): BillingConversionIntent {
	return {
		level: "hard",
		reason: "negative_balance_limit_exceeded",
		audience: "unknown",
		preferredOfferKind: "mixed",
		title: "Add credits to continue",
		message: "Add credits or choose a plan to resume AI requests.",
		primaryAction: {
			label: "Add credits now",
			action: "open_billing_conversion",
		},
		source: "client_fallback",
	};
}

const SOFT_DISMISS_COOLDOWN_MS = 30 * 60 * 1000;

class BillingConversionStore {
	private state = $state<BillingConversionState>({
		open: false,
		level: null,
		intent: null,
		warning: null,
		dismissedSoftAt: null,
	});

	get open() {
		return this.state.open;
	}

	get level() {
		return this.state.level;
	}

	get intent() {
		return this.state.intent;
	}

	get warning() {
		return this.state.warning;
	}

	get hasSoftReminder() {
		return !!this.state.warning;
	}

	get isHardBlocked() {
		return this.state.level === "hard" && !!this.state.intent;
	}

	openFromIntent(intent: BillingConversionIntent) {
		this.state.intent = intent;
		this.state.level = intent.level;
		if (intent.level === "hard") this.state.dismissedSoftAt = null;
		this.state.open = true;
	}

	showSoft(warning: BillingResponsePayload) {
		this.state.warning = warning;
		this.state.intent = warning.conversion;
		this.state.level = "soft";
		const dismissedSoftAt = this.state.dismissedSoftAt;
		if (
			!dismissedSoftAt ||
			Date.now() - dismissedSoftAt >= SOFT_DISMISS_COOLDOWN_MS
		) {
			this.state.dismissedSoftAt = null;
			this.state.open = true;
		}
	}

	showHard(intent: BillingConversionIntent) {
		this.state.intent = intent;
		this.state.level = "hard";
		this.state.open = true;
	}

	close() {
		if (this.state.level === "soft") this.state.dismissedSoftAt = Date.now();
		this.state.open = false;
	}

	openReminder() {
		if (!this.state.intent) this.state.intent = defaultHardIntent();
		this.state.level = this.state.intent.level;
		this.state.open = true;
	}

	openFallbackHard() {
		this.showHard(
			this.state.intent?.level === "hard"
				? this.state.intent
				: defaultHardIntent(),
		);
	}

	clear() {
		this.state.open = false;
		this.state.level = null;
		this.state.intent = null;
		this.state.warning = null;
		this.state.dismissedSoftAt = null;
	}

	handleResponseBody(body: unknown) {
		const warning = extractWarningFromBody(body);
		if (warning) {
			this.showSoft(warning);
			return;
		}
		const intent = extractIntentFromBody(body);
		if (intent?.level === "hard") this.showHard(intent);
	}

	/**
	 * Opens the upgrade UI when `error` is a 402 carrying a billing conversion
	 * intent. Returns true when handled so callers can skip their own error UI.
	 */
	handleHttpError(error: unknown): boolean {
		if (!(error instanceof HttpError) || error.status !== 402) return false;
		const intent = extractIntentFromBody(error.body);
		if (!intent) return false;
		this.openFromIntent(intent);
		return true;
	}
}

export const billingConversion = new BillingConversionStore();
