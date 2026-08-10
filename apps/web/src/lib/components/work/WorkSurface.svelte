<script lang="ts">
import type { WorkComposerChip } from "@cohub/protocol/work-surface";
import type { WorkContent, WorkRecord } from "@neta-art/cohub";
import { onMount, untrack } from "svelte";
import { page } from "$app/state";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import UserIdentity from "$lib/components/UserIdentity.svelte";
import WorkBoardSurface from "$lib/components/work/WorkBoardSurface.svelte";
import WorkFileSurface from "$lib/components/work/WorkFileSurface.svelte";
import { readWorkCheckoutState } from "$lib/components/work/work-checkout-state";
import { createWorkBridgeHost } from "$lib/features/work/bridge-host.svelte";
import {
	createWorkSurfaceHost,
	type WorkSurfaceHost,
} from "$lib/features/work/surface-host";
import WorkAuthorizeDialog from "$lib/features/work/WorkAuthorizeDialog.svelte";
import WorkPurchaseDialog from "$lib/features/work/WorkPurchaseDialog.svelte";
import { parseNewChatBackgroundAction } from "$lib/new-chat-background-bridge";
import { emitSpaceConfigBackgroundAction } from "$lib/space-config";
import { workDisplayTitle } from "$lib/work-page-meta";
import { buildWorkIframeUrl, type WorkLaunchState } from "$lib/work-url";

type WorkSurfaceMode = "page" | "background" | "preview";

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
	launchState?: WorkLaunchState | null;
	/**
	 * Receives the surface RPC host once mounted, so a parent can invoke methods
	 * the Work registered. Only meaningful for embedded (web / port) Works.
	 */
	onSurfaceHost?: (host: WorkSurfaceHost | null) => void;
	onComposerChip?: (chip: WorkComposerChip | null) => void;
};

const {
	work,
	space = null,
	owner = null,
	content = null,
	mode = "page",
	launchState = null,
	onSurfaceHost = undefined,
	onComposerChip = undefined,
}: Props = $props();

let frame: HTMLIFrameElement | null = $state(null);
let bridgeReady = $state(false);

const isBackground = $derived(mode === "background");
const isPreview = $derived(mode === "preview");
const spaceName = $derived(space?.name || space?.slug || "Space");
const workTitle = $derived(workDisplayTitle(work.meta, work.slug));
const publisherName = $derived(owner?.displayName ?? "Cohub");
const publisherAvatarUrl = $derived(owner?.avatarUrl?.trim() || null);
const hideCohubBar = $derived(work.meta?.presentation?.hideCohubBar === true);
// Board and file Works render natively; only web and port Works are embedded.
const boardContent = $derived(content?.kind === "board" ? content : null);
const fileContent = $derived(content?.kind === "file" ? content : null);
const embeddedContent = $derived(
	content && (content.kind === "web" || content.kind === "port")
		? content
		: null,
);
const nativeContent = $derived(boardContent ?? fileContent);
const iframeSrc = $derived.by(() => {
	const contentUrl =
		embeddedContent?.url ??
		(!content && work.targetType === "port" ? work.targetRef : "");
	return buildWorkIframeUrl(contentUrl, launchState);
});
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
const shouldRenderFrame = $derived(
	Boolean(bridgeReady && hasFrameSource && !nativeContent),
);
const frameReplyTarget = $derived(frameOrigin ?? page.url.origin);
const framePreconnectOrigin = $derived.by(() => {
	if (!frameOrigin || frameOrigin === page.url.origin) return null;
	return frameOrigin;
});
// A new document invalidates any announced methods.
$effect(() => {
	void iframeSrc;
	surfaceHost?.reset();
});

const frameSandbox = $derived(
	`allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals${isBackground ? "" : " allow-pointer-lock"}`,
);
const framePermissions = $derived(
	isBackground ? undefined : "clipboard-write; fullscreen; web-share",
);
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

// Surface RPC is opt-in: only created when a parent wants to call into the Work.
const surfaceHost = untrack(() =>
	onSurfaceHost || onComposerChip
		? createWorkSurfaceHost({
				getFrame: () => frame,
				getFrameOrigin: () => frameOrigin,
				onComposerChip,
			})
		: null,
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
	if (surfaceHost?.handleMessage(event)) return;
	await host.handleMessage(event);
}

onMount(() => {
	window.addEventListener("message", onFrameMessage);
	bridgeReady = true;
	onSurfaceHost?.(surfaceHost);
	return () => {
		window.removeEventListener("message", onFrameMessage);
		onSurfaceHost?.(null);
		surfaceHost?.dispose();
	};
});
</script>

<svelte:head>
	{#if framePreconnectOrigin}
		<link rel="preconnect" href={framePreconnectOrigin} crossorigin="anonymous" />
	{/if}
</svelte:head>

<div class={isBackground ? "work-surface background" : isPreview ? "work-surface preview" : "work-surface page"}>
	{#if boardContent}
		<div class="work-native">
			<WorkBoardSurface content={boardContent} />
		</div>
	{:else if fileContent}
		<div class="work-native">
			<WorkFileSurface content={fileContent} />
		</div>
	{:else if shouldRenderFrame}
		<iframe
			bind:this={frame}
			class="work-frame"
			title={workTitle}
			sandbox={frameSandbox}
			allow={framePermissions}
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

	.work-surface.page {
		min-height: 100vh;
	}

	.work-surface.background,
	.work-surface.preview {
		width: 100%;
		height: 100%;
	}

	/* Preview lives inside the workspace pane and owns no page chrome. */
	.work-surface.preview {
		display: flex;
		min-height: 0;
		flex-direction: column;
	}

	.work-surface.preview .work-frame,
	.work-surface.preview .work-native {
		flex: 1 1 auto;
		min-height: 0;
	}

	.work-frame {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
		background: var(--bg-primary);
		user-select: none;
	}

	/* Native surfaces own their own scrolling and chrome. */
	.work-native {
		height: 100%;
		min-height: 0;
	}

	.work-surface.page .work-native {
		height: 100vh;
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
</style>
