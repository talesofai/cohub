<script lang="ts">
import type { SpaceRouteTarget } from "$lib/space-routes";
import SpaceSettingsPage from "../../../spaces/[id]/settings/+page.svelte";

const props = $props<{
	data: { spaceId: string; spaceRouteTarget: SpaceRouteTarget };
}>();
</script>

<SpaceSettingsPage data={props.data} />
