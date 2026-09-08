<script lang="ts">
import type { AppDetailResponse } from "@neta-art/cohub";
import { onMount } from "svelte";
import AppSurface from "$lib/components/app/AppSurface.svelte";
import { createEmbedClient } from "$lib/features/app/embed-client";
import {
	EMBED_TIMEOUT,
	envelope,
	parseEmbed,
} from "$lib/features/app/embed-protocol";

let detail = $state<AppDetailResponse | null>(null);
let launch = $state<{ search?: string; hash?: string } | undefined>();
let client = $state<ReturnType<typeof createEmbedClient> | null>(null);
let error = $state("");

onMount(() => {
	if (window.top === window || !location.hash.slice(1)) {
		error = "Open this App from a Cohub workspace.";
		return;
	}
	const instanceId = location.hash.slice(1);
	const timer = setTimeout(() => {
		error = "The App host did not connect. Reopen this window.";
	}, EMBED_TIMEOUT);
	const accept = (event: MessageEvent) => {
		if (
			event.source !== window.top ||
			event.origin !== location.origin ||
			client ||
			error
		)
			return;
		const message = parseEmbed(event.data);
		if (
			message?.type !== "attached" ||
			message.instanceId !== instanceId ||
			!event.ports[0] ||
			!message.detail
		)
			return;
		clearTimeout(timer);
		client = createEmbedClient(event.ports[0], (value) => {
			launch = value;
		});
		detail = message.detail as AppDetailResponse;
		launch = message.launch as typeof launch;
	};
	window.addEventListener("message", accept);
	const detach = () => client?.dispose();
	window.addEventListener("pagehide", detach);
	window.top?.postMessage(envelope("attach", { instanceId }), location.origin);
	return () => {
		clearTimeout(timer);
		window.removeEventListener("message", accept);
		window.removeEventListener("pagehide", detach);
		client?.dispose();
	};
});
</script>

<svelte:head><title>App</title><meta name="robots" content="noindex, nofollow" /></svelte:head>
<div class="h-dvh w-full overflow-hidden bg-bg-content">
	{#if detail && client}
		<AppSurface mode="app" app={detail.app} space={detail.space} owner={detail.owner} content={detail.content}
			launchState={{ search: launch?.search ?? "", hash: launch?.hash ?? "" }} bridgeFactory={client.createBridge} onFrameLoad={client.loaded}
			onFrameFocus={client.focused} onNavigationOpen={client.open} />
	{:else}
		<p class="p-4 text-sm text-text-secondary" role="status">{error || "Connecting App…"}</p>
	{/if}
</div>
