<script lang="ts">
import type { Permission } from "@neta-art/cohub";
import {
	AlertTriangle,
	ArrowLeft,
	Check,
	Loader2,
	Search,
	ShieldCheck,
} from "lucide-svelte";
import Dialog from "$lib/components/Dialog.svelte";
import { APP_SCOPE_OPTIONS } from "$lib/features/space/modules/app-utils";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	normalizeSpacePickerQuery,
	type SpacePickerFilter,
	selectSpacePickerItems,
} from "$lib/space-picker-model";
import { authStore } from "$lib/stores/auth.svelte";

const {
	open,
	pending,
	error,
	saving,
	appName,
	authorName,
	onConfirm,
	onCancel,
}: {
	open: boolean;
	pending: {
		scopes: Permission[];
		reason?: string;
		spaceId?: string;
		spaceName?: string | null;
		selectSpace?: boolean;
		spaces?: Array<{
			id: string;
			name: string | null;
			ownerUserUuid?: string | null;
			isPinned?: boolean;
		}> | null;
		homeSpaceName?: string | null;
	} | null;
	error: string | null;
	saving: boolean;
	appName?: string;
	authorName?: string;
	onConfirm: (pickedSpaceId?: string) => void;
	onCancel: () => void;
} = $props();

const locale = $derived(getLocale());

type OperationGroup = {
	title: string;
	description: string;
	scopes: string[];
};

// Maps viewer scopes to user-facing operation groups shown in the consent
// dialog. Each group is shown only when at least one of its scopes is present
// in the requested set. Unmapped scopes fall back to a generic group.
const OPERATION_GROUPS: OperationGroup[] = [
	{
		title: "Start AI generation",
		description:
			"Create image, video, and other generation tasks. Each run uses your generation quota.",
		scopes: ["generation.create"],
	},
	{
		title: "Send instructions in sessions",
		description:
			"Send prompts and run agent actions in the granted space as you.",
		scopes: ["session.prompt.fullaccess"],
	},
	{
		title: "Read data",
		description: "Read files, sessions, and task runs in the granted space.",
		scopes: [
			"session.prompt.readonly",
			"session.view",
			"file.view",
			"taskrun.view",
		],
	},
	{
		title: "Read your account data",
		description:
			"List your spaces, sessions, and task runs, and read your usage across all of them.",
		scopes: [
			"user.session.list",
			"user.space.list",
			"user.taskrun.list",
			"user.usage.read",
		],
	},
];

const operationGroups = $derived.by<OperationGroup[]>(() => {
	if (!pending) return [];
	const requested = new Set(pending.scopes);
	const groups = OPERATION_GROUPS.filter((g) =>
		g.scopes.some((s) => requested.has(s as Permission)),
	);
	// Surface any scopes not covered by the predefined groups.
	const mapped = new Set(groups.flatMap((g) => g.scopes));
	const unmapped = pending.scopes.filter((s) => !mapped.has(s));
	if (unmapped.length > 0) {
		groups.push({
			title: "Other actions",
			description: unmapped.map(scopeLabel).join(", "),
			scopes: unmapped,
		});
	}
	return groups;
});

const displayName = $derived(appName?.trim() || "this app");

// Picker selection resets whenever a new request opens the dialog.
let selectedSpaceId = $state("");
let spaceQuery = $state("");
let spaceFilter = $state<SpacePickerFilter>("recent");
let pickerStep = $state<"choose" | "review">("review");
$effect(() => {
	void pending;
	selectedSpaceId = "";
	spaceQuery = "";
	spaceFilter = "recent";
	pickerStep = pending?.selectSpace ? "choose" : "review";
});

const picking = $derived(
	Boolean(pending?.selectSpace && pickerStep === "choose"),
);
const spaceOptions = $derived(pending?.spaces ?? null);
function handleSpaceQueryInput(event: Event) {
	spaceQuery = (event.currentTarget as HTMLInputElement).value;
	if (spaceQuery.trim()) spaceFilter = "all";
}

const visibleSpaceOptions = $derived.by(() => {
	if (!spaceOptions) return null;
	return selectSpacePickerItems(spaceOptions, {
		filter: spaceFilter,
		query: normalizeSpacePickerQuery(spaceQuery),
		viewerUserUuid: authStore.userUuid,
		limit: 6,
	});
});
const spaceLabel = $derived.by(() => {
	if (!pending) return null;
	if (pending.spaceId) return pending.spaceName?.trim() || pending.spaceId;
	if (pending.selectSpace) return null;
	return pending.homeSpaceName?.trim() || null;
});
const requiresGenerationQuota = $derived(
	Boolean(pending?.scopes.includes("generation.create")),
);
const confirmLabel = "Authorize and continue";
const confirmDisabled = $derived(
	saving || (Boolean(pending?.selectSpace) && !selectedSpaceId),
);

// Human label for scopes outside the predefined operation groups.
const scopeLabel = (scope: string) =>
	APP_SCOPE_OPTIONS.find((option) => option.scope === scope)?.label ?? scope;
</script>

<Dialog {open} onClose={onCancel} maxWidth="440px" maxHeight="90vh" scrollable={false}>
	{#if pending}
		<div class="auth-panel" class:auth-review={!picking}>
			<div class="auth-intro">
				<div class="auth-icon"><ShieldCheck class="h-4 w-4" /></div>
				<div class="min-w-0">
					<div class="auth-title">{m.app_auth_title({}, { locale })}</div>
					<p class="auth-copy">"{displayName}" is requesting to use Cohub as you</p>
					{#if authorName}
						<p class="auth-author">Author: {authorName}</p>
					{/if}
					{#if pending.reason}
						<p class="auth-reason">{pending.reason}</p>
					{/if}
				</div>
			</div>

			<hr class="auth-divider" />

			{#if picking}
				<section class="auth-section auth-picker-step">
					<div class="auth-step-heading">
						<div>
							<div class="auth-section-label">Choose a Space</div>
							<div class="auth-step-copy">Select where this app can act.</div>
						</div>
					</div>
					{#if spaceOptions === null}
						<div class="auth-space-empty">Couldn't load your Spaces. Deny and try again.</div>
					{:else if spaceOptions.length === 0}
						<div class="auth-space-empty">You don't have any Spaces yet.</div>
					{:else}
						<label class="auth-space-search">
							<Search class="h-3.5 w-3.5" />
							<input value={spaceQuery} oninput={handleSpaceQueryInput} placeholder="Search Spaces" aria-label="Search Spaces" />
						</label>
						<div class="auth-space-filters" role="tablist" aria-label="Filter Spaces">
							{#each [{ key: "recent", label: "Recent" }, { key: "all", label: "All" }, { key: "mine", label: "Mine" }, { key: "pinned", label: "Pinned" }] as filter}
								<button type="button" class:active={spaceFilter === filter.key} role="tab" aria-selected={spaceFilter === filter.key} onclick={() => (spaceFilter = filter.key as SpacePickerFilter)}>{filter.label}</button>
							{/each}
						</div>
						<div class="auth-space-list" role="radiogroup" aria-label="Choose a Space">
							{#each visibleSpaceOptions ?? [] as space (space.id)}
								<label class="auth-space-option" class:selected={selectedSpaceId === space.id}>
									<input type="radio" bind:group={selectedSpaceId} value={space.id} />
									<span class="auth-space-option-name">{space.name || space.id}</span>
								</label>
							{/each}
							{#if (visibleSpaceOptions?.length ?? 0) === 0}
								<div class="auth-space-empty">No matching Spaces.</div>
							{/if}
						</div>
					{/if}
					<div class="auth-picker-actions">
						<button type="button" class="auth-cancel" disabled={saving} onclick={onCancel}>Deny</button>
						<button type="button" class="auth-confirm" disabled={saving || !selectedSpaceId} onclick={() => (pickerStep = "review")}>Review access</button>
					</div>
				</section>
			{:else}
				{#if pending.selectSpace}
					<section class="auth-space auth-selected-space">
						<div class="auth-space-label">Space</div>
						<div class="auth-selected-row">
							<div class="auth-space-name" title={selectedSpaceId}>{pending.spaces?.find((space) => space.id === selectedSpaceId)?.name || selectedSpaceId}</div>
							<button type="button" class="auth-change-space" onclick={() => (pickerStep = "choose")}><ArrowLeft class="h-3 w-3" /> Change</button>
						</div>
					</section>
				{:else if spaceLabel}
					<section class="auth-space">
						<div class="auth-space-label">Space</div>
						<div class="auth-space-name" title={pending.spaceId ?? undefined}>{spaceLabel}</div>
					</section>
				{/if}
			{/if}

			{#if !picking}
			<section class="auth-section">
				<div class="auth-section-label">{m.app_auth_once_authorized({}, { locale })}</div>
				<div class="auth-scope-list">
					{#each operationGroups as group (group.title)}
						<div class="auth-scope-row">
							<div class="auth-scope-check"><Check class="h-3 w-3" /></div>
							<div class="min-w-0">
								<div class="auth-scope-name">{group.title}</div>
								<div class="auth-scope-description">{group.description}</div>
							</div>
						</div>
					{/each}
				</div>
			</section>

			{#if requiresGenerationQuota}
				<section class="auth-usage">
					<div class="auth-usage-label">{m.app_auth_about_usage({}, { locale })}</div>
					<p class="auth-usage-copy">
						How often and when generation runs is decided by the app. Each call uses your
						quota.
					</p>
				</section>
			{/if}

			<hr class="auth-divider" />

			<div class="auth-validity">Valid for 14 days. You won't be asked again during that time.</div>

			{#if error}
				<div class="auth-error"><AlertTriangle class="h-3.5 w-3.5" /> {error}</div>
			{/if}

				<div class="auth-actions">
					<button type="button" class="auth-cancel" disabled={saving} onclick={onCancel}>Deny</button>
					<button type="button" class="auth-confirm" disabled={confirmDisabled} onclick={() => onConfirm(selectedSpaceId || undefined)}>
						{#if saving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
						{confirmLabel}
					</button>
				</div>
			{/if}
		</div>
	{/if}
</Dialog>

<style>
	.auth-panel {
		display: grid;
		gap: 16px;
		padding: 18px;
	}

	.auth-panel.auth-review {
		gap: 12px;
		padding: 16px;
	}

	.auth-intro {
		display: grid;
		grid-template-columns: 34px minmax(0, 1fr);
		gap: 12px;
		align-items: flex-start;
	}

	.auth-icon {
		display: inline-flex;
		width: 34px;
		height: 34px;
		align-items: center;
		justify-content: center;
		border-radius: 9px;
		background: var(--brand-muted);
		color: var(--brand-muted-fg);
		border: 1px solid var(--brand-border);
		box-shadow: inset 0 1px 0 color-mix(in srgb, var(--bg-elevated) 80%, transparent);
	}

	.auth-title {
		font-size: 15px;
		font-weight: 650;
		line-height: 1.25;
		letter-spacing: -0.01em;
		color: var(--text-primary);
	}

	.auth-copy {
		margin-top: 6px;
		font-size: 13px;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.auth-author {
		margin-top: 3px;
		font-size: 12px;
		line-height: 1.4;
		color: var(--text-tertiary);
	}

	.auth-reason {
		margin-top: 6px;
		font-size: 12px;
		line-height: 1.5;
		color: var(--text-tertiary);
	}

	.auth-space-empty {
		border: 1px solid var(--border-subtle);
		border-radius: 10px;
		background: var(--bg-elevated);
		padding: 12px;
		font-size: 12px;
		line-height: 1.5;
		color: var(--text-tertiary);
	}

	.auth-space-list {
		display: grid;
		border: 1px solid var(--border-subtle);
		border-radius: 10px;
		background: var(--bg-elevated);
	}

	.auth-space-option {
		display: flex;
		align-items: center;
		gap: 11px;
		padding: 10px 12px;
		font-size: 12.5px;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.auth-space-option + .auth-space-option {
		border-top: 1px solid var(--border-subtle);
	}

	.auth-space-option:hover,
	.auth-space-option.selected {
		background: var(--bg-hover);
	}

	.auth-space-search {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 34px;
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		padding: 0 10px;
		color: var(--text-tertiary);
	}

	.auth-space-search:focus-within {
		border-color: var(--brand-border);
		box-shadow: 0 0 0 2px var(--brand-ring);
	}

	.auth-space-search input {
		width: 100%;
		min-width: 0;
		border: 0;
		outline: 0;
		background: transparent;
		font: inherit;
		font-size: 12px;
		color: var(--text-primary);
	}

	.auth-space-search input::placeholder {
		color: var(--text-placeholder);
	}

	.auth-space-filters {
		display: flex;
		gap: 2px;
		overflow-x: auto;
		padding: 2px;
		border-radius: 7px;
		background: var(--bg-elevated);
	}

	.auth-space-filters button {
		min-height: 28px;
		flex: 1 0 auto;
		border: 0;
		border-radius: 5px;
		background: transparent;
		padding: 3px 9px;
		font-size: 11px;
		color: var(--text-tertiary);
		cursor: pointer;
	}

	.auth-space-filters button:hover,
	.auth-space-filters button.active {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.auth-space-filters button.active {
		box-shadow: inset 0 0 0 1px var(--border-subtle);
	}

	.auth-step-copy {
		margin-top: 3px;
		font-size: 11px;
		color: var(--text-tertiary);
	}

	.auth-picker-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding-top: 2px;
	}

	.auth-selected-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.auth-change-space {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex: 0 0 auto;
		border: 0;
		background: transparent;
		padding: 2px 0;
		font-size: 11px;
		color: var(--text-tertiary);
		cursor: pointer;
	}

	.auth-change-space:hover {
		color: var(--brand);
	}

	.auth-space-option input {
		accent-color: var(--brand);
		flex: 0 0 auto;
		margin: 0;
	}

	.auth-space-option-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-primary);
	}

	.auth-divider {
		border: 0;
		border-top: 1px solid var(--border-subtle);
		margin: 0;
	}

	.auth-section {
		display: grid;
		gap: 9px;
	}

	.auth-section-label {
		font-size: 12px;
		font-weight: 500;
		color: var(--text-secondary);
	}

	.auth-scope-list {
		display: grid;
		overflow: hidden;
		border: 1px solid var(--border-subtle);
		border-radius: 10px;
		background: var(--bg-elevated);
	}

	.auth-scope-row {
		display: grid;
		grid-template-columns: 18px minmax(0, 1fr);
		gap: 10px;
		padding: 10px;
		background: var(--bg-elevated);
	}

	.auth-scope-row + .auth-scope-row {
		border-top: 1px solid var(--border-subtle);
	}

	.auth-scope-check {
		display: inline-flex;
		width: 18px;
		height: 18px;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		background: var(--brand);
		color: var(--brand-contrast-fg);
		flex: 0 0 auto;
		margin-top: 1px;
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand) 24%, transparent);
	}

	.auth-scope-name {
		font-size: 12.5px;
		font-weight: 650;
		line-height: 1.25;
		color: var(--text-primary);
	}

	.auth-scope-description {
		margin-top: 2px;
		font-size: 11.5px;
		line-height: 1.35;
		color: var(--text-secondary);
	}

	.auth-space {
		display: grid;
		gap: 4px;
		padding: 12px;
		border: 1px solid var(--border-subtle);
		border-radius: 10px;
		background: var(--bg-elevated);
	}

	.auth-space-label {
		font-size: 11px;
		font-weight: 650;
		line-height: 1.2;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-tertiary);
	}

	.auth-space-name {
		font-size: 13px;
		font-weight: 550;
		color: var(--text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.auth-usage {
		display: grid;
		gap: 4px;
	}

	.auth-usage-label {
		font-size: 12px;
		font-weight: 650;
		color: var(--text-primary);
	}

	.auth-usage-copy {
		font-size: 11.5px;
		line-height: 1.4;
		color: var(--text-secondary);
	}

	.auth-validity {
		font-size: 12px;
		line-height: 1.4;
		color: var(--text-tertiary);
	}

	.auth-error {
		display: flex;
		align-items: center;
		gap: 7px;
		border-radius: 8px;
		border: 1px solid color-mix(in srgb, var(--error-soft) 28%, transparent);
		background: var(--error-bg);
		padding: 9px 10px;
		font-size: 12px;
		line-height: 1.35;
		color: var(--error-soft);
	}

	.auth-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding-top: 2px;
	}

	.auth-cancel,
	.auth-confirm {
		display: inline-flex;
		height: 34px;
		min-width: 72px;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border-radius: 7px;
		padding: 0 13px;
		font-size: 12.5px;
		font-weight: 650;
		line-height: 1;
		transition:
			background-color 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease,
			transform 0.15s ease,
			opacity 0.15s ease;
	}

	.auth-cancel {
		border: 1px solid transparent;
		color: var(--text-secondary);
	}

	.auth-cancel:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.auth-confirm {
		border: 1px solid var(--brand);
		background: var(--brand);
		color: var(--brand-contrast-fg);
	}

	.auth-confirm:hover {
		background: var(--brand-hover);
		border-color: var(--brand-hover);
	}

	.auth-cancel:focus-visible,
	.auth-confirm:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--bg-primary), 0 0 0 4px var(--brand-ring);
	}

	.auth-cancel:active,
	.auth-confirm:active {
		transform: translateY(1px);
	}

	.auth-cancel:disabled,
	.auth-confirm:disabled {
		pointer-events: none;
		opacity: 0.55;
		transform: none;
	}

	@media (max-width: 640px) {
		.auth-panel {
			gap: 14px;
			padding: 14px 14px max(14px, env(safe-area-inset-bottom));
		}

		.auth-intro {
			grid-template-columns: 32px minmax(0, 1fr);
			gap: 11px;
		}

		.auth-icon {
			width: 32px;
			height: 32px;
		}

		.auth-title {
			font-size: 14.5px;
		}

		.auth-copy {
			font-size: 13px;
			line-height: 1.5;
		}

		.auth-scope-row {
			padding: 11px;
		}

		.auth-actions {
			position: sticky;
			bottom: calc(-1 * max(14px, env(safe-area-inset-bottom)));
			display: grid;
			grid-template-columns: 1fr 1fr;
			margin: 0 -14px calc(-1 * max(14px, env(safe-area-inset-bottom)));
			padding: 10px 14px max(14px, env(safe-area-inset-bottom));
			border-top: 1px solid var(--border-subtle);
			background: var(--bg-primary);
		}

		.auth-cancel,
		.auth-confirm {
			height: 44px;
			min-width: 0;
		}
	}
</style>
