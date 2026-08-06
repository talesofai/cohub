<script lang="ts">
import SpaceWorkspacePage from "$lib/features/space/SpaceWorkspacePage.svelte";

const props = $props<{
	data: {
		spaceId: string;
		view:
			| "session"
			| "checkpoint"
			| "checkpoint-new"
			| "cronjob"
			| "cronjob-new"
			| "work"
			| "task";
		sessionId?: string | null;
		filePath?: string | null;
		checkpointId?: string | null;
		cronjobId?: string | null;
		workId?: string | null;
		taskId?: string | null;
		previewKind?: "file" | "board" | "port" | null;
		previewKey?: string | null;
		turnSequence?: string | null;
	};
}>();
</script>

<SpaceWorkspacePage data={props.data} />
