<script lang="ts">
import type { SpaceFsNode } from "$lib/space-fs";
import { File, Folder, FolderOpen, Plus, FolderPlus, Pencil, Trash2 } from "lucide-svelte";
import FsTreeItem from "./FsTreeItem.svelte";

const {
  node,
  depth,
  selectedPath,
  onToggle,
  onSelect,
  onCreateFile,
  onCreateDir,
  onRename,
  onDelete,
  canWrite = true,
}: {
  node: SpaceFsNode;
  depth: number;
  selectedPath: string;
  onToggle: (node: SpaceFsNode) => void;
  onSelect: (node: SpaceFsNode) => void;
  onCreateFile: (parentPath: string) => void;
  onCreateDir: (parentPath: string) => void;
  onRename: (node: SpaceFsNode) => void;
  onDelete: (node: SpaceFsNode) => void;
  canWrite?: boolean;
} = $props();

const indent = $derived(10 + depth * 14);
const isActive = $derived(selectedPath === node.path);

function handleClick() {
  if (node.type === 'dir') onToggle(node);
  else onSelect(node);
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    handleClick();
  }
}

function stop(handler: () => void) {
  return (e: MouseEvent) => {
    e.stopPropagation();
    handler();
  };
}
</script>

<div
  class:selected={isActive}
  class="tree-item"
  role="button"
  tabindex="0"
  style={`padding-left: ${indent}px`}
  onclick={handleClick}
  onkeydown={handleKeydown}
>
  <span class="icon shrink-0">
    {#if node.type === 'dir'}
      {#if node.isOpen}
        <FolderOpen class="w-3.5 h-3.5" />
      {:else}
        <Folder class="w-3.5 h-3.5" />
      {/if}
    {:else}
      <File class="w-3.5 h-3.5" />
    {/if}
  </span>
  <span class="name">{node.name}</span>
  {#if node.isLoading}
    <span class="loading">...</span>
  {/if}
  {#if canWrite}
    <span class="actions">
      {#if node.type === 'dir'}
        <button type="button" title="New file" onclick={stop(() => onCreateFile(node.path))}><Plus class="w-3 h-3" /></button>
        <button type="button" title="New folder" onclick={stop(() => onCreateDir(node.path))}><FolderPlus class="w-3 h-3" /></button>
      {/if}
      <button type="button" title="Rename" onclick={stop(() => onRename(node))}><Pencil class="w-3 h-3" /></button>
      <button type="button" title="Delete" class="danger" onclick={stop(() => onDelete(node))}><Trash2 class="w-3 h-3" /></button>
    </span>
  {/if}
</div>

{#if node.type === 'dir' && node.isOpen && node.children.length > 0}
  {#each node.children as child (child.path)}
    <FsTreeItem
      node={child}
      depth={depth + 1}
      {selectedPath}
      {onToggle}
      {onSelect}
      {onCreateFile}
      {onCreateDir}
      {onRename}
      {onDelete}
      {canWrite}
    />
  {/each}
{/if}

<style>
  .tree-item {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 26px;
    padding-right: 6px;
    border-radius: 5px;
    color: var(--text-tertiary);
    cursor: pointer;
    user-select: none;
  }
  .tree-item:hover, .tree-item.selected { background: var(--bg-hover); color: var(--text-secondary); }
  .tree-item.selected { color: var(--text-primary); }
  .icon { width: 16px; display: inline-flex; justify-content: center; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .loading { font-size: 11px; color: var(--text-placeholder); }
  .actions { display: none; align-items: center; gap: 1px; }
  .tree-item:hover .actions { display: inline-flex; }
  .actions button { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border: none; border-radius: 4px; background: transparent; color: var(--text-tertiary); }
  .actions button:hover { background: var(--bg-hover-strong); color: var(--text-primary); }
  .actions button.danger:hover { background: var(--error-bg); color: var(--error-soft); }
</style>
