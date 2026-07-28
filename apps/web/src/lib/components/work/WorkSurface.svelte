<script lang="ts">
import type { WorkRecord, WorkTargetType } from "@neta-art/cohub";
import { onMount, untrack } from "svelte";
import { page } from "$app/state";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import UserIdentity from "$lib/components/UserIdentity.svelte";
import { readWorkCheckoutState } from "$lib/components/work/work-checkout-state";
import { createWorkBridgeHost } from "$lib/features/work/bridge-host.svelte";
import WorkAuthorizeDialog from "$lib/features/work/WorkAuthorizeDialog.svelte";
import WorkPurchaseDialog from "$lib/features/work/WorkPurchaseDialog.svelte";
import { parseNewChatBackgroundAction } from "$lib/new-chat-background-bridge";
import { emitSpaceConfigBackgroundAction } from "$lib/space-config";
import { workDisplayTitle } from "$lib/work-page-meta";

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

const isBackground = $derived(mode === "background");
const spaceName = $derived(space?.name || space?.slug || "Space");
const workTitle = $derived(workDisplayTitle(work.meta, work.slug));
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

// `work` and `isBackground` are constant for the lifetime of this surface
// (a different work remounts the component), so capturing their initial values
// is intentional. `reply`/`getCheckoutState` stay reactive via their closures.
const host = untrack(() =>
	createWorkBridgeHost({
		work,
		isBackground,
		reply: (requestId, payload) => {
			if (!frameOrigin) return;
			frame?.contentWindow?.postMessage(
				{ requestId, ...payload },
				frameReplyTarget,
			);
		},
		getCheckoutState: () => checkoutState,
	}),
);

async function onFrameMessage(event: MessageEvent) {
	if (event.source !== frame?.contentWindow) return;
	if (!frameOrigin || event.origin !== frameOrigin) return;
	if (isBackground) {
		const action = parseNewChatBackgroundAction(event.data);
		if (action) {
			emitSpaceConfigBackgroundAction(action);
			return;
		}
	}
	await host.handleMessage(event);
}

onMount(() => {
	window.addEventListener("message", onFrameMessage);
	bridgeReady = true;
	return () => window.removeEventListener("message", onFrameMessage);
});
</script>

<svelte:head>
	{#if framePreconnectOrigin}
		<link rel="preconnect" href={framePreconnectOrigin} crossorigin="anonymous" />
	{/if}
</svelte:head>

<div
	class={isBackground
		? "work-surface background"
		: "work-surface page public-work-viewport"}
>
	{#if shouldRenderFrame}
		<iframe
			bind:this={frame}
			class="work-frame"
			title={workTitle}
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
						<span class="hidden min-w-0 truncate font-medium leading-none text-text-primary sm:inline">{workTitle}</span>
					</div>
				</div>
				<div class="flex shrink-0 items-center gap-2">
					<div class="flex min-w-0 items-center gap-2 overflow-hidden">
						<span class="hidden shrink-0 leading-none text-text-tertiary md:inline">Published by</span>
						<UserIdentity
							name={publisherName}
							avatarUrl={publisherAvatarUrl}
							username={owner?.username}
							size="xs"
							class="min-w-0 text-text-secondary"
							avatarClass="h-5 w-5 rounded-full bg-bg-elevated text-[8px]"
							nameClass="hidden max-w-32 truncate font-medium leading-none sm:inline"
						/>
					</div>
					<button type="button" class="inline-flex h-8 shrink-0 items-center justify-center rounded-md px-2.5 font-medium leading-none text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 disabled:pointer-events-none disabled:opacity-50">
						Remix
					</button>
				</div>
			</div>
		</footer>
	{/if}
</div>

<WorkPurchaseDialog
	open={host.purchaseOpen && !!host.pendingPurchase}
	pending={host.pendingPurchase}
	error={host.purchaseError}
	saving={host.purchaseSaving}
	onConfirm={() => void host.confirmPurchase()}
	onCancel={host.cancelPurchase}
/>

<WorkAuthorizeDialog
	open={host.authOpen && !!host.pendingAuth}
	pending={host.pendingAuth}
	error={host.authError}
	saving={host.authSaving}
	workName={workTitle}
	authorName={owner?.displayName}
	onConfirm={() => void host.confirmAuth()}
	onCancel={host.cancelAuth}
/>

<style>
	.work-surface {
		position: relative;
		overflow: hidden;
		background: var(--bg-content);
		color: var(--text-primary);
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
		height: 100%;
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
</style>
