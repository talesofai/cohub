<script lang="ts">
import SpaceWorkspacePage from "$lib/features/space/SpaceWorkspacePage.svelte";

const props = $props<{
	data: {
		spaceId: string;
		view: "session";
		sessionId?: string | null;
		filePath?: string | null;
		previewKind?: "file" | "board" | "port" | "work" | null;
		previewKey?: string | null;
	};
}>();
</script>

<SpaceWorkspacePage data={props.data} />
