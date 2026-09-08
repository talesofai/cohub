<script lang="ts">
import type { AppNavigationOpenMessage } from "@cohub/protocol/app-navigation";
import type { AppRuntimeShellContext } from "@neta-art/cohub";
import { onMount, untrack } from "svelte";
import { appDisplayTitle } from "$lib/app-page-meta";
import AppAuthorizeDialog from "$lib/features/app/AppAuthorizeDialog.svelte";
import { readInstalledApps } from "$lib/features/app/app-center";
import { resolveAppNavigation } from "$lib/features/app/app-open";
import { createAppBridgeHost } from "$lib/features/app/bridge-host.svelte";
import { createEmbedHost, type EmbedEntry } from "$lib/features/app/embed-host";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";
import { readAppCheckoutState } from "./app-checkout-state";

const { frame, origin, appId, shell, onCloseSelf, onNavigationOpen } = $props<{
	frame: HTMLIFrameElement | null;
	origin: string | null;
	appId: string;
	shell?: AppRuntimeShellContext;
	onCloseSelf?: () => void;
	onNavigationOpen?: (message: AppNavigationOpenMessage) => Promise<{
		handled: boolean;
		reason?: "unsupported" | "invalid_target" | "inaccessible" | "timeout";
		call?: import("@cohub/protocol/app-navigation").AppNavigationOpenResponse["call"];
	}>;
}>();
let entries = $state<EmbedEntry[]>([]);
let host: ReturnType<typeof createEmbedHost> | null = null;

onMount(() => {
	host = createEmbedHost({
		root: window,
		getContainer: () => frame?.contentWindow ?? null,
		getContainerOrigin: () => origin,
		parentAppId: appId,
		getShell: () => shell,
		resolveApp: (ref, launch) => resolveAppNavigation(sdk.apps, ref, launch),
		canOpen: async (id, spaceId) =>
			(await readInstalledApps(spaceId, { refresh: true })).document.apps.some(
				(app) => app.id === id && app.enabled,
			),
		createBridge: createAppBridgeHost,
		getCheckoutState: () => readAppCheckoutState(new URL(window.location.href)),
		onNavigation: onNavigationOpen,
		onCloseSelf,
		onEntries: (value) => {
			entries = value;
		},
	});
	const onMessage = (event: MessageEvent) => {
		host?.handleMessage(event);
	};
	const onLoad = () => host?.reset();
	window.addEventListener("message", onMessage);
	frame?.addEventListener("load", onLoad);
	return () => {
		window.removeEventListener("message", onMessage);
		frame?.removeEventListener("load", onLoad);
		host?.dispose();
		host = null;
	};
});
let identity: string | undefined;
$effect(() => {
	const next = `${authStore.userUuid ?? ""}:${shell?.space?.id ?? ""}`;
	untrack(() => {
		if (identity !== undefined && identity !== next) host?.reset();
		identity = next;
	});
});
$effect(() => {
	void shell;
	void host?.notifyContextChanged();
});
</script>

{#each entries as entry (entry.id)}
	{#if entry.bridge}
		<AppAuthorizeDialog
			open={entry.bridge.authOpen && !!entry.bridge.pendingAuth && entry.id === entries.find(item => item.bridge?.authOpen)?.id}
			pending={entry.bridge.pendingAuth}
			error={entry.bridge.authError}
			saving={entry.bridge.authSaving}
			appName={appDisplayTitle(entry.detail.app.meta, entry.detail.app.slug)}
			authorName={entry.detail.owner?.displayName}
			onConfirm={(spaceId) => void entry.bridge?.confirmAuth(spaceId)}
			onCancel={() => entry.bridge?.cancelAuth()}
		/>
	{/if}
{/each}
