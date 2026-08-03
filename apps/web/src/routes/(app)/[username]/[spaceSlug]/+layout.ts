import { error } from "@sveltejs/kit";
import { mapFriendlySpaceLoadError } from "$lib/friendly-space-load-error";
import { sdk } from "$lib/sdk";
import { getSpaceRouteIdentity } from "$lib/space-routes";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";
import type { LayoutLoad } from "./$types";

export const load: LayoutLoad = async ({ params }) => {
	try {
		const space = await sdk.spaces.getBySlug(params.username, params.spaceSlug);
		cacheSpaceRecordSoon(space);
		return {
			space,
			spaceId: space.id,
			spaceRouteTarget: getSpaceRouteIdentity({
				id: space.id,
				slug: space.slug,
				ownerUsername: space.ownerProfile?.username ?? params.username,
			}),
		};
	} catch (cause) {
		const mapped = mapFriendlySpaceLoadError(cause);
		throw error(mapped.status, mapped.message);
	}
};
