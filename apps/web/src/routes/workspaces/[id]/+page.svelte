<script lang="ts">
import {
  FolderKanban,
  Globe,
  Lock,
  Play,
  Terminal,
  Copy,
  Check,
  FileCode,
  Folder,
  GitFork,
  ArrowLeft,
  X,
} from "lucide-svelte";
import { getWorkspaceById, getWorkspaceTree, getWorkspaceFile, forkWorkspace, updateWorkspace, type Tree, type WorkspaceDetail } from "$lib/api";
import { renderMarkdown } from "$lib/markdown";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { logtoClient } from "$lib/auth.js";

const { params } = $props();

const workspaceId = $derived(params.id);

let workspace = $state<WorkspaceDetail | null>(null);
let tree = $state<Tree | null>(null);
let isEmpty = $state(false);
let readmeHtml = $state<string | null>(null);
let isLoading = $state(true);
let isForking = $state(false);
let isPublishing = $state(false);
let loadError = $state("");
let copied = $state(false);
let actionError = $state("");

const gitRemoteUrl = $derived(workspace?.sshUrl || workspace?.cloneUrl || "");
const isOwner = $derived(Boolean(workspace?.isOwner));

async function loadWorkspace() {
  isLoading = true;
  loadError = "";
  readmeHtml = null;
  try {
    workspace = await getWorkspaceById(workspaceId);
    tree = await getWorkspaceTree(workspaceId, "").catch(() => null);
    isEmpty = !tree || !tree.entries || tree.entries.length === 0;

    if (!isEmpty && tree?.entries) {
      const readmeEntry = tree.entries.find((e) =>
        /^readme(\.[\w]+)?$/i.test(e.name),
      );
      if (readmeEntry) {
        try {
          const fileData = await getWorkspaceFile(workspaceId, readmeEntry.path);
          if (fileData && typeof fileData.content === "string") {
            readmeHtml = await renderMarkdown(fileData.content);
          }
        } catch {
          // Silently ignore
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workspace not found or access denied";
    if (message.includes("unauthorized") || message.includes("401")) {
      await logtoClient.signIn(`${window.location.origin}/callback`);
      return;
    }
    loadError = message;
  } finally {
    isLoading = false;
  }
}

onMount(() => {
  loadWorkspace();
});

function copyCloneUrl() {
  if (!gitRemoteUrl) return;
  navigator.clipboard.writeText(gitRemoteUrl);
  copied = true;
  setTimeout(() => { copied = false; }, 2000);
}

async function handleFork(preferredName?: string) {
  if (isForking || !workspace) return;
  isForking = true;
  try {
    const result = await forkWorkspace(workspace.id, preferredName);
    goto(`/workspaces/${result.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fork workspace";
    if (message.includes("forbidden") || message.includes("403")) {
      actionError = "You don't have permission to fork this workspace";
    } else if (message.includes("already exists") || message.includes("409")) {
      const newName = prompt("A workspace with this name already exists. Enter a new name:");
      if (newName?.trim()) {
        isForking = false;
        handleFork(newName.trim());
        return;
      }
    } else {
      actionError = message;
    }
  } finally {
    isForking = false;
  }
}

async function handlePublish() {
  if (isPublishing || !workspace) return;
  if (workspace?.visibility === "public") return;
  isPublishing = true;
  actionError = "";
  try {
    const result = await updateWorkspace(workspace.id, { visibility: "public" });
    workspace = result;
  } catch (error) {
    actionError = error instanceof Error ? error.message : "Failed to publish workspace";
  } finally {
    isPublishing = false;
  }
}

async function handleMakePrivate() {
  if (isPublishing || !workspace) return;
  if (workspace?.visibility === "private") return;
  isPublishing = true;
  actionError = "";
  try {
    const result = await updateWorkspace(workspace.id, { visibility: "private" });
    workspace = result;
  } catch (error) {
    actionError = error instanceof Error ? error.message : "Failed to make workspace private";
  } finally {
    isPublishing = false;
  }
}
</script>

<div class="flex-1 flex flex-col min-h-0 overflow-y-auto">
  <!-- Header -->
  <div class="h-[40px] flex items-center justify-between px-4 border-b border-border-subtle shrink-0 bg-bg-primary">
    <div class="flex items-center gap-3 min-w-0">
      <a href="/workspaces" class="text-text-tertiary hover:text-text-primary transition-colors shrink-0" onclick={(e) => { e.preventDefault(); goto("/workspaces"); }}>
        <ArrowLeft class="w-4 h-4" />
      </a>
      <div class="w-[1px] h-4 bg-border-subtle shrink-0"></div>
      <FolderKanban class="w-4 h-4 text-text-tertiary shrink-0" />
      <span class="text-[13px] text-text-primary truncate max-w-[320px]">{workspace?.name || workspaceId}</span>
      {#if workspace?.visibility === "private"}
        <span class="flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] bg-warning-bg text-warning-soft border border-warning-soft/30 shrink-0">
          <Lock class="w-2.5 h-2.5" />
          Private
        </span>
      {:else if workspace?.visibility === "public"}
        <span class="flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] bg-success-bg text-success-soft border border-success-soft/30 shrink-0">
          <Globe class="w-2.5 h-2.5" />
          Public
        </span>
      {/if}
    </div>

    <div class="flex items-center gap-1.5">
      {#if workspace?.isOwner !== undefined}
        <button
          onclick={() => handleFork()}
          disabled={isForking}
          class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[5px] text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100 disabled:opacity-50"
        >
          <GitFork class="w-3.5 h-3.5" />
          <span class="hidden sm:inline">{isForking ? "Forking..." : "Fork"}</span>
        </button>
      {/if}
      {#if isOwner && workspace?.visibility === "private"}
        <button
          onclick={handlePublish}
          disabled={isPublishing}
          class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[5px] text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100 disabled:opacity-50"
        >
          <Globe class="w-3.5 h-3.5" />
          <span class="hidden sm:inline">{isPublishing ? "Publishing..." : "Make Public"}</span>
        </button>
      {/if}
      {#if isOwner && workspace?.visibility === "public"}
        <button
          onclick={handleMakePrivate}
          disabled={isPublishing}
          class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[5px] text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100 disabled:opacity-50"
        >
          <Lock class="w-3.5 h-3.5" />
          <span class="hidden sm:inline">{isPublishing ? "Updating..." : "Make Private"}</span>
        </button>
      {/if}
      {#if isOwner && !isEmpty}
        <a
          href="/spaces/new"
          class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[5px] bg-[#FF3E00] hover:bg-brand-hover text-[12px] text-white font-medium transition-colors"
        >
          <Play class="w-3.5 h-3.5" />
          <span class="hidden sm:inline">Create Space</span>
        </a>
      {/if}
    </div>
  </div>

  <div class="flex-1 p-4 overflow-y-auto">
    {#if isLoading}
      <div class="flex items-center justify-center py-12 text-[12px] text-text-tertiary">
        <div class="w-4 h-4 rounded-full border-2 border-border-subtle border-t-brand animate-spin mr-2"></div>
        Loading workspace...
      </div>
    {:else if loadError}
      <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{loadError}</div>
    {:else if workspace}
      <!-- Action Error -->
      {#if actionError}
        <div class="mb-4 rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft flex items-center justify-between">
          <span>{actionError}</span>
          <button onclick={() => actionError = ""} class="ml-3 text-text-tertiary hover:text-text-secondary shrink-0"><X class="w-3 h-3" /></button>
        </div>
      {/if}

      <!-- Description -->
      {#if workspace.description}
        <p class="text-[13px] text-text-tertiary mb-3">{workspace.description}</p>
      {/if}

      {#if workspace.ownerUsername || workspace.ownerUserUuid}
        <p class="text-[11px] text-text-placeholder mb-4">
          Owned by <span class="text-text-tertiary">{workspace.ownerUsername || workspace.ownerUserUuid}</span>
          {#if workspace && workspace.forkedFrom}
            {@const ff = workspace.forkedFrom}
            · forked from <a href="/workspaces/{ff.id}" onclick={(e) => { e.preventDefault(); goto(`/workspaces/${ff.id}`); }} class="text-text-tertiary hover:text-text-secondary underline">{ff.ownerUsername || ff.ownerUserUuid}/{ff.name}</a>
          {/if}
        </p>
      {/if}

      <!-- Git clone info -->
      {#if gitRemoteUrl}
        <div class="mb-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-2 p-2.5 rounded-[5px] border border-border-subtle bg-bg-surface">
          <div class="flex items-center gap-2 min-w-0">
            <Terminal class="w-3.5 h-3.5 text-text-tertiary shrink-0" />
            <code class="flex-1 text-[11px] font-mono text-text-tertiary truncate">{gitRemoteUrl}</code>
          </div>
          <button
            onclick={copyCloneUrl}
            class="flex items-center justify-center gap-1 px-2 py-1.5 rounded-[4px] text-[11px] bg-bg-hover hover:bg-bg-hover-strong text-text-tertiary hover:text-text-secondary transition-colors duration-100 shrink-0 sm:w-auto"
          >
            {#if copied}
              <Check class="w-3 h-3" /> Copied
            {:else}
              <Copy class="w-3 h-3" /> Copy
            {/if}
          </button>
        </div>
      {/if}

      <!-- Empty workspace -->
      {#if isEmpty}
        <div class="border border-border-subtle rounded-md bg-bg-surface overflow-hidden">
          <div class="px-4 py-3 border-b border-border-subtle bg-bg-content">
            <h2 class="text-[13px] font-medium text-text-secondary">Repository Setup</h2>
            <p class="text-[12px] text-text-tertiary mt-1">This workspace is empty. Initialize it with Git.</p>
          </div>

          {#if gitRemoteUrl}
            <div class="p-4 grid grid-cols-1 gap-3">
              <div class="p-3 rounded-[5px] bg-bg-code border border-border-subtle">
                <div class="flex items-center gap-2 mb-2">
                  <Terminal class="w-3 h-3 text-text-tertiary" />
                  <span class="text-[10px] uppercase tracking-wider text-text-tertiary font-medium">Create a new repository</span>
                </div>
                <pre class="font-mono text-[11px] leading-5 text-text-tertiary whitespace-pre-wrap">touch README.md
git init
git checkout -b main
git add README.md
git commit -m "first commit"
git remote add origin {gitRemoteUrl}
git push -u origin main</pre>
              </div>
              <div class="p-3 rounded-[5px] bg-bg-code border border-border-subtle">
                <div class="flex items-center gap-2 mb-2">
                  <Terminal class="w-3 h-3 text-text-tertiary" />
                  <span class="text-[10px] uppercase tracking-wider text-text-tertiary font-medium">Push existing repository</span>
                </div>
                <pre class="font-mono text-[11px] leading-5 text-text-tertiary whitespace-pre-wrap">git remote add origin {gitRemoteUrl}
git push -u origin main</pre>
              </div>
            </div>
          {/if}
        </div>
      {:else if readmeHtml}
        <!-- README -->
        <div class="border border-border-subtle rounded-md bg-bg-surface overflow-hidden">
          <div class="px-4 py-3 border-b border-border-subtle bg-bg-content flex items-center justify-between">
            <h2 class="text-[13px] font-medium text-text-secondary">README</h2>
            <span class="text-[10px] text-text-placeholder">Documentation</span>
          </div>
          <div class="p-4 prose prose-invert prose-sm max-w-none">
            {@html readmeHtml}
          </div>
        </div>
      {:else if tree}
        <!-- File List -->
        <div class="border border-border-subtle rounded-md bg-bg-surface overflow-hidden">
          <div class="px-4 py-3 border-b border-border-subtle bg-bg-content flex items-center justify-between">
            <h2 class="text-[13px] font-medium text-text-secondary">Files</h2>
            <span class="text-[10px] text-text-placeholder">{tree.entries.length} entries</span>
          </div>
          <div class="divide-y divide-border-subtle">
            {#each tree.entries as entry}
              <div class="flex items-center gap-3 px-4 py-2.5 hover:bg-bg-hover transition-colors duration-100">
                {#if entry.type === "dir"}
                  <div class="w-7 h-7 rounded-[5px] bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
                    <Folder class="w-3.5 h-3.5 text-blue-400/70" />
                  </div>
                {:else}
                  <div class="w-7 h-7 rounded-[5px] bg-bg-hover border border-border-subtle flex items-center justify-center shrink-0">
                    <FileCode class="w-3.5 h-3.5 text-text-tertiary" />
                  </div>
                {/if}
                <div class="min-w-0 flex-1">
                  <div class="text-[13px] text-text-secondary font-mono truncate">{entry.name}</div>
                  <div class="text-[11px] text-text-placeholder">{entry.type === "dir" ? "Directory" : "File"}</div>
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {/if}
  </div>
</div>
