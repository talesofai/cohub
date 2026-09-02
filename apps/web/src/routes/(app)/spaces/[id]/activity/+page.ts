import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params }) => ({
	spaceId: params.id,
});
