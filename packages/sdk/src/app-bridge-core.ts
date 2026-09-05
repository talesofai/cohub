import { PERMISSIONS, type Permission } from "./types.js";
import type { AppRecord } from "./apis/apps.js";
import type {
	AppRuntimeCheckoutState,
	AppRuntimeContext,
	AppRuntimeInvocationContext,
	AppRuntimeShellContext,
} from "./app-runtime.js";
import {
	syncGrantedAppScopes,
	clearGrantedAppScopes,
	hasGrantedAppScopes,
	listGrantedAppScopes,
	setGrantedAppScopes,
} from "./app-grant-cache.js";

/**
 * The subset of an app record the bridge host needs to answer bridge messages.
 * Matches what the iframe host (AppSurface) and the broker page both have on
 * hand after loading the app.
 */
export type AppBridgeCoreApp = Pick<
	AppRecord,
	"id" | "spaceId" | "slug" | "userUuid" | "appScopes"
> & {
	/** App home space display name, when the host knows it. */
	spaceName?: string | null;
};

/** A space offered to the viewer inside the consent dialog's picker. */
export type AppAuthorizeSpaceOption = {
	id: string;
	name: string | null;
	ownerUserUuid?: string | null;
	isPinned?: boolean;
};

/**
 * A pending authorize request surfaced to the UI as a consent dialog.
 * `spaceId` targets a space other than the app's home space; `spaceName` is
 * resolved by the host (never trusted from the app) for the dialog copy.
 * `selectSpace` asks the viewer to pick the target space inside the dialog —
 * one consent covers both the choice and the grant.
 */
export type AppAuthorizeRequest = {
	requestId: string;
	scopes: Permission[];
	reason?: string;
	spaceId?: string;
	spaceName?: string | null;
	selectSpace?: boolean;
	spaces?: AppAuthorizeSpaceOption[] | null;
	/** App home space display name, for context on home-space grants. */
	homeSpaceName?: string | null;
};

/**
 * A purchase request being processed by the host.
 */
export type AppPurchaseRequest = {
	requestId: string;
	productKey: string;
	purchaseAttemptId: string;
};

export type AppCheckoutStarted = AppPurchaseRequest & {
	value?: number;
	currency?: string;
};

/**
 * Reactive dialog state managed by the core. The host (Svelte or React)
 * subscribes via {@link AppBridgeCoreConfig.onStateChange} and mirrors these
 * fields into its own reactive primitives.
 */
export type AppBridgeDialogState = {
	authOpen: boolean;
	pendingAuth: AppAuthorizeRequest | null;
	authError: string | null;
	authSaving: boolean;
};

/**
 * Resolves the current user's Cohub API access token. The core uses this to
 * mint app session / authorization tokens via the Cohub API.
 */
export type AppBridgeGetAccessToken = (
	options?: { forceRefresh?: boolean },
) => Promise<string | null>;

/**
 * Resolves the current viewer's user UUID (or null when unauthenticated).
 * Used for ownership checks and silent re-authorization cache lookups.
 */
export type AppBridgeGetViewerUuid = () => Promise<string | null>;

export type AppPromotionAttributionContext = {
	promotionId: string;
	sourceUrl?: string;
	fbp?: string;
	fbc?: string;
};

export type AppBridgeAuthorizationContext = {
	/** The host surface handling this authorization request. */
	surface: "page" | "app" | "background" | "broker";
};

/**
 * Requests the host to start a sign-in flow, redirecting back to the given
 * path afterward. The core calls this when an API request fails due to missing
 * authentication.
 */
export type AppBridgeRequestSignIn = (redirectPath: string) => Promise<void>;

/**
 * Configuration injected by the caller. The core is transport-agnostic: how a
 * reply is delivered back to the app (iframe postMessage vs opener
 * postMessage) and how the current checkout state is read (page URL) are the
 * caller's responsibility, so the same core serves both bridge and broker
 * hosts. Auth dependencies (token resolution, viewer identity, sign-in) are
 * also injected so the core stays free of any framework's store/auth plumbing.
 */
export type AppBridgeCoreConfig = {
	app: AppBridgeCoreApp;
	/** Trusted host context used to decide whether the publisher may authorize silently. */
	authorizationContext?: AppBridgeAuthorizationContext;
	/** Optional snapshot describing what opened this app runtime. */
	invocation?: AppRuntimeInvocationContext;
	/** Reads the latest opening context without recreating the app surface. */
	getInvocation?: () => AppRuntimeInvocationContext | undefined;
	/** Optional snapshot of the current embedding shell location. */
	shell?: AppRuntimeShellContext;
	/** Reads the latest shell context without recreating the app surface. */
	getShell?: () => AppRuntimeShellContext | undefined;
	/** Sends an unsolicited event to the app runtime. */
	notify?: (payload: Record<string, unknown>) => void;
	/** @deprecated Use authorizationContext with a background surface. */
	isBackground?: boolean;
	/** Base origin for Cohub API requests (e.g. "https://cohub.live"). */
	apiOrigin: string;
	/** Sends a reply payload back to the app runtime. */
	reply: (requestId: string, payload: Record<string, unknown>) => void;
	/** Reads the current checkout state (typically derived from the page URL). */
	getCheckoutState: () => AppRuntimeCheckoutState;
	/** Resolves the current user's Cohub access token. */
	getAccessToken: AppBridgeGetAccessToken;
	/** Resolves the current viewer's user UUID. */
	getViewerUuid: AppBridgeGetViewerUuid;
	/** Starts a sign-in flow with a post-login redirect path. */
	requestSignIn: AppBridgeRequestSignIn;
	/** Returns optional host-owned promotion attribution for checkout. */
	getPromotionAttribution?: () => AppPromotionAttributionContext | null;
	/** Called when the host begins processing a purchase request. */
	onPurchaseRequested?: (input: AppPurchaseRequest) => void;
	/** Called immediately before navigating to a usable checkout. */
	onCheckoutStarted?: (input: AppCheckoutStarted) => void;
	/** Called whenever the dialog state changes, for reactive UI binding. */
	onStateChange?: (state: AppBridgeDialogState) => void;
};

export type AppBridgeCore = {
	/** Returns a snapshot of the current dialog state. */
	getState: () => AppBridgeDialogState;
	/** Processes an inbound bridge message (already source/origin-validated). */
	handleMessage: (event: MessageEvent) => Promise<void>;
	/** Sends the current complete runtime context to the app. */
	notifyContextChanged: (
		invocation?: AppRuntimeInvocationContext,
	) => Promise<void>;
	/** Confirm/cancel handlers for the authorize dialog. `confirmAuth` receives the space picked in picker mode. */
	confirmAuth: (pickedSpaceId?: string) => Promise<void>;
	cancelAuth: () => void;
};

function readTokenResponse(value: unknown) {
	if (!value || typeof value !== "object") return null;
	const token = (value as Record<string, unknown>).token;
	return typeof token === "string" && token ? token : null;
}

function clonePermissionScopes(scopes: readonly Permission[] | null | undefined) {
	return Array.from(scopes ?? []).filter(
		(scope): scope is Permission => typeof scope === "string",
	);
}

/**
 * Scopes arriving over postMessage are untrusted: keep only known permission
 * names (in first-seen order, deduplicated) so a malicious app cannot push
 * arbitrary strings, duplicates, or oversized arrays into the consent dialog.
 */
function sanitizeRequestedScopes(value: unknown): Permission[] {
	if (!Array.isArray(value)) return [];
	const known = new Set<string>(PERMISSIONS);
	const seen = new Set<Permission>();
	for (const scope of value) {
		if (typeof scope === "string" && known.has(scope)) seen.add(scope as Permission);
	}
	return Array.from(seen);
}

/** Consent dialogs render the reason; keep hostile input bounded. */
const MAX_REASON_LENGTH = 280;

class AppAuthorizationError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "AppAuthorizationError";
	}
}

const isDefinitiveAuthorizationFailure = (error: unknown) =>
	error instanceof AppAuthorizationError && [401, 403, 404].includes(error.status);

function sanitizeReason(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length > MAX_REASON_LENGTH ? trimmed.slice(0, MAX_REASON_LENGTH) : trimmed;
}

function normalizePermissionScopes(scopes: readonly Permission[]) {
	return Array.from(new Set(clonePermissionScopes(scopes)));
}

/**
 * Framework-agnostic app bridge host core — message handling, app session
 * token minting, authorization (with silent re-grant cache), and
 * purchase/checkout flow — without any rendering or reactive primitives.
 *
 * Both the Cohub iframe host (AppSurface, Svelte) and the standalone broker
 * page compose this with their own transport-specific reply and auth
 * dependencies. External hosts (e.g. Neta-Studio in React) can do the same.
 */
export function createAppBridgeCore(
	config: AppBridgeCoreConfig,
): AppBridgeCore {
	const { app, reply, getCheckoutState, getAccessToken, getViewerUuid } =
		config;
	const apiOrigin = config.apiOrigin;
	const authorizationContext =
		config.authorizationContext ??
		(config.isBackground
			? { surface: "background" as const }
			: { surface: "page" as const });
	const onStateChange = config.onStateChange;

	let appToken: string | null = null;
	/** Consents made through this host, keyed by target space. */
	const sessionViewerGrants = new Map<string, { spaceId: string; scopes: Permission[] }>();
	let activeInvocation: AppRuntimeInvocationContext | undefined;
	let contextChangeVersion = 0;
	const legacyRequestIds = new Set<string>();

	async function getContext(): Promise<AppRuntimeContext> {
		const invocation =
			activeInvocation !== undefined
				? activeInvocation
				: config.getInvocation?.() ?? config.invocation;
		const shell = config.getShell?.() ?? config.shell;
		const appScopes = clonePermissionScopes(app.appScopes);
		const viewerUuid = await getViewerUuid();
		// Viewer grants as far as the host can tell: previously consented
		// (localStorage cache) overlaid by this session's fresh consents. The
		// server remains the source of truth; this is display-only.
		const viewerGrants = mergeViewerGrants(
			viewerUuid,
			Array.from(sessionViewerGrants.values()),
		);
		return {
			app: {
				id: app.id,
				slug: app.slug,
				url: typeof location !== "undefined" ? location.href : "",
				homeSpace: { id: app.spaceId, name: app.spaceName ?? null },
			},
			// Kept for clients that still read context.space.
			space: { id: app.spaceId },
			viewer: viewerUuid ? { userUuid: viewerUuid } : null,
			...(invocation ? { invocation: { ...invocation } } : {}),
			...(shell
				? {
						shell: {
							...shell,
							space: shell.space ? { ...shell.space } : null,
							session: shell.session ? { ...shell.session } : null,
							turn: shell.turn ? { ...shell.turn } : null,
						},
					}
				: {}),
			permissions: {
				scopes: normalizePermissionScopes([
					...appScopes,
					...viewerGrants.flatMap((grant) => grant.scopes),
				]),
				appScopes,
				viewerScopes: normalizePermissionScopes(
					viewerGrants.flatMap((grant) => grant.scopes),
				),
				viewerGrants,
			},
		};
	}

	/** Builds an authorize reply; the target space rides along for the app. */
	function authorizeResult(
		token: string | null,
		spaceId: string | undefined,
		spaceName: string | null,
	) {
		return {
			type: "cohub.app.authorize.result",
			token,
			space: spaceId
				? { id: spaceId, name: spaceName }
				: { id: app.spaceId, name: app.spaceName ?? null },
		};
	}

	function replyForRequest(
		requestId: string,
		payload: Record<string, unknown>,
		complete = false,
	) {
		const namespace = legacyRequestIds.has(requestId) ? "work" : "app";
		const type = payload.type;
		reply(requestId, {
			...payload,
			...(typeof type === "string" && type.startsWith("cohub.app.")
				? { type: type.replace("cohub.app.", `cohub.${namespace}.`) }
				: {}),
		});
		if (complete) legacyRequestIds.delete(requestId);
	}

	function toLegacyWorkContext(context: AppRuntimeContext) {
		const permissions = context.permissions
			? {
					scopes: context.permissions.scopes,
					workScopes: context.permissions.appScopes,
					appScopes: context.permissions.appScopes,
					viewerScopes: context.permissions.viewerScopes,
				}
			: undefined;
		return {
			// Keep the legacy projection stable as App context gains fields.
			work: {
				id: context.app.id,
				slug: context.app.slug,
				url: context.app.url,
			},
			space: context.space,
			...(context.viewer !== undefined ? { viewer: context.viewer } : {}),
			...(context.invocation ? { invocation: context.invocation } : {}),
			...(permissions ? { permissions } : {}),
		};
	}

	async function notifyContextChanged(
		invocation?: AppRuntimeInvocationContext,
	) {
		activeInvocation = invocation;
		const version = ++contextChangeVersion;
		if (!config.notify) return;
		const context = await getContext();
		if (version !== contextChangeVersion) return;
		config.notify({
			type: "cohub.app.context.changed",
			context,
		});
	}

	const state: AppBridgeDialogState = {
		authOpen: false,
		pendingAuth: null,
		authError: null,
		authSaving: false,
	};

	function notify() {
		onStateChange?.({ ...state });
	}

	const pendingPurchaseStorageKey = `cohub-app-purchase:${app.id}`;
	const purchaseInFlight = new Map<string, Promise<unknown>>();
	let activePurchase: { productKey: string; promise: Promise<unknown> } | null = null;

	async function isCurrentViewerAppOwner() {
		const viewerUuid = await getViewerUuid();
		return Boolean(viewerUuid && viewerUuid === app.userUuid);
	}

	function mergeViewerGrants(
		viewerUuid: string | null,
		sessionGrants: Array<{ spaceId: string; scopes: Permission[] }>,
	) {
		const bySpace = new Map<string, { spaceId: string; scopes: Permission[] }>();
		for (const grant of listGrantedAppScopes(viewerUuid, app.id, app.spaceId)) {
			bySpace.set(grant.spaceId, grant);
		}
		for (const grant of sessionGrants) {
			bySpace.set(grant.spaceId, grant);
		}
		return Array.from(bySpace.values());
	}

	function allowsOwnerAutoAuthorization() {
		return (
			authorizationContext.surface === "background" ||
			authorizationContext.surface === "app"
		);
	}

	async function ensureBaseToken(forceRefresh = false) {
		if (appToken && !forceRefresh) return appToken;
		const userToken = await getAccessToken({ forceRefresh });
		if (!userToken) {
			await config.requestSignIn(
				typeof location !== "undefined" ? location.pathname : "/",
			);
			return null;
		}
		const response = await fetch(
			`${apiOrigin}/api/apps/${app.id}/session`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${userToken}` },
			},
		);
		if (!response.ok) throw new Error("Failed to create app session.");
		const token = readTokenResponse(await response.json());
		if (!token) throw new Error("Invalid app session response.");
		appToken = token;
		return appToken;
	}

	/**
	 * Calls the authorize endpoint. `silent` marks a background refresh of a
	 * previous consent: the server then only renews a live grant and never
	 * creates or revives one, so a revoked grant cannot come back without a
	 * fresh dialog.
	 */
	async function authorize(
		scopes: Permission[],
		spaceId?: string,
		options?: { silent?: boolean },
	) {
		const userToken = await getAccessToken();
		if (!userToken) {
			await config.requestSignIn(
				typeof location !== "undefined" ? location.pathname : "/",
			);
			throw new Error("Sign in is required to authorize this app.");
		}
		const response = await fetch(
			`${apiOrigin}/api/apps/${app.id}/authorize`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${userToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					scopes,
					...(spaceId ? { spaceId } : {}),
					...(options?.silent ? { silent: true } : {}),
				}),
			},
		);
		const payload = await response.json().catch(() => null) as {
			token?: unknown;
			grant?: { spaceId?: unknown; scopes?: unknown } | null;
			message?: unknown;
		} | null;
		if (!response.ok) {
			throw new AppAuthorizationError(
				typeof payload?.message === "string" ? payload.message : "Authorization failed.",
				response.status,
			);
		}
		const token = readTokenResponse(payload);
		if (!token) throw new Error("Invalid app authorization response.");
		const canonicalSpaceId =
			typeof payload?.grant?.spaceId === "string" && payload.grant.spaceId
				? payload.grant.spaceId
				: spaceId ?? app.spaceId;
		const grantedScopes = sanitizeRequestedScopes(payload?.grant?.scopes);
		const canonicalScopes = grantedScopes.length > 0 ? grantedScopes : clonePermissionScopes(scopes);
		appToken = token;
		sessionViewerGrants.set(canonicalSpaceId, {
			spaceId: canonicalSpaceId,
			scopes: canonicalScopes,
		});
		const viewerUuid = await getViewerUuid();
		syncGrantedAppScopes(viewerUuid, app.id, spaceId, canonicalSpaceId, canonicalScopes);
		return { token, spaceId: canonicalSpaceId, scopes: canonicalScopes };
	}

	/**
	 * Lists the viewer's spaces for the consent dialog picker. Fetched by the
	 * host with the viewer's own token — the app only ever learns the space
	 * the viewer picks, never the list.
	 */
	async function listViewerSpaces(): Promise<AppAuthorizeSpaceOption[] | null> {
		const request = async (forceRefresh = false) => {
			const userToken = await getAccessToken({ forceRefresh });
			if (!userToken) return null;
			return fetch(`${apiOrigin}/api/spaces`, {
				headers: { Authorization: `Bearer ${userToken}` },
			});
		};

		try {
			let response = await request();
			// The consent dialog can outlive the access token's short lifetime. A
			// single refresh keeps a stale cached token from looking like a missing
			// Space list without retrying genuine authorization failures forever.
			if (response?.status === 401) response = await request(true);
			if (!response?.ok) return null;
			const spaces = (await response.json()) as Array<{
				id?: unknown;
				name?: unknown;
				userUuid?: unknown;
				ownerUserUuid?: unknown;
				isPinned?: unknown;
			}>;
			if (!Array.isArray(spaces)) return null;
			return spaces.flatMap((space): AppAuthorizeSpaceOption[] => {
				if (typeof space.id !== "string" || !space.id) return [];
				return [{
					id: space.id,
					name: typeof space.name === "string" && space.name ? space.name : null,
					...(typeof (space.ownerUserUuid ?? space.userUuid) === "string"
						? { ownerUserUuid: (space.ownerUserUuid ?? space.userUuid) as string }
						: {}),
					...(typeof space.isPinned === "boolean" ? { isPinned: space.isPinned } : {}),
				}];
			});
		} catch {
			return null;
		}
	}

	const pickedSpaceStorageKey = `cohub:app-picked-space:${app.id}`;

	function readLastPickedSpace(): string | null {
		try {
			return localStorage.getItem(pickedSpaceStorageKey);
		} catch {
			return null;
		}
	}

	function writeLastPickedSpace(spaceId: string) {
		try {
			localStorage.setItem(pickedSpaceStorageKey, spaceId);
		} catch {
			// Ignore storage failures.
		}
	}

	/**
	 * Resolves the target space's name for the consent dialog. The host — not
	 * the app — resolves it, so the dialog cannot be tricked into labeling a
	 * grant with the wrong space.
	 */
	async function resolveSpaceName(spaceId: string): Promise<string | null> {
		const userToken = await getAccessToken();
		if (!userToken) return null;
		try {
			const response = await fetch(
				`${apiOrigin}/api/spaces/${encodeURIComponent(spaceId)}`,
				{ headers: { Authorization: `Bearer ${userToken}` } },
			);
			if (!response.ok) return null;
			const space = (await response.json()) as { name?: unknown };
			return typeof space.name === "string" && space.name ? space.name : null;
		} catch {
			return null;
		}
	}

	function writePendingPurchase(input: {
		orderId: string;
		productKey: string;
	}) {
		if (typeof sessionStorage === "undefined") return;
		try {
			sessionStorage.setItem(
				pendingPurchaseStorageKey,
				JSON.stringify({ ...input, at: Date.now() }),
			);
		} catch {
			// ignore storage failures
		}
	}

	function readPendingPurchase(): {
		orderId: string;
		productKey: string;
		at: number;
	} | null {
		if (typeof sessionStorage === "undefined") return null;
		try {
			const raw = sessionStorage.getItem(pendingPurchaseStorageKey);
			if (!raw) return null;
			const parsed = JSON.parse(raw) as {
				orderId?: unknown;
				productKey?: unknown;
				at?: unknown;
			};
			return typeof parsed.orderId === "string" &&
				typeof parsed.productKey === "string" &&
				typeof parsed.at === "number"
				? {
						orderId: parsed.orderId,
						productKey: parsed.productKey,
						at: parsed.at,
					}
				: null;
		} catch {
			return null;
		}
	}

	function clearPendingPurchase() {
		if (typeof sessionStorage === "undefined") return;
		try {
			sessionStorage.removeItem(pendingPurchaseStorageKey);
		} catch {
			// ignore storage failures
		}
	}

	async function createPurchase(
		productKey: string,
		purchaseAttemptId: string,
	) {
		const userToken = await getAccessToken();
		if (!userToken) {
			await config.requestSignIn(
				typeof location !== "undefined"
					? location.pathname + location.search + location.hash
					: "/",
			);
			return null;
		}
		const promotionAttribution = config.getPromotionAttribution?.() ?? null;
		const response = await fetch(
			`${apiOrigin}/api/apps/${app.id}/commerce/purchase`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${userToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					productKey,
					purchaseAttemptId,
					...(promotionAttribution ? { promotionAttribution } : {}),
				}),
			},
		);
		if (!response.ok)
			throw new Error(
				(await response.json().catch(() => null))?.message ??
					"Purchase failed.",
			);
		const json = await response.json();
		return (json as { checkout?: unknown }).checkout ?? null;
	}

	async function handleMessage(event: MessageEvent) {
		const data = event.data as {
			type?: string;
			requestId?: string;
			scopes?: Permission[];
			reason?: string;
			spaceId?: string;
			selectSpace?: boolean;
			alwaysAsk?: boolean;
			forceRefresh?: boolean;
			productKey?: string;
			purchaseAttemptId?: string;
		};
		if (!data?.requestId) return;
		const isLegacyWork = data.type?.startsWith("cohub.work.") === true;
		if (isLegacyWork) legacyRequestIds.add(data.requestId);
		try {
			if (data.type === "cohub.app.context" || data.type === "cohub.work.context") {
				const context = await getContext();
				replyForRequest(data.requestId, {
					type: "cohub.app.context.result",
					context: isLegacyWork ? toLegacyWorkContext(context) : context,
				}, true);
			}
			if (data.type === "cohub.app.token" || data.type === "cohub.work.token") {
				const token = await ensureBaseToken(Boolean(data.forceRefresh));
				replyForRequest(data.requestId, { type: "cohub.app.token.result", token }, true);
			}
			if (
				data.type === "cohub.app.checkout-state" ||
				data.type === "cohub.work.checkout-state"
			) {
				const pending = readPendingPurchase();
				const checkoutState = getCheckoutState();
				const orderId =
					checkoutState.orderId ?? pending?.orderId ?? null;
				if (checkoutState.status && checkoutState.orderId)
					clearPendingPurchase();
				replyForRequest(data.requestId, {
					type: "cohub.app.checkout-state.result",
					status: checkoutState.status,
					orderId,
				}, true);
			}
			if (data.type === "cohub.app.purchase" || data.type === "cohub.work.purchase") {
				const productKey =
					typeof data.productKey === "string" ? data.productKey.trim() : "";
				if (!productKey) {
					replyForRequest(data.requestId, {
						type: "cohub.app.error",
						message: "Product key is required.",
					}, true);
					return;
				}
				const suppliedPurchaseAttemptId =
					typeof data.purchaseAttemptId === "string"
						? data.purchaseAttemptId.trim()
						: "";
				const purchaseAttemptId = suppliedPurchaseAttemptId || data.requestId
					.replace(/[^a-zA-Z0-9_-]/g, "_")
					.slice(0, 128);
				if (!/^[a-zA-Z0-9_-]{1,128}$/.test(purchaseAttemptId)) {
					replyForRequest(data.requestId, {
						type: "cohub.app.error",
						message: "Purchase attempt id is invalid.",
					}, true);
					return;
				}
				const purchase = { requestId: data.requestId, productKey, purchaseAttemptId };
				const existing = purchaseInFlight.get(purchaseAttemptId);
				if (existing) {
					await replyPurchaseResult(purchase, existing);
					return;
				}
				if (activePurchase) {
					if (activePurchase.productKey !== productKey) {
						replyForRequest(data.requestId, {
							type: isLegacyWork ? "cohub.work.error" : "cohub.app.error",
							message: "Another purchase is already in progress.",
						}, true);
						return;
					}
					// Older SDKs may generate a new attempt id for every click. Coalesce
					// those requests while the same product is already being purchased.
					await replyPurchaseResult(purchase, activePurchase.promise);
					return;
				}
				config.onPurchaseRequested?.(purchase);
				const request = executePurchase(purchase);
				activePurchase = { productKey, promise: request };
				purchaseInFlight.set(purchaseAttemptId, request);
				try {
					await replyPurchaseResult(purchase, request);
				} finally {
					purchaseInFlight.delete(purchaseAttemptId);
					if (activePurchase?.promise === request) activePurchase = null;
				}
			}
			if (data.type === "cohub.app.authorize" || data.type === "cohub.work.authorize") {
				const scopes = sanitizeRequestedScopes(data.scopes);
				const spaceId =
					typeof data.spaceId === "string" && data.spaceId
						? data.spaceId
						: undefined;
				// Picker mode only applies when the app does not already know the
				// target space.
				const selectSpace = data.selectSpace === true && !spaceId;
				// `alwaysAsk` skips silent reuse so the viewer can re-confirm or
				// change the grant (e.g. switch to another Space).
				const alwaysAsk = data.alwaysAsk === true;
				if (scopes.length === 0) {
					replyForRequest(data.requestId, {
						type: "cohub.app.error",
						message: "No scopes requested.",
					}, true);
					return;
				}
				// The publisher's own app auto-authorizes without a dialog — but
				// never when the app explicitly asks for re-consent, and always
				// through the silent path so a revoked grant cannot come back
				// without the owner confirming it again. A failed silent attempt
				// (e.g. the owner revoked the grant) falls through to the consent
				// dialog like any other viewer.
				if (
					!selectSpace &&
					!alwaysAsk &&
					allowsOwnerAutoAuthorization() &&
					(await isCurrentViewerAppOwner())
				) {
					try {
						const result = await authorize(scopes, spaceId, { silent: true });
						replyForRequest(
							data.requestId,
							authorizeResult(
								result.token,
								result.spaceId,
								result.spaceId === app.spaceId ? app.spaceName ?? null : null,
							),
							true,
						);
						return;
					} catch (error) {
						if (!isDefinitiveAuthorizationFailure(error)) {
							replyForRequest(data.requestId, {
								type: "cohub.app.error",
								message: error instanceof Error ? error.message : "Authorization failed.",
							}, true);
							return;
						}
						// A definitive rejection needs fresh viewer consent.
					}
				}
				// Returning viewers who previously granted the requested scopes are
				// re-authorized silently with a fresh token — no consent dialog. In
				// picker mode the last picked space is reused.
				const viewerUuid = await getViewerUuid();
				// Picker mode can only go silent against the last picked space;
				// a home-space request needs no target at all.
				const silentSpaceId = selectSpace ? readLastPickedSpace() : spaceId;
				if (
					!alwaysAsk &&
					viewerUuid &&
					(selectSpace ? Boolean(silentSpaceId) : true) &&
					silentSpaceId !== null &&
					hasGrantedAppScopes(viewerUuid, app.id, scopes, silentSpaceId ?? undefined)
				) {
					try {
						const result = await authorize(scopes, silentSpaceId, { silent: true });
						replyForRequest(
							data.requestId,
							authorizeResult(result.token, result.spaceId, null),
							true,
						);
						return;
					} catch (error) {
						if (!isDefinitiveAuthorizationFailure(error)) {
							replyForRequest(data.requestId, {
								type: "cohub.app.error",
								message: error instanceof Error ? error.message : "Authorization failed.",
							}, true);
							return;
						}
						// The server rejected this grant: clear it and ask again.
						clearGrantedAppScopes(viewerUuid, app.id, silentSpaceId);
					}
				}
				const [spaceName, spaces] = await Promise.all([
					spaceId ? resolveSpaceName(spaceId) : Promise.resolve(null),
					selectSpace ? listViewerSpaces() : Promise.resolve(undefined),
				]);
				state.pendingAuth = {
					requestId: data.requestId,
					scopes,
					reason: sanitizeReason(data.reason),
					homeSpaceName: app.spaceName ?? null,
					...(spaceId ? { spaceId, spaceName } : {}),
					...(selectSpace ? { selectSpace: true, spaces: spaces ?? null } : {}),
				};
				state.authError = null;
				state.authOpen = true;
				notify();
			}
		} catch (error) {
			replyForRequest(data.requestId, {
				type: "cohub.app.error",
				message: error instanceof Error ? error.message : "Request failed.",
			}, true);
		}
	}

	function cancelAuth() {
		if (state.authSaving) return;
		if (!state.pendingAuth) return;
		replyForRequest(state.pendingAuth.requestId, {
			type: "cohub.app.authorize.result",
			token: null,
		}, true);
		state.authOpen = false;
		state.pendingAuth = null;
		state.authError = null;
		state.authSaving = false;
		notify();
	}

	async function executePurchase(purchase: AppPurchaseRequest) {
		const checkout = await createPurchase(
			purchase.productKey,
			purchase.purchaseAttemptId,
		);
		if (checkout && typeof checkout === "object") {
			const next = checkout as {
				checkoutUrl?: unknown;
				checkoutUsable?: unknown;
				orderId?: unknown;
				productKey?: unknown;
				value?: unknown;
				currency?: unknown;
			};
			if (typeof next.orderId === "string" && typeof next.productKey === "string") {
				writePendingPurchase({ orderId: next.orderId, productKey: next.productKey });
			}
			const url = next.checkoutUrl;
			if (next.checkoutUsable === true && typeof url === "string" && url) {
				config.onCheckoutStarted?.({
					...purchase,
					...(typeof next.value === "number" ? { value: next.value } : {}),
					...(typeof next.currency === "string" ? { currency: next.currency } : {}),
				});
				window.location.href = url;
			}
		}
		return checkout;
	}

	async function replyPurchaseResult(
		purchase: AppPurchaseRequest,
		request: Promise<unknown>,
	) {
		try {
			replyForRequest(purchase.requestId, {
				type: "cohub.app.purchase.result",
				checkout: await request,
			}, true);
		} catch (error) {
			replyForRequest(purchase.requestId, {
				type: "cohub.app.error",
				message: error instanceof Error ? error.message : "Purchase failed.",
			}, true);
		}
	}

	async function confirmAuth(pickedSpaceId?: string) {
		if (!state.pendingAuth || state.authSaving) return;
		const pending = state.pendingAuth;
		if (pending.selectSpace && !pickedSpaceId) {
			state.authError = "Pick a Space to continue.";
			notify();
			return;
		}
		state.authError = null;
		state.authSaving = true;
		notify();
		try {
			const requestedSpaceId = pending.selectSpace ? pickedSpaceId : pending.spaceId;
			const result = await authorize(pending.scopes, requestedSpaceId);
			const viewerUuid = await getViewerUuid();
			setGrantedAppScopes(viewerUuid, app.id, result.scopes, result.spaceId);
			if (pending.selectSpace) writeLastPickedSpace(result.spaceId);
			const spaceName = pending.selectSpace
				? pending.spaces?.find((space) => space.id === result.spaceId)?.name ?? null
				: pending.spaceName ?? app.spaceName ?? null;
			replyForRequest(
				pending.requestId,
				authorizeResult(result.token, result.spaceId, spaceName),
				true,
			);
			state.authOpen = false;
			state.pendingAuth = null;
		} catch (error) {
			state.authError =
				error instanceof Error ? error.message : "Authorization failed.";
		} finally {
			state.authSaving = false;
			notify();
		}
	}

	return {
		getState: () => ({ ...state }),
		handleMessage,
		notifyContextChanged,
		confirmAuth,
		cancelAuth,
	};
}
