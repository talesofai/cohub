<script lang="ts">
import type {
	SpacePublicEndpoint,
	SpacePublicEndpoints,
} from "@cohub/protocol/ports";
import type { WorkComposerChip } from "@cohub/protocol/work-surface";
import type {
	BoardOperation,
	SpacePendingDiffFileResponse,
	SpaceRecord,
	WorkRecord,
} from "@neta-art/cohub";
import type { BoardDocument } from "@neta-art/cohub/board";
import { fade } from "svelte/transition";
import type {
	BoardAutomationActivity,
	BoardCollaboratorProfile,
} from "$lib/board/board-activity";
import type { FileViewMode } from "$lib/components/file-diff-view";
import PreviewExpandMenu from "$lib/components/PreviewExpandMenu.svelte";
import WorkPublishDialog from "$lib/components/WorkPublishDialog.svelte";
import WorkspacePreviewPane from "$lib/components/WorkspacePreviewPane.svelte";
import type { WorkSurfaceHost } from "$lib/features/work/surface-host";
import { DURATION_PANEL, svelteEaseIn } from "$lib/motion.svelte";
import type { SpaceFsNode } from "$lib/space-fs";
import { patchCachedSpaceList } from "$lib/stores/space-list-cache";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";
import type { LocalUploadEntry } from "$lib/upload-entries";
import type { WorkspaceFileLinkTarget } from "$lib/workspace-file-links";
import BoardPreviewPanel from "./BoardPreviewPanel.svelte";
import type { InlineBoardPanelState } from "./board-preview-controller.svelte";
import FilesSidebarPanel from "./FilesSidebarPanel.svelte";
import type { FileWorkspaceInlineFile } from "./file-workspace-controller.svelte";
import InlineFilePanel from "./InlineFilePanel.svelte";
import PortPreviewPanel from "./PortPreviewPanel.svelte";
import PreviewTabs from "./PreviewTabs.svelte";
import type { PreviewTab } from "./preview-tabs";
import { workspaceFilePreviewKind } from "./preview-tabs";
import WorkPreviewPanel from "./WorkPreviewPanel.svelte";
import type { InlineWorkPreview } from "./work-preview-controller.svelte";

type PanHandlers = {
	start: (event: MouseEvent) => void;
};

type PublishTarget = {
	targetType: "file" | "directory" | "port";
	targetRef: string;
} | null;

export type SpaceFileDomainProps = {
	spaceId: string;
	spaceOwnerUsername: string | null;
	spaceSlug: string | null;
	spaceHasMinimalAccess: boolean;
	activeFsReadonly: boolean;
	canEditFiles: boolean;
	activeFsSidebarSubtitle: string;
	isMobile: boolean;
	isRightDrawerVisible: boolean;
	previewPanelWidth: number;
	previewFocusMode: boolean;
	previewImmersiveMode: boolean;
	rightSidebarCollapsed: boolean;
	rightSidebarWidth: number;
	rightDragOffsetPx: number;
	rightIsDragging: boolean;
	fileTree: SpaceFsNode[];
	fileTreeLoading: boolean;
	fileTreeError: string | null;
	selectedFilePath: string;
	inlineFile: FileWorkspaceInlineFile | null;
	inlineFileTabs: FileWorkspaceInlineFile[];
	activeInlineFilePath: string | null;
	inlineFileCanGoBack: boolean;
	inlineBoard: InlineBoardPanelState | null;
	inlineBoardTabs: InlineBoardPanelState[];
	activeInlineBoardPath: string | null;
	/** Display identities for board collaborator cursors and automation markers. */
	boardCollaborators?: Map<string, BoardCollaboratorProfile>;
	/** Recent CLI / Agent board transactions. */
	boardActivities?: BoardAutomationActivity[];
	onOpenBoardActivity?: (
		activity: BoardAutomationActivity,
	) => void | Promise<void>;
	inlinePortPreview: { port: string; url: string } | null;
	inlinePortTabs: { port: string; url: string }[];
	activeInlinePort: string | null;
	inlineWorkPreview: InlineWorkPreview | null;
	inlineWorkTabs: InlineWorkPreview[];
	activeInlineWorkId: string | null;
	activePreviewKind: "file" | "board" | "port" | "work" | null;
	inlinePortEndpoint: SpacePublicEndpoint | null;
	previewEndpoints: SpacePublicEndpoints;
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
	inlineFileCopied: boolean;
	inlineFileExt: string;
	inlineFileIsImage: boolean;
	inlineFileIsVideo: boolean;
	inlineFileIsAudio: boolean;
	inlineFileIsPdf: boolean;
	inlineFileDataUrl: string | null;
	inlineFileWork: WorkRecord | null;
	fileActionMenuOpenPath: string | null;
	inlineFileZoom: number;
	inlineFilePanX: number;
	inlineFilePanY: number;
	inlineFileDragging: boolean;
	inlineFilePanHandlers: PanHandlers;
	uploadPaneVisible: boolean;
	uploadPaneTargetDir: string;
	pendingUploadFiles: File[];
	pendingUploadEntries: LocalUploadEntry[];
	workPublishTarget: PublishTarget;
	onSpaceUpdated: (space: SpaceRecord) => void;
	onMobileRightDrawerClose: () => void;
	onSetUploadPaneVisible: (visible: boolean) => void;
	onToggleDirectory: (node: SpaceFsNode) => void | Promise<void>;
	onRefreshFileTree: () => void | Promise<void>;
	onCreateFile: (parentPath: string) => void | Promise<void>;
	onCreateBoard: (parentPath: string) => void | Promise<void>;
	onCreateDir: (parentPath: string) => void | Promise<void>;
	onRenameNode: (node: SpaceFsNode) => void | Promise<void>;
	onMoveNode: (node: SpaceFsNode, targetDir: string) => void | Promise<void>;
	onDeleteNode: (node: SpaceFsNode) => void | Promise<void>;
	onDownloadNode: (node: SpaceFsNode) => void | Promise<void>;
	onUploadFiles: (
		files: File[] | LocalUploadEntry[],
		targetDir: string,
	) => void;
	onInsertPathReference: (path: string) => void;
	onOpenInlineFile: (path: string) => void | Promise<void>;
	onOpenLinkedInlineFile: (
		target: string | WorkspaceFileLinkTarget,
	) => void | Promise<void>;
	onOpenInlineBoard: (path: string) => void | Promise<void>;
	onCloseInlineFile: () => void;
	onActivateInlineFile: (path: string) => void;
	onCloseInlineFileTab: (path: string) => void;
	onActivateInlineBoard: (path: string) => void;
	onCloseInlineBoardTab: (path: string) => void;
	onActivateInlinePort: (port: string) => void;
	onCloseInlinePortTab: (port: string) => void;
	onActivateInlineWork: (workId: string) => void;
	onCloseInlineWorkTab: (workId: string) => void;
	onRetryInlineWork: (workId: string) => void;
	onRegisterWorkSurface: (workId: string, host: WorkSurfaceHost | null) => void;
	onWorkComposerChip: (workId: string, chip: WorkComposerChip | null) => void;
	onBackInlineFile: () => void | Promise<void>;
	onDownloadInlineFile: () => void | Promise<void>;
	onRetryInlineFile?: () => void | Promise<void>;
	onCopyInlineFileContent: () => void | Promise<void>;
	onUpdateInlineFileDraft: (path: string, draft: string) => void;
	onRetryInlineFileSave: () => void | Promise<void>;
	onOverwriteInlineFile: () => void | Promise<void>;
	onReloadInlineFile: () => void | Promise<void>;
	onOpenInlinePort: (port: string, url: string) => void;
	onCommitInlineBoard: (
		boardId: string,
		path: string,
		document: BoardDocument,
		ops: BoardOperation[],
	) => void | Promise<void>;
	onRetryInlineBoardSave: (boardId: string) => void | Promise<void>;
	onBeginPreviewPanelResize: (event: PointerEvent) => void;
	onTogglePreviewFocusMode: () => void | Promise<void>;
	onTogglePreviewImmersiveMode: () => void | Promise<void>;
	onBeginRightSidebarResize: (event: PointerEvent) => void;
	treeVisible?: boolean;
	onToggleTree?: () => void;
	onEditResourceLabels: (
		type: "file",
		path: string,
		anchorEl?: HTMLElement | null,
	) => void | Promise<void>;
	onInsertFilePathReference: (path: string) => void;
	onGetFileActionNode: (path: string) => SpaceFsNode;
	onUploadComplete: () => void | Promise<void>;
	onOpenWorkPublish: (type: "file" | "directory" | "port", ref: string) => void;
	onCloseWorkPublish: () => void;
	onVisibleLinesChange?: (
		path: string,
		range: { start: number; end: number } | null,
	) => void;
	onBoardViewStateChange?: (state: {
		path: string;
		visibleRect: {
			x: number;
			y: number;
			width: number;
			height: number;
		} | null;
		selectedNodes: Array<{ id: string; type: string; title?: string }>;
	}) => void;
};

let {
	spaceId,
	spaceOwnerUsername,
	spaceSlug,
	spaceHasMinimalAccess,
	activeFsReadonly,
	canEditFiles,
	activeFsSidebarSubtitle,
	isMobile,
	isRightDrawerVisible,
	previewPanelWidth,
	previewFocusMode,
	previewImmersiveMode,
	rightSidebarCollapsed,
	rightSidebarWidth,
	rightDragOffsetPx,
	rightIsDragging,
	fileTree,
	fileTreeLoading,
	fileTreeError,
	selectedFilePath,
	inlineFile,
	inlineFileTabs,
	activeInlineFilePath,
	inlineFileCanGoBack,
	inlineBoard,
	inlineBoardTabs,
	activeInlineBoardPath,
	boardCollaborators,
	boardActivities,
	onOpenBoardActivity,
	inlinePortPreview,
	inlinePortTabs,
	activeInlinePort,
	inlineWorkPreview,
	inlineWorkTabs,
	activeInlineWorkId,
	activePreviewKind,
	inlinePortEndpoint,
	previewEndpoints,
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
	inlineFileCopied,
	inlineFileExt,
	inlineFileIsImage,
	inlineFileIsVideo,
	inlineFileIsAudio,
	inlineFileIsPdf,
	inlineFileDataUrl,
	inlineFileWork,
	fileActionMenuOpenPath = $bindable(),
	inlineFileZoom = $bindable(),
	inlineFilePanX = $bindable(),
	inlineFilePanY = $bindable(),
	inlineFileDragging,
	inlineFilePanHandlers,
	uploadPaneVisible,
	uploadPaneTargetDir,
	pendingUploadFiles,
	pendingUploadEntries,
	workPublishTarget = $bindable(),
	onSpaceUpdated,
	onMobileRightDrawerClose,
	onSetUploadPaneVisible,
	onToggleDirectory,
	onRefreshFileTree,
	onCreateFile,
	onCreateBoard,
	onCreateDir,
	onRenameNode,
	onMoveNode,
	onDeleteNode,
	onDownloadNode,
	onUploadFiles,
	onInsertPathReference,
	onOpenInlineFile,
	onOpenLinkedInlineFile,
	onOpenInlineBoard,
	onCloseInlineFile,
	onActivateInlineFile,
	onCloseInlineFileTab,
	onActivateInlineBoard,
	onCloseInlineBoardTab,
	onActivateInlinePort,
	onCloseInlinePortTab,
	onActivateInlineWork,
	onCloseInlineWorkTab,
	onRetryInlineWork,
	onRegisterWorkSurface,
	onWorkComposerChip,
	onBackInlineFile,
	onDownloadInlineFile,
	onRetryInlineFile,
	onCopyInlineFileContent,
	onUpdateInlineFileDraft,
	onRetryInlineFileSave,
	onOverwriteInlineFile,
	onReloadInlineFile,
	onOpenInlinePort,
	onCommitInlineBoard,
	onRetryInlineBoardSave,
	onBeginPreviewPanelResize,
	onTogglePreviewFocusMode,
	onTogglePreviewImmersiveMode,
	onBeginRightSidebarResize,
	treeVisible = true,
	onToggleTree,
	onEditResourceLabels,
	onInsertFilePathReference,
	onGetFileActionNode,
	onUploadComplete,
	onOpenWorkPublish,
	onCloseWorkPublish,
	onVisibleLinesChange,
	onBoardViewStateChange,
}: SpaceFileDomainProps = $props();

function closeMobileDrawerIfNeeded(mobile: boolean) {
	if (mobile) onMobileRightDrawerClose();
}

function publishInlineFile() {
	if (inlineFile?.response) onOpenWorkPublish("file", inlineFile.response.path);
}

function handleSpaceUpdated(nextSpace: SpaceRecord) {
	onSpaceUpdated(nextSpace);
	cacheSpaceRecordSoon(nextSpace);
	patchCachedSpaceList((items) =>
		items.map((item) => (item.id === spaceId ? nextSpace : item)),
	);
}
const previewTabs = $derived([
	...inlineFileTabs.map((tab) => ({
		kind: "file" as const,
		key: tab.path,
		label: tab.response?.name ?? tab.path.split("/").pop() ?? tab.path,
		title: tab.path,
		syncStatus: tab.syncStatus,
		active: activePreviewKind === "file" && tab.path === activeInlineFilePath,
	})),
	...inlineBoardTabs.map((tab) => ({
		kind: "board" as const,
		key: tab.path,
		label: tab.path.split("/").pop() ?? tab.path,
		title: tab.path,
		syncStatus: tab.saveError
			? ("error" as const)
			: tab.saving
				? ("saving" as const)
				: ("idle" as const),
		active: activePreviewKind === "board" && tab.path === activeInlineBoardPath,
	})),
	...inlinePortTabs.map((tab) => ({
		kind: "port" as const,
		key: tab.port,
		label: `:${tab.port}`,
		title: tab.url,
		syncStatus: "idle" as const,
		active: activePreviewKind === "port" && tab.port === activeInlinePort,
	})),
	...inlineWorkTabs.map((tab) => ({
		kind: "work" as const,
		key: tab.workId,
		label: tab.label,
		title: tab.detail?.publicUrl ?? tab.label,
		syncStatus: tab.error ? ("error" as const) : ("idle" as const),
		active: activePreviewKind === "work" && tab.workId === activeInlineWorkId,
	})),
]);

function activatePreviewTab(kind: PreviewTab["kind"], key: string) {
	if (kind === "file") onActivateInlineFile(key);
	else if (kind === "board") onActivateInlineBoard(key);
	else if (kind === "port") onActivateInlinePort(key);
	else onActivateInlineWork(key);
}

function closePreviewTab(kind: PreviewTab["kind"], key: string) {
	if (kind === "file") onCloseInlineFileTab(key);
	else if (kind === "board") onCloseInlineBoardTab(key);
	else if (kind === "port") onCloseInlinePortTab(key);
	else onCloseInlineWorkTab(key);
}

function previewContentOut(node: Element) {
	const reducedMotion =
		typeof window !== "undefined" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	return fade(node, {
		duration: isMobile || reducedMotion ? 0 : DURATION_PANEL,
		easing: svelteEaseIn,
	});
}
</script>

<WorkspacePreviewPane
	width={previewPanelWidth}
	ariaLabel="Workspace preview"
	onResizeStart={onBeginPreviewPanelResize}
	immersive={previewImmersiveMode}
	open={Boolean(activePreviewKind)}
>
	{#if activePreviewKind}
		<div
			class="relative flex h-full min-w-0 flex-col overflow-hidden"
			out:previewContentOut
		>
			{#if !isMobile && !previewImmersiveMode}
				<PreviewTabs
					tabs={previewTabs}
					onActivate={activatePreviewTab}
					onClose={closePreviewTab}
					{treeVisible}
					{onToggleTree}
				>
					{#snippet trailing()}
						<PreviewExpandMenu
							focused={previewFocusMode}
							immersive={previewImmersiveMode}
							size="sm"
							onToggleFocus={onTogglePreviewFocusMode}
							onToggleImmersive={onTogglePreviewImmersiveMode}
						/>
					{/snippet}
				</PreviewTabs>
			{/if}
			<div class="relative min-h-0 flex-1">
{#if activePreviewKind === "file" && inlineFile}
		<InlineFilePanel
		{inlineFile}
		{previewTabs}
		{treeVisible}
		{onToggleTree}
		onActivatePreviewTab={activatePreviewTab}
		onClosePreviewTab={closePreviewTab}
		{inlineFileCanGoBack}
		{inlineFileDownloadUrl}
		{inlineFileDownloadName}
		{inlineFileIsText}
		{inlineFileHasRenderedPreview}
		bind:inlineFileViewMode
		{inlineFileDiff}
		{inlineFileDiffLoading}
		{inlineFileDiffError}
		{inlineFileIsMarkdown}
		{inlineFileIsCsv}
		{inlineFileIsHtml}
		{activeFsReadonly}
		{canEditFiles}
		{inlineFileCopied}
		{inlineFileExt}
		{inlineFileIsImage}
		{inlineFileIsVideo}
		{inlineFileIsAudio}
		{inlineFileIsPdf}
		{inlineFileDataUrl}
		inlineFileSpaceId={spaceId}
		{inlineFileWork}
		previewImmersiveMode={previewImmersiveMode}
		{isMobile}
		bind:fileActionMenuOpenPath
		bind:inlineFileZoom
		bind:inlineFilePanX
		bind:inlineFilePanY
		{inlineFileDragging}
		{inlineFilePanHandlers}
		onCloseInlineFile={onCloseInlineFile}
		onBackInlineFile={onBackInlineFile}
		onOpenLinkedInlineFile={onOpenLinkedInlineFile}
		onDownloadInlineFile={onDownloadInlineFile}
		onRetryInlineFile={onRetryInlineFile}
		onCopyInlineFileContent={onCopyInlineFileContent}
		onUpdateInlineFileDraft={onUpdateInlineFileDraft}
		onRetryInlineFileSave={onRetryInlineFileSave}
		onOverwriteInlineFile={onOverwriteInlineFile}
		onReloadInlineFile={onReloadInlineFile}
		onPublishInlineFile={publishInlineFile}
		onTogglePreviewImmersiveMode={onTogglePreviewImmersiveMode}
		onLabelFile={(path: string, anchorEl?: HTMLElement | null) =>
			onEditResourceLabels("file", path, anchorEl)}
		onInsertFilePathReference={onInsertFilePathReference}
		onDownloadFilePath={(path: string) => onDownloadNode(onGetFileActionNode(path))}
		onRenameFilePath={(path: string) => onRenameNode(onGetFileActionNode(path))}
		onDeleteFilePath={(path: string) => onDeleteNode(onGetFileActionNode(path))}
		onVisibleLinesChange={onVisibleLinesChange}
		/>
{/if}

{#if inlineBoard}
	<div
		class="h-full min-h-0"
		hidden={activePreviewKind !== "board"}
		inert={activePreviewKind !== "board"}
		aria-hidden={activePreviewKind !== "board"}
	>
		<BoardPreviewPanel
		board={inlineBoard}
		previewTabs={previewTabs}
		spaceId={spaceId}
		active={activePreviewKind === "board"}
		{treeVisible}
		{onToggleTree}
		onActivatePreviewTab={activatePreviewTab}
		onClosePreviewTab={closePreviewTab}
		immersive={previewImmersiveMode}
		{isMobile}
		collaborators={boardCollaborators}
		activities={boardActivities}
		onOpenActivity={onOpenBoardActivity}
		onToggleImmersive={onTogglePreviewImmersiveMode}
		onCommit={onCommitInlineBoard}
		onRetrySave={onRetryInlineBoardSave}
		onViewStateChange={onBoardViewStateChange}
		onOpenFile={onOpenInlineFile}
		/>
	</div>
{/if}

{#if activePreviewKind === "port" && inlinePortPreview}
		<PortPreviewPanel
		previewTabs={previewTabs}
		{treeVisible}
		{onToggleTree}
		onActivatePreviewTab={activatePreviewTab}
		onClosePreviewTab={closePreviewTab}
		port={inlinePortPreview.port}
		url={inlinePortEndpoint?.url ?? inlinePortPreview.url}
		status={inlinePortEndpoint?.status ?? "unknown"}
		observedAt={inlinePortEndpoint?.observedAt}
		immersive={previewImmersiveMode}
		{isMobile}
		onToggleImmersive={onTogglePreviewImmersiveMode}
		onPublish={() => onOpenWorkPublish("port", inlinePortPreview!.port)}
		/>
{/if}

{#if activePreviewKind === "work" && inlineWorkPreview}
	<WorkPreviewPanel
		preview={inlineWorkPreview}
		{previewTabs}
		{treeVisible}
		{onToggleTree}
		onActivatePreviewTab={activatePreviewTab}
		onClosePreviewTab={closePreviewTab}
		immersive={previewImmersiveMode}
		{isMobile}
		onToggleImmersive={onTogglePreviewImmersiveMode}
		onRetry={onRetryInlineWork}
		onRegisterSurface={onRegisterWorkSurface}
		onComposerChip={onWorkComposerChip}
	/>
{/if}
			</div>
		</div>
	{/if}
</WorkspacePreviewPane>

<FilesSidebarPanel
	{spaceId}
	nodes={spaceHasMinimalAccess ? [] : fileTree}
	selectedPath={selectedFilePath}
	loading={!spaceHasMinimalAccess && fileTreeLoading}
	error={spaceHasMinimalAccess
		? "Files are not available for this shared session."
		: fileTreeError}
	subtitle={activeFsSidebarSubtitle}
	activePort={spaceHasMinimalAccess || activePreviewKind !== "port"
		? null
		: activeInlinePort}
	canWrite={!spaceHasMinimalAccess && canEditFiles && !activeFsReadonly}
	showItemActions={!spaceHasMinimalAccess && !activeFsReadonly}
	draggable={!spaceHasMinimalAccess}
	previewEndpoints={spaceHasMinimalAccess ? {} : previewEndpoints}
	desktopCollapsed={rightSidebarCollapsed}
	desktopFloating={previewImmersiveMode}
	desktopWidth={rightSidebarWidth}
	{rightDragOffsetPx}
	{rightIsDragging}
	isDrawerVisible={isRightDrawerVisible}
	{uploadPaneVisible}
	{uploadPaneTargetDir}
	{pendingUploadFiles}
	{pendingUploadEntries}
	onToggle={onToggleDirectory}
	onSelect={(node, options) => {
		if (node.type !== "file") return;
		if (workspaceFilePreviewKind(node.path, activeFsReadonly) === "board")
			void onOpenInlineBoard(node.path);
		else void onOpenInlineFile(node.path);
		closeMobileDrawerIfNeeded(options.mobile);
	}}
	onRefresh={onRefreshFileTree}
	onCreateFile={onCreateFile}
	onCreateBoard={onCreateBoard}
	onCreateDir={onCreateDir}
	onRename={onRenameNode}
	onMove={onMoveNode}
	onDelete={onDeleteNode}
	onDownload={onDownloadNode}
	onUpload={onUploadFiles}
	onInsertReference={onInsertPathReference}
	onPublishDirectory={(path, options) => {
		onOpenWorkPublish("directory", path);
		closeMobileDrawerIfNeeded(options.mobile);
	}}
	onOpenPort={(port, url, options) => {
		onOpenInlinePort(port, url);
		closeMobileDrawerIfNeeded(options.mobile);
	}}
	onUploadPaneClose={() => onSetUploadPaneVisible(false)}
	onUploadComplete={onUploadComplete}
	onResizeStart={onBeginRightSidebarResize}
/>

<WorkPublishDialog
	open={Boolean(workPublishTarget)}
	{spaceId}
	ownerUsername={spaceOwnerUsername}
	{spaceSlug}
	targetType={workPublishTarget?.targetType ?? "file"}
	targetRef={workPublishTarget?.targetRef ?? ""}
	onSpaceUpdated={handleSpaceUpdated}
	onClose={onCloseWorkPublish}
/>
