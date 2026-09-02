<script lang="ts">
import "../../app.css";
import { page } from "$app/state";

const { children } = $props();

/** Public App routes set icons via AppPageHead; others use shell defaults. */
const isPublicAppPath = $derived.by(() => {
	const segments = page.url.pathname.split("/").filter(Boolean);
	return segments.length === 4 && segments[2] === "w";
});
</script>

<svelte:head>
	{#if !isPublicAppPath}
		<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
		<link rel="apple-touch-icon" href="/pwa/icon-192x192.png" />
	{/if}
</svelte:head>

<div class="min-h-screen overflow-x-clip bg-bg-primary text-text-primary">
	{@render children?.()}
</div>
