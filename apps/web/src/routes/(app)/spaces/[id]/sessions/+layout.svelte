<script lang="ts">
/**
 * Shared shell for a Space's new and existing chat routes.
 * Keeping the workspace mounted preserves open previews and their runtime state.
 */
import type { Snippet } from "svelte";
import { page } from "$app/state";
import SpaceWorkspacePage from "$lib/features/space/SpaceWorkspacePage.svelte";

let { children }: { children: Snippet } = $props();

const data = $derived({
	spaceId: page.data.spaceId as string,
	view: "session" as const,
	sessionId: (page.data.sessionId as string | null | undefined) ?? null,
	filePath: (page.data.filePath as string | null | undefined) ?? null,
	previewKind:
		(page.data.previewKind as
			| "file"
			| "board"
			| "port"
			| "work"
			| null
			| undefined) ?? null,
	previewKey: (page.data.previewKey as string | null | undefined) ?? null,
	turnSequence: (page.data.turnSequence as string | null | undefined) ?? null,
});
</script>

<SpaceWorkspacePage {data} />
{@render children()}
