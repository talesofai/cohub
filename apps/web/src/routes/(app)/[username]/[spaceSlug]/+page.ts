import { readPreviewFromSearch } from "$lib/features/space/modules/workspace-preview-route";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ parent, url }) => {
	const { space } = await parent();
	const sessionId = url.searchParams.get("session");
	// Prefer ?preview=; legacy ?file= maps to file preview.
	const preview =
		readPreviewFromSearch(url.searchParams) ??
		(url.searchParams.get("file")
			? {
					kind: "file" as const,
					key: url.searchParams.get("file") as string,
				}
			: null);

	return {
		spaceId: space.id,
		view: "session" as const,
		sessionId: sessionId ?? "new",
		filePath: null,
		previewKind: preview?.kind ?? null,
		previewKey: preview?.key ?? null,
	};
};
