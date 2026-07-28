<script lang="ts">
import type { WorkDetailResponse } from "@neta-art/cohub";
import { onMount } from "svelte";
import WorkPageHead from "$lib/components/work/WorkPageHead.svelte";
import WorkSurface from "$lib/components/work/WorkSurface.svelte";
import { sdk } from "$lib/sdk";
import { buildWorkPageMeta } from "$lib/work-page-meta";

type ReadyData = {
	mode: "ready";
	work: WorkDetailResponse["work"];
	space: WorkDetailResponse["space"];
	owner: WorkDetailResponse["owner"];
	content: WorkDetailResponse["content"];
	publicUrl: WorkDetailResponse["publicUrl"];
	pathname: string;
	origin: string;
};

type ClientData = {
	mode: "client";
	pathname: string;
	origin: string;
	username: string;
	spaceSlug: string;
	workSlug: string;
};

const props = $props<{ data: ReadyData | ClientData }>();

let clientDetail = $state<WorkDetailResponse | null>(null);
let clientError = $state("");
let clientLoading = $state(false);
/** WorkSurface uses window/postMessage; mount only after hydration. */
let surfaceReady = $state(false);

const ready = $derived(
	props.data.mode === "ready"
		? props.data
		: clientDetail
			? {
					mode: "ready" as const,
					work: clientDetail.work,
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
		? buildWorkPageMeta(
				{
					work: ready.work,
					space: ready.space,
					owner: ready.owner,
					publicUrl: ready.publicUrl,
					contentUrl: ready.content?.url ?? null,
				},
				{ origin: ready.origin, path: ready.pathname },
			)
		: buildWorkPageMeta(null, {
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
	if (props.data.mode !== "client") {
		clientDetail = null;
		clientError = "";
		clientLoading = false;
		return;
	}
	const { username, spaceSlug, workSlug } = props.data;
	let cancelled = false;
	clientLoading = true;
	clientError = "";
	clientDetail = null;
	void sdk.works
		.getBySlug(username, spaceSlug, workSlug)
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
				status === 401 || status === 403
					? "Sign in to view this Work."
					: status === 404
						? "Work not found."
						: "Failed to load this Work.";
		});
	return () => {
		cancelled = true;
	};
});
</script>

<WorkPageHead meta={pageMeta} />

{#if ready && surfaceReady}
	<WorkSurface
		work={ready.work}
		space={ready.space}
		owner={ready.owner}
		content={ready.content}
	/>
{:else if ready}
	<!-- SSR / first paint: head already has share meta; surface hydrates client-side. -->
	<div class="public-work-viewport bg-bg-primary" aria-hidden="true"></div>
{:else if clientLoading}
	<div
		class="public-work-viewport flex items-center justify-center bg-bg-primary px-4 text-[13px] text-text-tertiary"
	>
		Loading Work…
	</div>
{:else}
	<div
		class="public-work-viewport flex items-center justify-center bg-bg-primary px-4 text-[13px] text-text-secondary"
	>
		{clientError || "Work is unavailable."}
	</div>
{/if}
