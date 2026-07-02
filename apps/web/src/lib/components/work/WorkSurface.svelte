<script lang="ts">
import type { Permission, WorkRecord, WorkTargetType } from "@neta-art/cohub";
import {
	AlertTriangle,
	Check,
	CreditCard,
	Loader2,
	ShieldCheck,
} from "lucide-svelte";
import { onDestroy, onMount } from "svelte";
import { page } from "$app/state";
import { PUBLIC_API_ORIGIN } from "$env/static/public";
import { getAuthToken, signInWithRedirectPath } from "$lib/auth";
import EmbeddedCheckoutDialog from "$lib/components/billing/EmbeddedCheckoutDialog.svelte";
import Dialog from "$lib/components/Dialog.svelte";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import { readWorkCheckoutState } from "$lib/components/work/work-checkout-state";
import { parseNewChatBackgroundAction } from "$lib/new-chat-background-bridge";
import { emitSpaceConfigBackgroundAction } from "$lib/space-config";
import { authStore } from "$lib/stores/auth.svelte";
import {
	clearGrantedWorkScopes,
	hasGrantedWorkScopes,
	setGrantedWorkScopes,
} from "$lib/stores/work-grant-cache";

type WorkSurfaceMode = "page" | "background";
type WorkContent =
	| { url: string; targetType: "port"; port: string }
	| { url: string; targetType: WorkTargetType; path: string };

type WorkSpace = {
	id: string;
	slug: string | null;
	name: string | null;
	userUuid: string;
	publicProfile?: { avatarUrl: string | null } | null;
};

type WorkOwner = {
	username: string | null;
	displayName: string;
	avatarUrl?: string | null;
} | null;
type WorkCheckoutStatus = "success" | "failed" | "cancel";
type WorkPurchaseCheckout = {
	providerKey: string | null;
	checkoutUrl: string | null;
	checkoutClientSecret: string | null;
	checkoutUiMode: string | null;
	checkoutUsable: boolean;
	status: string | null;
	message: string | null;
	orderId: string;
	productKey: string;
};
type WorkCommerceOrder = {
	id: string;
	status: string;
	paidAt: string | null;
};

type Props = {
	work: Pick<
		WorkRecord,
		| "id"
		| "spaceId"
		| "userUuid"
		| "slug"
		| "visibility"
		| "targetType"
		| "targetRef"
		| "workScopes"
		| "allowedViewerScopes"
		| "meta"
	>;
	space?: WorkSpace | null;
	owner?: WorkOwner;
	content?: WorkContent | null;
	mode?: WorkSurfaceMode;
};

const {
	work,
	space = null,
	owner = null,
	content = null,
	mode = "page",
}: Props = $props();

let frame: HTMLIFrameElement | null = $state(null);
let bridgeReady = $state(false);
let workToken = $state<string | null>(null);
let authOpen = $state(false);
let purchaseOpen = $state(false);
let purchaseError = $state<string | null>(null);
let purchaseSaving = $state(false);
let pendingPurchase = $state<{ requestId: string; productKey: string } | null>(
	null,
);
let embeddedCheckout = $state<{
	clientSecret: string;
	title: string;
	orderId: string;
	requestId: string;
	checkout: WorkPurchaseCheckout;
} | null>(null);
let completedCheckout = $state<{
	status: WorkCheckoutStatus;
	orderId: string;
} | null>(null);
let pendingAuth = $state<{
	requestId: string;
	scopes: Permission[];
	reason?: string;
} | null>(null);
let authError = $state<string | null>(null);
let authSaving = $state(false);

const isBackground = $derived(mode === "background");
const spaceName = $derived(space?.name || space?.slug || "Space");
const publisherName = $derived(owner?.displayName ?? "Cohub");
const publisherAvatarUrl = $derived(owner?.avatarUrl?.trim() || null);
const hideCohubBar = $derived(work.meta?.presentation?.hideCohubBar === true);
const iframeSrc = $derived.by(
	() => content?.url ?? (work.targetType === "port" ? work.targetRef : ""),
);
function isAllowedFrameOrigin(origin: string, targetType: string) {
	try {
		const { protocol, hostname } = new URL(origin);
		if (protocol !== "https:") return false;
		if (targetType === "port")
			return hostname === "cohub.run" || hostname.endsWith(".cohub.run");
		return true;
	} catch {
		return false;
	}
}

const frameOrigin = $derived.by(() => {
	if (!iframeSrc) return null;
	try {
		const origin = new URL(iframeSrc, page.url).origin;
		if (origin === page.url.origin) return origin;
		return isAllowedFrameOrigin(origin, work.targetType) ? origin : null;
	} catch {
		return null;
	}
});
const hasFrameSource = $derived(Boolean(iframeSrc && frameOrigin));
const shouldRenderFrame = $derived(Boolean(bridgeReady && hasFrameSource));
const frameReplyTarget = $derived(frameOrigin ?? page.url.origin);
const framePreconnectOrigin = $derived.by(() => {
	if (!frameOrigin || frameOrigin === page.url.origin) return null;
	return frameOrigin;
});
const frameSandbox =
	"allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals";
const checkoutState = $derived(readWorkCheckoutState(page.url));
const pendingPurchaseStorageKey = $derived(`cohub-work-purchase:${work.id}`);
const completedPurchaseStorageKey = $derived(
	`cohub-work-purchase:${work.id}:completed`,
);
const CHECKOUT_COMPLETION_TTL_MS = 24 * 60 * 60 * 1000;

function readTokenResponse(value: unknown) {
	if (!value || typeof value !== "object") return null;
	const token = (value as Record<string, unknown>).token;
	return typeof token === "string" && token ? token : null;
}

async function isCurrentViewerWorkOwner() {
	await authStore.ensureLoaded();
	return Boolean(authStore.userUuid && authStore.userUuid === work.userUuid);
}

async function ensureBaseToken(forceRefresh = false) {
	if (workToken && !forceRefresh) return workToken;
	const userToken = await getAuthToken({ forceRefresh });
	if (!userToken) {
		await signInWithRedirectPath(location.pathname);
		return null;
	}
	const response = await fetch(
		`${PUBLIC_API_ORIGIN ?? ""}/api/works/${work.id}/session`,
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
	const userToken = await getAuthToken();
	if (!userToken) {
		await signInWithRedirectPath(location.pathname);
		return null;
	}
	const response = await fetch(
		`${PUBLIC_API_ORIGIN ?? ""}/api/works/${work.id}/authorize`,
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
	return workToken;
}

function clonePermissionScopes(
	scopes: readonly Permission[] | null | undefined,
) {
	return Array.from(scopes ?? []).filter(
		(scope): scope is Permission => typeof scope === "string",
	);
}

function reply(requestId: string, payload: Record<string, unknown>) {
	if (!frameOrigin) return;
	frame?.contentWindow?.postMessage(
		{ requestId, ...payload },
		frameReplyTarget,
	);
}

function formatScopeLabel(scope: string) {
	const labels: Record<string, string> = {
		"session.prompt.readonly": "Prompt read-only",
		"session.prompt.fullaccess": "Prompt full access",
		"generation.create": "Create generations",
		"file.view": "View files",
		"taskrun.view": "View task runs",
		"user.space.list": "List your spaces",
		"user.session.list": "List your sessions",
		"user.usage.read": "Read your usage",
	};
	return labels[scope] ?? scope;
}

function formatScopeDescription(scope: string) {
	const descriptions: Record<string, string> = {
		"session.prompt.readonly":
			"Read prompts and session context without making changes.",
		"session.prompt.fullaccess":
			"Send prompts and act in the session with your approval.",
		"generation.create": "Start image, video, or other generation tasks.",
		"file.view": "Read files in this space.",
		"taskrun.view": "View task progress and results in this space.",
		"user.space.list":
			"See the list of spaces you own or belong to across your account.",
		"user.session.list": "See sessions you created across all your spaces.",
		"user.usage.read": "Read your aggregated token usage and cost statistics.",
	};
	return (
		descriptions[scope] ?? "Grant this work the requested Cohub permission."
	);
}

function replyAuthCancel() {
	if (authSaving) return;
	if (!pendingAuth) return;
	reply(pendingAuth.requestId, {
		type: "cohub.work.authorize.result",
		token: null,
	});
	authOpen = false;
	pendingAuth = null;
	authError = null;
	authSaving = false;
}

function replyPurchaseCancel() {
	if (purchaseSaving) return;
	if (!pendingPurchase) return;
	reply(pendingPurchase.requestId, {
		type: "cohub.work.purchase.result",
		checkout: null,
	});
	purchaseOpen = false;
	purchaseError = null;
	pendingPurchase = null;
	purchaseSaving = false;
}

function isWorkPurchaseCheckout(value: unknown): value is WorkPurchaseCheckout {
	if (!value || typeof value !== "object") return false;
	const checkout = value as Record<string, unknown>;
	return (
		typeof checkout.orderId === "string" &&
		typeof checkout.productKey === "string" &&
		typeof checkout.checkoutUsable === "boolean"
	);
}

function writePendingPurchase(input: { orderId: string; productKey: string }) {
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

function writeCheckoutCompletion(input: {
	status: WorkCheckoutStatus;
	orderId: string;
}) {
	if (typeof sessionStorage === "undefined") return;
	try {
		sessionStorage.setItem(
			completedPurchaseStorageKey,
			JSON.stringify({ ...input, at: Date.now() }),
		);
	} catch {
		// ignore storage failures
	}
}

function readCheckoutCompletion(): {
	status: WorkCheckoutStatus;
	orderId: string;
	at: number;
} | null {
	if (typeof sessionStorage === "undefined") return null;
	try {
		const raw = sessionStorage.getItem(completedPurchaseStorageKey);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as {
			status?: unknown;
			orderId?: unknown;
			at?: unknown;
		};
		if (
			typeof parsed.at === "number" &&
			Date.now() - parsed.at > CHECKOUT_COMPLETION_TTL_MS
		) {
			sessionStorage.removeItem(completedPurchaseStorageKey);
			return null;
		}
		return (parsed.status === "success" ||
			parsed.status === "failed" ||
			parsed.status === "cancel") &&
			typeof parsed.orderId === "string" &&
			typeof parsed.at === "number"
			? {
					status: parsed.status,
					orderId: parsed.orderId,
					at: parsed.at,
				}
			: null;
	} catch {
		return null;
	}
}

function clearCheckoutCompletion() {
	if (typeof sessionStorage === "undefined") return;
	try {
		sessionStorage.removeItem(completedPurchaseStorageKey);
	} catch {
		// ignore storage failures
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

async function createPurchase(productKey: string) {
	const userToken = await getAuthToken();
	if (!userToken) {
		await signInWithRedirectPath(
			location.pathname + location.search + location.hash,
		);
		return null;
	}
	const response = await fetch(
		`${PUBLIC_API_ORIGIN ?? ""}/api/works/${work.id}/commerce/purchase`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${userToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ productKey }),
		},
	);
	if (!response.ok)
		throw new Error(
			(await response.json().catch(() => null))?.message ?? "Purchase failed.",
		);
	const json = await response.json();
	return (json as { checkout?: unknown }).checkout ?? null;
}

async function getWorkOrder(
	orderId: string,
): Promise<WorkCommerceOrder | null> {
	const userToken = await getAuthToken();
	if (!userToken) return null;
	const response = await fetch(
		`${PUBLIC_API_ORIGIN ?? ""}/api/works/${work.id}/commerce/orders/${encodeURIComponent(orderId)}`,
		{
			headers: { Authorization: `Bearer ${userToken}` },
		},
	);
	if (!response.ok) return null;
	const json = (await response.json().catch(() => null)) as {
		order?: unknown;
	} | null;
	const order = json?.order;
	if (!order || typeof order !== "object") return null;
	const record = order as Record<string, unknown>;
	return typeof record.id === "string" && typeof record.status === "string"
		? {
				id: record.id,
				status: record.status,
				paidAt: typeof record.paidAt === "string" ? record.paidAt : null,
			}
		: null;
}

function checkoutStatusFromOrder(
	order: WorkCommerceOrder,
): WorkCheckoutStatus | null {
	const status = order.status.toLowerCase();
	if (
		order.paidAt ||
		status === "paid" ||
		status === "success" ||
		status === "succeeded" ||
		status === "completed"
	) {
		return "success";
	}
	if (status === "failed" || status === "payment_failed") return "failed";
	if (
		status === "cancel" ||
		status === "canceled" ||
		status === "cancelled" ||
		status === "expired"
	) {
		return "cancel";
	}
	return null;
}

async function recoverRedirectCheckoutState(orderId: string) {
	const order = await getWorkOrder(orderId);
	if (!order) return null;
	const status = checkoutStatusFromOrder(order);
	if (!status) return null;
	const completion = { status, orderId };
	completedCheckout = completion;
	writeCheckoutCompletion(completion);
	clearPendingPurchase();
	return completion;
}

async function handleMessage(event: MessageEvent) {
	if (event.source !== frame?.contentWindow) return;
	if (!frameOrigin || event.origin !== frameOrigin) return;
	if (isBackground) {
		const action = parseNewChatBackgroundAction(event.data);
		if (action) {
			emitSpaceConfigBackgroundAction(action);
			return;
		}
	}
	const data = event.data as {
		type?: string;
		requestId?: string;
		scopes?: Permission[];
		reason?: string;
		forceRefresh?: boolean;
		productKey?: string;
	};
	if (!data?.requestId) return;
	try {
		if (!frameOrigin) return;
		if (data.type === "cohub.work.context") {
			const workScopes = clonePermissionScopes(work.workScopes);
			reply(data.requestId, {
				type: "cohub.work.context.result",
				context: {
					work: {
						id: work.id,
						slug: work.slug,
						url: location.href,
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
			const pendingPurchase = readPendingPurchase();
			const completedPurchase = readCheckoutCompletion();
			let status =
				completedCheckout?.status ??
				completedPurchase?.status ??
				checkoutState.status;
			let orderId =
				completedCheckout?.orderId ??
				completedPurchase?.orderId ??
				checkoutState.orderId ??
				pendingPurchase?.orderId ??
				null;
			if (
				!status &&
				pendingPurchase?.orderId &&
				page.url.searchParams.has("checkout_session_id")
			) {
				const recovered = await recoverRedirectCheckoutState(
					pendingPurchase.orderId,
				);
				status = recovered?.status ?? status;
				orderId = recovered?.orderId ?? orderId;
			}
			if (status && orderId) clearPendingPurchase();
			reply(data.requestId, {
				type: "cohub.work.checkout-state.result",
				status,
				orderId,
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
			pendingPurchase = { requestId: data.requestId, productKey };
			completedCheckout = null;
			clearCheckoutCompletion();
			purchaseError = null;
			purchaseOpen = true;
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
			await authStore.ensureLoaded();
			const viewerUuid = authStore.userUuid;
			if (viewerUuid && hasGrantedWorkScopes(viewerUuid, work.id, scopes)) {
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
			pendingAuth = {
				requestId: data.requestId,
				scopes,
				reason: data.reason,
			};
			authError = null;
			authOpen = true;
		}
	} catch (error) {
		reply(data.requestId, {
			type: "cohub.work.error",
			message: error instanceof Error ? error.message : "Request failed.",
		});
	}
}

function finishEmbeddedCheckout(status: WorkCheckoutStatus) {
	if (!embeddedCheckout) return;
	const current = embeddedCheckout;
	const completion = {
		status,
		orderId: current.orderId,
	};
	completedCheckout = completion;
	writeCheckoutCompletion(completion);
	clearPendingPurchase();
	reply(current.requestId, {
		type: "cohub.work.purchase.result",
		checkout:
			status === "success" ? { ...current.checkout, status: "success" } : null,
	});
	embeddedCheckout = null;
}

async function confirmPurchase() {
	if (!pendingPurchase || purchaseSaving) return;
	const currentPurchase = pendingPurchase;
	purchaseSaving = true;
	purchaseError = null;
	try {
		const checkout = await createPurchase(currentPurchase.productKey);
		if (isWorkPurchaseCheckout(checkout)) {
			writePendingPurchase({
				orderId: checkout.orderId,
				productKey: checkout.productKey,
			});
			const secret = checkout.checkoutClientSecret;
			const usable = checkout.checkoutUsable === true;
			if (
				usable &&
				checkout.checkoutUiMode === "embedded_page" &&
				typeof secret === "string" &&
				secret
			) {
				embeddedCheckout = {
					clientSecret: secret,
					title: currentPurchase.productKey,
					orderId: checkout.orderId,
					requestId: currentPurchase.requestId,
					checkout,
				};
				purchaseOpen = false;
				pendingPurchase = null;
				return;
			}
			const url = checkout.checkoutUrl;
			if (usable && typeof url === "string" && url) {
				window.location.href = url;
			}
		}
		reply(currentPurchase.requestId, {
			type: "cohub.work.purchase.result",
			checkout,
		});
		purchaseOpen = false;
		pendingPurchase = null;
	} catch (error) {
		purchaseError = error instanceof Error ? error.message : "Purchase failed.";
	} finally {
		purchaseSaving = false;
	}
}

async function confirmAuth() {
	if (!pendingAuth || authSaving) return;
	authError = null;
	authSaving = true;
	try {
		const token = await authorize(pendingAuth.scopes);
		await authStore.ensureLoaded();
		setGrantedWorkScopes(authStore.userUuid, work.id, pendingAuth.scopes);
		reply(pendingAuth.requestId, {
			type: "cohub.work.authorize.result",
			token,
		});
		authOpen = false;
		pendingAuth = null;
	} catch (error) {
		authError =
			error instanceof Error ? error.message : "Authorization failed.";
	} finally {
		authSaving = false;
	}
}

onMount(() => {
	window.addEventListener("message", handleMessage);
	bridgeReady = true;
});
onDestroy(() => window.removeEventListener("message", handleMessage));
</script>

<svelte:head>
	{#if mode === "page"}
		<title>{work.slug} · Cohub</title>
	{/if}
	{#if framePreconnectOrigin}
		<link rel="preconnect" href={framePreconnectOrigin} crossorigin="anonymous" />
	{/if}
</svelte:head>

<div class={isBackground ? "work-surface background" : "work-surface page"}>
	{#if shouldRenderFrame}
		<iframe
			bind:this={frame}
			class="work-frame"
			title={work.slug}
			sandbox={frameSandbox}
			src={iframeSrc}
		></iframe>
	{:else if !hasFrameSource}
		<div class="empty-state">Work asset is unavailable.</div>
	{/if}

	{#if mode === "page" && !hideCohubBar}
		<footer class="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-3 pb-3 sm:pb-4">
			<div class="work-bar pointer-events-auto flex h-12 w-full max-w-[860px] items-center gap-3 rounded-lg border border-border-subtle bg-bg-surface/95 px-2.5 text-[11px] text-text-tertiary shadow-lg shadow-bg-primary/15 backdrop-blur-md supports-[not(backdrop-filter:blur(0))]:bg-bg-surface sm:px-3">
				<div class="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
					<img src="/favicon.svg" alt="Cohub" class="block h-5 w-5 shrink-0 rounded-[5px]" />
					<div class="hidden h-4 w-px shrink-0 bg-border-subtle sm:block"></div>
					<div class="flex min-w-0 items-center gap-2 overflow-hidden">
						<SpaceAvatar name={spaceName} profile={space?.publicProfile} size="xs" class="translate-y-0" />
						<span class="min-w-0 truncate font-medium leading-none text-text-secondary">{spaceName}</span>
						<span class="hidden shrink-0 leading-none text-text-tertiary sm:inline">/</span>
						<span class="hidden min-w-0 truncate font-medium leading-none text-text-primary sm:inline">{work.slug}</span>
					</div>
				</div>
				<div class="flex shrink-0 items-center gap-2">
					<div class="flex min-w-0 items-center gap-2 overflow-hidden">
						<span class="hidden shrink-0 leading-none text-text-tertiary md:inline">Published by</span>
						<UserAvatar name={publisherName} avatarUrl={publisherAvatarUrl} size="xs" class="h-5 w-5 rounded-full bg-bg-elevated text-[8px]" />
						<span class="hidden max-w-32 truncate font-medium leading-none text-text-secondary sm:inline">{publisherName}</span>
					</div>
					<button type="button" class="inline-flex h-8 shrink-0 items-center justify-center rounded-md px-2.5 font-medium leading-none text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 disabled:pointer-events-none disabled:opacity-50">
						Remix
					</button>
				</div>
			</div>
		</footer>
	{/if}
</div>

<EmbeddedCheckoutDialog
	open={embeddedCheckout !== null}
	clientSecret={embeddedCheckout?.clientSecret ?? null}
	title={embeddedCheckout?.title ?? "Checkout"}
	onClose={() => finishEmbeddedCheckout("cancel")}
	onComplete={() => finishEmbeddedCheckout("success")}
/>

<Dialog open={purchaseOpen && !!pendingPurchase} onClose={replyPurchaseCancel} title="Complete purchase" maxWidth="420px">
	{#if pendingPurchase}
		<div class="auth-panel">
			<div class="auth-intro">
				<div class="auth-icon"><CreditCard class="h-4 w-4" /></div>
				<div class="min-w-0">
					<div class="auth-title">Continue to checkout?</div>
					<p class="auth-copy">This work wants to open a secure checkout for <span class="font-mono">{pendingPurchase.productKey}</span>.</p>
				</div>
			</div>
			{#if purchaseError}
				<div class="mt-3 rounded-[8px] border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] text-error-soft">{purchaseError}</div>
			{/if}
			<div class="auth-actions">
				<button type="button" class="auth-cancel" onclick={replyPurchaseCancel} disabled={purchaseSaving}>Cancel</button>
				<button type="button" class="auth-confirm" onclick={() => void confirmPurchase()} disabled={purchaseSaving}>
					{#if purchaseSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
					<span>{purchaseSaving ? 'Opening…' : 'Continue'}</span>
				</button>
			</div>
		</div>
	{/if}
</Dialog>

<Dialog open={authOpen && !!pendingAuth} onClose={replyAuthCancel} title="Work access" maxWidth="440px">
	{#if pendingAuth}
		<div class="auth-panel">
			<div class="auth-intro">
				<div class="auth-icon"><ShieldCheck class="h-4 w-4" /></div>
				<div class="min-w-0">
					<div class="auth-title">Allow work access?</div>
					<p class="auth-copy">{pendingAuth.reason || "This work wants to use Cohub on your behalf."}</p>
				</div>
			</div>

			<section class="auth-section">
				<div class="auth-section-label">Requested permissions</div>
				<div class="auth-scope-list">
					{#each pendingAuth.scopes as scope}
						<div class="auth-scope-row">
							<div class="auth-scope-check"><Check class="h-3 w-3" /></div>
							<div class="min-w-0">
								<div class="auth-scope-name">{formatScopeLabel(scope)}</div>
								<div class="auth-scope-description">{formatScopeDescription(scope)}</div>
							</div>
						</div>
					{/each}
				</div>
			</section>

			{#if authError}
				<div class="auth-error"><AlertTriangle class="h-3.5 w-3.5" /> {authError}</div>
			{/if}

			<div class="auth-actions">
				<button type="button" class="auth-cancel" disabled={authSaving} onclick={replyAuthCancel}>Cancel</button>
				<button type="button" class="auth-confirm" disabled={authSaving} onclick={confirmAuth}>
					{#if authSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
					Allow
				</button>
			</div>
		</div>
	{/if}
</Dialog>

<style>
	.work-surface {
		position: relative;
		overflow: hidden;
		background: var(--bg-content);
		color: var(--text-primary);
	}

	.work-surface.page {
		min-height: 100vh;
	}

	.work-surface.background {
		width: 100%;
		height: 100%;
	}

	.work-frame {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
		background: var(--bg-primary);
		user-select: none;
	}

	.work-surface.page .work-frame {
		height: 100vh;
	}

	.empty-state {
		display: flex;
		height: 100%;
		min-height: 220px;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
		font-size: 0.875rem;
		color: var(--text-tertiary);
	}

	.auth-panel {
		display: grid;
		gap: 18px;
		padding: 16px;
	}

	.auth-intro {
		display: grid;
		grid-template-columns: 34px minmax(0, 1fr);
		gap: 12px;
		align-items: flex-start;
	}

	.auth-icon {
		display: inline-flex;
		width: 34px;
		height: 34px;
		align-items: center;
		justify-content: center;
		border-radius: 9px;
		background: var(--brand-muted);
		color: var(--brand-muted-fg);
		border: 1px solid var(--brand-border);
		box-shadow: inset 0 1px 0 color-mix(in srgb, var(--bg-elevated) 80%, transparent);
	}

	.auth-title {
		font-size: 15px;
		font-weight: 650;
		line-height: 1.25;
		letter-spacing: -0.01em;
		color: var(--text-primary);
	}

	.auth-copy {
		margin-top: 6px;
		font-size: 13px;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.auth-section {
		display: grid;
		gap: 9px;
	}

	.auth-section-label {
		font-size: 10px;
		font-weight: 650;
		text-transform: uppercase;
		letter-spacing: 0.09em;
		color: var(--text-tertiary);
	}

	.auth-scope-list {
		display: grid;
		overflow: hidden;
		border: 1px solid var(--border-subtle);
		border-radius: 10px;
		background: var(--bg-elevated);
	}

	.auth-scope-row {
		display: grid;
		grid-template-columns: 18px minmax(0, 1fr);
		gap: 11px;
		padding: 12px;
		background: var(--bg-elevated);
	}

	.auth-scope-row + .auth-scope-row {
		border-top: 1px solid var(--border-subtle);
	}

	.auth-scope-check {
		display: inline-flex;
		width: 18px;
		height: 18px;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		background: var(--brand);
		color: var(--brand-contrast-fg);
		flex: 0 0 auto;
		margin-top: 1px;
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand) 24%, transparent);
	}

	.auth-scope-name {
		font-size: 12.5px;
		font-weight: 650;
		line-height: 1.25;
		color: var(--text-primary);
	}

	.auth-scope-description {
		margin-top: 3px;
		font-size: 12px;
		line-height: 1.45;
		color: var(--text-secondary);
	}

	.auth-error {
		display: flex;
		align-items: center;
		gap: 7px;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--error-soft) 28%, transparent);
		background: var(--error-bg);
		padding: 9px 10px;
		font-size: 12px;
		line-height: 1.35;
		color: var(--error-soft);
	}

	.auth-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding-top: 2px;
	}

	.auth-cancel,
	.auth-confirm {
		display: inline-flex;
		height: 34px;
		min-width: 72px;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border-radius: 7px;
		padding: 0 13px;
		font-size: 12.5px;
		font-weight: 650;
		line-height: 1;
		transition:
			background-color 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease,
			transform 0.15s ease,
			opacity 0.15s ease;
	}

	.auth-cancel {
		border: 1px solid transparent;
		color: var(--text-secondary);
	}

	.auth-cancel:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.auth-confirm {
		border: 1px solid var(--brand);
		background: var(--brand);
		color: var(--brand-contrast-fg);
	}

	.auth-confirm:hover {
		background: var(--brand-hover);
		border-color: var(--brand-hover);
	}

	.auth-cancel:focus-visible,
	.auth-confirm:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--bg-primary), 0 0 0 4px var(--brand-ring);
	}

	.auth-cancel:active,
	.auth-confirm:active {
		transform: translateY(1px);
	}

	.auth-cancel:disabled,
	.auth-confirm:disabled {
		pointer-events: none;
		opacity: 0.55;
		transform: none;
	}

	@media (max-width: 640px) {
		.auth-panel {
			gap: 16px;
			padding: 14px 14px max(14px, env(safe-area-inset-bottom));
		}

		.auth-intro {
			grid-template-columns: 32px minmax(0, 1fr);
			gap: 11px;
		}

		.auth-icon {
			width: 32px;
			height: 32px;
		}

		.auth-title {
			font-size: 14.5px;
		}

		.auth-copy {
			font-size: 13px;
			line-height: 1.5;
		}

		.auth-scope-row {
			padding: 11px;
		}

		.auth-actions {
			position: sticky;
			bottom: calc(-1 * max(14px, env(safe-area-inset-bottom)));
			display: grid;
			grid-template-columns: 1fr 1fr;
			margin: 0 -14px calc(-1 * max(14px, env(safe-area-inset-bottom)));
			padding: 10px 14px max(14px, env(safe-area-inset-bottom));
			border-top: 1px solid var(--border-subtle);
			background: var(--bg-primary);
		}

		.auth-cancel,
		.auth-confirm {
			height: 44px;
			min-width: 0;
		}
	}
</style>
