<script lang="ts">
import { ChevronDown, Folder, Plus, Trash2 } from "lucide-svelte";
import { type Snippet, tick } from "svelte";
import {
	type IndexedPaletteItem,
	type MineSpaceSection,
	SPACE_ID_MIME,
} from "$lib/command-palette/space-groups";

type Props = {
	commands: IndexedPaletteItem[];
	sections: MineSpaceSection[];
	ungrouped: IndexedPaletteItem[];
	collapsedGroupIds: Set<string>;
	dropTargetId: string | null;
	creating: boolean;
	createName: string;
	createError: string | null;
	commandRow: Snippet<[IndexedPaletteItem]>;
	spaceRow: Snippet<[IndexedPaletteItem, string | null]>;
	onToggleCollapsed: (id: string) => void;
	onDeleteGroup: (name: string) => void;
	onDropSpace: (groupId: string, spaceId: string) => void;
	onDragOverGroup: (groupId: string | null) => void;
	onStartCreate: () => void;
	onCancelCreate: () => void;
	onCreateNameInput: (value: string) => void;
	onSubmitCreate: () => void;
};

let {
	commands,
	sections,
	ungrouped,
	collapsedGroupIds,
	dropTargetId,
	creating,
	createName,
	createError,
	commandRow,
	spaceRow,
	onToggleCollapsed,
	onDeleteGroup,
	onDropSpace,
	onDragOverGroup,
	onStartCreate,
	onCancelCreate,
	onCreateNameInput,
	onSubmitCreate,
}: Props = $props();

let createInputEl = $state<HTMLInputElement | null>(null);

$effect(() => {
	if (!creating) return;
	void tick().then(() => createInputEl?.focus());
});

function readSpaceId(dataTransfer: DataTransfer | null) {
	if (!dataTransfer) return "";
	return (
		dataTransfer.getData(SPACE_ID_MIME) || dataTransfer.getData("text/plain")
	).trim();
}

function handleDragOver(event: DragEvent, groupId: string) {
	if (!event.dataTransfer) return;
	const types = Array.from(event.dataTransfer.types);
	if (!types.includes(SPACE_ID_MIME) && !types.includes("text/plain")) return;
	event.preventDefault();
	event.dataTransfer.dropEffect = "copy";
	onDragOverGroup(groupId);
}

function handleDrop(event: DragEvent, groupId: string) {
	event.preventDefault();
	const spaceId = readSpaceId(event.dataTransfer);
	onDragOverGroup(null);
	if (spaceId) onDropSpace(groupId, spaceId);
}

function handleCreateKeydown(event: KeyboardEvent) {
	if (event.key === "Enter") {
		event.preventDefault();
		event.stopPropagation();
		onSubmitCreate();
		return;
	}
	if (event.key === "Escape") {
		event.preventDefault();
		event.stopPropagation();
		onCancelCreate();
	}
}
</script>

<div class="mine-groups">
	{#each commands as command (command.item.id)}
		{@render commandRow(command)}
	{/each}

	{#each sections as section (section.id)}
		{@const collapsed = collapsedGroupIds.has(section.id)}
		<div
			class="mine-group"
			class:drop-target={dropTargetId === section.id}
			ondragenter={(event) => handleDragOver(event, section.id)}
			ondragover={(event) => handleDragOver(event, section.id)}
			ondragleave={(event) => {
				if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) {
					onDragOverGroup(null);
				}
			}}
			ondrop={(event) => handleDrop(event, section.id)}
			role="presentation"
		>
			<div class="mine-group-header">
				<button
					type="button"
					class="mine-group-toggle"
					aria-expanded={!collapsed}
					onclick={() => onToggleCollapsed(section.id)}
				>
					<span class="mine-chevron" class:collapsed>
						<ChevronDown class="h-3.5 w-3.5" />
					</span>
					<Folder class="h-3.5 w-3.5" />
					<span class="mine-group-name">{section.name}</span>
					<span class="mine-group-count">{section.items.length}</span>
				</button>
				<button
					type="button"
					class="mine-group-delete"
					title={`Delete ${section.name}`}
					aria-label={`Delete group ${section.name}`}
					onclick={() => onDeleteGroup(section.name)}
				>
					<Trash2 class="h-3.5 w-3.5" />
				</button>
			</div>
			{#if !collapsed}
				{#if section.items.length === 0}
					<div class="mine-group-empty">Drop a Space here</div>
				{:else}
					{#each section.items as row (`${section.id}:${row.item.spaceId}`)}
						{@render spaceRow(row, section.id)}
					{/each}
				{/if}
			{/if}
		</div>
	{/each}

	{#if sections.length > 0 && ungrouped.length > 0}
		<div class="mine-ungrouped-label">Ungrouped</div>
	{/if}
	{#each ungrouped as row (`ungrouped:${row.item.spaceId}`)}
		{@render spaceRow(row, null)}
	{/each}

	<div class="mine-create">
		{#if creating}
			<input
				bind:this={createInputEl}
				class="mine-create-input"
				value={createName}
				placeholder="Group name"
				autocomplete="off"
				spellcheck="false"
				oninput={(event) => onCreateNameInput((event.currentTarget as HTMLInputElement).value)}
				onkeydown={handleCreateKeydown}
			/>
			<button type="button" class="mine-create-submit" onclick={onSubmitCreate}>Create</button>
			<button type="button" class="mine-create-cancel" onclick={onCancelCreate}>Cancel</button>
		{:else}
			<button type="button" class="mine-create-btn" onclick={onStartCreate}>
				<Plus class="h-3.5 w-3.5" />
				New group
			</button>
		{/if}
		{#if createError}
			<div class="mine-create-error">{createError}</div>
		{/if}
	</div>
</div>

<style>
	.mine-groups {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.mine-group {
		border-radius: 9px;
		padding: 2px 0;
	}

	.mine-group.drop-target {
		background: color-mix(in oklch, var(--brand-bg) 42%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--brand) 28%, transparent);
	}

	.mine-group-header {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 0 4px;
	}

	.mine-group-toggle {
		display: flex;
		min-width: 0;
		flex: 1;
		align-items: center;
		gap: 8px;
		border: 0;
		background: transparent;
		padding: 6px 8px;
		border-radius: 7px;
		color: var(--text-secondary);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
	}

	.mine-group-toggle:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.mine-group-toggle:focus-visible,
	.mine-group-delete:focus-visible,
	.mine-create-btn:focus-visible,
	.mine-create-submit:focus-visible,
	.mine-create-cancel:focus-visible,
	.mine-create-input:focus-visible {
		outline: 2px solid color-mix(in oklch, var(--brand) 42%, transparent);
		outline-offset: -2px;
	}

	.mine-group-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.mine-group-count {
		margin-left: auto;
		color: var(--text-placeholder);
		font-family: var(--font-mono);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
	}

	.mine-chevron {
		display: grid;
		width: 14px;
		height: 14px;
		flex: 0 0 auto;
		place-items: center;
		color: var(--text-tertiary);
		transition: transform 120ms cubic-bezier(0.25, 1, 0.5, 1);
	}

	.mine-chevron.collapsed {
		transform: rotate(-90deg);
	}

	.mine-group-delete {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--text-tertiary);
		opacity: 0;
		cursor: pointer;
	}

	.mine-group-header:hover .mine-group-delete,
	.mine-group-delete:focus-visible {
		opacity: 1;
	}

	.mine-group-delete:hover {
		background: var(--bg-hover);
		color: var(--error-700);
	}

	.mine-group-empty {
		padding: 6px 16px 8px 36px;
		color: var(--text-placeholder);
		font-size: 12px;
	}

	.mine-ungrouped-label {
		padding: 8px 12px 2px;
		color: var(--text-placeholder);
		font-size: 11px;
		font-weight: 500;
	}

	.mine-create {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		padding: 6px 8px 4px;
	}

	.mine-create-btn,
	.mine-create-submit,
	.mine-create-cancel {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		padding: 4px 8px;
		color: var(--text-tertiary);
		font-size: 12px;
		cursor: pointer;
	}

	.mine-create-btn:hover,
	.mine-create-submit:hover,
	.mine-create-cancel:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.mine-create-input {
		min-width: 0;
		flex: 1;
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		background: var(--bg-primary);
		padding: 4px 8px;
		color: var(--text-primary);
		font-size: 12px;
	}

	.mine-create-error {
		width: 100%;
		color: var(--error-700);
		font-size: 11px;
	}

	@media (max-width: 640px) {
		.mine-group-delete {
			opacity: 1;
			width: 44px;
			height: 44px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.mine-chevron {
			transition: none;
		}
	}
</style>
