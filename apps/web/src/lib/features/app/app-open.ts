import type { AppDetailResponse } from "@neta-art/cohub";
import { parseAppRef } from "@neta-art/cohub/app-ref";

export type AppLoader = {
	get(id: string): Promise<AppDetailResponse>;
	getPublicById(id: string): Promise<AppDetailResponse>;
	getBySlug(
		owner: string,
		space: string,
		app: string,
	): Promise<AppDetailResponse>;
};

/** Same access fallback as the existing preview controller. */
export async function loadAppPreview(
	loader: Pick<AppLoader, "get" | "getPublicById">,
	id: string,
) {
	try {
		return await loader.get(id);
	} catch (cause) {
		const status = (cause as { status?: number } | null)?.status;
		if (status !== 401 && status !== 403) throw cause;
		return loader.getPublicById(id);
	}
}

/** Resolve navigation without opening panels, changing URLs or registering tabs. */
export async function resolveAppNavigation(
	loader: AppLoader,
	ref: string,
	launch?: { search?: string; hash?: string },
) {
	const parsed = parseAppRef(ref);
	if ("id" in parsed) {
		// Preserve the existing navigation endpoint's broader public fallback.
		const detail = await loader
			.get(parsed.id)
			.catch(() => loader.getPublicById(parsed.id));
		return { detail, launch };
	}
	const detail = await loader.getBySlug(
		parsed.username,
		parsed.spaceSlug,
		parsed.appSlug,
	);
	return {
		detail,
		launch:
			launch ??
			(parsed.search || parsed.hash
				? {
						...(parsed.search ? { search: parsed.search } : {}),
						...(parsed.hash ? { hash: parsed.hash } : {}),
					}
				: undefined),
	};
}
