<script lang="ts">
import { renderMarkdown } from "$lib/markdown";
import type { SpaceFsFileResponse } from "$lib/api";
import { Eye, FileWarning, Pencil, Save, X, Download } from "lucide-svelte";
import CodeEditor from "$lib/components/CodeEditor.svelte";

const {
  file,
  draftContent,
  dirty,
  loading,
  saving,
  error,
  onInput,
  onSave,
  onClose,
  onDownload,
  downloadUrl,
  children,
}: {
  file: SpaceFsFileResponse | null;
  draftContent: string;
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onInput: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
  onDownload?: () => void;
  downloadUrl?: string;
  children?: import("svelte").Snippet;
} = $props();

let markdownHtml = $state("");
let fileEdit = $state(true);

$effect(() => {
  const current = file;
  if (!current || current.kind !== "text" || !/\.md$/i.test(current.path)) {
    markdownHtml = "";
    return;
  }
  void renderMarkdown(current.content).then((html) => {
    if (file?.path === current.path) markdownHtml = html;
  }).catch(() => {
    markdownHtml = "";
  });
});

$effect(() => {
  if (file) fileEdit = true;
});

const dataUrl = $derived.by(() => {
  if (!file || file.kind !== "binary") return null;
  const mime = file.mimeType ?? "application/octet-stream";
  return `data:${mime};base64,${file.content}`;
});

const isImage = $derived(Boolean(file?.mimeType?.startsWith("image/")));
const isVideo = $derived(Boolean(file?.mimeType?.startsWith("video/")));
const isMarkdown = $derived(Boolean(file?.kind === "text" && /\.md$/i.test(file.path)));

const editorLanguage = $derived.by(() => {
  if (!file || file.kind !== "text") return "plaintext";
  return file.name.split(".").pop()?.toLowerCase() ?? "";
});
</script>

<div class="flex h-full min-h-0 flex-col bg-bg-content">
  <div class="flex h-10 items-center gap-1.5 sm:gap-2 border-b border-border-subtle px-2 sm:px-3 shrink-0">
    <div class="min-w-0 flex-1 truncate text-[11px] sm:text-[12px] text-text-secondary">
      {file?.path ?? "Chat"}
    </div>
    {#if isMarkdown}
      <button type="button" class="toggle-btn" class:active={!fileEdit} onclick={() => fileEdit = false}>
        <Eye class="w-3.5 h-3.5" />
      </button>
      <button type="button" class="toggle-btn" class:active={fileEdit} onclick={() => fileEdit = true}>
        <Pencil class="w-3.5 h-3.5" />
      </button>
    {/if}
    {#if onDownload || downloadUrl}
      <button type="button" class="icon-btn" onclick={onDownload}>
        <Download class="w-4 h-4" />
      </button>
    {/if}
    {#if dirty}
      <button type="button" class="action-btn" onclick={onSave} disabled={saving}>
        <Save class="w-3.5 h-3.5" />
        Save
      </button>
    {/if}
    <button type="button" class="icon-btn" onclick={onClose}>
      <X class="w-4 h-4" />
    </button>
  </div>

  {#if error}
    <div class="m-3 rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] text-error-soft">{error}</div>
  {:else if loading}
    <div class="flex-1 flex items-center justify-center text-[12px] text-text-tertiary">Loading file...</div>
  {:else if !file}
    <div class="flex-1 flex items-center justify-center text-[12px] text-text-tertiary">Select a file</div>
  {:else if file.kind === 'text'}
    {#if isMarkdown && !fileEdit}
      <div class="markdown-preview">{@html markdownHtml}</div>
    {:else}
      <CodeEditor value={draftContent} language={editorLanguage} onInput={onInput} />
    {/if}
  {:else if isImage && dataUrl}
    <div class="flex-1 min-h-0 overflow-auto p-4 flex items-center justify-center"><img src={dataUrl} alt={file.name} class="max-w-full max-h-full object-contain" /></div>
  {:else if isVideo && dataUrl}
    <div class="flex-1 min-h-0 overflow-auto p-4 flex items-center justify-center">
      <video src={dataUrl} controls class="max-w-full max-h-full">
        <track kind="captions" srclang="en" label="captions" default />
      </video>
    </div>
  {:else}
    <div class="flex-1 flex flex-col items-center justify-center gap-2 text-[12px] text-text-tertiary">
      <FileWarning class="w-5 h-5" />
      <span>Binary preview unavailable</span>
    </div>
  {/if}

  {@render children?.()}
</div>

<style>
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: none; border-radius: 6px; background: transparent; color: var(--text-tertiary); text-decoration: none; }
  .icon-btn:hover { background: var(--bg-hover); color: var(--text-secondary); }
  .action-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--border-subtle); background: var(--bg-hover); color: var(--text-secondary); font-size: 12px; }
  .action-btn:disabled { opacity: 0.5; }
  .toggle-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 28px; padding: 0 8px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--text-tertiary); font-size: 12px; }
  .toggle-btn:hover { background: var(--bg-hover); color: var(--text-secondary); }
  .toggle-btn.active { border-color: var(--border-subtle); background: var(--bg-hover); color: var(--text-primary); }
  .markdown-preview { height: 100%; overflow: auto; padding: 20px 24px; max-width: 860px; margin: 0 auto; line-height: 1.7; font-size: 14px; }
</style>
