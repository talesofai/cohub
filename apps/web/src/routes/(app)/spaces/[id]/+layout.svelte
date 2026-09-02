<script lang="ts">
/**
 * Keep the session workspace mounted across the Space root and session routes.
 * Other Space views continue to render through their own child pages.
 */
import type { Snippet } from "svelte";
import { page } from "$app/state";
import type { WindowKind } from "$lib/features/space/modules/window-route";
import SpaceWorkspacePage from "$lib/features/space/SpaceWorkspacePage.svelte";

let { children }: { children: Snippet } = $props();

const sessionData = $derived.by(() => {
	if (page.data.view !== "session") return null;
	return {
		spaceId: page.data.spaceId as string,
		view: "session" as const,
		sessionId: (page.data.sessionId as string | null | undefined) ?? null,
		filePath: (page.data.filePath as string | null | undefined) ?? null,
		windowKind: (page.data.windowKind as WindowKind | null | undefined) ?? null,
		windowKey: (page.data.windowKey as string | null | undefined) ?? null,
		turnSequence: (page.data.turnSequence as string | null | undefined) ?? null,
	};
});
</script>

{#if sessionData}
	<SpaceWorkspacePage data={sessionData} />
{/if}
{@render children()}
