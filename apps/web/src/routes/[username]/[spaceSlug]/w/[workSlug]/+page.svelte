<script lang="ts">
import { onDestroy, onMount } from "svelte";
import { PUBLIC_API_ORIGIN } from "$env/static/public";
import { getAuthToken, signInWithRedirectPath } from "$lib/auth";

const props = $props<{
	data: {
		work: {
			id: string;
			spaceId: string;
			slug: string;
			targetType: "file" | "directory" | "port";
			targetRef: string;
			workScopes: string[];
			allowedViewerScopes: string[];
		};
		owner: { username: string | null; displayName: string } | null;
		content: { url?: string; targetType?: string; path?: string } | null;
	};
}>();

let frame: HTMLIFrameElement | null = $state(null);
let workToken = $state<string | null>(null);
let authOpen = $state(false);
let pendingAuth = $state<{
	requestId: string;
	scopes: string[];
	reason?: string;
} | null>(null);
let authError = $state<string | null>(null);

const work = $derived(props.data.work);
const iframeSrc = $derived.by(
	() =>
		props.data.content?.url ??
		(work.targetType === "port" ? work.targetRef : ""),
);
function isAllowedFrameOrigin(origin: string, targetType: string) {
	try {
		const { protocol, hostname } = new URL(origin);
		if (protocol !== "https:") return false;
		if (targetType === "port")
			return hostname === "cohub.run" || hostname.endsWith(".cohub.run");
		return true;
	} catch {
		return false;
	}
}

const frameOrigin = $derived.by(() => {
	if (!iframeSrc) return null;
	try {
		const origin = new URL(iframeSrc, location.href).origin;
		return isAllowedFrameOrigin(origin, work.targetType) ? origin : null;
	} catch {
		return null;
	}
});
const frameReplyTarget = $derived(frameOrigin ?? location.origin);
const frameSandbox =
	"allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals";

async function ensureBaseToken(forceRefresh = false) {
	if (workToken && !forceRefresh) return workToken;
	const userToken = await getAuthToken({ forceRefresh });
	if (!userToken) {
		await signInWithRedirectPath(location.pathname);
		return null;
	}
	const response = await fetch(
		`${PUBLIC_API_ORIGIN ?? ""}/api/works/${work.id}/session`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${userToken}` },
		},
	);
	if (!response.ok) throw new Error("Failed to create work session.");
	const result = await response.json();
	workToken = result.token;
	return workToken;
}

async function authorize(scopes: string[]) {
	const userToken = await getAuthToken();
	if (!userToken) {
		await signInWithRedirectPath(location.pathname);
		return null;
	}
	const response = await fetch(
		`${PUBLIC_API_ORIGIN ?? ""}/api/works/${work.id}/authorize`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${userToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ scopes }),
		},
	);
	if (!response.ok)
		throw new Error(
			(await response.json().catch(() => null))?.message ??
				"Authorization failed.",
		);
	const result = await response.json();
	workToken = result.token;
	return workToken;
}

function reply(requestId: string, payload: Record<string, unknown>) {
	if (!frameOrigin) return;
	frame?.contentWindow?.postMessage(
		{ requestId, ...payload },
		frameReplyTarget,
	);
}

function replyAuthCancel() {
	if (!pendingAuth) return;
	reply(pendingAuth.requestId, {
		type: "cohub.work.authorize.result",
		token: null,
	});
	authOpen = false;
	pendingAuth = null;
	authError = null;
}

async function handleMessage(event: MessageEvent) {
	if (event.source !== frame?.contentWindow) return;
	if (frameOrigin && event.origin !== frameOrigin) return;
	const data = event.data as {
		type?: string;
		requestId?: string;
		scopes?: string[];
		reason?: string;
		forceRefresh?: boolean;
	};
	if (!data?.requestId) return;
	try {
		if (!frameOrigin) return;
		if (data.type === "cohub.work.context") {
			reply(data.requestId, {
				type: "cohub.work.context.result",
				context: {
					work: {
						id: work.id,
						slug: work.slug,
						url: location.href,
					},
					space: { id: work.spaceId },
					permissions: {
						scopes: work.workScopes,
						workScopes: work.workScopes,
						viewerScopes: [],
					},
				},
			});
		}
		if (data.type === "cohub.work.token") {
			const token = await ensureBaseToken(Boolean(data.forceRefresh));
			reply(data.requestId, { type: "cohub.work.token.result", token });
		}
		if (data.type === "cohub.work.authorize") {
			const scopes = (data.scopes ?? []).filter((scope) =>
				work.allowedViewerScopes.includes(scope),
			);
			if (scopes.length === 0) {
				reply(data.requestId, {
					type: "cohub.work.error",
					message: "No allowed scopes requested.",
				});
				return;
			}
			pendingAuth = {
				requestId: data.requestId,
				scopes,
				reason: data.reason,
			};
			authError = null;
			authOpen = true;
		}
	} catch (error) {
		reply(data.requestId, {
			type: "cohub.work.error",
			message: error instanceof Error ? error.message : "Request failed.",
		});
	}
}

async function confirmAuth() {
	if (!pendingAuth) return;
	authError = null;
	try {
		const token = await authorize(pendingAuth.scopes);
		reply(pendingAuth.requestId, {
			type: "cohub.work.authorize.result",
			token,
		});
		authOpen = false;
		pendingAuth = null;
	} catch (error) {
		authError =
			error instanceof Error ? error.message : "Authorization failed.";
	}
}

onMount(() => window.addEventListener("message", handleMessage));
onDestroy(() => window.removeEventListener("message", handleMessage));
</script>

<svelte:head><title>{work.slug} · Cohub</title></svelte:head>

<div class="flex min-h-screen flex-col bg-bg-content text-text-primary">
	<div class="min-h-0 flex-1">
		{#if iframeSrc}
			<iframe
				bind:this={frame}
				class="h-[calc(100vh-34px)] w-full border-0 bg-bg-primary"
				title={work.slug}
				sandbox={frameSandbox}
				src={iframeSrc}
			></iframe>
		{:else}
			<div class="flex h-[calc(100vh-34px)] items-center justify-center p-6 text-sm text-text-tertiary">
				Work asset is unavailable.
			</div>
		{/if}
	</div>
	<footer class="flex h-[34px] items-center justify-between border-t border-border-subtle bg-bg-surface px-3 text-[11px] text-text-tertiary">
		<div class="truncate">{work.slug} by {props.data.owner?.displayName ?? "Cohub"}</div>
		<div class="flex items-center gap-3">
			<span>Powered by Cohub</span>
			<button type="button" class="text-text-secondary hover:text-text-primary">Remix</button>
		</div>
	</footer>
</div>

{#if authOpen && pendingAuth}
	<div class="fixed inset-0 z-[100] flex items-center justify-center bg-overlay-scrim p-4">
		<div class="w-full max-w-[420px] rounded-xl border border-border-subtle bg-bg-primary shadow-2xl">
			<div class="border-b border-border-subtle px-4 py-3 text-sm font-medium text-text-primary">Allow work access?</div>
			<div class="space-y-3 p-4 text-sm text-text-secondary">
				<div>{pendingAuth.reason || "This work wants to use Cohub on your behalf."}</div>
				<ul class="space-y-1 text-xs text-text-tertiary">
					{#each pendingAuth.scopes as scope}<li>• {scope}</li>{/each}
				</ul>
				{#if authError}<div class="rounded-md border border-error-soft/30 bg-error-bg p-2 text-xs text-error-soft">{authError}</div>{/if}
			</div>
			<div class="flex justify-end gap-2 border-t border-border-subtle p-3">
				<button type="button" class="action-btn" onclick={replyAuthCancel}>Cancel</button>
				<button type="button" class="action-btn primary" onclick={() => void confirmAuth()}>Allow</button>
			</div>
		</div>
	</div>
{/if}
