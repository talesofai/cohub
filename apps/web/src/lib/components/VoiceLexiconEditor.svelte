<script lang="ts">
import type { VoiceLexiconEntry } from "@neta-art/cohub";
import {
	Check,
	Loader2,
	Pencil,
	Plus,
	RefreshCw,
	Trash2,
	X,
} from "lucide-svelte";
import { isComposingKeyboardEvent } from "$lib/keyboard";

type Props = {
	entries?: VoiceLexiconEntry[];
	loading?: boolean;
	error?: string;
	canManage?: boolean;
	emptyText?: string;
	addPlaceholder?: string;
	onrefresh?: () => void | Promise<void>;
	onadd?: (term: string) => void | Promise<void>;
	onupdate?: (entry: VoiceLexiconEntry, term: string) => void | Promise<void>;
	ondelete?: (entry: VoiceLexiconEntry) => void | Promise<void>;
};

let {
	entries = [],
	loading = false,
	error = "",
	canManage = true,
	emptyText = "No voice terms yet",
	addPlaceholder = "Add term",
	onrefresh,
	onadd,
	onupdate,
	ondelete,
}: Props = $props();

let termInput = $state("");
let editingId = $state<string | null>(null);
let editingTerm = $state("");
let busyAction = $state<string | null>(null);
let inlineError = $state("");

const sortedEntries = $derived(entries);

function getErrorMessage(error: unknown, fallback: string) {
	return error instanceof Error ? error.message : fallback;
}

function getSourceLabel(source: VoiceLexiconEntry["source"]) {
	if (source === "correction") return "learned";
	if (source === "auto") return "auto";
	return "manual";
}

function formatUpdatedAt(value: string | null) {
	if (!value) return "";
	try {
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(new Date(value));
	} catch {
		return value;
	}
}

async function refresh() {
	if (!onrefresh || busyAction) return;
	inlineError = "";
	busyAction = "refresh";
	try {
		await onrefresh();
	} catch (error) {
		inlineError = getErrorMessage(error, "Failed to refresh terms");
	} finally {
		busyAction = null;
	}
}

async function addTerm() {
	const term = termInput.trim();
	if (!term || !onadd || busyAction) return;
	inlineError = "";
	busyAction = "add";
	try {
		await onadd(term);
		termInput = "";
	} catch (error) {
		inlineError = getErrorMessage(error, "Failed to add term");
	} finally {
		busyAction = null;
	}
}

function beginEdit(entry: VoiceLexiconEntry) {
	if (!canManage || busyAction) return;
	inlineError = "";
	editingId = entry.id;
	editingTerm = entry.term;
}

function cancelEdit() {
	if (busyAction) return;
	editingId = null;
	editingTerm = "";
}

async function saveEdit(entry: VoiceLexiconEntry) {
	const term = editingTerm.trim();
	if (!term || !onupdate || busyAction) return;
	if (term === entry.term) {
		cancelEdit();
		return;
	}
	inlineError = "";
	busyAction = `update:${entry.id}`;
	try {
		await onupdate(entry, term);
		editingId = null;
		editingTerm = "";
	} catch (error) {
		inlineError = getErrorMessage(error, "Failed to update term");
	} finally {
		busyAction = null;
	}
}

async function deleteTerm(entry: VoiceLexiconEntry) {
	if (!ondelete || busyAction) return;
	inlineError = "";
	busyAction = `delete:${entry.id}`;
	try {
		await ondelete(entry);
		if (editingId === entry.id) cancelEdit();
	} catch (error) {
		inlineError = getErrorMessage(error, "Failed to delete term");
	} finally {
		busyAction = null;
	}
}
</script>

<div class="space-y-3">
	<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
		<div class="min-w-0">
			<div class="text-[12px] font-medium text-text-secondary">Terms</div>
			<div class="mt-0.5 text-[11px] text-text-tertiary">
				{entries.length} {entries.length === 1 ? "term" : "terms"}
			</div>
		</div>
		{#if onrefresh}
			<button
				type="button"
				onclick={refresh}
				disabled={loading || Boolean(busyAction)}
				class="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-[6px] border border-border-subtle bg-bg-input px-2.5 py-1.5 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
			>
				{#if busyAction === "refresh"}
					<Loader2 class="h-3.5 w-3.5 animate-spin" />
				{:else}
					<RefreshCw class="h-3.5 w-3.5" />
				{/if}
				Refresh
			</button>
		{/if}
	</div>

	{#if canManage && onadd}
		<div class="grid gap-2 sm:grid-cols-[1fr_auto]">
			<input
				bind:value={termInput}
				placeholder={addPlaceholder}
				maxlength="80"
				disabled={Boolean(busyAction)}
				onkeydown={(event) => {
					if (event.key === 'Enter' && !isComposingKeyboardEvent(event)) {
						event.preventDefault();
						void addTerm();
					}
				}}
				class="min-h-9 min-w-0 rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none disabled:opacity-50"
			/>
			<button
				type="button"
				onclick={() => void addTerm()}
				disabled={!termInput.trim() || Boolean(busyAction)}
				class="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[6px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover disabled:opacity-50"
			>
				{#if busyAction === "add"}
					<Loader2 class="h-3.5 w-3.5 animate-spin" />
				{:else}
					<Plus class="h-3.5 w-3.5" />
				{/if}
				Add
			</button>
		</div>
	{/if}

	{#if error || inlineError}
		<div class="rounded-[6px] border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] text-error-soft break-words">
			{inlineError || error}
		</div>
	{/if}

	{#if loading}
		<div class="flex items-center justify-center rounded-[7px] bg-bg-primary px-3 py-8 text-[12px] text-text-tertiary">
			<Loader2 class="mr-2 h-4 w-4 animate-spin" />
			Loading terms...
		</div>
	{:else if sortedEntries.length === 0}
		<div class="rounded-[7px] bg-bg-primary px-3 py-8 text-center text-[12px] text-text-tertiary">
			{emptyText}
		</div>
	{:else}
		<div class="overflow-hidden rounded-[7px] border border-border-subtle">
			<div class="hidden grid-cols-[minmax(0,1fr)_90px_80px_auto] gap-3 border-b border-border-subtle bg-bg-header-alt px-3 py-2 text-[10px] font-medium uppercase tracking-[0.08em] text-text-placeholder md:grid">
				<span>Term</span>
				<span>Source</span>
				<span>Uses</span>
				<span></span>
			</div>
			<div class="divide-y divide-border-subtle">
				{#each sortedEntries as entry (entry.id)}
					<div class="grid gap-2 bg-bg-primary px-3 py-2.5 md:grid-cols-[minmax(0,1fr)_90px_80px_auto] md:items-center">
						<div class="min-w-0">
							{#if editingId === entry.id}
								<div class="flex min-w-0 items-center gap-2">
									<input
										bind:value={editingTerm}
										maxlength="80"
										disabled={busyAction === `update:${entry.id}`}
										onkeydown={(event) => {
											if (event.key === 'Escape') {
												event.preventDefault();
												cancelEdit();
											}
											if (event.key === 'Enter' && !isComposingKeyboardEvent(event)) {
												event.preventDefault();
												void saveEdit(entry);
											}
										}}
										class="min-w-0 flex-1 rounded-[5px] border border-brand/40 bg-bg-input px-2 py-1.5 text-[13px] text-text-primary focus:outline-none disabled:opacity-50"
									/>
									<button type="button" onclick={() => void saveEdit(entry)} disabled={!editingTerm.trim() || busyAction === `update:${entry.id}`} class="shrink-0 rounded-[5px] p-1.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title="Save">
										{#if busyAction === `update:${entry.id}`}
											<Loader2 class="h-3.5 w-3.5 animate-spin" />
										{:else}
											<Check class="h-3.5 w-3.5" />
										{/if}
									</button>
									<button type="button" onclick={cancelEdit} disabled={Boolean(busyAction)} class="shrink-0 rounded-[5px] p-1.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title="Cancel">
										<X class="h-3.5 w-3.5" />
									</button>
								</div>
							{:else}
								<div class="truncate text-[13px] font-medium text-text-primary">{entry.term}</div>
								{#if entry.originalText}
									<div class="mt-0.5 truncate text-[11px] text-text-placeholder" title={entry.originalText}>
										from "{entry.originalText}"
									</div>
								{:else if entry.updatedAt}
									<div class="mt-0.5 truncate text-[11px] text-text-placeholder">{formatUpdatedAt(entry.updatedAt)}</div>
								{/if}
							{/if}
						</div>
						<div>
							<span class="inline-flex rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider bg-bg-hover text-text-tertiary">
								{getSourceLabel(entry.source)}
							</span>
						</div>
						<div class="text-[12px] text-text-tertiary">{entry.usageCount}</div>
						<div class="flex items-center justify-end gap-1.5">
							{#if canManage}
								<button type="button" onclick={() => beginEdit(entry)} disabled={Boolean(busyAction)} class="rounded-[5px] p-1.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title="Edit">
									<Pencil class="h-3.5 w-3.5" />
								</button>
								<button type="button" onclick={() => void deleteTerm(entry)} disabled={Boolean(busyAction)} class="rounded-[5px] p-1.5 text-text-tertiary transition-colors hover:bg-error-bg hover:text-error-soft disabled:opacity-50" title="Delete">
									{#if busyAction === `delete:${entry.id}`}
										<Loader2 class="h-3.5 w-3.5 animate-spin" />
									{:else}
										<Trash2 class="h-3.5 w-3.5" />
									{/if}
								</button>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
