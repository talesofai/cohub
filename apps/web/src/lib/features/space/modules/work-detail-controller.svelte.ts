import type {
	WorkMeta,
	WorkRecord,
	WorkVersionRecord,
	WorkViewStatsResponse,
} from "@neta-art/cohub";
import { goto } from "$app/navigation";
import {
	dispatchWorksChanged,
	isNewerWorkSnapshot,
	upsertWorkVersion,
	type WorksChangedDetail,
} from "$lib/features/work/work-realtime";
import { sdk } from "$lib/sdk";
import { buildSpaceLandingRoute } from "$lib/space-routes";
import { createKeyedRouteRequestGuard } from "./route-request-guard";
import {
	scopeState,
	selectedScopeList,
	WORK_SCOPE_OPTIONS,
	WORK_VIEWER_SCOPE_OPTIONS,
} from "./work-utils";

export type WorkTargetType = "file" | "directory" | "port";
export type WorkStatus = "published" | "disabled";
export type WorkVisibility = "public" | "space";

const WORK_HIDE_COHUB_BAR_FEATURE = "work.publish.hide_cohub_bar";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === "object" && !Array.isArray(value));

function getHideCohubBar(meta: WorkMeta | null | undefined) {
	return (
		isRecord(meta?.presentation) && meta.presentation.hideCohubBar === true
	);
}

function buildWorkMeta(
	currentMeta: WorkMeta | null | undefined,
	hideCohubBar: boolean,
): WorkMeta | null {
	const meta: WorkMeta = isRecord(currentMeta) ? { ...currentMeta } : {};
	const presentation: NonNullable<WorkMeta["presentation"]> &
		Record<string, unknown> = isRecord(meta.presentation)
		? { ...meta.presentation }
		: {};
	if (hideCohubBar) {
		presentation.hideCohubBar = true;
	} else {
		delete presentation.hideCohubBar;
	}
	if (Object.keys(presentation).length) {
		meta.presentation = presentation;
	} else {
		delete meta.presentation;
	}
	return Object.keys(meta).length ? meta : null;
}

export function createWorkDetailController(options: {
	getSpaceId: () => string;
	getRouteWorkId: () => string | null;
	getOwnerUsername: () => string | null;
	getSpaceSlug: () => string | null;
	/** Stats require space.edit; skip the request for read-only viewers. */
	getCanViewStats: () => boolean;
	onDetailLoaded?: (work: WorkRecord | null) => void;
}) {
	let detail = $state<WorkRecord | null>(null);
	let loading = $state(false);
	let error = $state("");
	let actionInProgress = $state(false);
	let deleteInProgress = $state(false);
	let editMode = $state(false);
	let formSlug = $state("");
	let formTargetType = $state<WorkTargetType>("file");
	let formTargetRef = $state("");
	let formStatus = $state<WorkStatus>("published");
	let formVisibility = $state<WorkVisibility>("public");
	let formHideCohubBar = $state(false);
	let hideCohubBarAllowed = $state(false);
	let hideCohubBarLoading = $state(false);
	let formScopes = $state<Record<string, boolean>>({});
	let formViewerScopes = $state<Record<string, boolean>>({});
	let formSubmitting = $state(false);
	let formError = $state("");
	let copiedId = $state(false);
	let copiedPublicRoute = $state(false);
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;
	let copiedPublicRouteTimer: ReturnType<typeof setTimeout> | null = null;
	let routeStateKey = "";
	let versions = $state<WorkVersionRecord[]>([]);
	let versionsLoading = $state(false);
	let versionsError = $state("");
	let stats = $state<WorkViewStatsResponse | null>(null);
	let statsLoading = $state(false);
	let statsError = $state("");
	let publishSubmitting = $state(false);
	let publishError = $state("");

	function notify(work: WorkRecord | null) {
		options.onDetailLoaded?.(work);
	}

	function syncFormFromDetail() {
		if (!detail) return;
		formSlug = detail.slug;
		formTargetType = detail.targetType;
		formTargetRef = detail.targetRef;
		formStatus = detail.status;
		formVisibility = detail.visibility;
		formHideCohubBar = getHideCohubBar(detail.meta);
		formScopes = scopeState(detail.workScopes, WORK_SCOPE_OPTIONS);
		formViewerScopes = scopeState(
			detail.allowedViewerScopes,
			WORK_VIEWER_SCOPE_OPTIONS,
		);
		formError = "";
		publishError = "";
	}

	async function loadHideCohubBarEntitlement() {
		const stateKey = routeStateKey;
		hideCohubBarLoading = true;
		try {
			const { enabled } = await sdk.billing.getFeatureEntitlement(
				WORK_HIDE_COHUB_BAR_FEATURE,
			);
			if (routeStateKey !== stateKey) return;
			hideCohubBarAllowed = enabled;
			if (!enabled && !getHideCohubBar(detail?.meta)) formHideCohubBar = false;
		} catch {
			if (routeStateKey !== stateKey) return;
			hideCohubBarAllowed = false;
			if (!getHideCohubBar(detail?.meta)) formHideCohubBar = false;
		} finally {
			if (routeStateKey === stateKey) hideCohubBarLoading = false;
		}
	}

	function notifyWorksUpdated(
		change: Omit<WorksChangedDetail, "spaceId"> = {},
	) {
		dispatchWorksChanged({ spaceId: options.getSpaceId(), ...change });
	}

	function publicRoute(work: WorkRecord | null = detail) {
		const ownerUsername = options.getOwnerUsername();
		const spaceSlug = options.getSpaceSlug();
		return ownerUsername && spaceSlug && work?.slug
			? `/${encodeURIComponent(ownerUsername)}/${encodeURIComponent(spaceSlug)}/w/${encodeURIComponent(work.slug)}`
			: null;
	}

	async function loadDetail(workId: string) {
		const requestSpaceId = options.getSpaceId();
		const isCurrentRequest = () =>
			options.getSpaceId() === requestSpaceId &&
			options.getRouteWorkId() === workId;
		loading = true;
		error = "";
		try {
			const { work } = await sdk.works.get(workId);
			if (!isCurrentRequest()) return;
			if (isNewerWorkSnapshot(detail, work)) {
				detail = work;
				notify(work);
				syncFormFromDetail();
			}
			void loadHideCohubBarEntitlement();
			void loadVersions(work.id);
			if (options.getCanViewStats()) void loadStats(work.id);
		} catch (cause) {
			if (!isCurrentRequest()) return;
			detail = null;
			notify(null);
			error = cause instanceof Error ? cause.message : "Failed to load work";
		} finally {
			if (isCurrentRequest()) loading = false;
		}
	}

	async function loadVersions(workId: string) {
		const guard = createKeyedRouteRequestGuard({
			captureKey: () =>
				`${options.getSpaceId()}:${options.getRouteWorkId() ?? ""}`,
		});
		versionsLoading = true;
		versionsError = "";
		try {
			const { versions: nextVersions } = await sdk.works.listVersions(workId);
			if (guard.isCurrent()) {
				versions = versions.reduce(upsertWorkVersion, nextVersions);
			}
		} catch (cause) {
			if (guard.isCurrent()) {
				versionsError =
					cause instanceof Error ? cause.message : "Failed to load versions";
			}
		} finally {
			if (guard.isCurrent()) versionsLoading = false;
		}
	}

	async function loadStats(workId: string) {
		if (!options.getCanViewStats()) return;
		const guard = createKeyedRouteRequestGuard({
			captureKey: () =>
				`${options.getSpaceId()}:${options.getRouteWorkId() ?? ""}`,
		});
		statsLoading = true;
		statsError = "";
		try {
			const nextStats = await sdk.works.getStats(workId);
			if (guard.isCurrent()) stats = nextStats;
		} catch (cause) {
			if (guard.isCurrent()) {
				statsError =
					cause instanceof Error ? cause.message : "Failed to load view stats";
			}
		} finally {
			if (guard.isCurrent()) statsLoading = false;
		}
	}

	async function publishVersion() {
		if (!detail || publishSubmitting) return;
		publishError = "";
		publishSubmitting = true;
		try {
			const { work, version } = await sdk.works.publishVersion(detail.id);
			detail = work;
			notify(work);
			syncFormFromDetail();
			await loadVersions(work.id);
			notifyWorksUpdated({ work, version });
		} catch (cause) {
			publishError =
				cause instanceof Error ? cause.message : "Failed to publish version";
		} finally {
			publishSubmitting = false;
		}
	}

	async function copyId(id: string) {
		try {
			await navigator.clipboard.writeText(id);
			copiedId = true;
			if (copiedTimer) clearTimeout(copiedTimer);
			copiedTimer = setTimeout(() => {
				copiedId = false;
			}, 1600);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Failed to copy work ID";
		}
	}

	async function copyPublicRoute(route: string) {
		const value =
			typeof window === "undefined"
				? route
				: `${window.location.origin}${route}`;
		try {
			await navigator.clipboard.writeText(value);
			copiedPublicRoute = true;
			if (copiedPublicRouteTimer) clearTimeout(copiedPublicRouteTimer);
			copiedPublicRouteTimer = setTimeout(() => {
				copiedPublicRoute = false;
			}, 1600);
		} catch (cause) {
			error =
				cause instanceof Error ? cause.message : "Failed to copy public link";
		}
	}

	async function toggleStatus(status: "published" | "disabled") {
		if (!detail || actionInProgress) return;
		actionInProgress = true;
		error = "";
		try {
			let work: WorkRecord;
			let version: WorkVersionRecord | undefined;
			if (status === "published") {
				const result = await sdk.works.publishVersion(detail.id);
				work = result.work;
				version = result.version;
			} else {
				work = (await sdk.works.update(detail.id, { status })).work;
			}
			detail = work;
			notify(work);
			syncFormFromDetail();
			void loadVersions(work.id);
			notifyWorksUpdated({ work, version });
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Failed to update work";
			void loadDetail(detail.id);
		} finally {
			actionInProgress = false;
		}
	}

	async function deleteWork() {
		if (
			!detail ||
			actionInProgress ||
			deleteInProgress ||
			!confirm(
				"Delete this work? This removes the management record and public link.",
			)
		)
			return;
		const deletedWorkId = detail.id;
		let deleted = false;
		actionInProgress = true;
		deleteInProgress = true;
		error = "";
		try {
			await sdk.works.delete(deletedWorkId);
			deleted = true;
			detail = null;
			notify(null);
			notifyWorksUpdated({ deletedWorkId });
			await goto(buildSpaceLandingRoute(options.getSpaceId()), {
				replaceState: true,
			});
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Failed to delete work";
		} finally {
			if (!deleted) {
				actionInProgress = false;
				deleteInProgress = false;
			}
		}
	}

	async function submitUpdate(event: SubmitEvent) {
		event.preventDefault();
		if (!detail || formSubmitting) return;
		formError = "";
		if (!formSlug.trim()) {
			formError = "Slug is required";
			return;
		}
		if (!formTargetRef.trim()) {
			formError = "Target is required";
			return;
		}
		formSubmitting = true;
		try {
			const shouldRelease =
				formStatus === "published" && detail.status !== "published";
			const { work: savedWork } = await sdk.works.update(detail.id, {
				slug: formSlug.trim(),
				status: shouldRelease ? detail.status : formStatus,
				visibility: formVisibility,
				targetType: formTargetType,
				targetRef: formTargetRef.trim(),
				workScopes: selectedScopeList(formScopes, WORK_SCOPE_OPTIONS),
				allowedViewerScopes: selectedScopeList(
					formViewerScopes,
					WORK_VIEWER_SCOPE_OPTIONS,
				),
				meta: buildWorkMeta(detail.meta, formHideCohubBar),
			});
			let work = savedWork;
			let version: WorkVersionRecord | undefined;
			if (shouldRelease) {
				const result = await sdk.works.publishVersion(savedWork.id);
				work = result.work;
				version = result.version;
			}
			detail = work;
			notify(work);
			editMode = false;
			syncFormFromDetail();
			void loadVersions(work.id);
			notifyWorksUpdated({ work, version });
		} catch (cause) {
			formError =
				cause instanceof Error ? cause.message : "Failed to save work";
		} finally {
			formSubmitting = false;
		}
	}

	function applyWorksChanged(change: WorksChangedDetail) {
		if (change.spaceId !== options.getSpaceId()) return;
		const workId = options.getRouteWorkId();
		if (!workId) return;
		if (change.deletedWorkId === workId) {
			detail = null;
			notify(null);
			return;
		}
		if (!change.work || change.work.id !== workId) return;
		if (isNewerWorkSnapshot(detail, change.work)) {
			detail = change.work;
			notify(change.work);
			if (!editMode && !formSubmitting) syncFormFromDetail();
		}
		if (change.version?.workId === workId) {
			versions = upsertWorkVersion(versions, change.version);
		}
	}

	function refresh() {
		const workId = options.getRouteWorkId();
		if (workId) void loadDetail(workId);
	}

	function resetTransientState() {
		loading = false;
		versions = [];
		versionsLoading = false;
		versionsError = "";
		stats = null;
		statsLoading = false;
		statsError = "";
		editMode = false;
		actionInProgress = false;
		deleteInProgress = false;
		formError = "";
		hideCohubBarAllowed = false;
		hideCohubBarLoading = false;
		publishError = "";
		copiedPublicRoute = false;
	}

	function syncRoute() {
		const workId = options.getRouteWorkId();
		const stateKey = `${options.getSpaceId()}:${workId ?? ""}`;
		if (routeStateKey === stateKey) return;
		routeStateKey = stateKey;
		resetTransientState();
		if (workId) {
			void loadDetail(workId);
			return;
		}
		detail = null;
		notify(null);
	}

	function dispose() {
		if (copiedTimer) clearTimeout(copiedTimer);
		if (copiedPublicRouteTimer) clearTimeout(copiedPublicRouteTimer);
		copiedTimer = null;
		copiedPublicRouteTimer = null;
	}

	return {
		get detail() {
			return detail;
		},
		get loading() {
			return loading;
		},
		get error() {
			return error;
		},
		get actionInProgress() {
			return actionInProgress;
		},
		get deleteInProgress() {
			return deleteInProgress;
		},
		get editMode() {
			return editMode;
		},
		set editMode(value: boolean) {
			editMode = value;
		},
		get formSlug() {
			return formSlug;
		},
		set formSlug(value: string) {
			formSlug = value;
		},
		get formTargetType() {
			return formTargetType;
		},
		set formTargetType(value: WorkTargetType) {
			formTargetType = value;
		},
		get formTargetRef() {
			return formTargetRef;
		},
		set formTargetRef(value: string) {
			formTargetRef = value;
		},
		get formStatus() {
			return formStatus;
		},
		set formStatus(value: WorkStatus) {
			formStatus = value;
		},
		get formVisibility() {
			return formVisibility;
		},
		set formVisibility(value: WorkVisibility) {
			formVisibility = value;
		},
		get formHideCohubBar() {
			return formHideCohubBar;
		},
		set formHideCohubBar(value: boolean) {
			formHideCohubBar = value;
		},
		get hideCohubBarAllowed() {
			return hideCohubBarAllowed;
		},
		get hideCohubBarLoading() {
			return hideCohubBarLoading;
		},
		get formScopes() {
			return formScopes;
		},
		set formScopes(value: Record<string, boolean>) {
			formScopes = value;
		},
		get formViewerScopes() {
			return formViewerScopes;
		},
		set formViewerScopes(value: Record<string, boolean>) {
			formViewerScopes = value;
		},
		get formSubmitting() {
			return formSubmitting;
		},
		get formError() {
			return formError;
		},
		get copiedId() {
			return copiedId;
		},
		get copiedPublicRoute() {
			return copiedPublicRoute;
		},
		get versions() {
			return versions;
		},
		get versionsLoading() {
			return versionsLoading;
		},
		get versionsError() {
			return versionsError;
		},
		get stats() {
			return stats;
		},
		get statsLoading() {
			return statsLoading;
		},
		get statsError() {
			return statsError;
		},
		get publishSubmitting() {
			return publishSubmitting;
		},
		get publishError() {
			return publishError;
		},
		syncFormFromDetail,
		publicRoute,
		loadStats,
		publishVersion,
		copyId,
		copyPublicRoute,
		toggleStatus,
		deleteWork,
		submitUpdate,
		applyWorksChanged,
		refresh,
		syncRoute,
		dispose,
	};
}
