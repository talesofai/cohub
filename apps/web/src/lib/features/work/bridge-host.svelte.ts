import {
	createWorkBridgeCore,
	type WorkAuthorizeRequest,
	type WorkBridgeCoreWork,
	type WorkPurchaseRequest,
	type WorkRuntimeCheckoutState,
} from "@neta-art/cohub";
import { PUBLIC_API_ORIGIN } from "$env/static/public";
import { getAuthToken, signInWithRedirectPath } from "$lib/auth";
import { authStore } from "$lib/stores/auth.svelte";

/**
 * The subset of a work record the bridge host needs to answer bridge messages.
 * Matches what the iframe host (WorkSurface) and the broker page both have on
 * hand after loading the work.
 */
export type WorkBridgeHostWork = WorkBridgeCoreWork;

/**
 * A pending authorize request surfaced to the UI as a consent dialog.
 */
/**
 * A pending purchase request surfaced to the UI as a checkout confirmation.
 */
export type {
	WorkAuthorizeRequest,
	WorkPurchaseRequest,
} from "@neta-art/cohub";

/**
 * Configuration injected by the caller. The host is transport-agnostic: how a
 * reply is delivered back to the work (iframe postMessage vs opener
 * postMessage) and how the current checkout state is read (page URL) are the
 * caller's responsibility, so the same host serves both bridge and broker.
 */
export type WorkBridgeHostConfig = {
	work: WorkBridgeHostWork;
	/** Base origin for first-party TalesofAI character requests. */
	netaApiOrigin?: string;
	/** True when running as a background chat surface (owner auto-authorizes). */
	isBackground?: boolean;
	/** Sends a reply payload back to the work runtime. */
	reply: (requestId: string, payload: Record<string, unknown>) => void;
	/** Reads the current checkout state (typically derived from the page URL). */
	getCheckoutState: () => WorkRuntimeCheckoutState;
};

export type WorkBridgeHost = {
	/** Reactive authorize-dialog state. */
	readonly authOpen: boolean;
	readonly pendingAuth: WorkAuthorizeRequest | null;
	readonly authError: string | null;
	readonly authSaving: boolean;
	/** Reactive purchase-dialog state. */
	readonly purchaseOpen: boolean;
	readonly pendingPurchase: WorkPurchaseRequest | null;
	readonly purchaseError: string | null;
	readonly purchaseSaving: boolean;
	/** Processes an inbound bridge message (already source/origin-validated). */
	handleMessage: (event: MessageEvent) => Promise<void>;
	/** Confirm/cancel handlers for the authorize dialog. */
	confirmAuth: () => Promise<void>;
	cancelAuth: () => void;
	/** Confirm/cancel handlers for the purchase dialog. */
	confirmPurchase: () => Promise<void>;
	cancelPurchase: () => void;
};

/**
 * Svelte 5 reactive wrapper around the framework-agnostic
 * {@link createWorkBridgeCore}. Binds the core's dialog state to `$state`
 * runes so Svelte templates can react to authorize/purchase dialog changes,
 * while delegating all message handling, token minting, and API calls to the
 * shared core. Both the iframe host (WorkSurface) and the standalone broker
 * page compose this with their own transport-specific reply.
 */
export function createWorkBridgeHost(
	config: WorkBridgeHostConfig,
): WorkBridgeHost {
	let authOpen = $state(false);
	let pendingAuth = $state<WorkAuthorizeRequest | null>(null);
	let authError = $state<string | null>(null);
	let authSaving = $state(false);
	let purchaseOpen = $state(false);
	let pendingPurchase = $state<WorkPurchaseRequest | null>(null);
	let purchaseError = $state<string | null>(null);
	let purchaseSaving = $state(false);

	const core = createWorkBridgeCore({
		work: config.work,
		netaApiOrigin: config.netaApiOrigin,
		isBackground: config.isBackground,
		apiOrigin: PUBLIC_API_ORIGIN ?? "",
		reply: config.reply,
		getCheckoutState: config.getCheckoutState,
		getAccessToken: (options) => getAuthToken(options),
		getViewerUuid: async () => {
			await authStore.ensureLoaded();
			return authStore.userUuid;
		},
		requestSignIn: (redirectPath) => signInWithRedirectPath(redirectPath),
		onStateChange: (next) => {
			authOpen = next.authOpen;
			pendingAuth = next.pendingAuth;
			authError = next.authError;
			authSaving = next.authSaving;
			purchaseOpen = next.purchaseOpen;
			pendingPurchase = next.pendingPurchase;
			purchaseError = next.purchaseError;
			purchaseSaving = next.purchaseSaving;
		},
	});

	return {
		get authOpen() {
			return authOpen;
		},
		get pendingAuth() {
			return pendingAuth;
		},
		get authError() {
			return authError;
		},
		get authSaving() {
			return authSaving;
		},
		get purchaseOpen() {
			return purchaseOpen;
		},
		get pendingPurchase() {
			return pendingPurchase;
		},
		get purchaseError() {
			return purchaseError;
		},
		get purchaseSaving() {
			return purchaseSaving;
		},
		handleMessage: core.handleMessage,
		confirmAuth: core.confirmAuth,
		cancelAuth: core.cancelAuth,
		confirmPurchase: core.confirmPurchase,
		cancelPurchase: core.cancelPurchase,
	};
}
