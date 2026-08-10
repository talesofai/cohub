<script lang="ts">
import type {
	SpaceFsFileResponse,
	SpacePendingDiffFileResponse,
	WorkRecord,
} from "@neta-art/cohub";
import {
	ArrowLeft,
	Check,
	Copy,
	Download,
	ListTree,
	Minus,
	MoreHorizontal,
	MoveHorizontal,
	Pencil,
	Plus,
	Rocket,
	TextCursorInput,
	Trash2,
	X,
} from "lucide-svelte";
import { floatNear } from "$lib/actions/portal";
import AudioPlayer from "$lib/components/AudioPlayer.svelte";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import type { FileViewMode } from "$lib/components/file-diff-view";
import MarkdownView from "$lib/components/MarkdownView.svelte";
import type { PdfPreviewControls } from "$lib/components/PdfPreview.svelte";
import type { PreviewCaptureTarget } from "$lib/features/preview-mark";
import PreviewMarkHost from "$lib/features/preview-mark/ui/PreviewMarkHost.svelte";
import { createLazyModuleLoader } from "$lib/lazy-module";
import type {
	OpenWorkspaceFileTarget,
	WorkspaceFilePosition,
} from "$lib/workspace-file-links";
import { formatFileSize } from "../space-utils";
import MobilePreviewTabsChrome from "./MobilePreviewTabsChrome.svelte";
import PreviewFloatChrome from "./PreviewFloatChrome.svelte";
import type { PreviewSyncStatus } from "./preview-sync-status";
import type { PreviewTab } from "./preview-tabs";

type InlineFilePanelState = {
	response: SpaceFsFileResponse | null;
	draft: string;
	path: string;
	position: WorkspaceFilePosition | null;
	loading: boolean;
	saving: boolean;
	syncStatus: PreviewSyncStatus;
	saveError: string | null;
	error: string | null;
	tooLarge: boolean;
};

type PanHandlers = {
	start: (event: MouseEvent) => void;
};

type Props = {
	inlineFile: InlineFilePanelState;
	previewTabs: PreviewTab[];
	inlineFileCanGoBack: boolean;
	inlineFileDownloadUrl: string;
	inlineFileDownloadName: string;
	inlineFileIsText: boolean;
	inlineFileHasRenderedPreview: boolean;
	inlineFileViewMode: FileViewMode;
	inlineFileDiff: SpacePendingDiffFileResponse | null;
	inlineFileDiffLoading: boolean;
	inlineFileDiffError: string | null;
	inlineFileIsMarkdown: boolean;
	inlineFileIsCsv: boolean;
	inlineFileIsHtml: boolean;
	activeFsReadonly: boolean;
	canEditFiles: boolean;
	inlineFileCopied: boolean;
	inlineFileExt: string;
	inlineFileIsImage: boolean;
	inlineFileIsVideo: boolean;
	inlineFileIsAudio: boolean;
	inlineFileIsPdf: boolean;
	inlineFileDataUrl: string | null;
	inlineFileSpaceId: string;
	inlineFileWork: WorkRecord | null;
	previewImmersiveMode: boolean;
	treeVisible?: boolean;
	onToggleTree?: () => void | Promise<void>;
	isMobile: boolean;
	fileActionMenuOpenPath: string | null;
	inlineFileZoom: number;
	inlineFilePanX: number;
	inlineFilePanY: number;
	inlineFileDragging: boolean;
	inlineFilePanHandlers: PanHandlers;
	onCloseInlineFile: () => void;
	onActivatePreviewTab: (kind: PreviewTab["kind"], key: string) => void;
	onClosePreviewTab: (kind: PreviewTab["kind"], key: string) => void;
	onBackInlineFile: () => void | Promise<void>;
	onOpenLinkedInlineFile: (
		target: OpenWorkspaceFileTarget,
	) => void | Promise<void>;
	onDownloadInlineFile: () => void | Promise<void>;
	onRetryInlineFile?: () => void | Promise<void>;
	onCopyInlineFileContent: () => void | Promise<void>;
	onUpdateInlineFileDraft: (path: string, draft: string) => void;
	onRetryInlineFileSave: () => void | Promise<void>;
	onOverwriteInlineFile: () => void | Promise<void>;
	onReloadInlineFile: () => void | Promise<void>;
	onPublishInlineFile: () => void;
	onTogglePreviewImmersiveMode: () => void | Promise<void>;
	onLabelFile: (
		path: string,
		anchorEl?: HTMLElement | null,
	) => void | Promise<void>;
	onInsertFilePathReference: (path: string) => void;
	onDownloadFilePath: (path: string) => void | Promise<void>;
	onRenameFilePath: (path: string) => void | Promise<void>;
	onDeleteFilePath: (path: string) => void | Promise<void>;
	onVisibleLinesChange?: (
		path: string,
		range: { start: number; end: number } | null,
	) => void;
};

let {
	inlineFile,
	previewTabs,
	inlineFileCanGoBack,
	inlineFileDownloadUrl,
	inlineFileDownloadName,
	inlineFileIsText,
	inlineFileHasRenderedPreview,
	inlineFileViewMode = $bindable(),
	inlineFileDiff,
	inlineFileDiffLoading,
	inlineFileDiffError,
	inlineFileIsMarkdown,
	inlineFileIsCsv,
	inlineFileIsHtml,
	activeFsReadonly,
	canEditFiles,
	inlineFileCopied,
	inlineFileExt,
	inlineFileIsImage,
	inlineFileIsVideo,
	inlineFileIsAudio,
	inlineFileIsPdf,
	inlineFileDataUrl,
	inlineFileSpaceId,
	inlineFileWork,
	previewImmersiveMode,
	treeVisible = true,
	onToggleTree,
	isMobile,
	fileActionMenuOpenPath = $bindable(),
	inlineFileZoom = $bindable(),
	inlineFilePanX = $bindable(),
	inlineFilePanY = $bindable(),
	inlineFileDragging,
	inlineFilePanHandlers,
	onCloseInlineFile,
	onActivatePreviewTab,
	onClosePreviewTab,
	onBackInlineFile,
	onOpenLinkedInlineFile,
	onDownloadInlineFile,
	onRetryInlineFile,
	onCopyInlineFileContent,
	onUpdateInlineFileDraft,
	onRetryInlineFileSave,
	onOverwriteInlineFile,
	onReloadInlineFile,
	onPublishInlineFile,
	onTogglePreviewImmersiveMode,
	onLabelFile,
	onInsertFilePathReference,
	onDownloadFilePath,
	onRenameFilePath,
	onDeleteFilePath,
	onVisibleLinesChange,
}: Props = $props();

const loadCodeEditorModule = createLazyModuleLoader(
	() => import("$lib/components/CodeEditor.svelte"),
);
const loadRenderedFilePreviewModule = createLazyModuleLoader(
	() => import("$lib/components/RenderedFilePreview.svelte"),
);
const loadFileDiffViewModule = createLazyModuleLoader(
	() => import("$lib/components/FileDiffView.svelte"),
);
const loadPdfPreviewModule = createLazyModuleLoader(
	() => import("$lib/components/PdfPreview.svelte"),
);
const loadCsvPreviewModule = createLazyModuleLoader(
	() => import("$lib/components/CsvPreview.svelte"),
);

const showDiffMode = $derived(!activeFsReadonly && inlineFileIsText);
// Bump to force #await to re-subscribe after a cleared lazy-import failure.
let codeEditorLoadAttempt = $state(0);
let htmlPreviewLoadAttempt = $state(0);
let fileDiffLoadAttempt = $state(0);
let pdfPreviewLoadAttempt = $state(0);
let csvPreviewLoadAttempt = $state(0);
let pdfControls = $state<PdfPreviewControls | null>(null);
let pdfPageDraft = $state("");
let pdfPageInputFocused = $state(false);
const pdfPageValue = $derived(
	pdfPageInputFocused ? pdfPageDraft : String(pdfControls?.page ?? ""),
);

function commitPdfPage() {
	const parsed = Number.parseInt(pdfPageDraft, 10);
	if (Number.isFinite(parsed)) pdfControls?.goToPage(parsed);
	pdfPageDraft = String(pdfControls?.page ?? 1);
}
const codeEditorModulePromise = $derived.by(() => {
	codeEditorLoadAttempt;
	return loadCodeEditorModule();
});
const htmlPreviewModulePromise = $derived.by(() => {
	htmlPreviewLoadAttempt;
	return loadRenderedFilePreviewModule();
});
const fileDiffModulePromise = $derived.by(() => {
	fileDiffLoadAttempt;
	return loadFileDiffViewModule();
});
const pdfPreviewModulePromise = $derived.by(() => {
	pdfPreviewLoadAttempt;
	return loadPdfPreviewModule();
});
const csvPreviewModulePromise = $derived.by(() => {
	csvPreviewLoadAttempt;
	return loadCsvPreviewModule();
});
let fileActionMenuAnchorEl: HTMLElement | null = $state(null);
let imageMarkOpen = $state(false);
let htmlMarkOpen = $state(false);
let htmlMarkTarget: PreviewCaptureTarget | null = $state(null);

const activeFilePath = $derived(inlineFile?.path ?? "");
const activeResponsePath = $derived(
	inlineFile?.response?.path ?? activeFilePath,
);

const imageMarkTarget = $derived.by((): PreviewCaptureTarget | null => {
	if (!inlineFileIsImage || !inlineFileDataUrl || !activeFilePath) return null;
	return {
		kind: "image",
		src: inlineFileDataUrl,
		path: activeFilePath,
	};
});
const showHtmlMark = $derived(
	inlineFileIsHtml &&
		inlineFileViewMode === "preview" &&
		inlineFileHasRenderedPreview,
);

// Soft-fail: keep content surface when we still have something usable.
// Empty text files (content === "") are still editable when open succeeded.
const hasUsableText = $derived(
	Boolean(
		inlineFile &&
			inlineFileIsText &&
			inlineFile.response &&
			(!inlineFile.error ||
				Boolean(inlineFile.response?.content) ||
				Boolean(inlineFile.draft)),
	),
);
const hasUsableMedia = $derived(
	Boolean(
		((inlineFileIsImage || inlineFileIsVideo || inlineFileIsAudio) &&
			inlineFileDataUrl) ||
			(inlineFileIsPdf &&
				inlineFile.response &&
				(inlineFile.response.content || inlineFile.response.url)),
	),
);
const showExclusiveFallback = $derived(
	Boolean(
		inlineFile?.error &&
			!inlineFile.loading &&
			!hasUsableText &&
			!hasUsableMedia &&
			!inlineFile.tooLarge,
	),
);

$effect(() => {
	if (!showHtmlMark) htmlMarkOpen = false;
});
</script>

{#snippet FileHeaderCoreActions(path: string)}
	<div class="relative shrink-0" data-resource-actions>
		<button
			type="button"
			class="icon-btn"
			onclick={(event) => {
				event.stopPropagation();
				const nextOpen = fileActionMenuOpenPath !== path;
				fileActionMenuAnchorEl = nextOpen ? event.currentTarget : null;
				fileActionMenuOpenPath = nextOpen ? path : null;
			}}
			title="More actions"
			aria-haspopup="menu"
			aria-expanded={fileActionMenuOpenPath === path}
		>
			<MoreHorizontal class="w-4 h-4" />
		</button>
		{#if fileActionMenuOpenPath === path && fileActionMenuAnchorEl}
			<div
				class="w-44 overflow-hidden rounded-md border border-border-subtle bg-bg-primary py-1 shadow-lg"
				role="menu"
				data-resource-actions
				use:floatNear={{
					getAnchor: () => fileActionMenuAnchorEl,
					placement: "bottom-end",
					gap: 4,
					width: 176,
					zIndex: 120,
				}}
			>
				<button type="button" class="menu-item" onclick={() => { void onLabelFile(path, fileActionMenuAnchorEl); fileActionMenuOpenPath = null; fileActionMenuAnchorEl = null; }} role="menuitem"><ListTree class="w-3.5 h-3.5" /><span>Label as…</span></button>
				<button type="button" class="menu-item" onclick={() => { onInsertFilePathReference(path); fileActionMenuOpenPath = null; fileActionMenuAnchorEl = null; }} role="menuitem"><TextCursorInput class="w-3.5 h-3.5" /><span>Insert reference</span></button>
				<button type="button" class="menu-item" onclick={() => { void onDownloadFilePath(path); fileActionMenuOpenPath = null; fileActionMenuAnchorEl = null; }} role="menuitem"><Download class="w-3.5 h-3.5" /><span>Download</span></button>
				{#if canEditFiles && !activeFsReadonly}
					<button type="button" class="menu-item" onclick={() => { void onRenameFilePath(path); fileActionMenuOpenPath = null; fileActionMenuAnchorEl = null; }} role="menuitem"><Pencil class="w-3.5 h-3.5" /><span>Rename</span></button>
					<button type="button" class="menu-item danger" onclick={() => { void onDeleteFilePath(path); fileActionMenuOpenPath = null; fileActionMenuAnchorEl = null; }} role="menuitem"><Trash2 class="w-3.5 h-3.5" /><span>Delete</span></button>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet FloatFileActions()}
	{#if inlineFileCanGoBack}
		<button
			type="button"
			class="icon-btn"
			onclick={() => void onBackInlineFile()}
			title="Back"
			aria-label="Back"
		>
			<ArrowLeft class="h-4 w-4" />
		</button>
	{/if}
	{@render FileHeaderCoreActions(activeResponsePath || activeFilePath)}
	{#if inlineFileIsPdf && hasUsableMedia}
		{@render PdfHeaderControls()}
	{/if}
	{#if hasUsableText && (inlineFileHasRenderedPreview || showDiffMode)}
		<div class="float-view-mode">
			<button
				type="button"
				class="segmented-btn"
				class:active={inlineFileViewMode === "source"}
				onclick={() => (inlineFileViewMode = "source")}
				title="Edit source"
			>Source</button>
			{#if inlineFileHasRenderedPreview}
				<button
					type="button"
					class="segmented-btn"
					class:active={inlineFileViewMode === "preview"}
					onclick={() => (inlineFileViewMode = "preview")}
					title={inlineFileIsMarkdown
						? "Preview markdown"
						: inlineFileIsCsv
							? "Preview table"
							: "Preview HTML"}
				>Preview</button>
			{/if}
			{#if showDiffMode}
				<button
					type="button"
					class="segmented-btn"
					class:active={inlineFileViewMode === "diff"}
					onclick={() => (inlineFileViewMode = "diff")}
					title="Diff since last save"
				>Diff</button>
			{/if}
		</div>
	{/if}
	{#if inlineFileIsHtml && inlineFileViewMode === "preview"}
		<button
			type="button"
			class="icon-btn preview-context-secondary"
			onclick={onPublishInlineFile}
			title="Publish work"
			aria-label="Publish work"
		>
			<Rocket class="h-4 w-4" />
		</button>
	{/if}
	{#if showHtmlMark}
		<div class="preview-context-secondary">
			<PreviewMarkHost bind:open={htmlMarkOpen} target={htmlMarkTarget} />
		</div>
	{/if}
	{#if hasUsableText}
		<button
			type="button"
			class="icon-btn preview-context-secondary"
			onclick={() => void onCopyInlineFileContent()}
			title="Copy content"
			aria-label="Copy content"
		>
			{#if inlineFileCopied}
				<Check class="h-4 w-4 text-success-soft" />
			{:else}
				<Copy class="h-4 w-4" />
			{/if}
		</button>
	{/if}
	{#if inlineFileIsImage && inlineFileDataUrl}
		{#if imageMarkTarget}
			<PreviewMarkHost bind:open={imageMarkOpen} target={imageMarkTarget} />
		{/if}
		<div class="float-image-zoom">
			<button
				type="button"
				class="zoom-btn"
				onclick={() => {
					inlineFileZoom = Math.max(0.25, inlineFileZoom - 0.25);
					inlineFilePanX = 0;
					inlineFilePanY = 0;
				}}
				title="Zoom out"
				aria-label="Zoom out"
			>
				<Minus class="h-4 w-4" />
			</button>
			<span class="w-10 text-center text-[11px] tabular-nums text-text-tertiary">
				{Math.round(inlineFileZoom * 100)}%
			</span>
			<button
				type="button"
				class="zoom-btn"
				onclick={() => {
					inlineFileZoom = Math.min(4, inlineFileZoom + 0.25);
					inlineFilePanX = 0;
					inlineFilePanY = 0;
				}}
				title="Zoom in"
				aria-label="Zoom in"
			>
				<Plus class="h-4 w-4" />
			</button>
		</div>
	{/if}
{/snippet}

{#snippet PdfHeaderControls()}
	{#if pdfControls}
		<div class="pdf-header-controls">
			<input
				class="pdf-page-input"
				type="text"
				inputmode="numeric"
				aria-label="Page number"
				value={pdfPageValue}
				oninput={(event) => {
					pdfPageDraft = event.currentTarget.value;
				}}
				onfocus={(event) => {
					pdfPageInputFocused = true;
					pdfPageDraft = String(pdfControls?.page ?? 1);
					event.currentTarget.select();
				}}
				onblur={() => {
					pdfPageInputFocused = false;
					commitPdfPage();
				}}
				onkeydown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
				}}
			/>
			<span class="pdf-page-total">/ {pdfControls.pageCount}</span>
			<span class="pdf-header-divider"></span>
			<button type="button" class="icon-btn" title="Zoom out" aria-label="Zoom out" onclick={() => pdfControls?.zoomOut()}>
				<Minus class="h-4 w-4" />
			</button>
			<span class="pdf-scale">{Math.round(pdfControls.scale * 100)}%</span>
			<button type="button" class="icon-btn" title="Zoom in" aria-label="Zoom in" onclick={() => pdfControls?.zoomIn()}>
				<Plus class="h-4 w-4" />
			</button>
			<button
				type="button"
				class="icon-btn"
				class:active={pdfControls.fitWidth}
				title="Fit width"
				aria-label="Fit width"
				aria-pressed={pdfControls.fitWidth}
				onclick={() => pdfControls?.fitPageWidth()}
			>
				<MoveHorizontal class="h-4 w-4" />
			</button>
		</div>
	{/if}
{/snippet}

{#snippet LazyLoadError(label: string, onRetry: () => void)}
	<div class="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
		<div class="text-[12px] text-error-soft">{label}</div>
		<button type="button" class="action-btn" onclick={onRetry}>Retry</button>
	</div>
{/snippet}


{#snippet FileOpenFallback(options: {
	title: string;
	detail: string;
	variant?: "error" | "warning" | "neutral";
	showRetry?: boolean;
})}
	{@const variant = options.variant ?? "neutral"}
	{@const border =
		variant === "error"
			? "border-error-soft/30 bg-error-bg"
			: variant === "warning"
				? "border-warning-soft/30 bg-warning-bg"
				: "border-border-subtle bg-bg-primary"}
	{@const titleColor =
		variant === "error"
			? "text-error-soft"
			: variant === "warning"
				? "text-warning-soft"
				: "text-text-primary"}
	<div class="flex flex-1 items-center justify-center p-4">
		<div class="w-full max-w-sm rounded-lg border {border} p-6 text-center">
			<div class="mb-1 text-sm font-semibold {titleColor}">{options.title}</div>
			<div class="mb-1 break-words text-xs text-text-secondary">{options.detail}</div>
			{#if inlineFile.response}
				<div class="mt-3 space-y-0.5 text-left text-[11px] text-text-tertiary">
					<div><span class="text-text-secondary">Name</span> · {inlineFile.response.name}</div>
					<div><span class="text-text-secondary">Type</span> · {inlineFile.response.mimeType ?? "application/octet-stream"}</div>
					<div><span class="text-text-secondary">Size</span> · {formatFileSize(inlineFile.response.size)}</div>
				</div>
			{/if}
			<div class="mt-4 flex flex-wrap items-center justify-center gap-2">
				{#if options.showRetry !== false && onRetryInlineFile}
					<button type="button" class="action-btn" onclick={() => void onRetryInlineFile()}>Retry</button>
				{/if}
				<a
					href={inlineFileDownloadUrl}
					download={inlineFileDownloadName}
					class="action-btn primary"
					onclick={(e) => {
						e.preventDefault();
						void onDownloadInlineFile();
					}}
				>
					<Download class="w-3.5 h-3.5" />
					Download
				</a>
			</div>
		</div>
	</div>
{/snippet}

{#snippet SoftFailBanner()}
	{#if inlineFile?.error && (hasUsableText || hasUsableMedia)}
		<div class="file-status-banner flex shrink-0 items-center gap-2 border-b border-error-soft/20 bg-error-bg px-3 py-1.5 text-[11px] text-error-soft">
			<span class="min-w-0 flex-1 truncate">{inlineFile.error}</span>
			{#if onRetryInlineFile}
				<button type="button" class="action-btn" onclick={() => void onRetryInlineFile()}>Retry</button>
			{/if}
			<button type="button" class="action-btn" onclick={() => void onDownloadInlineFile()}>
				<Download class="w-3.5 h-3.5" />
				Download
			</button>
		</div>
	{/if}
{/snippet}

{#snippet SyncIssueBanner()}
	{#if inlineFile?.saveError}
		<div class="file-status-banner flex shrink-0 items-center gap-2 border-b border-error-soft/20 bg-error-bg px-3 py-1.5 text-[11px] text-error-soft">
			<span class="min-w-0 flex-1 truncate">{inlineFile.saveError}</span>
			{#if inlineFile.syncStatus === "conflict"}
				<button type="button" class="action-btn" onclick={() => void onReloadInlineFile()}>Reload</button>
				<button type="button" class="action-btn" onclick={() => void onOverwriteInlineFile()}>Keep mine</button>
			{:else}
				<button type="button" class="action-btn" onclick={() => void onRetryInlineFileSave()}>Retry</button>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet MarkdownFilePreview()}
	{#if inlineFile?.response}
		<MarkdownView
			source={inlineFile.draft}
			variant="document"
			baseFilePath={inlineFile.response.path}
			onOpenFile={onOpenLinkedInlineFile}
		/>
	{/if}
{/snippet}

{#snippet HtmlFilePreview()}
	{#if inlineFile?.response}
		{#await htmlPreviewModulePromise then previewModule}
			{@const LazyRenderedFilePreview = previewModule.default}
			<LazyRenderedFilePreview
				name={inlineFile.response.name}
				source={inlineFile.draft}
				type="html"
				path={inlineFile.response.path}
				spaceId={inlineFileSpaceId}
				readonly={activeFsReadonly}
				work={inlineFileWork}
				bind:markTarget={htmlMarkTarget}
				onOpenFile={onOpenLinkedInlineFile}
			/>
		{:catch}
			{@render LazyLoadError("Preview failed to load.", () => {
				htmlPreviewLoadAttempt += 1;
			})}
		{/await}
	{/if}
{/snippet}

{#snippet CsvFilePreview()}
	{#if inlineFile?.response}
		{#await csvPreviewModulePromise then previewModule}
			{@const LazyCsvPreview = previewModule.default}
			<LazyCsvPreview
				source={inlineFile.draft}
				name={inlineFile.response.name}
			/>
		{:catch}
			{@render LazyLoadError("Preview failed to load.", () => {
				csvPreviewLoadAttempt += 1;
			})}
		{/await}
	{/if}
{/snippet}

{#snippet PdfFilePreview()}
	{#if inlineFile?.response}
		{#await pdfPreviewModulePromise then previewModule}
			{@const LazyPdfPreview = previewModule.default}
			<LazyPdfPreview
				name={inlineFile.response.name}
				url={inlineFile.response.delivery === "url"
					? (inlineFile.response.url ?? null)
					: null}
				base64={inlineFile.response.delivery === "url"
					? null
					: inlineFile.response.content}
				version={`${inlineFile.response.path}:${inlineFile.response.size}:${inlineFile.response.mtimeMs}`}
				{isMobile}
				onControlsChange={(controls) => {
					pdfControls = controls;
				}}
			/>
		{:catch}
			{@render LazyLoadError("PDF preview failed to load.", () => {
				pdfPreviewLoadAttempt += 1;
			})}
		{/await}
	{/if}
{/snippet}

{#snippet TextFileBody()}
	{#if inlineFileViewMode === "diff" && showDiffMode}
		{#await fileDiffModulePromise then diffModule}
			{@const LazyFileDiffView = diffModule.default}
			<LazyFileDiffView
				patch={inlineFileDiff}
				loading={inlineFileDiffLoading}
				error={inlineFileDiffError}
			/>
		{:catch}
			{@render LazyLoadError("Diff failed to load.", () => {
				fileDiffLoadAttempt += 1;
			})}
		{/await}
	{:else if inlineFileViewMode === "preview" && inlineFileHasRenderedPreview}
		{#if inlineFileIsMarkdown}
			{@render MarkdownFilePreview()}
		{:else if inlineFileIsCsv}
			{@render CsvFilePreview()}
		{:else}
			{@render HtmlFilePreview()}
		{/if}
	{:else if inlineFile}
		{#await codeEditorModulePromise then editorModule}
			{@const LazyCodeEditor = editorModule.default}
			{@const editorPath = inlineFile.path}
			<LazyCodeEditor
				value={inlineFile.draft}
				language={inlineFileExt}
				allowDrawerSwipe={isMobile}
				initialPosition={inlineFile.position}
				onInput={(v) => onUpdateInlineFileDraft(editorPath, v)}
				onVisibleLinesChange={(range) =>
					onVisibleLinesChange?.(editorPath, range)}
				readonly={!canEditFiles || activeFsReadonly}
			/>
		{:catch}
			{@render LazyLoadError("Editor failed to load.", () => {
				codeEditorLoadAttempt += 1;
			})}
		{/await}
	{/if}
{/snippet}

{#if isMobile}
	<div class="flex h-full min-w-0 flex-col bg-bg-content">
			<MobilePreviewTabsChrome
				tabs={previewTabs}
				onActivate={onActivatePreviewTab}
				onClose={onClosePreviewTab}
			>
				{#snippet trailing()}
					{#if inlineFileIsPdf && hasUsableMedia}
						{@render PdfHeaderControls()}
					{/if}
					{#if inlineFileCanGoBack}
						<button
							type="button"
							class="icon-btn"
							onclick={() => void onBackInlineFile()}
							title="Back"
							aria-label="Back"
						>
							<ArrowLeft class="h-4 w-4" />
						</button>
					{/if}
					{@render FileHeaderCoreActions(activeFilePath)}
				{/snippet}
			</MobilePreviewTabsChrome>
      {#if inlineFile?.loading}
        <CenteredLoading label="Loading file…" size="panel" />
      {:else if inlineFile?.tooLarge}
        {@render FileOpenFallback({
          title: "File too large to preview",
          detail: "This file exceeds 10MB and cannot be opened in the web editor.",
          variant: "warning",
          showRetry: false,
        })}
      {:else if showExclusiveFallback}
        {@render FileOpenFallback({
          title: "Couldn't open file",
          detail: inlineFile?.error ?? "Failed to open file",
          variant: "error",
        })}
      {:else if inlineFile?.response}
        {@render SoftFailBanner()}
        {@render SyncIssueBanner()}
        {#if hasUsableText}
          <div class="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle bg-bg-surface px-3">
            {#if inlineFileHasRenderedPreview || showDiffMode}
              <div class="flex items-center gap-0 rounded-md border border-border-subtle bg-bg-input p-[2px]">
                <button type="button" class="segmented-btn" class:active={inlineFileViewMode === "source"} onclick={() => inlineFileViewMode = "source"} title="Edit source">Source</button>
                {#if inlineFileHasRenderedPreview}
                  <button type="button" class="segmented-btn" class:active={inlineFileViewMode === "preview"} onclick={() => inlineFileViewMode = "preview"} title={inlineFileIsMarkdown ? "Preview markdown" : inlineFileIsCsv ? "Preview table" : "Preview HTML"}>Preview</button>
                {/if}
                {#if showDiffMode}
                  <button type="button" class="segmented-btn" class:active={inlineFileViewMode === "diff"} onclick={() => inlineFileViewMode = "diff"} title="Diff since last save">Diff</button>
                {/if}
              </div>
            {/if}
            <div class="flex-1"></div>
            {#if showHtmlMark}
              <PreviewMarkHost
                bind:open={htmlMarkOpen}
                target={htmlMarkTarget}
              />
            {/if}
            <button type="button" class="icon-btn" onclick={() => void onCopyInlineFileContent()} title="Copy content">
              {#if inlineFileCopied}<Check class="w-4 h-4 text-success-soft" />{:else}<Copy class="w-4 h-4" />{/if}
            </button>
            {#if activeFsReadonly}
              <span class="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-text-tertiary">Read-only snapshot</span>
            {/if}
          </div>
          <div class="flex-1 min-h-0">
            {@render TextFileBody()}
          </div>
        {:else if inlineFileIsImage && inlineFileDataUrl}
          <div class="relative flex flex-1 items-center justify-center overflow-hidden p-4">
            {#if imageMarkTarget}
              <div class="pointer-events-none absolute top-2 right-2 z-20">
                <div class="pointer-events-auto rounded-md border border-border-subtle bg-bg-surface/95 shadow-sm backdrop-blur-sm">
                  <PreviewMarkHost bind:open={imageMarkOpen} target={imageMarkTarget} />
                </div>
              </div>
            {/if}
            <img src={inlineFileDataUrl} alt={inlineFile.response.name} class="max-h-full max-w-full rounded-md" />
          </div>
        {:else if inlineFileIsVideo && inlineFileDataUrl}
          <div class="flex flex-1 items-center justify-center p-4">
            <video src={inlineFileDataUrl} controls class="max-h-full max-w-full rounded-md">
              <track kind="captions" />
            </video>
          </div>
        {:else if inlineFileIsAudio && inlineFileDataUrl}
          <div class="flex flex-1 items-center justify-center p-4">
            <div class="w-full max-w-md">
              <AudioPlayer
                src={inlineFileDataUrl}
                title={inlineFile.response.name}
                subtitle={formatFileSize(inlineFile.response.size)}
                downloadUrl={inlineFileDownloadUrl}
                downloadName={inlineFileDownloadName}
              />
            </div>
          </div>
        {:else if inlineFileIsPdf && hasUsableMedia}
          <div class="min-h-0 flex-1">
            {@render PdfFilePreview()}
          </div>
        {:else}
          {@render FileOpenFallback({
            title: "Preview not available",
            detail: "This file type cannot be previewed in the browser.",
            variant: "neutral",
            showRetry: false,
          })}
        {/if}
      {:else}
        <div class="flex-1 flex items-center justify-center text-sm text-text-tertiary">No file selected</div>
      {/if}
		</div>
	{:else}
      <div class="inline-file-preview relative flex h-full min-w-0 flex-col bg-bg-content" class:inline-file-preview--immersive={previewImmersiveMode}>
        {#if previewImmersiveMode}
          <PreviewFloatChrome
            tabs={previewTabs}
            filesVisible={treeVisible}
            onActivate={onActivatePreviewTab}
            onClose={onClosePreviewTab}
            onToggleFiles={onToggleTree}
            onExit={onTogglePreviewImmersiveMode}
          >
            {#snippet context()}{@render FloatFileActions()}{/snippet}
          </PreviewFloatChrome>
        {/if}
        {#if inlineFile?.loading}
          <div class="preview-chrome flex h-11 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-bg-surface px-3">
            <span class="preview-chrome-path flex-1 truncate text-xs text-text-secondary">{activeFilePath}</span>
            {@render FileHeaderCoreActions(activeFilePath)}
            <button type="button" class="icon-btn" onclick={onCloseInlineFile} title="Close file">
              <X class="w-4 h-4" />
            </button>
          </div>
          <CenteredLoading label="Loading file…" size="panel" />
        {:else if inlineFile?.tooLarge}
          <div class="preview-chrome flex h-11 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-bg-surface px-3">
            <span class="preview-chrome-path flex-1 truncate text-xs text-text-secondary">{activeFilePath}</span>
            {@render FileHeaderCoreActions(activeFilePath)}
            <button type="button" class="icon-btn" onclick={onCloseInlineFile} title="Close file">
              <X class="w-4 h-4" />
            </button>
          </div>
          {@render FileOpenFallback({
            title: "File too large to preview",
            detail: "This file exceeds 10MB and cannot be opened in the web editor.",
            variant: "warning",
            showRetry: false,
          })}
        {:else if showExclusiveFallback}
          <div class="preview-chrome flex h-11 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-bg-surface px-3">
            <span class="preview-chrome-path flex-1 truncate text-xs text-text-secondary">{activeFilePath}</span>
            {@render FileHeaderCoreActions(activeFilePath)}
            <button type="button" class="icon-btn" onclick={onCloseInlineFile} title="Close file">
              <X class="w-4 h-4" />
            </button>
          </div>
          {@render FileOpenFallback({
            title: "Couldn't open file",
            detail: inlineFile?.error ?? "Failed to open file",
            variant: "error",
          })}
        {:else if inlineFile?.response}
          {@render SoftFailBanner()}
          {@render SyncIssueBanner()}
          {#if hasUsableText}
            <div class="preview-chrome flex h-11 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-bg-surface px-3">
              {#if inlineFileCanGoBack}
                <button type="button" class="icon-btn" onclick={() => void onBackInlineFile()} title="Back">
                  <ArrowLeft class="w-4 h-4" />
                </button>
              {/if}
              <div class="preview-chrome-path min-w-0 flex-1 truncate text-xs sm:text-sm text-text-secondary">
                {activeResponsePath}
              </div>
              {@render FileHeaderCoreActions(activeResponsePath)}
              {#if inlineFileIsHtml && inlineFileViewMode === "preview"}
                <button type="button" class="action-btn" onclick={onPublishInlineFile} title="Publish work">
                  <Rocket class="w-3.5 h-3.5 shrink-0" />
                  <span class="hidden sm:inline">Publish</span>
                </button>
              {/if}
              {#if inlineFileHasRenderedPreview || showDiffMode}
                <div class="flex items-center gap-0 rounded-md border border-border-subtle bg-bg-input p-[2px]">
                  <button
                    type="button"
                    class="segmented-btn"
                    class:active={inlineFileViewMode === "source"}
                    onclick={() => inlineFileViewMode = "source"}
                    title="Edit source"
                  >
                    Source
                  </button>
                  {#if inlineFileHasRenderedPreview}
                    <button
                      type="button"
                      class="segmented-btn"
                      class:active={inlineFileViewMode === "preview"}
                      onclick={() => inlineFileViewMode = "preview"}
                      title={inlineFileIsMarkdown ? "Preview markdown" : inlineFileIsCsv ? "Preview table" : "Preview HTML"}
                    >
                      Preview
                    </button>
                  {/if}
                  {#if showDiffMode}
                    <button
                      type="button"
                      class="segmented-btn"
                      class:active={inlineFileViewMode === "diff"}
                      onclick={() => inlineFileViewMode = "diff"}
                      title="Diff since last save"
                    >
                      Diff
                    </button>
                  {/if}
                </div>
              {/if}
              {#if showHtmlMark}
                <PreviewMarkHost
                  bind:open={htmlMarkOpen}
                  target={htmlMarkTarget}
                />
              {/if}
              <button type="button" class="icon-btn" onclick={() => void onCopyInlineFileContent()} title="Copy content">
                {#if inlineFileCopied}
                  <Check class="w-4 h-4 text-success-soft" />
                {:else}
                  <Copy class="w-4 h-4" />
                {/if}
              </button>
              {#if activeFsReadonly}
                <span class="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-text-tertiary">Read-only snapshot</span>
              {/if}
              <button type="button" class="icon-btn" onclick={onCloseInlineFile} title="Close file">
                <X class="w-4 h-4" />
              </button>
            </div>
            <div class="flex-1 min-h-0">
              {@render TextFileBody()}
            </div>
          {:else if inlineFileIsImage && inlineFileDataUrl}
            <div class="relative flex min-h-0 flex-1 flex-col">
              <div class="preview-chrome flex h-11 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-bg-surface px-3">
                <div class="preview-chrome-path min-w-0 flex-1 truncate text-xs sm:text-sm text-text-secondary">
                  {activeResponsePath}
                </div>
                <div class="text-xs text-text-tertiary hidden sm:inline">{formatFileSize(inlineFile.response.size)}</div>
                {@render FileHeaderCoreActions(activeResponsePath)}
                {#if imageMarkTarget}
                  <PreviewMarkHost bind:open={imageMarkOpen} target={imageMarkTarget} />
                {/if}
                <button type="button" class="zoom-btn" onclick={() => { inlineFileZoom = Math.max(0.25, inlineFileZoom - 0.25); inlineFilePanX = 0; inlineFilePanY = 0; }} title="Zoom out">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="7" y1="11" x2="15" y2="11"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                </button>
                <span class="text-xs text-text-tertiary tabular-nums w-10 text-center">{Math.round(inlineFileZoom * 100)}%</span>
                <button type="button" class="zoom-btn" onclick={() => { inlineFileZoom = Math.min(4, inlineFileZoom + 0.25); inlineFilePanX = 0; inlineFilePanY = 0; }} title="Zoom in">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="11" y1="7" x2="11" y2="15"/><line x1="7" y1="11" x2="15" y2="11"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                </button>
                <button type="button" class="icon-btn" onclick={onCloseInlineFile} title="Close file">
                  <X class="w-4 h-4" />
                </button>
              </div>
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <div class="flex flex-1 items-center justify-center overflow-hidden p-4" tabindex="-1" role="group" aria-label="Image preview — scroll to zoom, drag to pan, double-click to reset" onwheel={(e) => {
                if (e.ctrlKey || e.metaKey) {
                  e.preventDefault();
                  inlineFileZoom = Math.max(0.25, Math.min(4, inlineFileZoom + (e.deltaY < 0 ? 0.1 : -0.1)));
                  inlineFilePanX = 0;
                  inlineFilePanY = 0;
                }
              }} ondblclick={() => { inlineFileZoom = 1; inlineFilePanX = 0; inlineFilePanY = 0; }} onmousedown={inlineFilePanHandlers.start} style={inlineFileDragging ? 'cursor: grabbing;' : (inlineFileZoom > 1 ? 'cursor: grab;' : '')}>
                <img src={inlineFileDataUrl} alt={inlineFile.response.name} style={`transform: translate(${inlineFilePanX}px, ${inlineFilePanY}px) scale(${inlineFileZoom}); ${inlineFileDragging ? '' : 'transition: transform 150ms ease;'}`} class="max-h-full max-w-full rounded-md select-none" />
              </div>
            </div>
          {:else if inlineFileIsVideo && inlineFileDataUrl}
            <div class="preview-chrome flex h-11 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-bg-surface px-3">
              <div class="preview-chrome-path min-w-0 flex-1 truncate text-xs sm:text-sm text-text-secondary">
                {activeResponsePath}
              </div>
              <div class="text-xs text-text-tertiary hidden sm:inline">{formatFileSize(inlineFile.response.size)}</div>
              {@render FileHeaderCoreActions(activeResponsePath)}
              <button type="button" class="icon-btn" onclick={onCloseInlineFile} title="Close file">
                <X class="w-4 h-4" />
              </button>
            </div>
            <div class="flex flex-1 items-center justify-center p-4">
              <video src={inlineFileDataUrl} controls class="max-h-full max-w-full rounded-md">
                <track kind="captions" />
              </video>
            </div>
          {:else if inlineFileIsAudio && inlineFileDataUrl}
            <div class="preview-chrome flex h-11 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-bg-surface px-3">
              <div class="preview-chrome-path min-w-0 flex-1 truncate text-xs sm:text-sm text-text-secondary">
                {activeResponsePath}
              </div>
              <div class="text-xs text-text-tertiary hidden sm:inline">{formatFileSize(inlineFile.response.size)}</div>
              {@render FileHeaderCoreActions(activeResponsePath)}
              <button type="button" class="icon-btn" onclick={onCloseInlineFile} title="Close file">
                <X class="w-4 h-4" />
              </button>
            </div>
            <div class="flex flex-1 items-center justify-center p-4">
              <div class="w-full max-w-md">
                <AudioPlayer
                  src={inlineFileDataUrl}
                  title={inlineFile.response.name}
                  subtitle={formatFileSize(inlineFile.response.size)}
                  downloadUrl={inlineFileDownloadUrl}
                  downloadName={inlineFileDownloadName}
                />
              </div>
            </div>
          {:else if inlineFileIsPdf && hasUsableMedia}
            <div class="preview-chrome flex h-11 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-bg-surface px-3">
              <div class="min-w-0 flex-1">
                {@render PdfHeaderControls()}
              </div>
              <div class="hidden text-xs text-text-tertiary sm:inline">{formatFileSize(inlineFile.response.size)}</div>
              {@render FileHeaderCoreActions(activeResponsePath)}
              <button type="button" class="icon-btn" onclick={onCloseInlineFile} title="Close file">
                <X class="h-4 w-4" />
              </button>
            </div>
            <div class="min-h-0 flex-1">
              {@render PdfFilePreview()}
            </div>
          {:else}
            <div class="preview-chrome flex h-11 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-bg-surface px-3">
              <div class="preview-chrome-path min-w-0 flex-1 truncate text-xs sm:text-sm text-text-secondary">
                {activeResponsePath}
              </div>
              <div class="text-xs text-text-tertiary hidden sm:inline">{formatFileSize(inlineFile?.response ? inlineFile.response.size : 0)}</div>
              {@render FileHeaderCoreActions(activeResponsePath)}
              <button type="button" class="icon-btn" onclick={onCloseInlineFile} title="Close file">
                <X class="w-4 h-4" />
              </button>
            </div>
            {@render FileOpenFallback({
              title: "Preview not available",
              detail: "This file type cannot be previewed in the browser.",
              variant: "neutral",
              showRetry: false,
            })}
          {/if}
        {:else}
          <div class="flex-1 flex items-center justify-center text-xs text-text-tertiary">No file selected</div>
        {/if}
      </div>
{/if}

<style>
  .inline-file-preview--immersive :global(.preview-chrome) {
    display: none;
  }

  .inline-file-preview--immersive :global(.preview-float-chrome + .file-status-banner) {
    margin-top: 58px;
  }

  .pdf-header-controls {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
  }

  .pdf-page-input {
    width: 2.5rem;
    height: 1.75rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .pdf-page-input:focus {
    border-color: color-mix(in srgb, var(--brand) 50%, transparent);
    outline: none;
  }

  .pdf-page-total,
  .pdf-scale {
    flex-shrink: 0;
    color: var(--text-tertiary);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .pdf-scale {
    width: 2.75rem;
    text-align: center;
  }

  .pdf-header-divider {
    width: 1px;
    height: 1rem;
    margin-inline: 2px;
    background: var(--border-subtle);
  }

  .float-view-mode,
  .float-image-zoom {
    display: flex;
    align-items: center;
    gap: 0;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: var(--bg-input);
    padding: 2px;
  }

  @container (max-width: 620px) {
    .float-view-mode .segmented-btn:not(.active) {
      display: none;
    }
  }
</style>
