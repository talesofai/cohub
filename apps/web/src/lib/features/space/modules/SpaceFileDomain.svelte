<script lang="ts">
import type { AppNavigationOpenMessage } from "@cohub/protocol/app-navigation";
import type { AppComposerChip } from "@cohub/protocol/app-surface";
import type {
	SpacePublicEndpoint,
	SpacePublicEndpoints,
} from "@cohub/protocol/ports";
import type {
	AppRecord,
	AppRuntimeShellContext,
	SpacePendingDiffFileResponse,
	SpaceRecord,
} from "@neta-art/cohub";
import type { BoardDocument } from "@neta-art/cohub/board";
import { fade } from "svelte/transition";
import type {
	BoardAutomationActivity,
	BoardCollaboratorProfile,
} from "$lib/board/board-activity";
import AppPublishDialog from "$lib/components/AppPublishDialog.svelte";
import type { FileViewMode } from "$lib/components/file-diff-view";
import PreviewExpandMenu from "$lib/components/PreviewExpandMenu.svelte";
import WorkspaceWindowsPane from "$lib/components/WorkspaceWindowsPane.svelte";
import type { AppSurfaceHost } from "$lib/features/app/surface-host";
import { DURATION_PANEL, svelteEaseIn } from "$lib/motion.svelte";
import type { SpaceFsNode } from "$lib/space-fs";
import { patchCachedSpaceList } from "$lib/stores/space-list-cache";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";
import type { LocalUploadEntry } from "$lib/upload-entries";
import type { ResolveWorkspaceAsset } from "$lib/workspace-assets";
import type { WorkspaceFileLinkTarget } from "$lib/workspace-file-links";
import AppWindow from "./AppWindow.svelte";
import type { InlineAppPreview } from "./app-window-controller.svelte";
import BoardWindow from "./BoardWindow.svelte";
import type { InlineBoardPanelState } from "./board-window-controller.svelte";
import FilesSidebarPanel from "./FilesSidebarPanel.svelte";
import type { FileWorkspaceInlineFile } from "./file-workspace-controller.svelte";
import InlineFilePanel from "./InlineFilePanel.svelte";
import PortWindow from "./PortWindow.svelte";
import WindowTabs from "./WindowTabs.svelte";
import type { Window } from "./windows";
import { workspaceFilePreviewKind } from "./windows";

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
	inlineAppPreview: InlineAppPreview | null;
	inlineAppTabs: InlineAppPreview[];
	appShell: AppRuntimeShellContext;
	activeInlineAppId: string | null;
	activeWindowKind: "file" | "board" | "port" | "app" | null;
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
	inlineFileApp: AppRecord | null;
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
	appPublishTarget: PublishTarget;
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
	resolveWorkspaceAsset: ResolveWorkspaceAsset;
	onOpenInlineBoard: (path: string) => void | Promise<void>;
	onOpenTask: (taskRunId: string) => void | Promise<void>;
	onCloseInlineFile: () => void;
	onActivateInlineFile: (path: string) => void;
	onCloseInlineFileTab: (path: string) => void;
	onActivateInlineBoard: (path: string) => void;
	onCloseInlineBoardTab: (path: string) => void;
	onActivateInlinePort: (port: string) => void;
	onCloseInlinePortTab: (port: string) => void;
	onActivateInlineApp: (appId: string) => void;
	onCloseInlineAppTab: (appId: string) => void;
	onRetryInlineApp: (appId: string) => void;
	onRegisterAppSurface: (appId: string, host: AppSurfaceHost | null) => void;
	onAppComposerChip: (appId: string, chip: AppComposerChip | null) => void;
	onNavigationOpen?: (message: AppNavigationOpenMessage) => Promise<{
		handled: boolean;
		reason?: "unsupported" | "invalid_target" | "inaccessible" | "timeout";
		call?:
			| { ok: true; result?: unknown }
			| { ok: false; code: string; message: string };
	}>;
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
		before: BoardDocument,
		commands: import("@neta-art/cohub").BoardSemanticCommand[],
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
	onOpenAppPublish: (type: "file" | "directory" | "port", ref: string) => void;
	onOpenMarketplace: () => void;
	onOpenInstalledApp: (app: import("@cohub/protocol").InstalledApp) => void;
	onCloseAppPublish: () => void;
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
	inlineAppPreview,
	inlineAppTabs,
	appShell,
	activeInlineAppId,
	activeWindowKind,
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
	inlineFileApp,
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
	appPublishTarget = $bindable(),
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
	resolveWorkspaceAsset,
	onOpenInlineBoard,
	onOpenTask,
	onCloseInlineFile,
	onActivateInlineFile,
	onCloseInlineFileTab,
	onActivateInlineBoard,
	onCloseInlineBoardTab,
	onActivateInlinePort,
	onCloseInlinePortTab,
	onActivateInlineApp,
	onCloseInlineAppTab,
	onRetryInlineApp,
	onRegisterAppSurface,
	onAppComposerChip,
	onNavigationOpen = undefined,
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
	onOpenAppPublish,
	onOpenMarketplace,
	onOpenInstalledApp,
	onCloseAppPublish,
	onVisibleLinesChange,
	onBoardViewStateChange,
}: SpaceFileDomainProps = $props();

function closeMobileDrawerIfNeeded(mobile: boolean) {
	if (mobile) onMobileRightDrawerClose();
}

function publishInlineFile() {
	if (inlineFile?.response) onOpenAppPublish("file", inlineFile.response.path);
}

function handleSpaceUpdated(nextSpace: SpaceRecord) {
	onSpaceUpdated(nextSpace);
	cacheSpaceRecordSoon(nextSpace);
	patchCachedSpaceList((items) =>
		items.map((item) => (item.id === spaceId ? nextSpace : item)),
	);
}
const windows = $derived([
	...inlineFileTabs.map((tab) => ({
		kind: "file" as const,
		key: tab.path,
		label: tab.response?.name ?? tab.path.split("/").pop() ?? tab.path,
		title: tab.path,
		syncStatus: tab.syncStatus,
		active: activeWindowKind === "file" && tab.path === activeInlineFilePath,
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
		active: activeWindowKind === "board" && tab.path === activeInlineBoardPath,
	})),
	...inlinePortTabs.map((tab) => ({
		kind: "port" as const,
		key: tab.port,
		label: `:${tab.port}`,
		title: tab.url,
		syncStatus: "idle" as const,
		active: activeWindowKind === "port" && tab.port === activeInlinePort,
	})),
	...inlineAppTabs.map((tab) => ({
		kind: "app" as const,
		key: tab.appId,
		label: tab.label,
		title: tab.detail?.publicUrl ?? tab.label,
		syncStatus: tab.error ? ("error" as const) : ("idle" as const),
		active: activeWindowKind === "app" && tab.appId === activeInlineAppId,
	})),
]);

function activateWindow(kind: Window["kind"], key: string) {
	if (kind === "file") onActivateInlineFile(key);
	else if (kind === "board") onActivateInlineBoard(key);
	else if (kind === "port") onActivateInlinePort(key);
	else onActivateInlineApp(key);
}

function closeWindow(kind: Window["kind"], key: string) {
	if (kind === "file") onCloseInlineFileTab(key);
	else if (kind === "board") onCloseInlineBoardTab(key);
	else if (kind === "port") onCloseInlinePortTab(key);
	else onCloseInlineAppTab(key);
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

<WorkspaceWindowsPane
	width={previewPanelWidth}
	ariaLabel="Workspace preview"
	onResizeStart={onBeginPreviewPanelResize}
	immersive={previewImmersiveMode}
	open={Boolean(activeWindowKind)}
>
	{#if windows.length > 0}
		<div
			class="relative flex h-full min-w-0 flex-col overflow-hidden"
			hidden={!activeWindowKind}
			inert={!activeWindowKind}
			aria-hidden={!activeWindowKind}
			out:previewContentOut
		>
			{#if !isMobile && !previewImmersiveMode}
				<WindowTabs
					tabs={windows}
					onActivate={activateWindow}
					onClose={closeWindow}
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
				</WindowTabs>
			{/if}
			<div class="relative min-h-0 flex-1">
{#if inlineFile}
	<div
		class="h-full min-h-0"
		hidden={activeWindowKind !== "file"}
		inert={activeWindowKind !== "file"}
		aria-hidden={activeWindowKind !== "file"}
	>
		<InlineFilePanel
		{inlineFile}
		{windows}
		{treeVisible}
		{onToggleTree}
		onActivateWindow={activateWindow}
		onCloseWindow={closeWindow}
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
		{inlineFileApp}
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
		{resolveWorkspaceAsset}
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
	</div>
{/if}

{#if inlineBoard}
	<div
		class="h-full min-h-0"
		hidden={activeWindowKind !== "board"}
		inert={activeWindowKind !== "board"}
		aria-hidden={activeWindowKind !== "board"}
	>
		<BoardWindow
		board={inlineBoard}
		windows={windows}
		spaceId={spaceId}
		shell={appShell}
		onNavigationOpen={onNavigationOpen}
		active={activeWindowKind === "board"}
		{treeVisible}
		{onToggleTree}
		onActivateWindow={activateWindow}
		onCloseWindow={closeWindow}
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
		onOpenTask={onOpenTask}
		/>
	</div>
{/if}

{#if inlinePortPreview}
	<div
		class="h-full min-h-0"
		hidden={activeWindowKind !== "port"}
		inert={activeWindowKind !== "port"}
		aria-hidden={activeWindowKind !== "port"}
	>
		<PortWindow
		windows={windows}
		{treeVisible}
		{onToggleTree}
		onActivateWindow={activateWindow}
		onCloseWindow={closeWindow}
		port={inlinePortPreview.port}
		url={inlinePortEndpoint?.url ?? inlinePortPreview.url}
		status={inlinePortEndpoint?.status ?? "unknown"}
		observedAt={inlinePortEndpoint?.observedAt}
		immersive={previewImmersiveMode}
		{isMobile}
		onToggleImmersive={onTogglePreviewImmersiveMode}
		onPublish={() => onOpenAppPublish("port", inlinePortPreview!.port)}
		/>
	</div>
{/if}

{#if inlineAppPreview}
	<div
		class="h-full min-h-0"
		hidden={activeWindowKind !== "app"}
		inert={activeWindowKind !== "app"}
		aria-hidden={activeWindowKind !== "app"}
	>
	<AppWindow
		preview={inlineAppPreview}
		shell={appShell}
		{windows}
		{treeVisible}
		{onToggleTree}
		onActivateWindow={activateWindow}
		onCloseWindow={closeWindow}
		immersive={previewImmersiveMode}
		{isMobile}
		onToggleImmersive={onTogglePreviewImmersiveMode}
		onRetry={onRetryInlineApp}
		onRegisterSurface={onRegisterAppSurface}
		onComposerChip={onAppComposerChip}
		onNavigationOpen={onNavigationOpen}
	/>
	</div>
{/if}
			</div>
		</div>
	{/if}
</WorkspaceWindowsPane>

<FilesSidebarPanel
	{spaceId}
	nodes={spaceHasMinimalAccess ? [] : fileTree}
	selectedPath={selectedFilePath}
	loading={!spaceHasMinimalAccess && fileTreeLoading}
	error={spaceHasMinimalAccess
		? "Files are not available for this shared session."
		: fileTreeError}
	subtitle={activeFsSidebarSubtitle}
	activePort={spaceHasMinimalAccess || activeWindowKind !== "port"
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
		onOpenAppPublish("directory", path);
		closeMobileDrawerIfNeeded(options.mobile);
	}}
	onOpenPort={(port, url, options) => {
		onOpenInlinePort(port, url);
		closeMobileDrawerIfNeeded(options.mobile);
	}}
	onUploadPaneClose={() => onSetUploadPaneVisible(false)}
	onUploadComplete={onUploadComplete}
	onResizeStart={onBeginRightSidebarResize}
	onOpenMarketplace={onOpenMarketplace}
	onOpenInstalledApp={onOpenInstalledApp}
/>

<AppPublishDialog
	open={Boolean(appPublishTarget)}
	{spaceId}
	ownerUsername={spaceOwnerUsername}
	{spaceSlug}
	targetType={appPublishTarget?.targetType ?? "file"}
	targetRef={appPublishTarget?.targetRef ?? ""}
	onSpaceUpdated={handleSpaceUpdated}
	onClose={onCloseAppPublish}
/>
