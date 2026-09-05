<script lang="ts">
import type { AppRecord } from "@neta-art/cohub";
import { onDestroy, untrack } from "svelte";
import * as publicEnv from "$env/static/public";
import { readAppCheckoutState } from "$lib/components/app/app-checkout-state";
import MarkdownView from "$lib/components/MarkdownView.svelte";
import AppAuthorizeDialog from "$lib/features/app/AppAuthorizeDialog.svelte";
import { createAppBridgeHost } from "$lib/features/app/bridge-host.svelte";
import type { PreviewCaptureTarget } from "$lib/features/preview-mark";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	createSpacePreviewSessionController,
	type SpacePreviewTarget,
} from "$lib/space-preview-session.svelte";
import type { WorkspaceFileLinkTarget } from "$lib/workspace-file-links";

let {
	name,
	source,
	type,
	path = null,
	spaceId = null,
	readonly = false,
	app = null,
	markTarget = $bindable(null),
	onOpenFile,
}: {
	name: string;
	source: string;
	type: "markdown" | "html";
	path?: string | null;
	spaceId?: string | null;
	readonly?: boolean;
	/** When set, auto-host app runtime APIs for this published file. */
	app?: AppRecord | null;
	/** Outbound mark capture target for parent chrome. */
	markTarget?: PreviewCaptureTarget | null;
	onOpenFile?: (target: WorkspaceFileLinkTarget) => void | Promise<void>;
} = $props();

const locale = $derived(getLocale());

const previewOrigin =
	publicEnv.PUBLIC_PREVIEW_ORIGIN?.replace(/\/+$/, "") ?? "";
let frame: HTMLIFrameElement | null = $state(null);
let lastSrcdocFrame: HTMLIFrameElement | null = null;
let lastSrcdoc = "";

const canUsePreviewOrigin = $derived(
	Boolean(type === "html" && !readonly && previewOrigin && spaceId && path),
);
const previewKey = $derived(
	`${type}:${previewOrigin}:${spaceId ?? ""}:${path ?? ""}`,
);
const previewSession = createSpacePreviewSessionController({
	getTarget: (): SpacePreviewTarget | null =>
		canUsePreviewOrigin && spaceId && path
			? { origin: previewOrigin, spaceId, path }
			: null,
	errorMessage: () => m.preview_failed({}, { locale }),
});

// Auto-enable the app bridge when this HTML file is a published app.
const host = $derived.by(() => {
	if (!app || type !== "html" || !canUsePreviewOrigin) return null;
	return createAppBridgeHost({
		app,
		reply: (requestId, payload) => {
			frame?.contentWindow?.postMessage(
				{ requestId, ...payload },
				previewOrigin,
			);
		},
		getCheckoutState: () => readAppCheckoutState(new URL(window.location.href)),
	});
});

function handleFrameMessage(event: MessageEvent) {
	if (
		!host ||
		event.source !== frame?.contentWindow ||
		event.origin !== previewOrigin
	)
		return;
	void host.handleMessage(event);
}

// Publish mark context to parent chrome (button lives in the file header).
$effect(() => {
	if (type !== "html" || !frame || !path) {
		markTarget = null;
		return;
	}
	markTarget = {
		kind: "iframe",
		element: frame,
		source: { kind: "html", path },
	};
});

$effect(() => {
	previewKey;
	if (type !== "html") return;
	void untrack(() => previewSession.reset());
	return previewSession.stop;
});

// Fallback srcdoc path: only rewrite when source or iframe node actually
// changes so panel resizes never reassign iframe.srcdoc and reload the page.
$effect(() => {
	if (type !== "html" || canUsePreviewOrigin) return;
	const nextSource = source;
	const el = frame;
	if (!el) return;
	if (lastSrcdocFrame === el && lastSrcdoc === nextSource) return;
	lastSrcdocFrame = el;
	lastSrcdoc = nextSource;
	el.srcdoc = nextSource;
});

$effect(() => {
	window.addEventListener("message", handleFrameMessage);
	return () => window.removeEventListener("message", handleFrameMessage);
});

onDestroy(() => {
	markTarget = null;
	previewSession.stop();
});
</script>

{#if type === "markdown"}
	<MarkdownView {source} variant="document" baseFilePath={path} {onOpenFile} />
{:else if canUsePreviewOrigin}
	<div class="relative flex h-full min-h-0 flex-col bg-white">
		{#if previewSession.error}
			<div class="flex flex-1 items-center justify-center p-4 text-xs text-error-soft">{previewSession.error}</div>
		{:else if previewSession.src}
			<iframe
				bind:this={frame}
				class="min-h-0 flex-1 border-0 bg-white"
				title={m.html_preview_title({ name }, { locale })}
				sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
				src={previewSession.src}
			></iframe>
		{:else}
			<div class="flex flex-1 items-center justify-center p-4 text-xs text-text-tertiary">{m.loading_preview({}, { locale })}</div>
		{/if}
	</div>
	{#if host}
		<AppAuthorizeDialog
			open={host.authOpen && !!host.pendingAuth}
			pending={host.pendingAuth}
			error={host.authError}
			saving={host.authSaving}
			appName={app?.slug ?? "Preview"}
			authorName="Cohub"
			onConfirm={(spaceId) => void host.confirmAuth(spaceId)}
			onCancel={host.cancelAuth}
		/>
	{/if}
{:else}
	<div class="relative h-full w-full">
		<iframe
			bind:this={frame}
			class="h-full w-full border-0 bg-white"
			title={m.html_preview_title({ name }, { locale })}
			sandbox="allow-scripts"
		></iframe>
	</div>
{/if}
