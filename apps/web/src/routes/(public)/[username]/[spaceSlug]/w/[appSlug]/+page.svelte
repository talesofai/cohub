<script lang="ts">
import type { AppNavigationOpenMessage } from "@cohub/protocol/app-navigation";
import { isUuid } from "@cohub/protocol/identifiers";
import type {
	AppDetailResponse,
	AppRuntimeShellContext,
} from "@neta-art/cohub";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { buildAppPageMeta } from "$lib/app-page-meta";
import { reportAppPromotionReady, startAppPromotion } from "$lib/app-promotion";
import AppPageHead from "$lib/components/app/AppPageHead.svelte";
import AppSurface from "$lib/components/app/AppSurface.svelte";
import { resolveAppNavigation } from "$lib/features/app/app-open";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";
import {
	buildSpaceCheckpointRoute,
	buildSpaceCronjobRoute,
	buildSpaceFileRoute,
	buildSpaceSessionRoute,
	buildSpaceTaskRoute,
} from "$lib/space-routes";

type ReadyData = {
	mode: "ready";
	app: AppDetailResponse["app"];
	space: AppDetailResponse["space"];
	owner: AppDetailResponse["owner"];
	content: AppDetailResponse["content"];
	publicUrl: AppDetailResponse["publicUrl"];
	pathname: string;
	origin: string;
};

type ClientData = {
	mode: "client";
	pathname: string;
	origin: string;
	username: string;
	spaceSlug: string;
	appSlug: string;
};

const props = $props<{ data: ReadyData | ClientData }>();

const launchState = $derived({
	search: page.url.search,
	hash: page.url.hash,
});

let clientDetail = $state<AppDetailResponse | null>(null);
let clientError = $state("");
let clientLoading = $state(false);
/** AppSurface uses window/postMessage; mount only after hydration. */
let surfaceReady = $state(false);
let surfaceLoaded = false;
let promotionReadyReported = false;
let promotionRuntime: ReturnType<typeof startAppPromotion> | null = null;
let activePromotionKey = "";
let standaloneShell = $state<AppRuntimeShellContext | undefined>();
let hostNotice = $state("");

// Opt-in target context, verified with the account API. The query is not a grant.
$effect(() => {
	void authStore.userUuid;
	const spaceId = page.url.searchParams.get("cohub_space");
	standaloneShell = undefined;
	hostNotice = "";
	if (!surfaceReady || !spaceId || !isUuid(spaceId)) return;
	let cancelled = false;
	void sdk
		.space(spaceId)
		.get()
		.then((space) => {
			if (!cancelled)
				standaloneShell = {
					surface: "workspace",
					space: { id: space.id, name: space.name },
					session: null,
					turn: null,
				};
		})
		.catch(() => {
			if (!cancelled) hostNotice = "Space context is unavailable.";
		});
	return () => {
		cancelled = true;
	};
});

function closeStandalone() {
	window.close();
	if (!window.closed) hostNotice = "You can close this tab.";
}

async function openStandalone(message: AppNavigationOpenMessage) {
	const target = message.target;
	if (!standaloneShell?.space)
		return { handled: false as const, reason: "unsupported" as const };
	if (target.kind === "app") {
		if (message.call)
			return { handled: false as const, reason: "unsupported" as const };
		const { detail, launch } = await resolveAppNavigation(
			sdk.apps,
			target.ref,
			target.launch,
		);
		if (!detail.publicUrl) return { handled: false as const, reason: "inaccessible" as const };
		const url = new URL(detail.publicUrl, page.url.origin);
		if (url.origin !== page.url.origin)
			return { handled: false as const, reason: "unsupported" as const };
		if (launch?.search) url.search = launch.search;
		if (launch?.hash) url.hash = launch.hash;
		url.searchParams.set("cohub_space", standaloneShell.space.id);
		await goto(url.href);
		return { handled: true as const };
	}
	if (target.spaceId !== standaloneShell.space.id)
		return { handled: false as const, reason: "unsupported" as const };
	const url =
		target.kind === "file"
			? buildSpaceFileRoute(target.spaceId, target.path)
			: target.kind === "session"
				? buildSpaceSessionRoute(target.spaceId, target.sessionId)
				: target.kind === "task"
					? buildSpaceTaskRoute(target.spaceId, target.taskRunId)
					: target.kind === "checkpoint"
						? buildSpaceCheckpointRoute(target.spaceId, target.checkpointId)
						: buildSpaceCronjobRoute(target.spaceId, target.cronjobId);
	await goto(url);
	return { handled: true as const };
}

const promotionId = $derived(page.url.searchParams.get("cohub_campaign"));

function maybeReportPromotionReady() {
	if (
		!surfaceLoaded ||
		promotionReadyReported ||
		!promotionRuntime ||
		!promotionId ||
		!ready
	)
		return;
	const appId = ready.app.id;
	promotionReadyReported = true;
	void promotionRuntime
		.then((runtime) => reportAppPromotionReady(appId, promotionId, runtime))
		.catch(() => undefined);
}

function handleSurfaceReady() {
	surfaceLoaded = true;
	maybeReportPromotionReady();
}

const ready = $derived(
	props.data.mode === "ready"
		? props.data
		: clientDetail
			? {
					mode: "ready" as const,
					app: clientDetail.app,
					space: clientDetail.space,
					owner: clientDetail.owner,
					content: clientDetail.content,
					publicUrl: clientDetail.publicUrl,
					pathname: props.data.pathname,
					origin: props.data.origin,
				}
			: null,
);

const pageMeta = $derived(
	ready
		? buildAppPageMeta(
				{
					app: ready.app,
					space: ready.space,
					owner: ready.owner,
					publicUrl: ready.publicUrl,
					contentUrl: ready.content?.url ?? null,
					contentKind:
						ready.content?.kind === "web" || ready.content?.kind === "port"
							? ready.content.kind
							: null,
				},
				{ origin: ready.origin, path: ready.pathname },
			)
		: buildAppPageMeta(null, {
				origin: props.data.origin,
				path: props.data.pathname,
				// Auth-gated shell must not be indexed before client resolution.
				indexable: false,
			}),
);

onMount(() => {
	surfaceReady = true;
});

$effect(() => {
	if (!surfaceReady || !promotionId || !ready) return;
	const key = `${ready.app.id}:${promotionId}`;
	if (activePromotionKey === key) return;
	activePromotionKey = key;
	promotionReadyReported = false;
	promotionRuntime = startAppPromotion(ready.app.id, promotionId);
	promotionRuntime.catch(() => undefined);
	maybeReportPromotionReady();
});

$effect(() => {
	if (props.data.mode !== "client") {
		clientDetail = null;
		clientError = "";
		clientLoading = false;
		return;
	}
	const { username, spaceSlug, appSlug } = props.data;
	let cancelled = false;
	clientLoading = true;
	clientError = "";
	clientDetail = null;
	void sdk.apps
		.getBySlug(username, spaceSlug, appSlug)
		.then((detail) => {
			if (!cancelled) {
				clientDetail = detail;
				clientLoading = false;
			}
		})
		.catch((err: unknown) => {
			if (cancelled) return;
			clientLoading = false;
			const status =
				err && typeof err === "object" && "status" in err
					? Number((err as { status?: unknown }).status)
					: 0;
			clientError =
				status === 401
					? "Sign in to view this App."
					: status === 403 || status === 404
						? "App not found."
						: "Failed to load this App.";
		});
	return () => {
		cancelled = true;
	};
});
</script>

<AppPageHead meta={pageMeta} />

{#if hostNotice}<p class="fixed left-3 top-3 z-50 rounded bg-bg-surface p-3 text-sm text-text-secondary" role="status">{hostNotice}</p>{/if}

{#if ready && surfaceReady}
	{#key ready.app.id}
	<AppSurface
		app={ready.app}
		space={ready.space}
		owner={ready.owner}
		content={ready.content}
		{launchState}
		shell={standaloneShell}
		onCloseSelf={closeStandalone}
		onNavigationOpen={openStandalone}
		onReady={handleSurfaceReady}
	/>
	{/key}
{:else if ready}
	<!-- SSR / first paint: head already has share meta; surface hydrates client-side. -->
	<div class="min-h-screen bg-bg-primary" aria-hidden="true"></div>
{:else if clientLoading}
	<div
		class="flex min-h-screen items-center justify-center bg-bg-primary px-4 text-[13px] text-text-tertiary"
	>
		Loading App…
	</div>
{:else}
	<div
		class="flex min-h-screen items-center justify-center bg-bg-primary px-4 text-[13px] text-text-secondary"
	>
		{clientError || "App is unavailable."}
	</div>
{/if}
