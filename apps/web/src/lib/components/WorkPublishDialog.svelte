<script lang="ts">
import {
	HttpError,
	type Permission,
	type SpaceRecord,
	type WorkMeta,
	type WorkRecord,
	type WorkTargetType,
} from "@neta-art/cohub";
import { Check, Copy, ExternalLink, Loader2, Rocket } from "lucide-svelte";
import Dialog from "$lib/components/Dialog.svelte";
import { WORK_VIEWER_SCOPE_OPTIONS } from "$lib/features/space/modules/work-utils";
import { dispatchWorksChanged } from "$lib/features/work/work-realtime";
import { sdk } from "$lib/sdk";
import {
	normalizePublicSlugInput,
	normalizeUsernameInput,
	validateSpaceSlugInput,
	validateUsernameInput,
	validateWorkSlugInput,
} from "$lib/slug-rules";
import { authStore } from "$lib/stores/auth.svelte";

const WORK_HIDE_COHUB_BAR_FEATURE = "work.publish.hide_cohub_bar";

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
let visibility = $state<"public" | "space">("public");
let hideCohubBar = $state(false);
let hideCohubBarAllowed = $state(false);
let hideCohubBarLoading = $state(false);

const workScopes = $state<Record<string, boolean>>({
	"space.view": true,
	"session.view": false,
	"file.view": false,
	"taskrun.view": false,
});
const allowedViewerScopes = $state<Record<string, boolean>>({
	"session.prompt.readonly": true,
	"session.prompt.fullaccess": false,
	"generation.create": false,
	"user.space.list": false,
	"user.session.list": false,
	"user.usage.read": false,
});
const missingUsername = $derived(!ownerUsername?.trim());
const missingSpaceSlug = $derived(!spaceSlug?.trim());
const usernameValidation = $derived(
	validateUsernameInput(usernameDraft, { required: missingUsername }),
);
const spaceSlugValidation = $derived(
	validateSpaceSlugInput(spaceSlugDraft, {
		required: missingSpaceSlug,
		label: "Space slug",
	}),
);
const workSlugValidation = $derived(
	validateWorkSlugInput(slug, { required: true, label: "Work slug" }),
);
const currentUsername = $derived(
	ownerUsername?.trim() || usernameValidation.value || "",
);
const currentSpaceSlug = $derived(
	spaceSlug?.trim() || spaceSlugValidation.value || "",
);
const currentWorkSlug = $derived(workSlugValidation.value || "");
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
		visibility = "public";
		hideCohubBar = false;
		hideCohubBarAllowed = false;
		hideCohubBarLoading = false;
		return;
	}
	if (initializedTargetRef !== targetRef) {
		const base =
			targetRef
				.split("/")
				.filter(Boolean)
				.pop()
				?.replace(/\.[^.]+$/, "") || "work";
		slug = normalizePublicSlugInput(base) || "work";
		published = null;
		error = null;
		copied = false;
		visibility = "public";
		hideCohubBar = false;
		initializedTargetRef = targetRef;
	}
	if (!missingUsername) usernameDraft = ownerUsername ?? "";
	if (!missingSpaceSlug) spaceSlugDraft = spaceSlug ?? "";
});

$effect(() => {
	if (!open) return;
	let cancelled = false;
	hideCohubBarLoading = true;
	void sdk.billing
		.getFeatureEntitlement(WORK_HIDE_COHUB_BAR_FEATURE)
		.then(({ enabled }) => {
			if (cancelled) return;
			hideCohubBarAllowed = enabled;
			if (!enabled) hideCohubBar = false;
		})
		.catch(() => {
			if (cancelled) return;
			hideCohubBarAllowed = false;
			hideCohubBar = false;
		})
		.finally(() => {
			if (!cancelled) hideCohubBarLoading = false;
		});
	return () => {
		cancelled = true;
	};
});

function selectedScopes(source: Record<string, boolean>) {
	return Object.entries(source)
		.filter(([, enabled]) => enabled)
		.map(([scope]) => scope as Permission);
}

function buildWorkMeta(): WorkMeta | undefined {
	if (!hideCohubBar) return undefined;
	return { presentation: { hideCohubBar: true } };
}

async function ensurePublicAddress() {
	if (missingUsername) {
		const { value: nextUsername, error } = validateUsernameInput(
			usernameDraft,
			{ required: true },
		);
		if (!nextUsername) throw new Error(error ?? "Username is required.");
		const currentProfile = authStore.profile;
		await authStore.updateProfile({
			displayName: currentProfile?.displayName ?? "User",
			avatarUrl: currentProfile?.avatarUrl ?? null,
			username: nextUsername,
		});
		usernameDraft = nextUsername;
	}
	if (missingSpaceSlug) {
		const { value: nextSpaceSlug, error } = validateSpaceSlugInput(
			spaceSlugDraft,
			{ required: true, label: "Space slug" },
		);
		if (!nextSpaceSlug) throw new Error(error ?? "Space slug is required.");
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
		if (!currentWorkSlug)
			throw new Error(workSlugValidation.error ?? "Work slug is required.");
		try {
			const result = await sdk.works.create({
				spaceId,
				slug: currentWorkSlug,
				status: "published",
				visibility,
				targetType,
				targetRef,
				workScopes: selectedScopes(workScopes),
				allowedViewerScopes: selectedScopes(allowedViewerScopes),
				meta: buildWorkMeta(),
			});
			published = result.work;
		} catch (cause) {
			if (!(cause instanceof HttpError) || cause.status !== 409) throw cause;
			const { works } = await sdk.works.listBySpace(spaceId);
			const existingWork = works.find((work) => work.slug === currentWorkSlug);
			if (!existingWork) throw cause;
			const { work } = await sdk.works.update(existingWork.id, {
				status: existingWork.status,
				visibility,
				targetType,
				targetRef,
				workScopes: selectedScopes(workScopes),
				allowedViewerScopes: selectedScopes(allowedViewerScopes),
				meta: buildWorkMeta(),
			});
			published = (await sdk.works.publishVersion(work.id)).work;
		}
		if (published) dispatchWorksChanged({ spaceId, work: published });
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
					<label class="field" class:field-required={Boolean(usernameValidation.error)}>
						<span>Username</span>
						{#if missingUsername}
							<input class="form-input font-mono" bind:value={usernameDraft} oninput={() => usernameDraft = normalizeUsernameInput(usernameDraft)} placeholder="Required" maxlength="39" aria-invalid={Boolean(usernameValidation.error)} title={usernameValidation.error ?? "Username"} aria-label={usernameValidation.error ?? "Username"} />
						{:else}
							<div class="readonly-value">{ownerUsername}</div>
						{/if}
					</label>
					<label class="field" class:field-required={Boolean(spaceSlugValidation.error)}>
						<span>Space slug</span>
						{#if missingSpaceSlug}
							<input class="form-input font-mono" bind:value={spaceSlugDraft} oninput={() => spaceSlugDraft = normalizePublicSlugInput(spaceSlugDraft)} placeholder="Required" maxlength="80" aria-invalid={Boolean(spaceSlugValidation.error)} title={spaceSlugValidation.error ?? "Space slug"} aria-label={spaceSlugValidation.error ?? "Space slug"} />
						{:else}
							<div class="readonly-value">{spaceSlug}</div>
						{/if}
					</label>
					<label class="field" class:field-required={Boolean(workSlugValidation.error)}>
						<span>Work slug</span>
						<input class="form-input font-mono" bind:value={slug} oninput={() => slug = normalizePublicSlugInput(slug)} placeholder="Required" maxlength="80" aria-invalid={Boolean(workSlugValidation.error)} title={workSlugValidation.error ?? "Work slug"} aria-label={workSlugValidation.error ?? "Work slug"} />
					</label>
				</div>
			</section>

			<section class="source-section">
				<div>
					<div class="section-label">Source</div>
					<div class="source-ref"><span>{targetType}</span>{targetRef}</div>
				</div>
			</section>

			<section class="access-section">
				<div class="section-label">Access</div>
				<label class="access-row">
					<input type="radio" bind:group={visibility} value="public" />
					<span><span class="access-title">Anyone with the link</span><span class="access-copy">The work page is fully public.</span></span>
				</label>
				<label class="access-row">
					<input type="radio" bind:group={visibility} value="space" />
					<span><span class="access-title">Use space access</span><span class="access-copy">Viewers need this Space's access.</span></span>
				</label>
			</section>

			<section class="permissions-grid">
				<div>
					<div class="section-label">Work can</div>
					<label class="permission-row"><input type="checkbox" bind:checked={workScopes["space.view"]} /> View space</label>
					<label class="permission-row"><input type="checkbox" bind:checked={workScopes["session.view"]} /> View sessions</label>
					<label class="permission-row"><input type="checkbox" bind:checked={workScopes["file.view"]} /> View files</label>
					<label class="permission-row"><input type="checkbox" bind:checked={workScopes["taskrun.view"]} /> View task runs</label>
				</div>
				<div>
					<div class="section-label">Viewers can allow</div>
					{#each WORK_VIEWER_SCOPE_OPTIONS as option (option.scope)}
						<label class="permission-row"><input type="checkbox" bind:checked={allowedViewerScopes[option.scope]} /> {option.label}</label>
					{/each}
				</div>
			</section>

			<section class="presentation-section">
				<div class="section-label">Presentation</div>
				<label class="presentation-row" class:disabled-option={!hideCohubBarAllowed || hideCohubBarLoading}>
					<input type="checkbox" bind:checked={hideCohubBar} disabled={!hideCohubBarAllowed || hideCohubBarLoading} />
					<span class="min-w-0 flex-1">
						<span class="presentation-title">Hide Cohub bar</span>
						<span class="presentation-copy">Remove the Cohub footer bar from the public work page.</span>
					</span>
					{#if !hideCohubBarAllowed && !hideCohubBarLoading}
						<span class="plan-badge">Pro / Max</span>
					{/if}
				</label>
				{#if !hideCohubBarAllowed && !hideCohubBarLoading}
					<div class="presentation-hint">Included with Pro and Max.</div>
				{/if}
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
	.readonly-value { display: flex; align-items: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-tertiary); }
	.source-ref { display: flex; min-width: 0; gap: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); }
	.source-ref span { color: var(--text-placeholder); }
	.access-section { display: grid; gap: 8px; }
	.access-row { display: flex; align-items: flex-start; gap: 8px; border-radius: 6px; border: 1px solid var(--border-subtle); background: var(--bg-surface); padding: 10px; font-size: 12px; color: var(--text-secondary); }
	.access-row input { margin-top: 2px; accent-color: var(--brand); }
	.access-title { display: block; font-weight: 500; color: var(--text-primary); }
	.access-copy { display: block; margin-top: 2px; color: var(--text-tertiary); }
	.permissions-grid { display: grid; gap: 14px; }
	@media (min-width: 640px) { .permissions-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
	.permission-row { display: flex; align-items: center; gap: 8px; min-height: 28px; font-size: 12px; color: var(--text-secondary); }
	.permission-row input { accent-color: var(--brand); }
	.presentation-section { display: grid; gap: 8px; }
	.presentation-row { display: flex; align-items: flex-start; gap: 8px; min-height: 28px; font-size: 12px; color: var(--text-secondary); }
	.presentation-row input { margin-top: 2px; accent-color: var(--brand); }
	.presentation-title { display: block; font-weight: 500; color: var(--text-primary); }
	.presentation-copy { display: block; margin-top: 2px; color: var(--text-tertiary); }
	.presentation-hint { font-size: 11px; color: var(--text-tertiary); }
	.plan-badge { flex-shrink: 0; border-radius: 9999px; border: 1px solid var(--border-subtle); padding: 3px 8px; font-size: 10px; line-height: 1; color: var(--text-tertiary); }
	.disabled-option { opacity: .6; }
	.error-box { border-radius: 6px; border: 1px solid color-mix(in srgb, var(--error-soft) 30%, transparent); background: var(--error-bg); padding: 8px 10px; font-size: 12px; color: var(--error-soft); }
	.button-row { display: flex; justify-content: flex-end; gap: 8px; }
	.footer-row { position: sticky; bottom: 0; z-index: 2; margin: 0 -16px -16px; border-top: 1px solid var(--border-subtle); background: color-mix(in srgb, var(--bg-primary) 94%, transparent); padding: 12px 16px 16px; backdrop-filter: blur(10px); }
	.primary-btn, .secondary-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; border-radius: 6px; padding: 0 12px; font-size: 12px; font-weight: 500; transition: background 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease; }
	.primary-btn { border: 1px solid var(--brand); background: var(--brand); color: var(--brand-contrast-fg); }
	.primary-btn:hover:not(:disabled) { opacity: .92; }
	.primary-btn:disabled { cursor: not-allowed; opacity: .5; }
	.secondary-btn { border: 1px solid var(--border-subtle); background: var(--bg-surface); color: var(--text-secondary); }
	.secondary-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
	.success-block { display: flex; align-items: center; gap: 10px; border-radius: 8px; border: 1px solid var(--border-subtle); background: var(--bg-surface); padding: 12px; }
	.success-icon { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 6px; background: var(--brand); color: var(--brand-contrast-fg); }

	@media (max-width: 639px) {
		.form-input, .readonly-value { height: 44px; padding: 0 11px; font-size: 14px; }
		.permission-row { min-height: 40px; align-items: center; }
		.permission-row input, .access-row input { width: 16px; height: 16px; }
		.button-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); }
		.primary-btn, .secondary-btn { width: 100%; min-height: 44px; font-size: 13px; }
	}
</style>
