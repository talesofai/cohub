<script lang="ts">
import type {
	SpacePublicEndpoint,
	SpacePublicEndpoints,
} from "@cohub/protocol/ports";
import type {
	CanvasSemanticOp,
	SpaceRecord,
	WorkRecord,
} from "@neta-art/cohub";
import { isCovasFile } from "$lib/canvas/canvas-file";
import type { CovasDocument } from "$lib/canvas/canvas-schema";
import WorkPublishDialog from "$lib/components/WorkPublishDialog.svelte";
import { isTextFileResponse } from "$lib/space-file-text";
import type { SpaceFsNode } from "$lib/space-fs";
import { patchCachedSpaceList } from "$lib/stores/space-list-cache";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";
import type { LocalUploadEntry } from "$lib/upload-entries";
import type { WorkspaceFileLinkTarget } from "$lib/workspace-file-links";
import CanvasPreviewPanel from "./CanvasPreviewPanel.svelte";
import type { InlineCanvasPanelState } from "./canvas-preview-controller.svelte";
import FilesSidebarPanel from "./FilesSidebarPanel.svelte";
import type { FileWorkspaceInlineFile } from "./file-workspace-controller.svelte";
import InlineFilePanel from "./InlineFilePanel.svelte";
import PortPreviewPanel from "./PortPreviewPanel.svelte";

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
	inlineCanvas: InlineCanvasPanelState | null;
	inlineCanvasTabs: InlineCanvasPanelState[];
	activeInlineCanvasPath: string | null;
	inlinePortPreview: { port: string; url: string } | null;
	inlinePortTabs: { port: string; url: string }[];
	activeInlinePort: string | null;
	activePreviewKind: "file" | "canvas" | "port" | null;
	inlinePortEndpoint: SpacePublicEndpoint | null;
	previewEndpoints: SpacePublicEndpoints;
	inlineFileDownloadUrl: string;
	inlineFileDownloadName: string;
	inlineFileIsText: boolean;
	inlineFileHasRenderedPreview: boolean;
	inlineFileEdit: boolean;
	inlineFileIsMarkdown: boolean;
	inlineFileIsHtml: boolean;
	inlineFileDirty: boolean;
	inlineFileCopied: boolean;
	inlineFileExt: string;
	inlineFileIsImage: boolean;
	inlineFileIsVideo: boolean;
	inlineFileDataUrl: string | null;
	inlineFileDebugWork: WorkRecord | null;
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
	onCreateCanvas: (parentPath: string) => void | Promise<void>;
	onCreateDir: (parentPath: string) => void | Promise<void>;
	onRenameNode: (node: SpaceFsNode) => void | Promise<void>;
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
	onOpenInlineCanvas: (path: string) => void | Promise<void>;
	onCloseInlineFile: () => void;
	onActivateInlineFile: (path: string) => void;
	onCloseInlineFileTab: (path: string) => void;
	onActivateInlineCanvas: (path: string) => void;
	onCloseInlineCanvasTab: (path: string) => void;
	onActivateInlinePort: (port: string) => void;
	onCloseInlinePortTab: (port: string) => void;
	onBackInlineFile: () => void | Promise<void>;
	onDownloadInlineFile: () => void | Promise<void>;
	onCopyInlineFileContent: () => void | Promise<void>;
	onSaveInlineFile: () => void | Promise<void>;
	onOpenInlinePort: (port: string, url: string) => void;
	onCloseInlinePort: () => void;
	onCommitInlineCanvas: (
		document: CovasDocument,
		ops: CanvasSemanticOp[],
	) => void | Promise<void>;
	onCloseInlineCanvas: () => void;
	onBeginPreviewPanelResize: (event: PointerEvent) => void;
	onTogglePreviewFocusMode: () => void | Promise<void>;
	onTogglePreviewImmersiveMode: () => void | Promise<void>;
	onBeginRightSidebarResize: (event: PointerEvent) => void;
	onEditResourceLabels: (type: "file", path: string) => void | Promise<void>;
	onInsertFilePathReference: (path: string) => void;
	onGetFileActionNode: (path: string) => SpaceFsNode;
	onUploadComplete: () => void | Promise<void>;
	onOpenWorkPublish: (type: "file" | "directory" | "port", ref: string) => void;
	onCloseWorkPublish: () => void;
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
	inlineCanvas,
	inlineCanvasTabs,
	activeInlineCanvasPath,
	inlinePortPreview,
	inlinePortTabs,
	activeInlinePort,
	activePreviewKind,
	inlinePortEndpoint,
	previewEndpoints,
	inlineFileDownloadUrl,
	inlineFileDownloadName,
	inlineFileIsText,
	inlineFileHasRenderedPreview,
	inlineFileEdit = $bindable(),
	inlineFileIsMarkdown,
	inlineFileIsHtml,
	inlineFileDirty,
	inlineFileCopied,
	inlineFileExt,
	inlineFileIsImage,
	inlineFileIsVideo,
	inlineFileDataUrl,
	inlineFileDebugWork,
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
	onCreateCanvas,
	onCreateDir,
	onRenameNode,
	onDeleteNode,
	onDownloadNode,
	onUploadFiles,
	onInsertPathReference,
	onOpenInlineFile,
	onOpenLinkedInlineFile,
	onOpenInlineCanvas,
	onCloseInlineFile,
	onActivateInlineFile,
	onCloseInlineFileTab,
	onActivateInlineCanvas,
	onCloseInlineCanvasTab,
	onActivateInlinePort,
	onCloseInlinePortTab,
	onBackInlineFile,
	onDownloadInlineFile,
	onCopyInlineFileContent,
	onSaveInlineFile,
	onOpenInlinePort,
	onCloseInlinePort,
	onCommitInlineCanvas,
	onCloseInlineCanvas,
	onBeginPreviewPanelResize,
	onTogglePreviewFocusMode,
	onTogglePreviewImmersiveMode,
	onBeginRightSidebarResize,
	onEditResourceLabels,
	onInsertFilePathReference,
	onGetFileActionNode,
	onUploadComplete,
	onOpenWorkPublish,
	onCloseWorkPublish,
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
		dirty: Boolean(
			tab.response &&
				isTextFileResponse(tab.response) &&
				tab.draft !== tab.response.content,
		),
		active: activePreviewKind === "file" && tab.path === activeInlineFilePath,
	})),
	...inlineCanvasTabs.map((tab) => ({
		kind: "canvas" as const,
		key: tab.path,
		label: tab.path.split("/").pop() ?? tab.path,
		title: tab.path,
		dirty: tab.saving,
		active:
			activePreviewKind === "canvas" && tab.path === activeInlineCanvasPath,
	})),
	...inlinePortTabs.map((tab) => ({
		kind: "port" as const,
		key: tab.port,
		label: `:${tab.port}`,
		title: tab.url,
		dirty: false,
		active: activePreviewKind === "port" && tab.port === activeInlinePort,
	})),
]);

function activatePreviewTab(kind: "file" | "canvas" | "port", key: string) {
	if (kind === "file") onActivateInlineFile(key);
	else if (kind === "canvas") onActivateInlineCanvas(key);
	else onActivateInlinePort(key);
}

function closePreviewTab(kind: "file" | "canvas" | "port", key: string) {
	if (kind === "file") onCloseInlineFileTab(key);
	else if (kind === "canvas") onCloseInlineCanvasTab(key);
	else onCloseInlinePortTab(key);
}
</script>

{#if activePreviewKind === "file" && inlineFile}
	<InlineFilePanel
		{inlineFile}
		{previewTabs}
		onActivatePreviewTab={activatePreviewTab}
		onClosePreviewTab={closePreviewTab}
		{inlineFileCanGoBack}
		{inlineFileDownloadUrl}
		{inlineFileDownloadName}
		{inlineFileIsText}
		{inlineFileHasRenderedPreview}
		bind:inlineFileEdit
		{inlineFileIsMarkdown}
		{inlineFileIsHtml}
		{inlineFileDirty}
		{activeFsReadonly}
		{canEditFiles}
		{inlineFileCopied}
		{inlineFileExt}
		{inlineFileIsImage}
		{inlineFileIsVideo}
		{inlineFileDataUrl}
		inlineFileSpaceId={spaceId}
		{inlineFileDebugWork}
		previewPanelWidth={previewPanelWidth}
		previewFocusMode={previewFocusMode}
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
		onCopyInlineFileContent={onCopyInlineFileContent}
		onSaveInlineFile={onSaveInlineFile}
		onPublishInlineFile={publishInlineFile}
		onPreviewResizeStart={onBeginPreviewPanelResize}
		onTogglePreviewFocusMode={onTogglePreviewFocusMode}
		onTogglePreviewImmersiveMode={onTogglePreviewImmersiveMode}
		onLabelFile={(path) => onEditResourceLabels("file", path)}
		onInsertFilePathReference={onInsertFilePathReference}
		onDownloadFilePath={(path) => onDownloadNode(onGetFileActionNode(path))}
		onRenameFilePath={(path) => onRenameNode(onGetFileActionNode(path))}
		onDeleteFilePath={(path) => onDeleteNode(onGetFileActionNode(path))}
	/>
{/if}

{#if activePreviewKind === "canvas" && inlineCanvas}
	<CanvasPreviewPanel
		canvas={inlineCanvas}
		previewTabs={previewTabs}
		onActivatePreviewTab={activatePreviewTab}
		onClosePreviewTab={closePreviewTab}
		width={previewPanelWidth}
		focused={previewFocusMode}
		immersive={previewImmersiveMode}
		{isMobile}
		onResizeStart={onBeginPreviewPanelResize}
		onToggleFocus={onTogglePreviewFocusMode}
		onToggleImmersive={onTogglePreviewImmersiveMode}
		onCommit={onCommitInlineCanvas}
		onClose={onCloseInlineCanvas}
	/>
{/if}

{#if activePreviewKind === "port" && inlinePortPreview}
	<PortPreviewPanel
		previewTabs={previewTabs}
		onActivatePreviewTab={activatePreviewTab}
		onClosePreviewTab={closePreviewTab}
		port={inlinePortPreview.port}
		url={inlinePortEndpoint?.url ?? inlinePortPreview.url}
		status={inlinePortEndpoint?.status ?? "unknown"}
		observedAt={inlinePortEndpoint?.observedAt}
		width={previewPanelWidth}
		focused={previewFocusMode}
		immersive={previewImmersiveMode}
		{isMobile}
		onResizeStart={onBeginPreviewPanelResize}
		onToggleFocus={onTogglePreviewFocusMode}
		onToggleImmersive={onTogglePreviewImmersiveMode}
		onPublish={() => onOpenWorkPublish("port", inlinePortPreview!.port)}
		onClose={onCloseInlinePort}
	/>
{/if}

<FilesSidebarPanel
	{spaceId}
	nodes={spaceHasMinimalAccess ? [] : fileTree}
	selectedPath={selectedFilePath}
	loading={!spaceHasMinimalAccess && fileTreeLoading}
	error={spaceHasMinimalAccess
		? "Files are not available for this shared session."
		: fileTreeError}
	subtitle={activeFsSidebarSubtitle}
	activePort={spaceHasMinimalAccess ? null : (inlinePortPreview?.port ?? null)}
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
		if (isCovasFile(node.path) && !activeFsReadonly) void onOpenInlineCanvas(node.path);
		else void onOpenInlineFile(node.path);
		closeMobileDrawerIfNeeded(options.mobile);
	}}
	onRefresh={onRefreshFileTree}
	onCreateFile={onCreateFile}
	onCreateCanvas={onCreateCanvas}
	onCreateDir={onCreateDir}
	onRename={onRenameNode}
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
