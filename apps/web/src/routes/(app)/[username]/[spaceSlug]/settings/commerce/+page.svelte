<script lang="ts">
import type { SpaceRouteTarget } from "$lib/space-routes";
import SpaceCommerceSettingsPage from "../../../../spaces/[id]/settings/commerce/+page.svelte";

const props = $props<{
	data: { spaceId: string; spaceRouteTarget: SpaceRouteTarget };
}>();
</script>

<SpaceCommerceSettingsPage data={props.data} />
