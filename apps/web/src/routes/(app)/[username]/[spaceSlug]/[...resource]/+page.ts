import { error, redirect } from "@sveltejs/kit";
import {
	readPreviewFromSearch,
	withPreviewParam,
} from "$lib/features/space/modules/workspace-preview-route";
import { parseFriendlySpaceResourceRoute } from "$lib/friendly-space-route";
import { buildSpaceNewSessionRoute } from "$lib/space-routes";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ parent, params, url }) => {
	const route = parseFriendlySpaceResourceRoute(params.resource);
	if (!route) throw error(404, "Page not found");

	const { space, spaceRouteTarget } = await parent();

	if (route.kind === "file") {
		throw redirect(
			302,
			withPreviewParam(
				buildSpaceNewSessionRoute(spaceRouteTarget),
				url.searchParams,
				{
					kind: "file",
					key: route.path,
				},
			),
		);
	}

	const preview = readPreviewFromSearch(url.searchParams);
	const common = {
		spaceId: space.id,
		spaceRouteTarget,
		sessionId: null,
		filePath: null,
		previewKind: preview?.kind ?? null,
		previewKey: preview?.key ?? null,
	};

	if (route.kind === "session") {
		return {
			...common,
			view: "session" as const,
			sessionId: route.sessionId,
			turnSequence: url.searchParams.get("turn"),
		};
	}
	if (route.kind === "checkpoint") {
		return {
			...common,
			view: route.checkpointId
				? ("checkpoint" as const)
				: ("checkpoint-new" as const),
			checkpointId: route.checkpointId,
		};
	}
	if (route.kind === "cronjob") {
		return {
			...common,
			view: route.cronjobId ? ("cronjob" as const) : ("cronjob-new" as const),
			cronjobId: route.cronjobId,
		};
	}
	if (route.kind === "task") {
		return { ...common, view: "task" as const, taskId: route.taskId };
	}
	return { ...common, view: "work" as const, workId: route.workId };
};
