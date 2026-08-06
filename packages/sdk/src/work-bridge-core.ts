import type { Permission } from "./types.js";
import type { WorkRecord } from "./apis/works.js";
import type {
	WorkRuntimeCheckoutState,
	WorkRuntimeNetaCharacter,
	WorkRuntimeNetaCharacterPage,
} from "./work-runtime.js";
import {
	clearGrantedWorkScopes,
	hasGrantedWorkScopes,
	setGrantedWorkScopes,
} from "./work-grant-cache.js";

/**
 * The subset of a work record the bridge host needs to answer bridge messages.
 * Matches what the iframe host (WorkSurface) and the broker page both have on
 * hand after loading the work.
 */
export type WorkBridgeCoreWork = Pick<
	WorkRecord,
	"id" | "spaceId" | "slug" | "userUuid" | "workScopes" | "allowedViewerScopes"
>;

const DEFAULT_NETA_API_ORIGIN = "https://api.talesofai.cn";
const NETA_CHARACTER_UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type NetaCharacterOperation = "search" | "favorites" | "favorite";

type NetaCharacterRequest = {
	operation?: unknown;
	keywords?: unknown;
	pageIndex?: unknown;
	pageSize?: unknown;
	uuid?: unknown;
	isCancel?: unknown;
};

/**
 * A pending authorize request surfaced to the UI as a consent dialog.
 */
export type WorkAuthorizeRequest = {
	requestId: string;
	scopes: Permission[];
	reason?: string;
};

/**
 * A pending purchase request surfaced to the UI as a checkout confirmation.
 */
export type WorkPurchaseRequest = {
	requestId: string;
	productKey: string;
	purchaseAttemptId: string;
};

/**
 * Reactive dialog state managed by the core. The host (Svelte or React)
 * subscribes via {@link WorkBridgeCoreConfig.onStateChange} and mirrors these
 * fields into its own reactive primitives.
 */
export type WorkBridgeDialogState = {
	authOpen: boolean;
	pendingAuth: WorkAuthorizeRequest | null;
	authError: string | null;
	authSaving: boolean;
	purchaseOpen: boolean;
	pendingPurchase: WorkPurchaseRequest | null;
	purchaseError: string | null;
	purchaseSaving: boolean;
};

/**
 * Resolves the current user's Cohub API access token. The core uses this to
 * mint work session / authorization tokens via the Cohub API.
 */
export type WorkBridgeGetAccessToken = (
	options?: { forceRefresh?: boolean },
) => Promise<string | null>;

/**
 * Resolves the current viewer's user UUID (or null when unauthenticated).
 * Used for ownership checks and silent re-authorization cache lookups.
 */
export type WorkBridgeGetViewerUuid = () => Promise<string | null>;

/**
 * Requests the host to start a sign-in flow, redirecting back to the given
 * path afterward. The core calls this when an API request fails due to missing
 * authentication.
 */
export type WorkBridgeRequestSignIn = (redirectPath: string) => Promise<void>;

/**
 * Configuration injected by the caller. The core is transport-agnostic: how a
 * reply is delivered back to the work (iframe postMessage vs opener
 * postMessage) and how the current checkout state is read (page URL) are the
 * caller's responsibility, so the same core serves both bridge and broker
 * hosts. Auth dependencies (token resolution, viewer identity, sign-in) are
 * also injected so the core stays free of any framework's store/auth plumbing.
 */
export type WorkBridgeCoreConfig = {
	work: WorkBridgeCoreWork;
	/** True when running as a background chat surface (owner auto-authorizes). */
	isBackground?: boolean;
	/** Base origin for Cohub API requests (e.g. "https://cohub.run"). */
	apiOrigin: string;
	/** Base origin for the first-party TalesofAI API. */
	netaApiOrigin?: string;
	/** Sends a reply payload back to the work runtime. */
	reply: (requestId: string, payload: Record<string, unknown>) => void;
	/** Reads the current checkout state (typically derived from the page URL). */
	getCheckoutState: () => WorkRuntimeCheckoutState;
	/** Resolves the current user's Cohub access token. */
	getAccessToken: WorkBridgeGetAccessToken;
	/** Resolves the current viewer's user UUID. */
	getViewerUuid: WorkBridgeGetViewerUuid;
	/** Starts a sign-in flow with a post-login redirect path. */
	requestSignIn: WorkBridgeRequestSignIn;
	/** Called whenever the dialog state changes, for reactive UI binding. */
	onStateChange?: (state: WorkBridgeDialogState) => void;
};

export type WorkBridgeCore = {
	/** Returns a snapshot of the current dialog state. */
	getState: () => WorkBridgeDialogState;
	/** Processes an inbound bridge message (already source/origin-validated). */
	handleMessage: (event: MessageEvent) => Promise<void>;
	/** Confirm/cancel handlers for the authorize dialog. */
	confirmAuth: () => Promise<void>;
	cancelAuth: () => void;
	/** Confirm/cancel handlers for the purchase dialog. */
	confirmPurchase: () => Promise<void>;
	cancelPurchase: () => void;
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
 * Framework-agnostic work bridge host core — message handling, work session
 * token minting, authorization (with silent re-grant cache), and
 * purchase/checkout flow — without any rendering or reactive primitives.
 *
 * Both the Cohub iframe host (WorkSurface, Svelte) and the standalone broker
 * page compose this with their own transport-specific reply and auth
 * dependencies. External hosts (e.g. Neta-Studio in React) can do the same.
 */
export function createWorkBridgeCore(
	config: WorkBridgeCoreConfig,
): WorkBridgeCore {
	const { work, reply, getCheckoutState, getAccessToken, getViewerUuid } =
		config;
	const apiOrigin = config.apiOrigin;
	const netaApiOrigin = (config.netaApiOrigin ?? DEFAULT_NETA_API_ORIGIN).replace(/\/+$/, "");
	const isBackground = config.isBackground ?? false;
	const onStateChange = config.onStateChange;

	let workToken: string | null = null;
	const grantedNetaScopes = new Set<Permission>();

	const state: WorkBridgeDialogState = {
		authOpen: false,
		pendingAuth: null,
		authError: null,
		authSaving: false,
		purchaseOpen: false,
		pendingPurchase: null,
		purchaseError: null,
		purchaseSaving: false,
	};

	function notify() {
		onStateChange?.({ ...state });
	}

	const pendingPurchaseStorageKey = `cohub-work-purchase:${work.id}`;

	async function isCurrentViewerWorkOwner() {
		const viewerUuid = await getViewerUuid();
		return Boolean(viewerUuid && viewerUuid === work.userUuid);
	}

	async function ensureBaseToken(forceRefresh = false) {
		if (workToken && !forceRefresh) return workToken;
		const userToken = await getAccessToken({ forceRefresh });
		if (!userToken) {
			await config.requestSignIn(
				typeof location !== "undefined" ? location.pathname : "/",
			);
			return null;
		}
		const response = await fetch(
			`${apiOrigin}/api/works/${work.id}/session`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${userToken}` },
			},
		);
		if (!response.ok) throw new Error("Failed to create work session.");
		const token = readTokenResponse(await response.json());
		if (!token) throw new Error("Invalid work session response.");
		workToken = token;
		return workToken;
	}

	async function authorize(scopes: Permission[]) {
		const userToken = await getAccessToken();
		if (!userToken) {
			await config.requestSignIn(
				typeof location !== "undefined" ? location.pathname : "/",
			);
			return null;
		}
		const response = await fetch(
			`${apiOrigin}/api/works/${work.id}/authorize`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${userToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ scopes }),
			},
		);
		if (!response.ok)
			throw new Error(
				(await response.json().catch(() => null))?.message ??
					"Authorization failed.",
			);
		const token = readTokenResponse(await response.json());
		if (!token) throw new Error("Invalid work authorization response.");
		workToken = token;
		for (const scope of scopes) {
			if (scope === "neta.character.read" || scope === "neta.character.favorite") {
				grantedNetaScopes.add(scope);
			}
		}
		return workToken;
	}

	function readPageNumber(value: unknown, fallback: number, max: number) {
		return typeof value === "number" && Number.isInteger(value) && value >= 0
			? Math.min(value, max)
			: fallback;
	}

	function readPageSize(value: unknown) {
		return typeof value === "number" && Number.isInteger(value) && value >= 1
			? Math.min(value, 40)
			: 20;
	}

	function readNetaCharacter(value: unknown): WorkRuntimeNetaCharacter | null {
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const record = value as Record<string, unknown>;
		if (typeof record.uuid !== "string" || !NETA_CHARACTER_UUID_RE.test(record.uuid)) return null;
		const configValue = record.config && typeof record.config === "object" && !Array.isArray(record.config)
			? record.config as Record<string, unknown>
			: null;
		const charInfo = configValue?.char_info && typeof configValue.char_info === "object" && !Array.isArray(configValue.char_info)
			? configValue.char_info as Record<string, unknown>
			: null;
		const name = typeof record.name === "string" ? record.name.trim() : "";
		if (!name) return null;
		const shortName = typeof record.short_name === "string" && record.short_name.trim()
			? record.short_name.trim()
			: name.split("#")[0]?.trim() || name;
		const description = typeof record.biography === "string"
			? record.biography.trim()
			: typeof charInfo?.background === "string"
				? charInfo.background.trim()
				: null;
		return {
			uuid: record.uuid,
			name,
			shortName,
			type: typeof record.type === "string" ? record.type : null,
			avatarUrl: typeof configValue?.avatar_img === "string" && configValue.avatar_img ? configValue.avatar_img : null,
			headerUrl: typeof configValue?.header_img === "string" && configValue.header_img ? configValue.header_img : null,
			description: description || null,
			isFavored: record.is_favored === true,
		};
	}

	function normalizeNetaPage(value: unknown, fallbackPageIndex: number, fallbackPageSize: number): WorkRuntimeNetaCharacterPage {
		const record = value && typeof value === "object" && !Array.isArray(value)
			? value as Record<string, unknown>
			: {};
		const rawList = Array.isArray(record.list) ? record.list : [];
		const list = rawList.map(readNetaCharacter).filter((item): item is WorkRuntimeNetaCharacter => item !== null);
		const total = typeof record.total === "number" && Number.isFinite(record.total) ? Math.max(0, Math.trunc(record.total)) : list.length;
		const pageIndex = typeof record.page_index === "number" && Number.isInteger(record.page_index) ? Math.max(0, record.page_index) : fallbackPageIndex;
		const pageSize = typeof record.page_size === "number" && Number.isInteger(record.page_size) ? Math.max(0, record.page_size) : fallbackPageSize;
		return {
			list,
			total,
			pageIndex,
			pageSize,
			hasNext: record.has_next === true || (pageSize > 0 && (pageIndex + 1) * pageSize < total),
		};
	}

	function parseNetaOperation(value: unknown): NetaCharacterOperation | null {
		return value === "search" || value === "favorites" || value === "favorite" ? value : null;
	}

	async function requestNetaCharacters(input: NetaCharacterRequest) {
		const operation = parseNetaOperation(input.operation);
		if (!operation) throw new Error("Neta character operation is invalid.");
		const allowedScopes = clonePermissionScopes(work.allowedViewerScopes);
		const requiredScopes = operation === "favorite"
			? ["neta.character.read", "neta.character.favorite"]
			: ["neta.character.read"];
		if (!requiredScopes.every((scope) => allowedScopes.includes(scope as Permission))) {
			throw new Error("Neta character access is not enabled for this work.");
		}
		if (!requiredScopes.every((scope) => grantedNetaScopes.has(scope as Permission))) {
			throw new Error("Authorize TalesofAI character access before continuing.");
		}

		const token = await getAccessToken();
		if (!token) {
			await config.requestSignIn(typeof location !== "undefined" ? location.pathname : "/");
			throw new Error("Authentication is required.");
		}

		const pageIndex = readPageNumber(input.pageIndex, 0, 100_000);
		const pageSize = readPageSize(input.pageSize);
		const request = async (accessToken: string) => {
			if (operation === "favorite") {
				if (typeof input.uuid !== "string" || !NETA_CHARACTER_UUID_RE.test(input.uuid)) {
					throw new Error("Character id is invalid.");
				}
				if (typeof input.isCancel !== "boolean") throw new Error("Favorite action is invalid.");
				return fetch(`${netaApiOrigin}/v2/travel/parent/parent-favor`, {
					method: "PUT",
					headers: {
						Authorization: `Bearer ${accessToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ uuid: input.uuid, is_cancel: input.isCancel }),
				});
			}
			const keywords = typeof input.keywords === "string" ? input.keywords.trim() : "";
			if (keywords.length > 128) throw new Error("Search keywords are too long.");
			const params = new URLSearchParams({
				page_index: String(pageIndex),
				page_size: String(pageSize),
			});
			if (operation === "favorites") params.set("parent_type", "all");
			if (operation === "search") params.set("keywords", keywords);
			return fetch(
				`${netaApiOrigin}${operation === "search" ? "/v2/travel/parent-search-community" : "/v2/travel/parent/parent-favor/list"}?${params.toString()}`,
				{ headers: { Authorization: `Bearer ${accessToken}` } },
			);
		};

		let response = await request(token);
		if (response.status === 401) {
			const refreshedToken = await getAccessToken({ forceRefresh: true });
			if (!refreshedToken) throw new Error("Authentication is required.");
			response = await request(refreshedToken);
		}
		if (!response.ok) {
			const body = await response.json().catch(() => null) as { detail?: unknown; message?: unknown } | null;
			const detail = typeof body?.detail === "string" ? body.detail : typeof body?.message === "string" ? body.message : null;
			throw new Error(detail || `TalesofAI request failed (${response.status}).`);
		}
		if (operation === "favorite") return { ok: true };
		return { page: normalizeNetaPage(await response.json(), pageIndex, pageSize) };
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
		const response = await fetch(
			`${apiOrigin}/api/works/${work.id}/commerce/purchase`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${userToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ productKey, purchaseAttemptId }),
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
			forceRefresh?: boolean;
			productKey?: string;
			purchaseAttemptId?: string;
			operation?: unknown;
			keywords?: unknown;
			pageIndex?: unknown;
			pageSize?: unknown;
			uuid?: unknown;
			isCancel?: unknown;
		};
		if (!data?.requestId) return;
		try {
			if (data.type === "cohub.work.context") {
				const workScopes = clonePermissionScopes(work.workScopes);
				reply(data.requestId, {
					type: "cohub.work.context.result",
					context: {
						work: {
							id: work.id,
							slug: work.slug,
							url: typeof location !== "undefined" ? location.href : "",
						},
						space: { id: work.spaceId },
						permissions: {
							scopes: workScopes,
							workScopes,
							viewerScopes: [],
						},
					},
				});
			}
			if (data.type === "cohub.work.token") {
				const token = await ensureBaseToken(Boolean(data.forceRefresh));
				reply(data.requestId, { type: "cohub.work.token.result", token });
			}
			if (data.type === "cohub.work.checkout-state") {
				const pending = readPendingPurchase();
				const checkoutState = getCheckoutState();
				const orderId =
					checkoutState.orderId ?? pending?.orderId ?? null;
				if (checkoutState.status && checkoutState.orderId)
					clearPendingPurchase();
				reply(data.requestId, {
					type: "cohub.work.checkout-state.result",
					status: checkoutState.status,
					orderId,
				});
			}
			if (data.type === "cohub.neta.characters") {
				const result = await requestNetaCharacters(data);
				reply(data.requestId, {
					type: "cohub.neta.characters.result",
					...result,
				});
			}
			if (data.type === "cohub.work.purchase") {
				const productKey =
					typeof data.productKey === "string" ? data.productKey.trim() : "";
				if (!productKey) {
					reply(data.requestId, {
						type: "cohub.work.error",
						message: "Product key is required.",
					});
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
					reply(data.requestId, {
						type: "cohub.work.error",
						message: "Purchase attempt id is invalid.",
					});
					return;
				}
				state.pendingPurchase = {
					requestId: data.requestId,
					productKey,
					purchaseAttemptId,
				};
				state.purchaseError = null;
				state.purchaseOpen = true;
				notify();
			}
			if (data.type === "cohub.work.authorize") {
				const allowedViewerScopes = clonePermissionScopes(
					work.allowedViewerScopes,
				);
				const scopes = clonePermissionScopes(data.scopes).filter((scope) =>
					allowedViewerScopes.includes(scope),
				);
				if (scopes.length === 0) {
					reply(data.requestId, {
						type: "cohub.work.error",
						message: "No allowed scopes requested.",
					});
					return;
				}
				if (isBackground && (await isCurrentViewerWorkOwner())) {
					const token = await authorize(scopes);
					reply(data.requestId, {
						type: "cohub.work.authorize.result",
						token,
					});
					return;
				}
				// Returning viewers who previously granted the requested scopes are
				// re-authorized silently with a fresh token — no consent dialog.
				const viewerUuid = await getViewerUuid();
				if (
					viewerUuid &&
					hasGrantedWorkScopes(viewerUuid, work.id, scopes)
				) {
					try {
						const token = await authorize(scopes);
						reply(data.requestId, {
							type: "cohub.work.authorize.result",
							token,
						});
						return;
					} catch {
						// Granted scopes may have changed server-side; clear the stale
						// cache and fall back to the consent dialog so the viewer can
						// re-authorize.
						clearGrantedWorkScopes(viewerUuid, work.id);
					}
				}
				state.pendingAuth = {
					requestId: data.requestId,
					scopes,
					reason: data.reason,
				};
				state.authError = null;
				state.authOpen = true;
				notify();
			}
		} catch (error) {
			reply(data.requestId, {
				type: "cohub.work.error",
				message: error instanceof Error ? error.message : "Request failed.",
			});
		}
	}

	function cancelAuth() {
		if (state.authSaving) return;
		if (!state.pendingAuth) return;
		reply(state.pendingAuth.requestId, {
			type: "cohub.work.authorize.result",
			token: null,
		});
		state.authOpen = false;
		state.pendingAuth = null;
		state.authError = null;
		state.authSaving = false;
		notify();
	}

	function cancelPurchase() {
		if (state.purchaseSaving) return;
		if (!state.pendingPurchase) return;
		reply(state.pendingPurchase.requestId, {
			type: "cohub.work.purchase.result",
			checkout: null,
		});
		state.purchaseOpen = false;
		state.purchaseError = null;
		state.pendingPurchase = null;
		state.purchaseSaving = false;
		notify();
	}

	async function confirmPurchase() {
		if (!state.pendingPurchase || state.purchaseSaving) return;
		state.purchaseSaving = true;
		state.purchaseError = null;
		notify();
		try {
			const checkout = await createPurchase(
				state.pendingPurchase.productKey,
				state.pendingPurchase.purchaseAttemptId,
			);
			reply(state.pendingPurchase.requestId, {
				type: "cohub.work.purchase.result",
				checkout,
			});
			if (checkout && typeof checkout === "object") {
				const next = checkout as {
					checkoutUrl?: unknown;
					checkoutUsable?: unknown;
					orderId?: unknown;
					productKey?: unknown;
				};
				if (
					typeof next.orderId === "string" &&
					typeof next.productKey === "string"
				) {
					writePendingPurchase({
						orderId: next.orderId,
						productKey: next.productKey,
					});
				}
				const url = next.checkoutUrl;
				const usable = next.checkoutUsable === true;
				if (usable && typeof url === "string" && url) {
					window.location.href = url;
				}
			}
			state.purchaseOpen = false;
			state.pendingPurchase = null;
		} catch (error) {
			state.purchaseError =
				error instanceof Error ? error.message : "Purchase failed.";
		} finally {
			state.purchaseSaving = false;
			notify();
		}
	}

	async function confirmAuth() {
		if (!state.pendingAuth || state.authSaving) return;
		state.authError = null;
		state.authSaving = true;
		notify();
		try {
			const token = await authorize(state.pendingAuth.scopes);
			const viewerUuid = await getViewerUuid();
			setGrantedWorkScopes(
				viewerUuid,
				work.id,
				state.pendingAuth.scopes,
			);
			reply(state.pendingAuth.requestId, {
				type: "cohub.work.authorize.result",
				token,
			});
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
		confirmAuth,
		cancelAuth,
		confirmPurchase,
		cancelPurchase,
	};
}
