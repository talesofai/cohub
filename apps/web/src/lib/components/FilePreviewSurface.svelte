<script lang="ts">
import type { SpaceFsFileResponse } from "@neta-art/cohub";
import { Download } from "lucide-svelte";
import AudioPlayer from "$lib/components/AudioPlayer.svelte";
import MarkdownView from "$lib/components/MarkdownView.svelte";
import { filePreviewModel } from "$lib/file-preview-model";
import { createLazyModuleLoader } from "$lib/lazy-module";

const {
	file,
	source = file.content,
	downloadUrl = file.delivery === "url" ? (file.url ?? "") : "",
	isMobile = false,
}: {
	file: SpaceFsFileResponse;
	source?: string;
	downloadUrl?: string;
	isMobile?: boolean;
} = $props();

const model = $derived(filePreviewModel(file));
const loadCodeEditor = createLazyModuleLoader(
	() => import("$lib/components/CodeEditor.svelte"),
);
const loadRenderedPreview = createLazyModuleLoader(
	() => import("$lib/components/RenderedFilePreview.svelte"),
);
const loadPdfPreview = createLazyModuleLoader(
	() => import("$lib/components/PdfPreview.svelte"),
);
const loadCsvPreview = createLazyModuleLoader(
	() => import("$lib/components/CsvPreview.svelte"),
);

function formatSize(bytes: number) {
	if (bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const index = Math.min(
		units.length - 1,
		Math.floor(Math.log(bytes) / Math.log(1024)),
	);
	const value = bytes / 1024 ** index;
	return `${value < 10 && index > 0 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}
</script>

<div class="file-preview-surface">
	{#if model.kind === "markdown"}
		<MarkdownView {source} variant="document" baseFilePath={file.path} />
	{:else if model.kind === "html"}
		{#await loadRenderedPreview() then module}
			{@const RenderedPreview = module.default}
			<RenderedPreview
				name={file.name}
				{source}
				type="html"
				path={file.path}
				readonly
			/>
		{:catch}
			<div class="preview-message">Preview failed to load.</div>
		{/await}
	{:else if model.kind === "csv"}
		{#await loadCsvPreview() then module}
			{@const CsvPreview = module.default}
			<CsvPreview source={source} name={file.name} />
		{:catch}
			<div class="preview-message">Preview failed to load.</div>
		{/await}
	{:else if model.kind === "text"}
		{#await loadCodeEditor() then module}
			{@const CodeEditor = module.default}
			<CodeEditor value={source} language={model.language} readonly />
		{:catch}
			<div class="preview-message">Preview failed to load.</div>
		{/await}
	{:else if model.kind === "image" && model.mediaUrl}
		<div class="media-preview">
			<img src={model.mediaUrl} alt={file.name} />
		</div>
	{:else if model.kind === "video" && model.mediaUrl}
		<div class="media-preview">
			<video src={model.mediaUrl} controls playsinline aria-label={file.name}>
				<track kind="captions" />
			</video>
		</div>
	{:else if model.kind === "audio" && model.mediaUrl}
		<div class="audio-preview">
			<AudioPlayer
				src={model.mediaUrl}
				title={file.name}
				subtitle={formatSize(file.size)}
				downloadUrl={downloadUrl || undefined}
				downloadName={file.name}
			/>
		</div>
	{:else if model.kind === "pdf"}
		{#await loadPdfPreview() then module}
			{@const PdfPreview = module.default}
			<PdfPreview
				name={file.name}
				url={file.delivery === "url" ? (file.url ?? null) : null}
				base64={file.delivery === "url" ? null : file.content}
				version={`${file.path}:${file.size}:${file.mtimeMs}`}
				{isMobile}
			/>
		{:catch}
			<div class="preview-message">PDF preview failed to load.</div>
		{/await}
	{:else}
		<div class="fallback-preview">
			<div class="fallback-title">Preview not available</div>
			<div class="fallback-detail">{file.mimeType ?? "application/octet-stream"} · {formatSize(file.size)}</div>
			{#if downloadUrl}
				<a class="action-btn primary" href={downloadUrl} download={file.name}>
					<Download class="h-3.5 w-3.5" />
					Download
				</a>
			{/if}
		</div>
	{/if}
</div>

<style>
	.file-preview-surface {
		height: 100%;
		min-height: 0;
		min-width: 0;
		background: var(--bg-content);
	}

	.media-preview,
	.audio-preview,
	.preview-message,
	.fallback-preview {
		display: flex;
		height: 100%;
		min-height: 220px;
		align-items: center;
		justify-content: center;
	}

	.media-preview {
		padding: 1rem;
		overflow: auto;
	}

	.media-preview img,
	.media-preview video {
		display: block;
		max-width: 100%;
		max-height: 100%;
		border-radius: 6px;
	}

	.audio-preview {
		width: min(34rem, calc(100% - 2rem));
		padding: 1rem;
		margin-inline: auto;
	}

	.preview-message {
		color: var(--text-tertiary);
		font-size: 0.75rem;
	}

	.fallback-preview {
		flex-direction: column;
		gap: 0.5rem;
		padding: 1.5rem;
		text-align: center;
	}

	.fallback-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.fallback-detail {
		margin-bottom: 0.5rem;
		font-size: 0.75rem;
		color: var(--text-tertiary);
	}
</style>
