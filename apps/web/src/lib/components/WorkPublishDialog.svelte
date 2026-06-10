<script lang="ts">
import type {
	Permission,
	SpaceRecord,
	WorkRecord,
	WorkTargetType,
} from "@neta-art/cohub";
import { Check, Copy, ExternalLink, Loader2, Rocket } from "lucide-svelte";
import Dialog from "$lib/components/Dialog.svelte";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";

const {
	open,
	spaceId,
	ownerUsername,
	spaceSlug,
	targetType,
	targetRef,
	onClose,
	onSpaceUpdated,
}: {
	open: boolean;
	spaceId: string;
	ownerUsername: string | null;
	spaceSlug: string | null;
	targetType: WorkTargetType;
	targetRef: string;
	onClose: () => void;
	onSpaceUpdated?: (space: SpaceRecord) => void;
} = $props();

let slug = $state("");
let usernameDraft = $state("");
let spaceSlugDraft = $state("");
let publishing = $state(false);
let error = $state<string | null>(null);
let published = $state<WorkRecord | null>(null);
let copied = $state(false);
let initializedTargetRef = $state("");

const workScopes = $state<Record<string, boolean>>({
	"space.view": true,
	"session.view": false,
});
const allowedViewerScopes = $state<Record<string, boolean>>({
	"session.prompt.readonly": true,
	"session.prompt.fullaccess": false,
});
const currentUsername = $derived(
	ownerUsername?.trim() || normalizeUsername(usernameDraft),
);
const currentSpaceSlug = $derived(
	spaceSlug?.trim() || normalizeSlugInput(spaceSlugDraft),
);
const currentWorkSlug = $derived(normalizeSlugInput(slug));
const missingUsername = $derived(!ownerUsername?.trim());
const missingSpaceSlug = $derived(!spaceSlug?.trim());
const canPublish = $derived(
	Boolean(
		currentUsername && currentSpaceSlug && currentWorkSlug && !publishing,
	),
);
const publicPath = $derived(
	`/${currentUsername || "username"}/${currentSpaceSlug || "space"}/w/${currentWorkSlug || "work"}`,
);
const workUrl = $derived.by(() => {
	if (!currentUsername || !currentSpaceSlug || !published) return "";
	return `${window.location.origin}/${currentUsername}/${currentSpaceSlug}/w/${published.slug}`;
});

$effect(() => {
	if (!open) {
		slug = "";
		usernameDraft = "";
		spaceSlugDraft = "";
		publishing = false;
		error = null;
		published = null;
		copied = false;
		initializedTargetRef = "";
		return;
	}
	if (initializedTargetRef !== targetRef) {
		const base =
			targetRef
				.split("/")
				.filter(Boolean)
				.pop()
				?.replace(/\.[^.]+$/, "") || "work";
		slug = normalizeSlugInput(base) || "work";
		published = null;
		error = null;
		copied = false;
		initializedTargetRef = targetRef;
	}
	if (!missingUsername) usernameDraft = ownerUsername ?? "";
	if (!missingSpaceSlug) spaceSlugDraft = spaceSlug ?? "";
});

function normalizeSlugInput(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
		.slice(0, 80);
}

function normalizeUsername(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 39);
}

function selectedScopes(source: Record<string, boolean>) {
	return Object.entries(source)
		.filter(([, enabled]) => enabled)
		.map(([scope]) => scope as Permission);
}

async function ensurePublicAddress() {
	if (missingUsername) {
		const nextUsername = normalizeUsername(usernameDraft);
		if (!nextUsername) throw new Error("Username is required.");
		const currentProfile = authStore.profile;
		await authStore.updateProfile({
			displayName: currentProfile?.displayName ?? "User",
			avatarUrl: currentProfile?.avatarUrl ?? null,
			username: nextUsername,
		});
		usernameDraft = nextUsername;
	}
	if (missingSpaceSlug) {
		const nextSpaceSlug = normalizeSlugInput(spaceSlugDraft);
		if (!nextSpaceSlug) throw new Error("Space slug is required.");
		const result = await sdk.space(spaceId).update({ slug: nextSpaceSlug });
		onSpaceUpdated?.(result.space);
		spaceSlugDraft = result.space.slug ?? nextSpaceSlug;
	}
}

async function publish() {
	publishing = true;
	error = null;
	try {
		await ensurePublicAddress();
		if (!currentWorkSlug) throw new Error("Work slug is required.");
		const result = await sdk.works.create({
			spaceId,
			slug: currentWorkSlug,
			status: "published",
			targetType,
			targetRef,
			workScopes: selectedScopes(workScopes),
			allowedViewerScopes: selectedScopes(allowedViewerScopes),
		});
		published = result.work;
		window.dispatchEvent(
			new CustomEvent("cohub:works-changed", { detail: { spaceId } }),
		);
	} catch (err) {
		error = err instanceof Error ? err.message : "Publish failed.";
	} finally {
		publishing = false;
	}
}

async function copyUrl() {
	if (!workUrl) return;
	await navigator.clipboard.writeText(workUrl);
	copied = true;
	setTimeout(() => (copied = false), 1400);
}
</script>

<Dialog {open} onClose={onClose} title="Publish work" maxWidth="560px">
	<div class="publish-panel">
		{#if published}
			<div class="success-block">
				<div class="success-icon"><Check class="h-4 w-4" /></div>
				<div class="min-w-0 flex-1">
					<div class="text-[13px] font-medium text-text-primary">Published</div>
					<div class="mt-1 truncate font-mono text-[12px] text-text-tertiary">{workUrl}</div>
				</div>
			</div>
			<div class="button-row">
				<button type="button" class="secondary-btn" onclick={() => void copyUrl()}>
					{#if copied}<Check class="h-3.5 w-3.5" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
					Copy
				</button>
				<a class="secondary-btn" href={workUrl} target="_blank" rel="noreferrer"><ExternalLink class="h-3.5 w-3.5" />Open</a>
				<button type="button" class="primary-btn" onclick={onClose}>Done</button>
			</div>
		{:else}
			<section class="address-section">
				<div class="section-label">Public URL</div>
				<div class="url-preview">{publicPath}</div>
				<div class="address-grid">
					<label class="field" class:field-required={missingUsername && !currentUsername}>
						<span>Username</span>
						{#if missingUsername}
							<input class="form-input font-mono" bind:value={usernameDraft} oninput={() => usernameDraft = normalizeUsername(usernameDraft)} placeholder="Required" maxlength="39" aria-invalid={!currentUsername} />
							{#if !currentUsername}<div class="field-hint">Required for public URL</div>{/if}
						{:else}
							<div class="readonly-value">{ownerUsername}</div>
						{/if}
					</label>
					<label class="field" class:field-required={missingSpaceSlug && !currentSpaceSlug}>
						<span>Space slug</span>
						{#if missingSpaceSlug}
							<input class="form-input font-mono" bind:value={spaceSlugDraft} oninput={() => spaceSlugDraft = normalizeSlugInput(spaceSlugDraft)} placeholder="Required" maxlength="80" aria-invalid={!currentSpaceSlug} />
							{#if !currentSpaceSlug}<div class="field-hint">Required for public URL</div>{/if}
						{:else}
							<div class="readonly-value">{spaceSlug}</div>
						{/if}
					</label>
					<label class="field" class:field-required={!currentWorkSlug}>
						<span>Work slug</span>
						<input class="form-input font-mono" bind:value={slug} oninput={() => slug = normalizeSlugInput(slug)} placeholder="Required" maxlength="80" aria-invalid={!currentWorkSlug} />
						{#if !currentWorkSlug}<div class="field-hint">Required</div>{/if}
					</label>
				</div>
			</section>

			<section class="source-section">
				<div>
					<div class="section-label">Source</div>
					<div class="source-ref"><span>{targetType}</span>{targetRef}</div>
				</div>
			</section>

			<section class="permissions-grid">
				<div>
					<div class="section-label">Work can</div>
					<label class="permission-row"><input type="checkbox" bind:checked={workScopes["space.view"]} /> View space</label>
					<label class="permission-row"><input type="checkbox" bind:checked={workScopes["session.view"]} /> View sessions</label>
				</div>
				<div>
					<div class="section-label">Viewers can allow</div>
					<label class="permission-row"><input type="checkbox" bind:checked={allowedViewerScopes["session.prompt.readonly"]} /> Prompt read-only</label>
					<label class="permission-row"><input type="checkbox" bind:checked={allowedViewerScopes["session.prompt.fullaccess"]} /> Prompt full access</label>
				</div>
			</section>

			{#if error}<div class="error-box">{error}</div>{/if}
			<div class="button-row footer-row">
				<button type="button" class="secondary-btn" onclick={onClose}>Cancel</button>
				<button type="button" class="primary-btn" onclick={() => void publish()} disabled={!canPublish}>
					{#if publishing}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Rocket class="h-3.5 w-3.5" />{/if}
					Publish
				</button>
			</div>
		{/if}
	</div>
</Dialog>

<style>
	.publish-panel { display: grid; gap: 16px; padding: 16px; }
	.section-label { margin-bottom: 6px; font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--text-tertiary); }
	.address-section, .source-section { border: 1px solid var(--border-subtle); background: var(--bg-surface); border-radius: 8px; padding: 12px; }
	.url-preview { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-radius: 6px; background: var(--bg-input); padding: 8px 10px; font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); }
	.address-grid { display: grid; gap: 10px; margin-top: 12px; }
	@media (min-width: 640px) { .address-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
	.field { display: grid; gap: 5px; min-width: 0; }
	.field span { font-size: 11px; color: var(--text-tertiary); }
	.form-input, .readonly-value { height: 34px; min-width: 0; border-radius: 6px; border: 1px solid var(--border-subtle); background: var(--bg-input); padding: 0 9px; color: var(--text-primary); font-size: 12px; outline: none; }
	.form-input::placeholder { color: var(--text-placeholder); }
	.form-input:focus { border-color: var(--brand); }
	.field-required .form-input { border-color: color-mix(in srgb, var(--brand) 55%, var(--border-subtle)); background: color-mix(in srgb, var(--brand) 7%, var(--bg-input)); }
	.field-required span { color: var(--text-secondary); }
	.field-hint { font-size: 10px; color: var(--text-placeholder); }
	.readonly-value { display: flex; align-items: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-tertiary); }
	.source-ref { display: flex; min-width: 0; gap: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); }
	.source-ref span { color: var(--text-placeholder); }
	.permissions-grid { display: grid; gap: 14px; }
	@media (min-width: 640px) { .permissions-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
	.permission-row { display: flex; align-items: center; gap: 8px; min-height: 28px; font-size: 12px; color: var(--text-secondary); }
	.permission-row input { accent-color: var(--brand); }
	.error-box { border-radius: 6px; border: 1px solid color-mix(in srgb, var(--error-soft) 30%, transparent); background: var(--error-bg); padding: 8px 10px; font-size: 12px; color: var(--error-soft); }
	.button-row { display: flex; justify-content: flex-end; gap: 8px; }
	.footer-row { border-top: 1px solid var(--border-subtle); padding-top: 12px; }
	.primary-btn, .secondary-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; border-radius: 6px; padding: 0 12px; font-size: 12px; font-weight: 500; transition: background 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease; }
	.primary-btn { border: 1px solid var(--brand); background: var(--brand); color: var(--brand-contrast-fg); }
	.primary-btn:hover:not(:disabled) { opacity: .92; }
	.primary-btn:disabled { cursor: not-allowed; opacity: .5; }
	.secondary-btn { border: 1px solid var(--border-subtle); background: var(--bg-surface); color: var(--text-secondary); }
	.secondary-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
	.success-block { display: flex; align-items: center; gap: 10px; border-radius: 8px; border: 1px solid var(--border-subtle); background: var(--bg-surface); padding: 12px; }
	.success-icon { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 6px; background: var(--brand); color: var(--brand-contrast-fg); }
</style>
