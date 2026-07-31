<script lang="ts">
import type { SpaceFsChangedPayload } from "@cohub/protocol/fs";
import type { ChannelEnvelope } from "@cohub/protocol/realtime";
import type {
	BoardOperation,
	Permission,
	SpaceRecord,
	TaskRunRecord,
	UserProfile,
	WorkRecord,
} from "@neta-art/cohub";
import type { BoardDocument } from "@neta-art/cohub/board";
import {
	Check,
	Copy,
	Download,
	ListTree,
	MoreHorizontal,
	Pencil,
	TextCursorInput,
	Trash2,
	X,
} from "lucide-svelte";
import { onDestroy, onMount, tick, untrack } from "svelte";
import {
	beforeNavigate,
	goto,
	onNavigate,
	pushState,
	replaceState,
} from "$app/navigation";
import { page } from "$app/state";
import {
	type AccessState,
	isBlockingAccessState,
} from "$lib/access/access-state";
import { floatNear } from "$lib/actions/portal";
import type {
	BoardAutomationActivity,
	BoardCollaboratorProfile,
} from "$lib/board/board-activity";
import { invalidateFilePreview } from "$lib/board/board-file-preview-source";
import { spaceFsRepo } from "$lib/cache/repositories/space-fs-repo";
import { spaceRecordRepo } from "$lib/cache/repositories/space-record-repo";
import {
	createSpaceFsRefreshCoordinator,
	type SpaceFsRefreshBatch,
} from "$lib/cache/space-fs-refresh-coordinator";
import { reconcileSpaceFsSequence } from "$lib/cache/space-fs-sequence";
import AccessStateView from "$lib/components/AccessStateView.svelte";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import ResourceLabelPicker from "$lib/components/ResourceLabelPicker.svelte";
import UserIdentity from "$lib/components/UserIdentity.svelte";
import { createDeferredMount } from "$lib/deferred-mount.svelte";
import {
	createSessionChatHost,
	getSessionTitle,
	subscribeSpaceChannel,
} from "$lib/features/session-chat";
import SessionChatPanel from "$lib/features/session-chat/SessionChatPanel.svelte";
import {
	createWorkMutationBuffer,
	dispatchWorksChanged,
	parseWorkVersionPublished,
	upsertWorkSnapshot,
} from "$lib/features/work/work-realtime";
// SettingsOverlay removed — settings merged inline into detail page
import { isComposingKeyboardEvent } from "$lib/keyboard";
import {
	parseResourceLabelRealtimePayload,
	syncResourceLabelsToCache,
} from "$lib/labels/resource-label-cache-sync";
import {
	COMPACT_SHELL_MAX_WIDTH_PX,
	DESKTOP_SHELL_MIN_WIDTH_PX,
} from "$lib/layout/breakpoints";
import { DURATION_PANEL } from "$lib/motion.svelte";
import { sdk } from "$lib/sdk";
import {
	activateSpaceConfig,
	deactivateSpaceConfig,
	isSpaceConfigPath,
	refreshSpaceConfig,
	type SpaceConfig,
	subscribeSpaceConfig,
	subscribeSpaceConfigBackgroundAction,
} from "$lib/space-config";
import type { SpaceFsNode } from "$lib/space-fs";
import {
	buildSpaceNewSessionRoute,
	buildSpaceSessionRoute,
} from "$lib/space-routes";
import {
	activateSpaceStyle,
	deactivateSpaceStyle,
	isSpaceStylePath,
	refreshSpaceStyle,
} from "$lib/space-style";
import { authStore } from "$lib/stores/auth.svelte";
import { insertComposerSnippet } from "$lib/stores/composer-insert";
import {
	getCachedSessionListSnapshot,
	onSessionListCacheUpdated,
} from "$lib/stores/session-list-cache";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";
import {
	IMMERSIVE_CHAT_MAX,
	IMMERSIVE_CHAT_MIN,
	RIGHT_SIDEBAR_MAX,
	RIGHT_SIDEBAR_MIN,
	uiState,
} from "$lib/stores/ui.svelte";
import type { LocalUploadEntry } from "$lib/upload-entries";
import type { WorkspaceFileLinkTarget } from "$lib/workspace-file-links";
import { resolveWorkspaceSpaceId } from "$lib/workspace-route";
import { createBoardPreviewController } from "./modules/board-preview-controller.svelte";
import { createFileWorkspaceController } from "./modules/file-workspace-controller.svelte";
import {
	FLOAT_CHAT_EDGE_GAP,
	FLOAT_PANEL_GAP,
	FLOAT_PREVIEW_MIN_WIDTH,
	floatPanelsFit,
} from "./modules/float-layout";
import NewChatSpaceProfile from "./modules/NewChatSpaceProfile.svelte";
import PortReadyToastView from "./modules/PortReadyToast.svelte";
import { createPortPreviewController } from "./modules/port-preview-controller.svelte";
import { extractPublicEndpoints } from "./modules/port-preview-utils";
import {
	activePreviewFilePath,
	workspaceFilePreviewKind,
} from "./modules/preview-tabs";
import { createPreviewWorkspaceController } from "./modules/preview-workspace-controller.svelte";
import SessionShareDialog from "./modules/SessionShareDialog.svelte";
import SpaceDanmakuLayer from "./modules/SpaceDanmakuLayer.svelte";
import SpaceFileDomain, {
	type SpaceFileDomainProps,
} from "./modules/SpaceFileDomain.svelte";
import SpaceRouteDetailHost, {
	type RouteDetailView,
} from "./modules/SpaceRouteDetailHost.svelte";
import SpaceWorkspaceHeader from "./modules/SpaceWorkspaceHeader.svelte";
import {
	createSpaceBootstrapController,
	withBootstrapCacheTimeout,
} from "./modules/space-bootstrap-controller.svelte";
import {
	rememberSpaceDanmakuTurn,
	runSpaceDanmakuCatchup,
} from "./modules/space-danmaku-catchup";
import {
	createSpaceDanmakuController,
	extractDanmakuText,
} from "./modules/space-danmaku-controller.svelte";
import {
	isDanmakuEnabled,
	subscribeDanmakuPrefs,
} from "./modules/space-danmaku-prefs";
import { createSpacePresenceController } from "./modules/space-presence-controller.svelte";
import { createSpaceRealtimeController } from "./modules/space-realtime-controller.svelte";
import { createSpaceStatusController } from "./modules/space-status-controller.svelte";
import { createWorkspaceLayoutController } from "./modules/workspace-layout-controller.svelte";
import {
	encodePreviewParam,
	parsePreviewParam,
	readPreviewFromSearch,
	resolvePreviewRouteSync,
	type WorkspacePreviewRef,
	withCurrentPreview,
	withPreviewParam,
} from "./modules/workspace-preview-route";
import { displayUserName, fallbackUserName } from "./space-utils";

type Props = {
	data: {
		spaceId: string;
		view:
			| "space"
			| "session"
			| "checkpoint"
			| "checkpoint-new"
			| "cronjob"
			| "cronjob-new"
			| "work"
			| "task";
		sessionId?: string | null;
		filePath?: string | null;
		previewKind?: "file" | "board" | "port" | null;
		previewKey?: string | null;
		checkpointId?: string | null;
		cronjobId?: string | null;
		workId?: string | null;
		taskId?: string | null;
		turnSequence?: string | null;
	};
};
type ActiveFsSource =
	| { kind: "live" }
	| { kind: "checkpoint"; checkpointId: string };

const props = $props();
const data = $derived((props as Props).data);
const spaceId = $derived(data.spaceId);
const routeView = $derived(data.view);
const routeSessionId = $derived(data.sessionId ?? null);
const isNewSessionRoute = $derived(
	routeView === "session" && routeSessionId === "new",
);
const routePreviewRef = $derived.by((): WorkspacePreviewRef | null => {
	const shallowValue = page.state.workspacePreview;
	if (shallowValue !== undefined) return parsePreviewParam(shallowValue);
	const preview = readPreviewFromSearch(page.url.searchParams);
	if (preview) return preview;
	const legacyFile = page.url.searchParams.get("file");
	if (legacyFile) return { kind: "file", key: legacyFile };
	// Legacy residual for old /files routes.
	if (data.filePath) return { kind: "file", key: data.filePath };
	return null;
});
const routeCheckpointId = $derived(data.checkpointId ?? null);
const activeFsSource = $derived.by(
	(): ActiveFsSource =>
		routeView === "checkpoint" && routeCheckpointId
			? { kind: "checkpoint", checkpointId: routeCheckpointId }
			: { kind: "live" },
);
const activeFsSourceKey = $derived(
	activeFsSource.kind === "checkpoint"
		? `checkpoint:${activeFsSource.checkpointId}`
		: "live",
);
const activeFsReadonly = $derived(activeFsSource.kind === "checkpoint");
const activeFsSidebarSubtitle = $derived(
	activeFsSource.kind === "checkpoint"
		? `Saved snapshot · ${activeFsSource.checkpointId.slice(0, 8)}`
		: "",
);
const routeCronjobId = $derived(data.cronjobId ?? null);
const routeWorkId = $derived(data.workId ?? null);
const routeTaskId = $derived(data.taskId ?? null);
const routeTurnSequence = $derived.by(() => {
	const value = data.turnSequence;
	if (!value) return null;
	const sequence = Number(value);
	return Number.isFinite(sequence) && sequence > 0
		? Math.floor(sequence)
		: null;
});
let isMobile = $state(
	typeof window !== "undefined"
		? window.matchMedia(`(max-width: ${COMPACT_SHELL_MAX_WIDTH_PX}px)`).matches
		: false,
);
$effect(() => {
	if (typeof window === "undefined") return;
	const mql = window.matchMedia(`(max-width: ${COMPACT_SHELL_MAX_WIDTH_PX}px)`);
	const handler = (event: MediaQueryListEvent) => {
		isMobile = event.matches;
	};
	mql.addEventListener("change", handler);
	return () => mql.removeEventListener("change", handler);
});
const isRouteDetailView = $derived(
	routeView === "checkpoint-new" ||
		routeView === "checkpoint" ||
		routeView === "cronjob-new" ||
		routeView === "cronjob" ||
		routeView === "work" ||
		routeView === "task",
);
let space = $state<SpaceRecord | null>(null);
let spaceConfig = $state<SpaceConfig | null>(null);
let newChatProfileExpanded = $state(false);
let newChatProfileCanExpand = $state(false);
let newChatProfileBodyMaxHeight = $state(320);
let newChatProfileViewportEl: HTMLDivElement | null = $state(null);
let newChatProfileContentEl: HTMLDivElement | null = $state(null);
let newChatProfileBodyEl: HTMLDivElement | null = $state(null);
function hasAccessPermission(permission: Permission): boolean {
	return space?.access?.permissions.includes(permission) === true;
}
const canManageSessionAccess = $derived(hasAccessPermission("member.manage"));
// True when the backend returned only minimal info (session-level access only)
const spaceHasMinimalAccess = $derived(space?.accessLevel === "minimal");
// Right sidebar (files panel) is only available when the user has full space
// access. While the space is still loading or the user only has session-level
// access, the sidebar stays collapsed to prevent layout jumps.
const rightSidebarAvailable = $derived(
	Boolean(space) && !spaceHasMinimalAccess,
);
const canEditFiles = $derived(hasAccessPermission("file.edit"));
const spaceOwnerUsername = $derived(
	space?.ownerProfile?.username ??
		(space?.userUuid === authStore.userUuid
			? (authStore.profile?.username ?? null)
			: null),
);
const spaceSlug = $derived(space?.slug ?? null);
// Connection box filled when spaceRealtime is ready.
let connectionStateBox: {
	current: "idle" | "connecting" | "reconnecting" | "open" | "closed" | "error";
} = { current: "idle" };

const sessionChat = createSessionChatHost({
	openPath: (target) => openLinkedInlineFile(target),
	router: {
		toSession: async (sessionId, opts) => {
			// Keep open file/board/port preview when new chat becomes a real session.
			await goto(
				withCurrentPreview(buildSpaceSessionRoute(spaceId, sessionId)),
				{
					replaceState: opts?.replace ?? true,
					keepFocus: true,
					noScroll: true,
				},
			);
		},
		toTurn: async (sessionId, sequence) => {
			// Merge turn + current preview; buildSpaceSessionTurnRoute alone drops preview.
			await goto(
				withPreviewParam(
					buildSpaceSessionRoute(spaceId, sessionId),
					new URLSearchParams({ turn: String(sequence) }),
					readPreviewFromSearch(
						typeof window !== "undefined" ? window.location.search : null,
					),
				),
				{
					replaceState: true,
					keepFocus: true,
					noScroll: true,
				},
			);
		},
		toNewSession: async (opts) => {
			await goto(withCurrentPreview(buildSpaceNewSessionRoute(spaceId)), {
				replaceState: opts?.replace ?? false,
				keepFocus: true,
				noScroll: true,
			});
		},
	},
	getConnectionState: () => connectionStateBox.current,
	canManageSessionAccess: () => canManageSessionAccess,
	hasSpace: () => Boolean(space),
});

// Host is the unique owner of chat controllers and session records.

const activeSessionId = $derived(sessionChat.activeSessionId);
// Session rename (header inline edit)
let sessionRenaming = $state(false);
let sessionRenameValue = $state("");
let sessionRenameSaving = $state(false);

let resourceActionMenuOpen = $state(false);
let labelPickerResource = $state<{
	type: "session" | "checkpoint" | "file";
	ref: string;
	anchorEl: HTMLElement | null;
} | null>(null);
const portPreview = createPortPreviewController({
	getSpaceId: () => spaceId,
	getSpace: () => space,
	getPageMounted: () => pageMounted,
	getHasMinimalAccess: () => spaceHasMinimalAccess,
	onOpenPanel: () => {
		if (uiState.filesColumnHidden) uiState.setFilesColumnHidden(false);
		// Keep focus/immersive when switching port tabs.
		ensurePreviewPanelFits();
	},
	onClosePanel: () => {
		queueMicrotask(() => {
			if (!activePreviewKind) closePreviewFocusMode();
		});
	},
	onBeforeOpenPort: () => {},
});
const previewEndpoints = $derived(portPreview.endpoints);
const inlinePortPreview = $derived(portPreview.preview);
const inlinePortTabs = $derived(portPreview.previews);
const activeInlinePort = $derived(portPreview.activePort);
const portReadyToast = $derived(portPreview.readyToast);
let previewTabCleanupNotice = $state<string | null>(null);
let fileActionMenuAnchorEl: HTMLElement | null = $state(null);
let previewTabCleanupNoticeTimer: ReturnType<typeof setTimeout> | null = null;
const spaceStatus = createSpaceStatusController({
	getSpaceId: () => spaceId,
	getBootstrapStatus: () => bootstrapStatus,
	getPageVisible: () => pageVisible,
	getPageOnline: () => pageOnline,
	getPageMounted: () => pageMounted,
	onSpaceLoaded: (nextSpace) => {
		space = nextSpace;
		portPreview.setEndpoints(extractPublicEndpoints(nextSpace));
		cacheSpaceRecordSoon(nextSpace);
	},
});
const spaceLoadError = $derived(spaceStatus.loadError);
const spaceAccessState = $derived.by<AccessState>(() => {
	if (spaceLoadError) {
		const status = spaceStatus.loadErrorStatus;
		if (status === 404) return { kind: "not-found", resource: "space" };
		if (status === 403)
			return {
				kind: "forbidden",
				isAuthenticated: authStore.isAuthenticated,
				resource: "space",
			};
		if (status === 401) return { kind: "unauthorized" };
		return { kind: "error", message: spaceLoadError };
	}
	if (!space) return { kind: "loading" };
	if (spaceHasMinimalAccess) return { kind: "minimal" };
	return { kind: "full" };
});
const isBlockingAccess = $derived(isBlockingAccessState(spaceAccessState));
const effectiveRightSidebarCollapsed = $derived(
	!rightSidebarAvailable || uiState.rightSidebarCollapsed,
);
const isRightDrawerVisible = $derived(
	rightSidebarAvailable &&
		(uiState.rightIsDragging || uiState.mobileRightDrawerOpen),
);
const spaceMembers = $derived(spaceStatus.members);
const spaceMembersLoadedFor = $derived(spaceStatus.membersLoadedFor);
const spaceUsage = $derived(spaceStatus.usage);
const spaceUsageLoadedFor = $derived(spaceStatus.usageLoadedFor);
const spaceSandbox = $derived(spaceStatus.sandbox);
const spaceSandboxLoadedFor = $derived(spaceStatus.sandboxLoadedFor);
let workPublishTarget = $state<{
	targetType: "file" | "directory" | "port";
	targetRef: string;
} | null>(null);
const fileWorkspace = createFileWorkspaceController({
	getSpaceId: () => spaceId,
	getActiveFsSource: () => activeFsSource,
	getActiveFsSourceKey: () => activeFsSourceKey,
	getCanEditFiles: () => canEditFiles,
	getActiveFsReadonly: () => activeFsReadonly,
	getSpaceHasMinimalAccess: () => spaceHasMinimalAccess,
	onOpenInlineBoard: (path) => openInlineBoard(path),
	onCloseInlineBoard: () => closeInlineBoard(),
	onRenameInlineBoard: (fromPath, toPath) =>
		boardPreview.renamePath(fromPath, toPath),
	onOpenInlinePort: (port, url, optionsArg) =>
		openInlinePort(port, url, optionsArg),
	onCloseInlinePort: () => closeInlinePort(),
	onActivateFilePreview: () => {
		// Domain open paths (and re-activate) must reveal Files even when the
		// page wrapper was skipped (e.g. route hydrate → controller openFile).
		if (uiState.filesColumnHidden) uiState.setFilesColumnHidden(false);
		previewWorkspace.setActiveKind("file");
	},
	onClosePreviewFocusMode: () => {
		// Only leave focus/immersive when nothing is open in Files.
		queueMicrotask(() => {
			if (!activePreviewKind) closePreviewFocusMode();
		});
	},
	onEnsurePreviewPanelFits: ensurePreviewPanelFits,
});
const boardPreview = createBoardPreviewController({
	getSpaceId: () => spaceId,
	getSourceKey: () => activeFsSourceKey,
	getReadonly: () => activeFsReadonly,
	readFile: fileWorkspace.readActiveFsFile,
	onOpenPanel: () => {
		if (uiState.filesColumnHidden) uiState.setFilesColumnHidden(false);
		// Keep focus/immersive when switching board tabs.
		ensurePreviewPanelFits();
	},
	onClosePanel: () => {
		queueMicrotask(() => {
			if (!activePreviewKind) closePreviewFocusMode();
		});
	},
	onBeforeOpenBoard: () => {},
	onMarkSavePending: fileWorkspace.markFileSavePending,
	onClearSavePendingSoon: fileWorkspace.clearFileSavePendingSoon,
});
const fileTree = $derived(fileWorkspace.fileTree);
const fileTreeLoading = $derived(fileWorkspace.fileTreeLoading);
const fileTreeError = $derived(fileWorkspace.fileTreeError);
const inlineFile = $derived(fileWorkspace.inlineFile);
const inlineFileTabs = $derived(fileWorkspace.inlineFileTabs);
const activeInlineFilePath = $derived(fileWorkspace.activeInlineFilePath);
const inlineFileCanGoBack = $derived(fileWorkspace.inlineFileCanGoBack);
const inlineBoard = $derived(boardPreview.board);
const inlineBoardTabs = $derived(boardPreview.boards);
const activeInlineBoardPath = $derived(boardPreview.activeBoardPath);

const previewWorkspace = createPreviewWorkspaceController({
	getFileTabs: () => fileWorkspace.inlineFileTabs,
	getActiveFilePath: () => fileWorkspace.activeInlineFilePath,
	getBoardTabs: () => boardPreview.boards,
	getActiveBoardPath: () => boardPreview.activeBoardPath,
	getPortTabs: () => portPreview.previews,
	getActivePort: () => portPreview.activePort,
	openFile: (path, optionsArg) =>
		fileWorkspace.openInlineFile(path, optionsArg as never),
	activateFile: (path) => fileWorkspace.activateInlineFile(path),
	closeFile: (path, skipConfirm) =>
		fileWorkspace.closeInlineFileTab(path, skipConfirm),
	goBackFile: () => fileWorkspace.goBackInlineFile(),
	openBoard: (path) => boardPreview.openBoard(path),
	activateBoard: (path) => boardPreview.activateBoard(path),
	closeBoard: (path) => boardPreview.closeBoard(path ?? undefined),
	openPort: (port, url, optionsArg) =>
		portPreview.openPort(port, url, optionsArg),
	activatePort: (port) => portPreview.activatePort(port),
	closePort: (port) => portPreview.closePort(port ?? undefined),
	getPortEndpointUrl: (port) => previewEndpoints[port]?.url,
	syncUrl: (ref, replace = true) => syncPreviewQuery(ref, replace),
	onBudgetCleanup: () => {
		previewTabCleanupNotice = "Closed inactive previews to keep things fast.";
		if (previewTabCleanupNoticeTimer)
			clearTimeout(previewTabCleanupNoticeTimer);
		previewTabCleanupNoticeTimer = setTimeout(() => {
			previewTabCleanupNotice = null;
			previewTabCleanupNoticeTimer = null;
		}, 3000);
	},
});
const inlineFileCopied = $derived(fileWorkspace.inlineFileCopied);
const openWorkPublish = (
	targetType: "file" | "directory" | "port",
	targetRef: string,
) => {
	workPublishTarget = { targetType, targetRef };
};
const inlineFileIsMarkdown = $derived(fileWorkspace.inlineFileIsMarkdown);
const inlineFileIsHtml = $derived(fileWorkspace.inlineFileIsHtml);
const inlineFileHasRenderedPreview = $derived(
	fileWorkspace.inlineFileHasRenderedPreview,
);
const inlineFileExt = $derived(fileWorkspace.inlineFileExt);
const inlineFileIsImage = $derived(fileWorkspace.inlineFileIsImage);
const inlineFileIsVideo = $derived(fileWorkspace.inlineFileIsVideo);
const inlineFileIsPdf = $derived(fileWorkspace.inlineFileIsPdf);
const inlineFileIsText = $derived(fileWorkspace.inlineFileIsText);
const inlineFileDataUrl = $derived(fileWorkspace.inlineFileDataUrl);
let previewWorks = $state<WorkRecord[]>([]);
let previewWorksLoadedFor = $state<string | null>(null);
/** Realtime mutations seen while the full list request is in flight. */
const previewWorksBuffer = createWorkMutationBuffer();
let previewWorksToken = 0;
const inlineFileWork = $derived.by(() => {
	const filePath = inlineFile?.response?.path ?? null;
	if (!filePath || activeFsReadonly || authStore.userUuid !== space?.userUuid)
		return null;
	return (
		previewWorks.find(
			(work) =>
				work.status === "published" &&
				work.targetType === "file" &&
				work.targetRef === filePath,
		) ?? null
	);
});
const inlineFileDownloadUrl = $derived(fileWorkspace.inlineFileDownloadUrl);
const inlineFileDownloadName = $derived(fileWorkspace.inlineFileDownloadName);

$effect(() => {
	const currentSpaceId = spaceId;
	const currentOwnerId = space?.userUuid ?? null;
	if (
		!currentSpaceId ||
		!currentOwnerId ||
		activeFsReadonly ||
		previewWorksLoadedFor === currentSpaceId
	)
		return;
	const token = ++previewWorksToken;
	previewWorksBuffer.reset();
	void (async () => {
		try {
			await authStore.ensureLoaded();
			if (token !== previewWorksToken) return;
			if (!authStore.userUuid || authStore.userUuid !== currentOwnerId) {
				previewWorks = [];
				previewWorksLoadedFor = currentSpaceId;
				return;
			}
			const { works } = await sdk.works.listBySpace(currentSpaceId);
			if (token !== previewWorksToken) return;
			// Replay what realtime delivered mid-request instead of dropping the
			// response, which would hide every other Work until the next reload.
			previewWorks = previewWorksBuffer.apply(works);
			previewWorksLoadedFor = currentSpaceId;
		} catch {
			if (token !== previewWorksToken) return;
			previewWorks = [];
			previewWorksLoadedFor = currentSpaceId;
		}
	})();
});
const inlinePortEndpoint = $derived.by(() => {
	if (!inlinePortPreview) return null;
	return previewEndpoints[inlinePortPreview.port] ?? null;
});
const activePreviewKind = $derived(previewWorkspace.activeKind);
const selectedFilePath = $derived(
	activePreviewFilePath(
		activePreviewKind,
		activeInlineFilePath,
		activeInlineBoardPath,
	),
);

$effect(() => {
	if (activePreviewKind === "file" && inlineFile?.path) {
		sessionChat.reportActiveSource({
			kind: "file",
			path: inlineFile.path,
		});
		return;
	}
	if (activePreviewKind === "board" && inlineBoard?.path) {
		sessionChat.reportActiveSource({
			kind: "board",
			path: inlineBoard.path,
			boardId: inlineBoard.boardId,
		});
		return;
	}
	if (activePreviewKind === "port" && inlinePortPreview) {
		sessionChat.reportActiveSource({
			kind: "port",
			port: inlinePortPreview.port,
			url: inlinePortEndpoint?.url ?? inlinePortPreview.url,
		});
		return;
	}
	sessionChat.reportActiveSource(null);
});

const inlineFilePanHandlers = makeImagePanHandlers(
	() => fileWorkspace.inlineFileZoom,
	() => fileWorkspace.inlineFilePanX,
	() => fileWorkspace.inlineFilePanY,
	(v) => (fileWorkspace.inlineFilePanX = v),
	(v) => (fileWorkspace.inlineFilePanY = v),
	(v) => (fileWorkspace.inlineFileDragging = v),
);
let workspaceBodyEl = $state<HTMLDivElement | null>(null);
const previewLayout = createWorkspaceLayoutController({
	getIsCompact: () => isMobile,
	getWorkspaceBodyEl: () => workspaceBodyEl,
	getFilesAvailable: () => rightSidebarAvailable,
	getHasPreview: () => Boolean(activePreviewKind),
});
const previewPanelWidth = $derived(previewLayout.previewWidth);
const previewFocusMode = $derived(previewLayout.focusMode);
const previewImmersiveMode = $derived(previewLayout.immersiveMode);
const filesColumnHidden = $derived(previewLayout.filesColumnHidden);
/**
 * Header icon / show-hide semantics: treat empty rail (tree collapsed, no
 * preview) the same as a folded column so the first click always paints.
 * Reads reactive deps directly so the header stays in lockstep with layout.
 */
const filesChromeEffectivelyHidden = $derived(
	isMobile
		? !uiState.mobileRightDrawerOpen
		: filesColumnHidden ||
				(uiState.rightSidebarCollapsed && !activePreviewKind),
);
/**
 * Keep Files domain mounted through the column hide width tween so open
 * preview tabs and tree state survive. Unmount after the shell finishes.
 * Initial mount follows hidden state so cold start never mounts-then-tears-down.
 */
const filesColumnMount = createDeferredMount(
	() => !filesColumnHidden || isMobile || previewImmersiveMode,
	() => DURATION_PANEL,
);
const filesColumnMounted = $derived(filesColumnMount.mounted);
const immersiveChatVisible = $derived(
	!previewImmersiveMode || previewLayout.immersiveMainVisible,
);
const immersiveFilesInset = $derived(
	previewImmersiveMode && !effectiveRightSidebarCollapsed
		? uiState.rightSidebarWidth + FLOAT_PANEL_GAP * 2
		: FLOAT_PANEL_GAP,
);

let workspaceWidthTick = $state(0);
let pageMounted = $state(false);
let spaceFsEventTail = Promise.resolve();
let spaceFsEventGeneration = 0;
let lastSandboxFsSeq: number | null = null;
const spaceFsRefreshCoordinator = createSpaceFsRefreshCoordinator(
	refreshSpaceFsBatch,
	(error) => console.error("[files] Failed to refresh filesystem state", error),
);
const spaceBootstrap = createSpaceBootstrapController({
	getSpaceId: () => spaceId,
	getPageMounted: () => pageMounted,
	onEnterSpace: resetSpaceScopedState,
	onBootstrap: bootstrapSpace,
});
const bootstrapping = $derived(spaceBootstrap.bootstrapping);
let creatingSession = $state(false);
let rightSidebarResizeCleanup: (() => void) | null = null;
let immersiveChatResizeCleanup: (() => void) | null = null;
let lastImmersiveChatSessionId = $state<string | null | undefined>(undefined);

$effect(() => {
	const sessionId = activeSessionId;
	if (lastImmersiveChatSessionId === undefined) {
		lastImmersiveChatSessionId = sessionId;
		return;
	}
	if (lastImmersiveChatSessionId === sessionId) return;
	lastImmersiveChatSessionId = sessionId;
	// Chat re-shows on session switch; the float mutual-exclusion effect
	// below will hide it if the workspace is too narrow.
	previewLayout.setImmersiveMainVisible(true);
});

$effect(() => {
	previewLayout.handleCompactChange(isMobile);
});

// Restore focus/immersive geometry after space-scoped layout prefs load.
// Depend on presentation (not snapshot) so in-mode snapshot width edits don't re-expand.
$effect(() => {
	const currentSpaceId = spaceId;
	void uiState.workspacePresentation;
	void previewLayout.syncFromPrefs(currentSpaceId);
});

// Centralized Float mutual-exclusion: if Chat and Files are both visible but
// the workspace can't fit Chat-min + Files + Preview-min, hide Chat.  This
// catches cases that bypass the click handlers: session switch (re-shows
// chat), syncFromPrefs (refresh restore), and enterImmersive (defaults chat
// visible).  `workspaceWidthTick` bumps on resize so the effect re-runs.
$effect(() => {
	void previewImmersiveMode;
	void immersiveChatVisible;
	void effectiveRightSidebarCollapsed;
	void uiState.rightSidebarWidth;
	void workspaceWidthTick;
	if (
		previewImmersiveMode &&
		immersiveChatVisible &&
		!effectiveRightSidebarCollapsed &&
		!floatPanelsFit(
			workspaceBodyEl?.clientWidth ?? window.innerWidth,
			uiState.rightSidebarWidth,
			IMMERSIVE_CHAT_MIN,
		)
	) {
		previewLayout.setImmersiveMainVisible(false);
	}
});

// Re-fit the preview once the reserved geometry settles. On first paint the
// preview may be sized while the space is still loading (tree reserves 0) or
// before the tree reveals; when Files then claims its column the Main/chat
// panel could be squeezed below its minimum. Clamp again whenever preview
// presence, files availability, tree collapse, or tree width changes.
$effect(() => {
	if (isMobile) return;
	const hasPreview = Boolean(activePreviewKind);
	if (!hasPreview) return;
	// Track the inputs that feed getMaxPreviewWidth / tree reservation.
	void rightSidebarAvailable;
	void uiState.rightSidebarCollapsed;
	void uiState.rightSidebarWidth;
	void previewImmersiveMode;
	untrack(() => {
		if (previewImmersiveMode) return;
		void tick().then(() => previewLayout.ensurePreviewFits());
	});
});

// Apply the space's configured default layout as a fallback — only on a fresh
// entry (no local layout prefs for this space yet) and never overriding an
// explicit `?preview=` in the URL. Runs once per space via uiState guard.
$effect(() => {
	const currentSpaceId = spaceId;
	const layout = spaceConfig?.ui?.workspace?.defaultLayout;
	if (!layout) return;
	untrack(() => {
		const hasRoutePreview = Boolean(
			readPreviewFromSearch(
				typeof window !== "undefined" ? window.location.search : null,
			),
		);
		const openPreview = uiState.applySpaceDefaultLayoutIfFresh(
			currentSpaceId,
			layout,
			{ hasRoutePreview, isMobile },
		);
		if (!openPreview || !layout.preview) return;
		if (hasRoutePreview) return;
		syncPreviewQuery(layout.preview, true);
	});
});

let appliedFsSourceKey: string | null = null;
const spacePresence = createSpacePresenceController(() => spaceId);
const danmakuController = createSpaceDanmakuController();
let danmakuCatchupTimer: ReturnType<typeof setTimeout> | null = null;
let danmakuCatchupInFlight: Promise<unknown> | null = null;

function danmakuUserKey() {
	return authStore.userUuid ?? "anonymous";
}

function canRunDanmakuCatchup() {
	return (
		pageMounted &&
		typeof document !== "undefined" &&
		document.visibilityState === "visible" &&
		document.hasFocus() &&
		isDanmakuEnabled() &&
		!previewImmersiveMode
	);
}

function scheduleDanmakuCatchup(delayMs = 450) {
	if (!canRunDanmakuCatchup() || danmakuCatchupTimer) return;
	const scheduledSpaceId = spaceId;
	danmakuCatchupTimer = setTimeout(() => {
		danmakuCatchupTimer = null;
		if (!canRunDanmakuCatchup() || spaceId !== scheduledSpaceId) return;
		if (danmakuCatchupInFlight) return;
		const run = runSpaceDanmakuCatchup({
			spaceId: scheduledSpaceId,
			userKey: danmakuUserKey(),
			activeSessionId,
			fetchLimit: 100,
			playLimit: isMobile ? 40 : 100,
			fetchTurns: (options) => sdk.space(scheduledSpaceId).turns.list(options),
			enqueue: (items) =>
				spaceId === scheduledSpaceId && canRunDanmakuCatchup()
					? danmakuController.enqueueCatchup(items)
					: [],
		}).catch((error) => {
			console.warn("[space] Failed to load message catch-up:", error);
		});
		danmakuCatchupInFlight = run.finally(() => {
			danmakuCatchupInFlight = null;
		});
	}, delayMs);
}

const spaceRealtime = createSpaceRealtimeController({
	onTransportOpen: () => sessionChat.onTransportOpen(),
	onConnectionOpened: () => {
		fileWorkspace.retryFailedInlineFiles();
		void boardPreview.reconcileOpenBoards();
	},
	onConnectionRecovered: () => {
		void sessionChat.onConnectionRecovered();
		previewWorksLoadedFor = null;
		dispatchWorksChanged({ spaceId });
		scheduleDanmakuCatchup();
	},
	onHidden: () => {
		sessionChat.onVisibilityChanged(false);
	},
	onVisible: () => {
		// Host owns list + active-session tail refresh (single path).
		sessionChat.onVisibilityChanged(true);
		scheduleDanmakuCatchup();
	},
	onOnline: () => {
		fileWorkspace.retryFailedInlineFiles();
		if (wsConnectionState === "open") {
			void sessionChat.refreshSessions(false);
			void boardPreview.reconcileOpenBoards();
		}
	},
	onOffline: () => undefined,
	onStatusVisibilityChanged: () => scheduleStatusRefresh(),
});
const pageVisible = $derived(spaceRealtime.pageVisible);
const pageOnline = $derived(spaceRealtime.pageOnline);
const wsConnectionState = $derived(spaceRealtime.connectionState);
const onlineUsers = $derived(
	spacePresence.users.filter((user) => user.userId !== authStore.userUuid),
);
$effect(() => {
	connectionStateBox.current = wsConnectionState;
});
// Keep host access/route context in sync with shell route.
$effect(() => {
	const route =
		routeView === "session" && routeSessionId === "new"
			? ({ kind: "new" } as const)
			: routeView === "session" && routeSessionId
				? ({
						kind: "session",
						sessionId: routeSessionId,
						turnSequence: routeTurnSequence,
					} as const)
				: ({ kind: "none" } as const);
	sessionChat.syncContext({
		spaceId,
		route,
		access: {
			spaceLoadError,
			spaceHasMinimalAccess,
			canCreateSession,
			bootstrapping,
		},
	});
});
type RouteDetailHeaderMeta = {
	view: "checkpoint" | "cronjob" | "work" | "task";
	id: string;
	title: string;
};

let routeDetailHeaderMeta = $state<RouteDetailHeaderMeta | null>(null);
let taskRealtimeEvent = $state<{
	spaceId: string;
	payload: ChannelEnvelope;
	seq: number;
} | null>(null);
let taskRealtimeSeq = 0;
function normalizeTabTitleSegment(
	value: string | null | undefined,
	fallback: string,
	maxLength = 48,
): string {
	const normalized = value?.replace(/\s+/g, " ").trim() || fallback;
	return normalized.length > maxLength
		? `${normalized.slice(0, maxLength - 1)}…`
		: normalized;
}
const activeSessionState = $derived(sessionChat.activeSessionState);
const newChatBackground = $derived(
	spaceConfig?.ui?.newChat?.background ?? null,
);
const shouldShowNewChatBackground = $derived(
	Boolean(
		newChatBackground &&
			isNewSessionRoute &&
			!activeSessionId &&
			(activeSessionState?.turns.length ?? 0) === 0,
	),
);
const shouldShowNewChatProfile = $derived(
	Boolean(
		space &&
			isNewSessionRoute &&
			!activeSessionId &&
			(activeSessionState?.turns.length ?? 0) === 0 &&
			!shouldShowNewChatBackground,
	),
);
$effect(() => {
	if (!shouldShowNewChatProfile || !space) return;
	untrack(() => {
		if (
			hasAccessPermission("member.view") &&
			spaceMembersLoadedFor !== spaceId
		) {
			void loadSpaceMembers(spaceId);
		}
		if (spaceUsageLoadedFor !== spaceId) void loadSpaceUsage(spaceId);
		if (
			hasAccessPermission("sandbox.view") &&
			spaceSandboxLoadedFor !== spaceId
		) {
			void loadSpaceSandbox(spaceId);
		}
	});
});
function updateNewChatProfileOverflow() {
	const viewport = newChatProfileViewportEl;
	const content = newChatProfileContentEl;
	const body = newChatProfileBodyEl;
	if (!viewport || !content || !shouldShowNewChatProfile) {
		newChatProfileCanExpand = false;
		return;
	}
	const collapsedBodyOverflow = body
		? Math.max(0, body.scrollHeight - body.clientHeight)
		: 0;
	const naturalContentHeight = content.scrollHeight + collapsedBodyOverflow;
	const needsCollapse = naturalContentHeight > viewport.clientHeight + 2;
	newChatProfileCanExpand = needsCollapse;
	if (body) {
		const nonBodyHeight = content.scrollHeight - body.clientHeight;
		const expandControlReserve = needsCollapse ? 42 : 0;
		newChatProfileBodyMaxHeight = Math.max(
			112,
			viewport.clientHeight - nonBodyHeight - expandControlReserve - 4,
		);
	}
}
$effect(() => {
	const viewport = newChatProfileViewportEl;
	const content = newChatProfileContentEl;
	const body = newChatProfileBodyEl;
	if (!shouldShowNewChatProfile || !viewport || !content) return;
	void tick().then(updateNewChatProfileOverflow);
	const observer = new ResizeObserver(updateNewChatProfileOverflow);
	observer.observe(viewport);
	observer.observe(content);
	if (body) observer.observe(body);
	return () => observer.disconnect();
});
const activeRouteDetailHeader = $derived.by(() => {
	const meta = routeDetailHeaderMeta;
	if (!meta || meta.view !== routeView) return null;
	const routeIdByView = {
		checkpoint: routeCheckpointId,
		cronjob: routeCronjobId,
		work: routeWorkId,
		task: routeTaskId,
	} satisfies Record<RouteDetailHeaderMeta["view"], string | null>;
	return routeIdByView[meta.view] === meta.id ? meta : null;
});
const presenceMeta = $derived.by(() => {
	const panels: Record<string, unknown>[] = [];
	if (activeSessionId ?? routeSessionId) panels.push({ kind: "session" });
	if (inlineFile?.path || routePreviewRef?.kind === "file")
		panels.push({ kind: "file" });
	if (activeRouteDetailHeader)
		panels.push({ kind: activeRouteDetailHeader.view });
	return { panels };
});

const browserTabTitle = $derived.by(() => {
	const spaceTitle = normalizeTabTitleSegment(
		space?.name || space?.title || spaceId,
		"Space",
		36,
	);
	const spaceDescriptionTitle = space?.description?.trim()
		? normalizeTabTitleSegment(space.description, "", 64)
		: null;
	const routeTitle = (() => {
		if (routeView === "space") return null;
		if (routeView === "session") {
			if (isNewSessionRoute) return null;
			return activeSessionState?.session
				? normalizeTabTitleSegment(
						getSessionTitle(activeSessionState.session),
						"Chat",
					)
				: "Chat";
		}
		if (routePreviewRef?.kind === "file") {
			return normalizeTabTitleSegment(
				routePreviewRef.key.split("/").pop(),
				"File",
				44,
			);
		}
		if (routeView === "checkpoint") {
			return normalizeTabTitleSegment(
				activeRouteDetailHeader?.title ||
					(routeCheckpointId ? `Save ${routeCheckpointId.slice(0, 8)}` : null),
				"Save",
			);
		}
		if (routeView === "checkpoint-new") return "New save";
		if (routeView === "cronjob") {
			return normalizeTabTitleSegment(
				activeRouteDetailHeader?.title,
				"Cronjob",
			);
		}
		if (routeView === "cronjob-new") return "New cronjob";
		if (routeView === "work")
			return normalizeTabTitleSegment(activeRouteDetailHeader?.title, "Work");
		if (routeView === "task")
			return normalizeTabTitleSegment(activeRouteDetailHeader?.title, "Task");
		return null;
	})();
	if (routeTitle) return `${routeTitle} · ${spaceTitle} — Cohub`;
	return spaceDescriptionTitle
		? `${spaceTitle} · ${spaceDescriptionTitle} — Cohub`
		: `${spaceTitle} — Cohub`;
});
const bootstrapMeta = $derived.by(() => {
	const raw = space?.meta;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const bootstrap = (raw as Record<string, unknown>).bootstrap;
	if (!bootstrap || typeof bootstrap !== "object" || Array.isArray(bootstrap))
		return null;
	return bootstrap as Record<string, unknown>;
});
const bootstrapStatus = $derived.by<
	"pending" | "running" | "ready" | "failed" | null
>(() => {
	const value = bootstrapMeta?.status;
	return value === "pending" ||
		value === "running" ||
		value === "ready" ||
		value === "failed"
		? value
		: null;
});
const canCreateSession = $derived(Boolean(space && !creatingSession));
async function loadPreviewEndpoints() {
	await portPreview.loadEndpoints();
}

function closePortReadyToast() {
	portPreview.closeReadyToast();
}

function previewPortFromToast() {
	portPreview.previewFromToast();
}

function applyPortsChanged(payload: ChannelEnvelope) {
	portPreview.applyPortsChanged(payload);
}

function loadSpace() {
	return spaceStatus.loadSpace();
}
function retryLoadSpace() {
	void spaceStatus.loadSpace().then((ok) => {
		if (!ok) return;
		spaceBootstrap.resetLoaded();
		spaceBootstrap.runForCurrentSpace();
	});
}
function loadSpaceMembers(currentSpaceId = spaceId) {
	return spaceStatus.loadMembers(currentSpaceId);
}
function loadSpaceUsage(currentSpaceId = spaceId) {
	return spaceStatus.loadUsage(currentSpaceId);
}
function loadSpaceSandbox(currentSpaceId = spaceId) {
	return spaceStatus.loadSandbox(currentSpaceId);
}

function scheduleStatusRefresh() {
	spaceStatus.scheduleRefresh();
}

/**
 * Display identities for board cursors and automation markers.
 *
 * Board awareness carries an actor id and a fallback name; presence is what has
 * the avatar. Includes the local user so a marker for our own agent still shows
 * our avatar rather than falling back to initials.
 */
const boardCollaborators = $derived.by(() => {
	const map = new Map<string, BoardCollaboratorProfile>();
	for (const user of spacePresence.users) {
		map.set(user.userId, {
			userId: user.userId,
			displayName: displayUserName(user.profile, user.userId),
			avatarUrl: user.profile?.avatarUrl ?? null,
		});
	}
	return map;
});

/**
 * Open the chat behind an Agent board marker.
 *
 * The turn route is keyed by sequence, but provenance only carries the turn id,
 * so resolve it first. A failed lookup still navigates to the chat: landing in
 * the right conversation is more useful than refusing to move.
 */
async function openBoardActivity(activity: BoardAutomationActivity) {
	const sessionId = activity.source.sessionId;
	if (!sessionId) return;
	// An agent can run in another space's sandbox; route to where the chat lives.
	const targetSpaceId = activity.source.spaceId ?? spaceId;
	const turnId = activity.source.turnId;
	const sequence = turnId
		? await sdk
				.space(targetSpaceId)
				.session(sessionId)
				.turns.get(turnId)
				.then((response) => response.turn.sequence)
				.catch(() => null)
		: null;
	const pathname = buildSpaceSessionRoute(targetSpaceId, sessionId);
	// Keep the board open: the point is to read the turn beside what it changed.
	const href = withPreviewParam(
		pathname,
		sequence == null ? null : new URLSearchParams({ turn: String(sequence) }),
		readPreviewFromSearch(
			typeof window !== "undefined" ? window.location.search : null,
		),
	);
	await goto(href, { keepFocus: true, noScroll: true });
}
function userTitle(
	profile: UserProfile | null | undefined,
	userUuid: string | null | undefined,
): string {
	return [displayUserName(profile, userUuid), userUuid]
		.filter(Boolean)
		.join(" · ");
}
// Image pan handlers
function makeImagePanHandlers(
	zoom: () => number,
	panX: () => number,
	panY: () => number,
	setPanX: (v: number) => void,
	setPanY: (v: number) => void,
	setDragging: (v: boolean) => void,
) {
	let dragStartX = 0;
	let dragStartY = 0;
	let startPanX = 0;
	let startPanY = 0;
	return {
		start: (e: MouseEvent) => {
			if (zoom() <= 1) return;
			e.preventDefault();
			dragStartX = e.clientX;
			dragStartY = e.clientY;
			startPanX = panX();
			startPanY = panY();
			setDragging(true);
			document.addEventListener("mousemove", handleMove);
			document.addEventListener("mouseup", handleEnd);
		},
	};
	function handleMove(e: MouseEvent) {
		const dx = e.clientX - dragStartX;
		const dy = e.clientY - dragStartY;
		setPanX(startPanX + dx);
		setPanY(startPanY + dy);
	}
	function handleEnd() {
		setDragging(false);
		document.removeEventListener("mousemove", handleMove);
		document.removeEventListener("mouseup", handleEnd);
	}
}

// ── Session rename (header inline edit) ────────────────────────────────
function startSessionRename() {
	const session = activeSessionState?.session;
	if (!session) return;
	sessionRenaming = true;
	sessionRenameValue = session.title ?? getSessionTitle(session);
}
function cancelSessionRename() {
	sessionRenaming = false;
	sessionRenameValue = "";
}
async function submitSessionRename() {
	if (sessionRenameSaving || !activeSessionId) return;
	const trimmed = sessionRenameValue.trim();
	if (!trimmed) {
		cancelSessionRename();
		return;
	}
	const session = activeSessionState?.session;
	if (!session) return;
	if (trimmed === (session.title ?? getSessionTitle(session))) {
		cancelSessionRename();
		return;
	}
	sessionRenameSaving = true;
	try {
		await sessionChat.renameActiveSession(trimmed);
	} catch {
		// Silently fail
	} finally {
		sessionRenameSaving = false;
		cancelSessionRename();
	}
}
function spaceStyleChanged(
	changes: Array<{ path?: string; oldPath?: string }> | undefined,
) {
	return changes?.some(
		(change) =>
			isSpaceStylePath(change.path) || isSpaceStylePath(change.oldPath),
	);
}
function spaceConfigChanged(
	changes: Array<{ path?: string; oldPath?: string }> | undefined,
) {
	return changes?.some(
		(change) =>
			isSpaceConfigPath(change.path) || isSpaceConfigPath(change.oldPath),
	);
}
function normalizeSandboxFsPayload(
	payload: SpaceFsChangedPayload,
): SpaceFsChangedPayload | null {
	const result = reconcileSpaceFsSequence(payload, lastSandboxFsSeq);
	lastSandboxFsSeq = result.lastSeq;
	return result.payload;
}

function enqueueSpaceFsChanged(payload: ChannelEnvelope) {
	const generation = spaceFsEventGeneration;
	const eventSpaceId = payload.spaceId ?? spaceId;
	const sourceKey = activeFsSourceKey;
	const prepared = spaceFsEventTail
		.catch(() => undefined)
		.then(async () => {
			if (generation !== spaceFsEventGeneration || eventSpaceId !== spaceId)
				return null;
			const eventPayload = normalizeSandboxFsPayload(
				payload.payload as SpaceFsChangedPayload,
			);
			if (!eventPayload) return null;
			const { refreshDirs } = await spaceFsRepo.invalidateFsChanged(
				eventSpaceId,
				eventPayload,
			);
			return { eventPayload, refreshDirs };
		});
	spaceFsEventTail = prepared.then(
		() => undefined,
		(error) => {
			console.error("[files] Failed to invalidate filesystem cache", error);
		},
	);
	void prepared
		.then((result) => {
			if (
				!result ||
				generation !== spaceFsEventGeneration ||
				eventSpaceId !== spaceId
			)
				return;
			scheduleSpaceFsRefresh({
				eventPayload: result.eventPayload,
				dirs: result.refreshDirs,
				eventSpaceId,
				sourceKey,
				generation,
			});
		})
		.catch(() => undefined);
}

function isCurrentSpaceFsRefresh(batch: SpaceFsRefreshBatch) {
	return (
		batch.generation === spaceFsEventGeneration &&
		spaceId === batch.eventSpaceId &&
		activeFsSource.kind === "live" &&
		activeFsSourceKey === batch.sourceKey
	);
}

function scheduleSpaceFsRefresh(input: {
	eventPayload: SpaceFsChangedPayload;
	dirs: Set<string>;
	eventSpaceId: string;
	sourceKey: string;
	generation: number;
}) {
	const { eventPayload, eventSpaceId } = input;
	if (eventPayload.resync || spaceStyleChanged(eventPayload.changes))
		refreshSpaceStyle(eventSpaceId);
	if (eventPayload.resync || spaceConfigChanged(eventPayload.changes))
		refreshSpaceConfig(eventSpaceId);

	for (const change of eventPayload.changes ?? []) {
		const meta = {
			size: change.size,
			mtimeMs: change.mtimeMs,
			removed: change.kind === "delete",
		};
		if (change.path) invalidateFilePreview(eventSpaceId, change.path, meta);
		if (change.oldPath)
			invalidateFilePreview(eventSpaceId, change.oldPath, { removed: true });
	}

	const batch: SpaceFsRefreshBatch = {
		eventSpaceId,
		sourceKey: input.sourceKey,
		generation: input.generation,
		resync: Boolean(eventPayload.resync),
		dirs: input.dirs,
		boardManifestPaths: new Set(),
		inlineFilePaths: new Set(),
	};
	if (!isCurrentSpaceFsRefresh(batch)) return;
	if (batch.resync) {
		spaceFsRefreshCoordinator.enqueue(batch);
		return;
	}

	for (const change of eventPayload.changes ?? []) {
		if (change.kind === "rename" && change.oldPath && change.path) {
			boardPreview.renamePath(change.oldPath, change.path);
		} else if (change.kind === "delete" && change.path) {
			boardPreview.closeBoardsAtPath(change.path, change.nodeType === "dir");
		}
		if (
			change.path &&
			(change.kind === "create" ||
				change.kind === "modify" ||
				change.kind === "rename")
		)
			batch.boardManifestPaths.add(change.path);

		const isOwnPendingChange = fileWorkspace.isOwnPendingFileSave(
			change.path,
			eventPayload.source,
			change.kind,
			eventPayload.mutationId,
		);
		for (const tab of inlineFileTabs) {
			if (change.path !== tab.path && change.oldPath !== tab.path) continue;
			if (isOwnPendingChange) continue;
			if (change.kind === "delete") fileWorkspace.closeInlineFileTab(tab.path);
			else if (!fileWorkspace.isInlineFileDirty(tab.path) && change.path)
				batch.inlineFilePaths.add(change.path);
			else fileWorkspace.markInlineFileExternalChange(tab.path);
		}
	}
	spaceFsRefreshCoordinator.enqueue(batch);
}

async function refreshVisibleFsDirs(batch: SpaceFsRefreshBatch) {
	if (batch.dirs.has("")) await loadFileTree(true);
	if (!isCurrentSpaceFsRefresh(batch)) return;
	const refreshes: Promise<void>[] = [];
	for (const dir of batch.dirs) {
		if (!dir) continue;
		const node = fileWorkspace.findFsNode(dir);
		if (!node?.isOpen) continue;
		fileWorkspace.markDirectoryUnloaded(dir);
		refreshes.push(
			expandDirectory({ ...node, isOpen: false, isLoaded: false }),
		);
	}
	await Promise.all(refreshes);
}

async function refreshSpaceFsBatch(batch: SpaceFsRefreshBatch) {
	if (!isCurrentSpaceFsRefresh(batch)) return;
	if (batch.resync) {
		const inlineReloads = inlineFileTabs
			.filter((tab) => !fileWorkspace.isInlineFileDirty(tab.path))
			.map((tab) =>
				fileWorkspace
					.openInlineFile(tab.path, { activate: false, forceReload: true })
					.catch(() => undefined),
			);
		await Promise.all([
			loadFileTree(true),
			boardPreview.reconcileOpenBoards(),
			...inlineReloads,
		]);
		return;
	}

	const boardRefreshes = [...batch.boardManifestPaths].map((path) =>
		boardPreview.refreshBoardManifest(path),
	);
	const inlineReloads = [...batch.inlineFilePaths]
		.filter((path) => !fileWorkspace.isInlineFileDirty(path))
		.map((path) =>
			fileWorkspace
				.openInlineFile(path, { activate: false, forceReload: true })
				.catch(() => undefined),
		);
	await Promise.all([
		refreshVisibleFsDirs(batch),
		...boardRefreshes,
		...inlineReloads,
	]);
}

async function handleWsEvent(payload: ChannelEnvelope) {
	try {
		// Shell consumers only. Chat kernel is a single fan-out below so we never
		// double-apply session/task semantics against the same host state.
		if (payload.type === "space.ports.changed") {
			applyPortsChanged(payload);
		} else if (payload.type === "work.version.published") {
			const published = parseWorkVersionPublished(payload);
			if (published) {
				previewWorksBuffer.upsert(published.work);
				previewWorks = upsertWorkSnapshot(previewWorks, published.work);
				dispatchWorksChanged({
					spaceId,
					work: published.work,
					version: published.version,
				});
			}
		} else if (payload.type === "label.assignments.updated") {
			const snapshot = parseResourceLabelRealtimePayload({
				spaceId: payload.spaceId,
				payload: payload.payload,
			});
			if (snapshot?.spaceId === spaceId)
				await syncResourceLabelsToCache(snapshot);
		} else if (
			payload.type === "task.created" ||
			payload.type === "task.updated"
		) {
			// Route-detail host still observes task envelopes for the right panel.
			const eventPayload = payload.payload as {
				task?: Partial<TaskRunRecord> & {
					id?: string;
					spaceId?: string;
				};
			};
			const task = eventPayload.task;
			if (task?.id) {
				const eventSpaceId = task.spaceId ?? payload.spaceId ?? spaceId;
				if (eventSpaceId === spaceId) {
					taskRealtimeSeq += 1;
					taskRealtimeEvent = { spaceId, payload, seq: taskRealtimeSeq };
				}
			}
		}

		// Live danmaku: float other users' messages from other sessions (shell chrome).
		const targetSessionId =
			typeof payload.sessionId === "string" ? payload.sessionId : null;
		if (
			payload.type === "session.turn.created" &&
			targetSessionId &&
			targetSessionId !== activeSessionId
		) {
			const turn = payload.payload.turn as
				| {
						id?: unknown;
						sequence?: unknown;
						userUuid?: unknown;
						createdAt?: unknown;
						authorProfile?: {
							displayName?: unknown;
							avatarUrl?: unknown;
						} | null;
				  }
				| undefined;
			const senderUuid =
				typeof turn?.userUuid === "string" ? turn.userUuid : null;
			if (
				senderUuid &&
				senderUuid !== authStore.userUuid &&
				canRunDanmakuCatchup()
			) {
				const text = extractDanmakuText(turn);
				if (text) {
					const ap = turn?.authorProfile;
					const authorName =
						(ap && typeof ap.displayName === "string"
							? ap.displayName.trim()
							: "") || fallbackUserName(senderUuid);
					const avatarUrl =
						ap && typeof ap.avatarUrl === "string" ? ap.avatarUrl : null;
					const turnId = typeof turn?.id === "string" ? turn.id : payload.id;
					const sequence =
						typeof turn?.sequence === "number" ? turn.sequence : null;
					if (sequence !== null) {
						danmakuController.push({
							id: turnId,
							text,
							sessionId: targetSessionId,
							sequence,
							userUuid: senderUuid,
							authorName,
							avatarUrl,
							createdAt:
								typeof turn?.createdAt === "string"
									? turn.createdAt
									: new Date(payload.timestamp).toISOString(),
							source: "live",
						});
						rememberSpaceDanmakuTurn(danmakuUserKey(), spaceId, turnId);
					}
				}
			}
		}

		// One chat ingest path — host owns session/task/generation reconciliation.
		await sessionChat.ingestRealtimeEnvelope(payload);
	} catch (error) {
		console.error("[WS] handleWsEvent error:", error);
	}
}
onDestroy(() => {
	if (activeSessionId) sessionChat.captureCurrentScrollAnchor(activeSessionId);
	sessionChat.flushComposerDraft();
	sessionChat.dispose();
	if (previewTabCleanupNoticeTimer) clearTimeout(previewTabCleanupNoticeTimer);
	spaceBootstrap.resetLoaded();
});

beforeNavigate((navigation) => {
	if (activeSessionId) sessionChat.captureCurrentScrollAnchor(activeSessionId);
	sessionChat.flushComposerDraft();
	void fileWorkspace.persistInlineFileDrafts();
	void fileWorkspace.flushInlineFiles();
	if (!fileWorkspace.hasDirtyInlineFiles()) return;
	if (navigation.willUnload) {
		navigation.cancel();
		return;
	}
	const fromUrl = navigation.from?.url;
	const toUrl = navigation.to?.url;
	if (!fromUrl || !toUrl) return;
	// Query-only changes (preview open/close) keep drafts.
	if (fromUrl.pathname === toUrl.pathname) return;
	const fromPath = fromUrl.pathname;
	const toPath = toUrl.pathname;
	const fromCheckpoint = fromPath.includes("/checkpoints/");
	const toCheckpoint = toPath.includes("/checkpoints/");
	const fsSourceChanging = fromCheckpoint !== toCheckpoint;
	const sameSpace =
		Boolean(spaceId) &&
		resolveWorkspaceSpaceId({ pathname: toPath }) === spaceId;
	// Only prompt when drafts cannot survive the transition.
	if (!fsSourceChanging && sameSpace) return;
	const ok = confirm("File changes are still syncing. Leave anyway?");
	if (!ok) navigation.cancel();
});

onNavigate(() => {
	if (fileWorkspace.hasDirtyInlineFiles())
		return fileWorkspace.persistInlineFileDrafts();
});

function beginRightSidebarResize(event: PointerEvent) {
	event.preventDefault();
	if (
		window.innerWidth < DESKTOP_SHELL_MIN_WIDTH_PX ||
		effectiveRightSidebarCollapsed
	)
		return;
	const target = event.currentTarget as HTMLElement | null;
	target?.setPointerCapture?.(event.pointerId);
	rightSidebarResizeCleanup?.();
	const startX = event.clientX;
	const startWidth = uiState.rightSidebarWidth;
	const minMainWidth = previewImmersiveMode
		? (immersiveChatVisible ? IMMERSIVE_CHAT_MIN : 0) +
			FLOAT_PREVIEW_MIN_WIDTH +
			FLOAT_PANEL_GAP * 3
		: 720;
	const onPointerMove = (moveEvent: PointerEvent) => {
		const delta = startX - moveEvent.clientX;
		const viewportLimit = window.innerWidth - minMainWidth;
		const nextWidth = Math.min(
			RIGHT_SIDEBAR_MAX,
			Math.max(RIGHT_SIDEBAR_MIN, Math.min(startWidth + delta, viewportLimit)),
		);
		uiState.setRightSidebarWidth(nextWidth);
	};
	const stop = () => {
		if (target?.hasPointerCapture?.(event.pointerId)) {
			target.releasePointerCapture(event.pointerId);
		}
		document.body.classList.remove("sidebar-resizing");
		window.removeEventListener("pointermove", onPointerMove);
		window.removeEventListener("pointerup", stop);
		window.removeEventListener("pointercancel", stop);
		if (rightSidebarResizeCleanup === stop) rightSidebarResizeCleanup = null;
	};
	rightSidebarResizeCleanup = stop;
	document.body.classList.add("sidebar-resizing");
	window.addEventListener("pointermove", onPointerMove);
	window.addEventListener("pointerup", stop);
	window.addEventListener("pointercancel", stop);
}
function beginImmersiveChatResize(event: PointerEvent) {
	event.preventDefault();
	if (!previewImmersiveMode || window.innerWidth < DESKTOP_SHELL_MIN_WIDTH_PX)
		return;
	const target = event.currentTarget as HTMLElement | null;
	target?.setPointerCapture?.(event.pointerId);
	immersiveChatResizeCleanup?.();
	const startX = event.clientX;
	const startWidth = uiState.immersiveChatWidth;
	const rightReserved = effectiveRightSidebarCollapsed
		? FLOAT_PANEL_GAP
		: uiState.rightSidebarWidth + FLOAT_PANEL_GAP * 2;
	const onPointerMove = (moveEvent: PointerEvent) => {
		const delta = moveEvent.clientX - startX;
		const workspaceWidth = workspaceBodyEl?.clientWidth ?? window.innerWidth;
		const viewportLimit =
			workspaceWidth -
			rightReserved -
			FLOAT_PREVIEW_MIN_WIDTH -
			FLOAT_PANEL_GAP;
		const nextWidth = Math.min(
			IMMERSIVE_CHAT_MAX,
			Math.max(IMMERSIVE_CHAT_MIN, Math.min(startWidth + delta, viewportLimit)),
		);
		uiState.setImmersiveChatWidth(nextWidth);
	};
	const stop = () => {
		if (target?.hasPointerCapture?.(event.pointerId)) {
			target.releasePointerCapture(event.pointerId);
		}
		document.body.classList.remove("sidebar-resizing");
		window.removeEventListener("pointermove", onPointerMove);
		window.removeEventListener("pointerup", stop);
		window.removeEventListener("pointercancel", stop);
		if (immersiveChatResizeCleanup === stop) immersiveChatResizeCleanup = null;
	};
	immersiveChatResizeCleanup = stop;
	document.body.classList.add("sidebar-resizing");
	window.addEventListener("pointermove", onPointerMove);
	window.addEventListener("pointerup", stop);
	window.addEventListener("pointercancel", stop);
}

function ensurePreviewPanelFits() {
	previewLayout.ensurePreviewFits();
}
async function togglePreviewFocusMode() {
	await previewLayout.toggleFocus();
}
async function togglePreviewImmersiveMode() {
	await previewLayout.toggleImmersive();
}
function closePreviewFocusMode() {
	previewLayout.exitPresentation();
}
function handlePreviewWindowResize() {
	previewLayout.handleWindowResize();
	workspaceWidthTick++;
	if (
		previewImmersiveMode &&
		immersiveChatVisible &&
		!effectiveRightSidebarCollapsed &&
		!floatPanelsFit(
			workspaceBodyEl?.clientWidth ?? window.innerWidth,
			uiState.rightSidebarWidth,
			IMMERSIVE_CHAT_MIN,
		)
	) {
		void previewLayout.toggleTree(false);
	}
}
function beginPreviewPanelResize(event: PointerEvent) {
	previewLayout.beginPreviewResize(event);
}
async function toggleRightSidebar() {
	// Main header: hide/show Files chrome with consistent show/hide semantics.
	// Handles empty-rail (tree collapsed, no preview) so the first click always paints.
	await previewLayout.toggleFilesChrome();
}

async function toggleFilesTree() {
	const openingFiles = effectiveRightSidebarCollapsed;
	if (
		previewImmersiveMode &&
		openingFiles &&
		immersiveChatVisible &&
		!floatPanelsFit(
			workspaceBodyEl?.clientWidth ?? window.innerWidth,
			uiState.rightSidebarWidth,
			IMMERSIVE_CHAT_MIN,
		)
	) {
		previewLayout.setImmersiveMainVisible(false);
	}
	await previewLayout.toggleTree();
}

function syncPreviewQuery(ref: WorkspacePreviewRef | null, replace = true) {
	if (typeof window === "undefined") return;
	const search = new URLSearchParams(window.location.search);
	// Canonicalize the legacy public-slug query when preview state changes.
	search.delete("file");
	const next = withPreviewParam(window.location.pathname, search, ref);
	const current = `${window.location.pathname}${window.location.search}`;
	if (next === current) return;
	const state = {
		...page.state,
		workspacePreview: ref ? encodePreviewParam(ref) : null,
	};
	if (replace) replaceState(next, state);
	else pushState(next, state);
}

function currentPreviewRef(): WorkspacePreviewRef | null {
	return previewWorkspace.currentRef();
}
async function loadFileTree(force = false) {
	await fileWorkspace.loadFileTree(force);
}
async function expandDirectory(node: SpaceFsNode) {
	await fileWorkspace.expandDirectory(node);
}
async function refreshFileTree() {
	await fileWorkspace.refreshFileTree();
}
async function handleCreateFile(parentPath: string) {
	await fileWorkspace.handleCreateFile(parentPath);
}
async function handleCreateBoard(parentPath: string) {
	await fileWorkspace.handleCreateBoard(parentPath);
}
async function handleCreateDir(parentPath: string) {
	await fileWorkspace.handleCreateDir(parentPath);
}
async function handleRenameNode(node: SpaceFsNode) {
	const prevPath = node.path;
	await fileWorkspace.handleRenameNode(node);
	// If active preview path changed via rename, keep query in sync.
	const next = currentPreviewRef();
	if (next) syncPreviewQuery(next, true);
	else if (routePreviewRef?.key === prevPath) syncPreviewQuery(null, true);
}
async function handleMoveNode(node: SpaceFsNode, targetDir: string) {
	const prevPath = node.path;
	await fileWorkspace.handleMoveNode(node, targetDir);
	const next = currentPreviewRef();
	if (next) syncPreviewQuery(next, true);
	else if (routePreviewRef?.key === prevPath) syncPreviewQuery(null, true);
}
async function handleDownloadNode(node: SpaceFsNode) {
	await fileWorkspace.handleDownloadNode(node);
}
async function handleDeleteNode(node: SpaceFsNode) {
	const deleted = await fileWorkspace.handleDeleteNode(node);
	if (!deleted) return;
	boardPreview.closeBoardsAtPath(node.path, node.type === "dir");
}
async function openInlineFile(
	path: string,
	options: { syncUrl?: boolean } = {},
) {
	if (filesColumnHidden) previewLayout.setFilesColumnHidden(false);
	await previewWorkspace.openFile(path, options);
}
async function openLinkedInlineFile(target: string | WorkspaceFileLinkTarget) {
	const path = typeof target === "string" ? target : target.path;
	if (workspaceFilePreviewKind(path, activeFsReadonly) === "board") {
		await openInlineBoard(path);
		return;
	}
	const position =
		typeof target === "string" ? null : (target.position ?? null);
	await previewWorkspace.openFile(path, {
		preserveHistory: true,
		position,
	});
}
async function goBackInlineFile() {
	await previewWorkspace.goBackFile();
}
function closeInlineFile() {
	previewWorkspace.closeActive();
}
async function openInlineBoard(
	path: string,
	options: { syncUrl?: boolean } = {},
) {
	if (activeFsReadonly) {
		await openInlineFile(path, options);
		return;
	}
	if (filesColumnHidden) previewLayout.setFilesColumnHidden(false);
	await previewWorkspace.openBoard(path, options);
}
function closeInlineBoard() {
	const path = activeInlineBoardPath;
	if (path) previewWorkspace.close("board", path);
	else previewWorkspace.closeActive();
}
async function commitInlineBoard(
	boardId: string,
	path: string,
	document: BoardDocument,
	ops: BoardOperation[],
) {
	await boardPreview.commitBoard(boardId, path, document, ops);
}
async function retryInlineBoardSave(boardId: string) {
	await boardPreview.retryBoardSave(boardId);
}
function openInlinePort(
	port: string,
	url: string,
	options: { autoOpened?: boolean; syncUrl?: boolean } = {},
) {
	if (filesColumnHidden) previewLayout.setFilesColumnHidden(false);
	previewWorkspace.openPort(port, url, options);
}
function activateInlineFileTab(path: string) {
	previewWorkspace.activate("file", path);
}
function activateInlineBoardTab(path: string) {
	previewWorkspace.activate("board", path);
}
function activateInlinePortTab(port: string) {
	previewWorkspace.activate("port", port);
}
function closeInlinePort() {
	const port = activeInlinePort;
	if (port) previewWorkspace.close("port", port);
	else previewWorkspace.closeActive();
}
function closeInlineFileTab(path: string, skipConfirm = false) {
	previewWorkspace.close("file", path, skipConfirm);
}
function closeInlineBoardTab(path?: string) {
	previewWorkspace.close("board", path ?? activeInlineBoardPath);
}
function closeInlinePortTab(port?: string) {
	previewWorkspace.close("port", port ?? activeInlinePort);
}
async function downloadInlineFile() {
	await fileWorkspace.downloadInlineFile();
}
async function retryInlineFile() {
	const path = fileWorkspace.activeInlineFilePath;
	if (!path) return;
	await fileWorkspace.openInlineFile(path, { forceReload: true });
}
async function saveInlineFile() {
	await fileWorkspace.saveInlineFile();
}
function updateInlineFileDraft(path: string, draft: string) {
	fileWorkspace.updateInlineFileDraft(path, draft);
}
async function retryInlineFileSave() {
	await fileWorkspace.retryInlineFileSave();
}
async function overwriteInlineFile() {
	await fileWorkspace.overwriteInlineFile();
}
async function reloadInlineFile() {
	await fileWorkspace.reloadInlineFile();
}
function handleUploadFiles(
	files: File[] | LocalUploadEntry[],
	targetDir: string,
) {
	fileWorkspace.handleUploadFiles(files, targetDir);
}
async function handleFileKeyboardSave(event: KeyboardEvent) {
	if (
		(event.metaKey || event.ctrlKey) &&
		event.key.toLowerCase() === "s" &&
		inlineFile
	) {
		event.preventDefault();
		await saveInlineFile();
	}
	if (event.key === "Escape" && (inlineFile || inlinePortPreview)) {
		event.preventDefault();
		if (inlinePortPreview) closeInlinePort();
		else closeInlineFile();
	}
}
async function copyInlineFileContent() {
	await fileWorkspace.copyInlineFileContent();
}
function getFileActionNode(path: string): SpaceFsNode {
	return fileWorkspace.getFileActionNode(path);
}

function insertPathReference(path: string) {
	insertComposerSnippet(` \`${path}\` `);
	uiState.mobileRightDrawerOpen = false;
}

function insertActiveSessionReference() {
	if (!activeSessionId) return;
	insertPathReference(`/sessions/${activeSessionId}.jsonl`);
}

function insertFilePathReference(path: string) {
	insertPathReference(path);
}

function editResourceLabels(
	resourceType: "session" | "checkpoint" | "file",
	resourceRef: string,
	anchorEl: HTMLElement | null = null,
) {
	labelPickerResource = { type: resourceType, ref: resourceRef, anchorEl };
}

function hasResourceActions() {
	// Session header actions are always session-scoped.
	return Boolean(activeSessionState?.session);
}

function closeResourceActionMenu() {
	resourceActionMenuOpen = false;
}

function insertHeaderReference() {
	// Always insert the active session reference from the session header.
	insertActiveSessionReference();
	closeResourceActionMenu();
}

function focusComposerSoon() {
	requestAnimationFrame(() => {
		window.dispatchEvent(new CustomEvent("cohub:composer-focus"));
	});
}

function isEditableShortcutTarget(target: EventTarget | null) {
	if (!(target instanceof HTMLElement)) return false;
	return Boolean(
		target.closest(
			'input, textarea, select, [contenteditable="true"], [contenteditable=""]',
		),
	);
}

async function jumpRelativeTurn(direction: 1 | -1) {
	const railItems = sessionChat.activeTurnRailItems;
	if (!activeSessionId || railItems.length === 0) return;
	const current = sessionChat.currentTurnSequence;
	const sorted = railItems.map((turn) => turn.sequence).sort((a, b) => a - b);
	if (sorted.length === 0) return;
	let target: number | undefined;
	if (current == null) {
		target = direction > 0 ? sorted[0] : sorted.at(-1);
	} else if (direction > 0) {
		target = sorted.find((sequence) => sequence > current) ?? sorted.at(-1);
	} else {
		target = sorted.findLast((sequence) => sequence < current) ?? sorted[0];
	}
	if (target == null || target === current) return;
	await sessionChat.jumpToTurn(target);
}

function handleSessionVimKeydown(event: KeyboardEvent) {
	if (event.defaultPrevented || isComposingKeyboardEvent(event)) return;
	if (routeView !== "session" || !activeSessionState) return;
	const key = event.key.toLowerCase();
	if (
		(event.metaKey || event.ctrlKey) &&
		event.shiftKey &&
		!event.altKey &&
		key === "m"
	) {
		event.preventDefault();
		sessionChat.showModelSelector = true;
		void sessionChat.loadModelsCatalog();
		void sessionChat.loadGenerationModelsCatalog();
		return;
	}
	if (isEditableShortcutTarget(event.target)) return;
	if (key !== "g") sessionChat.scroll.clearPendingVimG();
	if (
		event.shiftKey &&
		!event.altKey &&
		!event.metaKey &&
		!event.ctrlKey &&
		key === "g"
	) {
		event.preventDefault();
		sessionChat.scroll.clearPendingVimG();
		sessionChat.scroll.scrollTimelineToBottom(() =>
			sessionChat.scrollToBottomNow(),
		);
		return;
	}
	if (
		event.shiftKey &&
		!event.altKey &&
		!event.metaKey &&
		!event.ctrlKey &&
		(key === "j" || key === "k")
	) {
		event.preventDefault();
		void jumpRelativeTurn(key === "j" ? 1 : -1);
		return;
	}
	if (
		!event.altKey &&
		!event.metaKey &&
		!event.ctrlKey &&
		!event.shiftKey &&
		key === "g"
	) {
		event.preventDefault();
		if (sessionChat.scroll.vimPendingGActive) {
			sessionChat.scroll.clearPendingVimG();
			sessionChat.scroll.scrollTimelineToTop(
				() => sessionChat.beginUserScroll(),
				(top) => sessionChat.setProgrammaticScrollTop(top),
				() => sessionChat.updateCurrentTurnSequence(),
			);
			return;
		}
		sessionChat.scroll.armPendingVimG();
		return;
	}
	if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
	if (key === "i") {
		event.preventDefault();
		focusComposerSoon();
		return;
	}
	if (key === "j") {
		event.preventDefault();
		sessionChat.scroll.scrollTimelineByLines(1, () =>
			sessionChat.beginUserScroll(),
		);
		return;
	}
	if (key === "k") {
		event.preventDefault();
		sessionChat.scroll.scrollTimelineByLines(-1, () =>
			sessionChat.beginUserScroll(),
		);
	}
}

onMount(() => {
	pageMounted = true;
	spaceRealtime.start();
	spacePresence.start();
	sessionChat.loadSessionScrollAnchors();
	window.addEventListener("keydown", handleSessionVimKeydown);
	const offSessionListCacheUpdated = onSessionListCacheUpdated(
		({ spaceId: updatedSpaceId, sessions }) => {
			if (updatedSpaceId !== spaceId) return;
			sessionChat.applySessionsSnapshot(sessions);
		},
	);
	const offBoardTxApplied = sdk
		.space(spaceId)
		.on("board.transaction.applied", (event) => {
			const payload = event.payload as {
				boardId?: unknown;
				version?: unknown;
				actorId?: unknown;
				txId?: unknown;
				operations?: unknown;
				metadata?: Record<string, unknown> | null;
			};
			if (
				typeof payload.boardId !== "string" ||
				!boardPreview.hasBoardId(payload.boardId)
			)
				return;
			// Skip only this client's own committed transactions (already reflected
			// locally). Keying on txId — not actorId — means the same user's other
			// tabs/devices still reconcile, so multi-tab editing stays in sync.
			if (boardPreview.isOwnTransaction(payload.txId)) return;
			const version =
				typeof payload.version === "number" ? payload.version : null;
			const txId = typeof payload.txId === "string" ? payload.txId : null;
			const ops = Array.isArray(payload.operations)
				? (payload.operations as import("@neta-art/cohub").BoardOperation[])
				: null;
			// Attribution before sync: the focus of a delete only exists in the
			// document as it stands now, and it is independent of which sync path
			// (incremental ops vs bootstrap) the event ends up taking.
			if (
				txId &&
				ops &&
				ops.length > 0 &&
				typeof payload.actorId === "string"
			) {
				boardPreview.noteRemoteTransaction({
					boardId: payload.boardId,
					actorId: payload.actorId,
					txId,
					operations: ops,
					metadata: payload.metadata ?? null,
				});
			}
			if (version != null && txId && ops && ops.length > 0) {
				boardPreview.requestRemoteOps(payload.boardId, {
					version,
					txId,
					ops,
				});
				return;
			}
			// Missing/empty ops or version → full bootstrap fallback.
			boardPreview.requestRemoteRefresh(payload.boardId);
		});
	const offBoardPlaybackChanged = sdk
		.space(spaceId)
		.on("board.playback.changed", (event) => {
			const snapshot =
				event.payload as import("@neta-art/cohub").BoardPlaybackSnapshot;
			if (!boardPreview.hasBoardId(snapshot.boardId)) return;
			boardPreview.applyPlayback(snapshot);
		});
	const offSpaceConfigUpdated = subscribeSpaceConfig((config) => {
		spaceConfig = config;
	});
	const offSpaceConfigBackgroundAction = subscribeSpaceConfigBackgroundAction(
		(payload) => {
			if (!shouldShowNewChatBackground) return;
			void sessionChat.applyBackgroundComposerPayload(payload);
		},
	);
	const offDanmakuPrefs = subscribeDanmakuPrefs((enabled) => {
		if (!enabled) {
			danmakuController.clear();
			return;
		}
		scheduleDanmakuCatchup();
	});
	// Preload model catalogs so the selector is ready immediately
	void sessionChat.loadModelsCatalog();
	void sessionChat.loadGenerationModelsCatalog();
	void sessionChat.loadPromptTemplates();
	const handleOpenInlineFileEvent = (e: Event) => {
		const custom = e as CustomEvent<{ spaceId?: string; path?: string }>;
		if (custom.detail?.spaceId !== spaceId || !custom.detail?.path) return;
		void openInlineFile(custom.detail.path);
	};
	const handleResourceActionMenuKeydown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			closeResourceActionMenu();
			fileWorkspace.fileActionMenuOpenPath = null;
		}
	};
	const handleResourceActionMenuClickOutside = (e: MouseEvent) => {
		const target = e.target as HTMLElement;
		if (!target.closest("[data-resource-actions]")) {
			closeResourceActionMenu();
			fileWorkspace.fileActionMenuOpenPath = null;
		}
	};
	const flushInlineFiles = () => {
		void fileWorkspace.flushInlineFiles();
	};
	const handleVisibilityChange = () => {
		if (document.visibilityState === "hidden") {
			flushInlineFiles();
			return;
		}
		scheduleDanmakuCatchup();
	};
	const handleWindowFocus = () => scheduleDanmakuCatchup();
	window.addEventListener("resize", handlePreviewWindowResize);
	// Re-expand preview when the workspace body width changes (e.g. sidebar
	// collapse transition settling) so Focus mode reaches its true max width.
	const workspaceResizeObserver = new ResizeObserver(() => {
		if (previewFocusMode) previewLayout.handleWindowResize();
	});
	if (workspaceBodyEl) workspaceResizeObserver.observe(workspaceBodyEl);
	window.addEventListener("cohub:open-inline-file", handleOpenInlineFileEvent);
	window.addEventListener("keydown", handleFileKeyboardSave);
	window.addEventListener("keydown", handleResourceActionMenuKeydown);
	window.addEventListener("blur", flushInlineFiles);
	window.addEventListener("focus", handleWindowFocus);
	document.addEventListener("visibilitychange", handleVisibilityChange);
	document.addEventListener("click", handleResourceActionMenuClickOutside);
	scheduleStatusRefresh();
	scheduleDanmakuCatchup();
	return () => {
		if (activeSessionId)
			sessionChat.captureCurrentScrollAnchor(activeSessionId);
		window.removeEventListener("keydown", handleSessionVimKeydown);
		offSessionListCacheUpdated();
		offBoardTxApplied();
		offBoardPlaybackChanged();
		offSpaceConfigUpdated();
		offSpaceConfigBackgroundAction();
		offDanmakuPrefs();
		danmakuController.dispose();
		spaceStatus.dispose();
		fileWorkspace.dispose();
		portPreview.dispose();
		sessionChat.scroll.stopVimScroll();
		sessionChat.scroll.clearPendingVimG();
		sessionChat.persistSessionScrollAnchorsNow();
		pageMounted = false;
		spacePresence.dispose();
		spaceRealtime.dispose();
		window.removeEventListener("resize", handlePreviewWindowResize);
		workspaceResizeObserver.disconnect();
		window.removeEventListener(
			"cohub:open-inline-file",
			handleOpenInlineFileEvent,
		);
		window.removeEventListener("keydown", handleFileKeyboardSave);
		window.removeEventListener("keydown", handleResourceActionMenuKeydown);
		window.removeEventListener("blur", flushInlineFiles);
		window.removeEventListener("focus", handleWindowFocus);
		document.removeEventListener("visibilitychange", handleVisibilityChange);
		document.removeEventListener("click", handleResourceActionMenuClickOutside);
		if (danmakuCatchupTimer) clearTimeout(danmakuCatchupTimer);
		danmakuCatchupTimer = null;
		rightSidebarResizeCleanup?.();
		immersiveChatResizeCleanup?.();
		previewLayout.dispose();
		deactivateSpaceStyle();
		deactivateSpaceConfig();
	};
});
function resetSpaceScopedState(currentSpaceId: string) {
	spaceFsEventGeneration += 1;
	spaceFsEventTail = Promise.resolve();
	spaceFsRefreshCoordinator.reset();
	lastSandboxFsSeq = null;
	if (danmakuCatchupTimer) clearTimeout(danmakuCatchupTimer);
	danmakuCatchupTimer = null;
	danmakuController.clear();
	activateSpaceStyle(currentSpaceId);
	// Chat-scoped state (sessions/turns/tasks/scroll/generation/share) lives on host.
	sessionChat.enterSpace(currentSpaceId);
	space = null;
	spaceConfig = null;
	activateSpaceConfig(currentSpaceId);
	spaceStatus.reset();
	newChatProfileExpanded = false;
	newChatProfileCanExpand = false;
	newChatProfileBodyMaxHeight = 320;
	newChatProfileViewportEl = null;
	newChatProfileContentEl = null;
	newChatProfileBodyEl = null;
	spaceRealtime.resetRecoveredConnection();
	// Chat-owned UI (turn rail / route turn) is reset by sessionChat.enterSpace.
	fileWorkspace.resetForSpace(currentSpaceId, { force: true });
	boardPreview.closeBoard();
	portPreview.setEndpoints({});
	portPreview.closePort();
	portPreview.closeReadyToast();
	taskRealtimeEvent = null;
	taskRealtimeSeq = 0;
	resourceActionMenuOpen = false;
	routeDetailHeaderMeta = null;
	creatingSession = false;
}

async function bootstrapSpace(currentSpaceId: string) {
	let sessionLoad: Promise<void> | null = null;
	const spaceLoad = loadSpace();
	const routeSession =
		routeView === "session" && routeSessionId && routeSessionId !== "new"
			? routeSessionId
			: null;
	try {
		// Prepare once. Repeat calls used to re-trigger tail reconcile and look like auto-refresh.
		if (routeSession) {
			sessionChat.prepareRouteSession(routeSession);
			sessionLoad = sessionChat
				.loadSessionState(routeSession)
				.catch(() => undefined);
		}
		const [cachedSpace, cachedSnapshot] = await Promise.all([
			withBootstrapCacheTimeout(spaceRecordRepo.getCached(currentSpaceId)),
			withBootstrapCacheTimeout(getCachedSessionListSnapshot(currentSpaceId)),
		]);
		if (spaceId !== currentSpaceId) return;
		const cachedSessions = cachedSnapshot?.sessions;
		if (cachedSessions && cachedSessions.length > 0)
			sessionChat.seedSessions(cachedSessions);
		if (cachedSpace?.space && !space) {
			space = cachedSpace.space;
			portPreview.setEndpoints(extractPublicEndpoints(cachedSpace.space));
		} else if (!space) {
			await spaceLoad;
		}
		if (spaceId !== currentSpaceId) return;
		void sessionChat.refreshSessions(false);
		void loadPreviewEndpoints();
		void loadFileTree();
		if (routeSession) {
			await sessionLoad;
			void sessionChat.loadTurnIndex(routeSession);
		}
	} catch {
		// Non-blocking; bootstrapping released by controller
	}
}

// React to space changes: reset state and reload data
$effect(() => {
	spaceBootstrap.runForCurrentSpace();
});
// Close mobile right drawer when the sidebar becomes unavailable (e.g.
// entering a minimal-access space) so it doesn't linger from a previous space.
$effect(() => {
	if (!rightSidebarAvailable) uiState.mobileRightDrawerOpen = false;
});
// Immersive preview takes over the viewport — clear any in-flight danmaku so
// they never overlay a full-screen preview.
$effect(() => {
	if (previewImmersiveMode) {
		danmakuController.clear();
		return;
	}
	if (pageMounted) untrack(() => scheduleDanmakuCatchup());
});
$effect(() => {
	const currentSpaceId = spaceId;
	const currentUserKey = danmakuUserKey();
	if (!pageMounted) return;
	void currentSpaceId;
	void currentUserKey;
	untrack(() => scheduleDanmakuCatchup());
});
$effect(() => {
	if (
		previewImmersiveMode &&
		pageMounted &&
		!activePreviewKind &&
		!routePreviewRef
	) {
		previewLayout.exitPresentation();
	}
});
// Port deep-link guard: if a ?preview=port:XXXX URL is pending but the endpoint
// never arrives (stale link, sandbox not running), the user would be stuck in
// Float with no active preview and no exit control.  After a timeout, clear
// the preview param and exit Float.
let portDeepLinkTimer: ReturnType<typeof setTimeout> | null = null;
$effect(() => {
	const ref = routePreviewRef;
	const hasActive = activePreviewKind;
	if (
		ref?.kind === "port" &&
		!hasActive &&
		previewImmersiveMode &&
		pageMounted
	) {
		if (portDeepLinkTimer) clearTimeout(portDeepLinkTimer);
		portDeepLinkTimer = setTimeout(() => {
			portDeepLinkTimer = null;
			// Re-check: endpoint may have arrived during the wait.
			if (
				routePreviewRef?.kind === "port" &&
				!activePreviewKind &&
				previewImmersiveMode
			) {
				syncPreviewQuery(null, true);
				previewLayout.exitPresentation();
			}
		}, 8000);
		return () => {
			if (portDeepLinkTimer) {
				clearTimeout(portDeepLinkTimer);
				portDeepLinkTimer = null;
			}
		};
	}
});
// React to space changes: subscribe to WS events for the new space
$effect(() => {
	const currentSpaceId = spaceId;
	spacePresence.syncSpace();
	spacePresence.updateMeta(presenceMeta);
	if (!pageMounted || !currentSpaceId) return;
	// Shared refcounted room: Sessions host (and any other panel) can join the
	// same space without opening a second sdk.space(id).subscribe.
	return subscribeSpaceChannel(currentSpaceId, (event) => {
		if (event.type === "space.fs.changed") {
			enqueueSpaceFsChanged(event);
			return;
		}
		void handleWsEvent(event);
	});
});
$effect(() => {
	// Ordered: source first, then route preview hydration (bi-directional).
	const sourceKey = activeFsSourceKey;
	const preview = routePreviewRef;
	const currentPreview = previewWorkspace.currentRef();
	// Retry pending port deep-links when sandbox endpoints arrive.
	if (preview?.kind === "port") void previewEndpoints[preview.key]?.url;
	untrack(() => {
		let reconciledPreview = currentPreview;
		// 1) FS source transition (checkpoint <-> live)
		if (sourceKey !== appliedFsSourceKey) {
			// beforeNavigate already confirmed discard when FS source changes.
			fileWorkspace.switchSource(sourceKey, { force: true });
			// Source change invalidates non-file previews; file tabs already cleared by switchSource.
			for (const tab of [...boardPreview.boards])
				boardPreview.closeBoard(tab.path);
			for (const tab of [...portPreview.previews])
				portPreview.closePort(tab.port);
			previewWorkspace.setActiveKind(null);
			appliedFsSourceKey = sourceKey;
			reconciledPreview = null;
		}

		// 2) Preview route hydration / teardown
		const target =
			preview?.kind === "board" && activeFsReadonly
				? { kind: "file" as const, key: preview.key }
				: preview;
		const action = resolvePreviewRouteSync(target, reconciledPreview);
		if (action === "close") {
			previewWorkspace.closeAll({ syncUrl: false });
			return;
		}
		if (action === "none" || !target) return;
		const result = previewWorkspace.hydrateFromRoute(target);
		if (!result.ok) {
			// Wait for trusted port endpoint; effect re-runs when endpoints update.
			return;
		}
	});
});

const spaceFileDomainProps = $derived.by<
	Omit<
		SpaceFileDomainProps,
		| "inlineFileViewMode"
		| "fileActionMenuOpenPath"
		| "inlineFileZoom"
		| "inlineFilePanX"
		| "inlineFilePanY"
		| "workPublishTarget"
	>
>(() => ({
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
	rightSidebarCollapsed: effectiveRightSidebarCollapsed,
	rightSidebarWidth: uiState.rightSidebarWidth,
	rightDragOffsetPx: uiState.rightDragOffsetPx,
	rightIsDragging: uiState.rightIsDragging,
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
	boardActivities: boardPreview.automationActivities,
	onOpenBoardActivity: openBoardActivity,
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
	inlineFileDiff: fileWorkspace.inlineFileDiff,
	inlineFileDiffLoading: fileWorkspace.inlineFileDiffLoading,
	inlineFileDiffError: fileWorkspace.inlineFileDiffError,
	inlineFileIsMarkdown,
	inlineFileIsHtml,
	inlineFileCopied,
	inlineFileExt,
	inlineFileIsImage,
	inlineFileIsVideo,
	inlineFileIsPdf,
	inlineFileDataUrl,
	inlineFileWork,
	inlineFileDragging: fileWorkspace.inlineFileDragging,
	inlineFilePanHandlers,
	uploadPaneVisible: fileWorkspace.uploadPaneVisible,
	uploadPaneTargetDir: fileWorkspace.uploadPaneTargetDir,
	pendingUploadFiles: fileWorkspace.pendingUploadFiles,
	pendingUploadEntries: fileWorkspace.pendingUploadEntries,
	onSpaceUpdated: (nextSpace: SpaceRecord) => {
		space = nextSpace;
	},
	onMobileRightDrawerClose: () => {
		uiState.mobileRightDrawerOpen = false;
	},
	onSetUploadPaneVisible: (visible: boolean) => {
		fileWorkspace.uploadPaneVisible = visible;
	},
	onToggleDirectory: expandDirectory,
	onRefreshFileTree: refreshFileTree,
	onCreateFile: handleCreateFile,
	onCreateBoard: handleCreateBoard,
	onCreateDir: handleCreateDir,
	onRenameNode: handleRenameNode,
	onMoveNode: handleMoveNode,
	onDeleteNode: handleDeleteNode,
	onDownloadNode: handleDownloadNode,
	onUploadFiles: handleUploadFiles,
	onInsertPathReference: insertPathReference,
	onOpenInlineFile: openInlineFile,
	onOpenLinkedInlineFile: openLinkedInlineFile,
	onOpenInlineBoard: openInlineBoard,
	onCloseInlineFile: closeInlineFile,
	onActivateInlineBoard: activateInlineBoardTab,
	onCloseInlineBoardTab: closeInlineBoardTab,
	onActivateInlinePort: activateInlinePortTab,
	onCloseInlinePortTab: closeInlinePortTab,
	onActivateInlineFile: activateInlineFileTab,
	onCloseInlineFileTab: closeInlineFileTab,
	onBackInlineFile: goBackInlineFile,
	onDownloadInlineFile: downloadInlineFile,
	onRetryInlineFile: retryInlineFile,
	onCopyInlineFileContent: copyInlineFileContent,
	onUpdateInlineFileDraft: updateInlineFileDraft,
	onRetryInlineFileSave: retryInlineFileSave,
	onOverwriteInlineFile: overwriteInlineFile,
	onReloadInlineFile: reloadInlineFile,
	onOpenInlinePort: openInlinePort,
	onCommitInlineBoard: commitInlineBoard,
	onRetryInlineBoardSave: retryInlineBoardSave,
	onBeginPreviewPanelResize: beginPreviewPanelResize,
	onTogglePreviewFocusMode: togglePreviewFocusMode,
	onTogglePreviewImmersiveMode: togglePreviewImmersiveMode,
	onBeginRightSidebarResize: beginRightSidebarResize,
	treeVisible: !effectiveRightSidebarCollapsed,
	onToggleTree: rightSidebarAvailable
		? () => {
				void toggleFilesTree();
			}
		: undefined,
	onEditResourceLabels: editResourceLabels,
	onInsertFilePathReference: insertFilePathReference,
	onGetFileActionNode: getFileActionNode,
	onUploadComplete: fileWorkspace.handleUploadComplete,
	onOpenWorkPublish: openWorkPublish,
	onCloseWorkPublish: () => {
		workPublishTarget = null;
	},
	onVisibleLinesChange: (path, range) =>
		sessionChat.reportFileVisibleLines(path, range),
	onBoardViewStateChange: (state) => sessionChat.reportBoardView(state),
}));

const headerContext = $derived({
	routeView,
	spaceId,
	space,
	activeSession: activeSessionState?.session,
	activeSessionLoaded: activeSessionState?.loaded ?? false,
	activeSessionLoading: activeSessionState?.loading ?? false,
	isNewSessionRoute,
	wsConnectionState,
	onlineUsers,
	activeRouteDetailHeader,
	activeSessionId,
	canManageSessionAccess,
	isActiveSessionPublic: activeSessionId
		? sessionChat.share.hasPermission(activeSessionId)
		: false,
	spaceHasMinimalAccess,
	rightSidebarAvailable,
	// Icon tracks effective hide (column folded or empty rail with no preview).
	rightSidebarCollapsed: filesChromeEffectivelyHidden,
});
const sessionRenameState = $derived({
	renaming: sessionRenaming,
	value: sessionRenameValue,
	saving: sessionRenameSaving,
});
const resourceActionState = $derived({
	open: resourceActionMenuOpen,
	available: hasResourceActions(),
});
const headerActions = {
	openShareModal: (id: string) => sessionChat.openShareModal(id),
	startSessionRename,
	cancelSessionRename,
	submitSessionRename,
	setSessionRenameValue: (value: string) => {
		sessionRenameValue = value;
	},
	toggleResourceActionMenu: () => {
		resourceActionMenuOpen = !resourceActionMenuOpen;
	},
	closeResourceActionMenu,
	labelHeaderResource: (anchorEl?: HTMLElement | null) => {
		if (activeSessionState?.session)
			void editResourceLabels(
				"session",
				activeSessionState.session.id,
				anchorEl ?? null,
			);
	},
	insertHeaderReference,
	toggleRightSidebar,
};
</script>

<svelte:head>
	<title>{browserTabTitle}</title>
</svelte:head>

{#snippet FileHeaderCoreActions(path: string)}
	<div class="relative shrink-0" data-resource-actions>
		<button
			type="button"
			class="icon-btn"
			onclick={(event) => {
				event.stopPropagation();
				const nextOpen = fileWorkspace.fileActionMenuOpenPath !== path;
				fileActionMenuAnchorEl = nextOpen ? event.currentTarget : null;
				fileWorkspace.fileActionMenuOpenPath = nextOpen ? path : null;
			}}
			title="More actions"
			aria-haspopup="menu"
			aria-expanded={fileWorkspace.fileActionMenuOpenPath === path}
		>
			<MoreHorizontal class="w-4 h-4" />
		</button>
		{#if fileWorkspace.fileActionMenuOpenPath === path && fileActionMenuAnchorEl}
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
				<button
					type="button"
					class="menu-item"
					onclick={() => {
						void editResourceLabels("file", path, fileActionMenuAnchorEl);
						fileWorkspace.fileActionMenuOpenPath = null;
					}}
					role="menuitem"
				>
					<ListTree class="w-3.5 h-3.5" />
					<span>Label as…</span>
				</button>
				<button
					type="button"
					class="menu-item"
					onclick={() => {
						insertFilePathReference(path);
						fileWorkspace.fileActionMenuOpenPath = null;
					}}
					role="menuitem"
				>
					<TextCursorInput class="w-3.5 h-3.5" />
					<span>Insert reference</span>
				</button>
				<button
					type="button"
					class="menu-item"
					onclick={() => {
						void handleDownloadNode(getFileActionNode(path));
						fileWorkspace.fileActionMenuOpenPath = null;
					}}
					role="menuitem"
				>
					<Download class="w-3.5 h-3.5" />
					<span>Download</span>
				</button>
				{#if canEditFiles && !activeFsReadonly}
					<button
						type="button"
						class="menu-item"
						onclick={() => {
							void handleRenameNode(getFileActionNode(path));
							fileWorkspace.fileActionMenuOpenPath = null;
						}}
						role="menuitem"
					>
						<Pencil class="w-3.5 h-3.5" />
						<span>Rename</span>
					</button>
					<button
						type="button"
						class="menu-item danger"
						onclick={() => {
							void handleDeleteNode(getFileActionNode(path));
							fileWorkspace.fileActionMenuOpenPath = null;
						}}
						role="menuitem"
					>
						<Trash2 class="w-3.5 h-3.5" />
						<span>Delete</span>
					</button>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet PanelLoadingState(label: string, compact = false)}
	<CenteredLoading label={label} size={compact ? "compact" : "panel"} />
{/snippet}

{#snippet UserMetaItem(profile: UserProfile | null | undefined, userUuid: string | null | undefined)}
	{#if userUuid}
		<UserIdentity
			name={displayUserName(profile, userUuid)}
			avatarUrl={profile?.avatarUrl}
			username={profile?.username}
			title={userTitle(profile, userUuid)}
			size="xxs"
			class="text-[11px] text-text-tertiary"
		/>
	{/if}
{/snippet}

{#snippet CopyIdMetaItem(id: string, copied: boolean, onCopy: () => void, label = "Copy ID")}
	<button
		type="button"
		class="inline-flex min-h-6 min-w-0 max-w-full items-center gap-1.5 font-mono text-[11px] text-text-placeholder transition-colors hover:text-text-secondary"
		onclick={onCopy}
		title={label}
	>
		<span class="truncate">{id}</span>
		{#if copied}
			<Check class="h-3 w-3 shrink-0 text-success-soft" />
		{:else}
			<Copy class="h-3 w-3 shrink-0" />
		{/if}
	</button>
{/snippet}

{#if isBlockingAccess}
	<AccessStateView state={spaceAccessState} retry={retryLoadSpace} />
{:else}
{#if portReadyToast}
	<PortReadyToastView
		port={portReadyToast.port}
		url={portReadyToast.url}
		onPreview={previewPortFromToast}
		onClose={closePortReadyToast}
	/>
{/if}
{#if previewTabCleanupNotice}
	<div class="preview-tab-cleanup-toast pointer-events-none">
		{previewTabCleanupNotice}
	</div>
{/if}
<div
	bind:this={workspaceBodyEl}
	class="workspace-body relative flex-1 min-h-0 flex overflow-hidden bg-[var(--chat-bg)]"
	class:workspace-body--preview-immersive={previewImmersiveMode}
	style={`--immersive-chat-width: ${uiState.immersiveChatWidth}px; --immersive-chat-edge-gap: ${FLOAT_CHAT_EDGE_GAP}px; --immersive-chat-max-width: calc(100% - ${immersiveFilesInset}px - ${FLOAT_PREVIEW_MIN_WIDTH + FLOAT_PANEL_GAP}px); --preview-safe-left: ${previewImmersiveMode && immersiveChatVisible ? `calc(min(var(--immersive-chat-width), var(--immersive-chat-max-width)) + var(--immersive-chat-edge-gap) + ${FLOAT_PANEL_GAP}px)` : `${FLOAT_PANEL_GAP}px`}; --preview-safe-right: ${immersiveFilesInset}px`}
>
  <SpaceDanmakuLayer controller={danmakuController} {spaceId} hidden={previewImmersiveMode} />
  <div
    class="workspace-main flex-1 min-h-0 flex flex-col min-w-0 bg-bg-content"
    class:workspace-main--immersive-hidden={!immersiveChatVisible}
  >
    {#if !previewImmersiveMode}
      <div class="workspace-main-header relative z-20 shrink-0 overflow-visible bg-bg-primary">
        <SpaceWorkspaceHeader
          context={headerContext}
          sessionRename={sessionRenameState}
          resourceActions={resourceActionState}
          actions={headerActions}
        />
      </div>
    {/if}
    <div class="workspace-main-body flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    {#if isRouteDetailView}
      <SpaceRouteDetailHost
        route={{
          view: routeView as RouteDetailView,
          checkpointId: routeCheckpointId,
          cronjobId: routeCronjobId,
          workId: routeWorkId,
          taskId: routeTaskId,
        }}
        {spaceId}
        {space}
        {spaceLoadError}
        {spaceHasMinimalAccess}
        {taskRealtimeEvent}
        ownerUsername={spaceOwnerUsername}
        {spaceSlug}
        onHeaderMeta={(meta) => {
          routeDetailHeaderMeta = meta;
        }}
      />
    {:else}
      <SessionChatPanel
        host={sessionChat}
        {shouldShowNewChatBackground}
        {newChatBackground}
        newChatBackgroundSpaceId={spaceId}
        {shouldShowNewChatProfile}
        {newChatProfileExpanded}
        bind:newChatProfileViewportEl
      >
        {#snippet newChatProfile()}
          <NewChatSpaceProfile
            {spaceId}
            {space}
            members={spaceMembers}
            usage={spaceUsage}
            sandbox={spaceSandbox}
            sandboxLoadedFor={spaceSandboxLoadedFor}
            expanded={newChatProfileExpanded}
            canExpand={newChatProfileCanExpand}
            bodyMaxHeight={newChatProfileBodyMaxHeight}
            bind:contentEl={newChatProfileContentEl}
            bind:bodyEl={newChatProfileBodyEl}
            onToggleExpanded={() => {
              newChatProfileExpanded = !newChatProfileExpanded;
            }}
          />
        {/snippet}
      </SessionChatPanel>
    {/if}
    </div>
    {#if previewImmersiveMode}
      <div class="immersive-chat-controls">
        <button
          type="button"
          class="immersive-chat-control"
          aria-label="Hide chat panel"
          title="Hide chat panel"
          onclick={() => {
            previewLayout.setImmersiveMainVisible(false);
          }}
        >
          <X class="h-3.5 w-3.5" />
        </button>
      </div>
      <button
        type="button"
        class="immersive-chat-resize-handle"
        aria-label="Resize chat panel"
        title="Resize chat panel"
        onpointerdown={beginImmersiveChatResize}
      ></button>
    {/if}
  </div>
  {#if filesColumnMounted || isMobile || previewImmersiveMode}
  <div
    class="files-column-shell min-h-0"
    class:files-column-shell--mobile={isMobile}
    class:files-column-shell--hidden={!isMobile && filesColumnHidden && !previewImmersiveMode}
    class:files-column-shell--immersive={!isMobile && previewImmersiveMode}
    aria-hidden={!isMobile && filesColumnHidden && !previewImmersiveMode}
    inert={!isMobile && filesColumnHidden && !previewImmersiveMode ? true : undefined}
  >
    <div class="files-column-shell-inner min-h-0 flex">
      <SpaceFileDomain
        {...spaceFileDomainProps}
        bind:inlineFileViewMode={fileWorkspace.inlineFileViewMode}
        bind:fileActionMenuOpenPath={fileWorkspace.fileActionMenuOpenPath}
        bind:inlineFileZoom={fileWorkspace.inlineFileZoom}
        bind:inlineFilePanX={fileWorkspace.inlineFilePanX}
        bind:inlineFilePanY={fileWorkspace.inlineFilePanY}
        bind:workPublishTarget
      />
    </div>
  </div>
  {/if}
  <SessionShareDialog
    open={sessionChat.share.open && !!sessionChat.share.sessionId}
    shareUrl={sessionChat.share.shareUrl}
    isPublic={sessionChat.share.isCurrentPublic}
    loadingAccess={sessionChat.share.loadingAccess}
    saving={sessionChat.share.saving}
    copied={sessionChat.share.copied}
    error={sessionChat.share.error}
    onClose={sessionChat.share.close}
    onCopyLink={sessionChat.share.copyLink}
    onSetPublic={sessionChat.share.setPublic}
  />
</div>
{/if}

{#if labelPickerResource}
	<ResourceLabelPicker
		{spaceId}
		resourceType={labelPickerResource.type}
		resourceRef={labelPickerResource.ref}
		anchorEl={labelPickerResource.anchorEl}
		onClose={() => {
			labelPickerResource = null;
		}}
	/>
{/if}

<style>
  @keyframes cohub-scroll-to-bottom-in {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(button[aria-label="Scroll to bottom"]) {
      animation: none !important;
    }
  }

  /*
   * Files column shell: clip the whole (preview + tree) unit when the header
   * hides files. 0fr / 1fr grid is width-accurate without measuring the
   * variable preview+tree size, and only paints the shell (cheap).
   */
  .files-column-shell {
    display: grid;
    flex-shrink: 0;
    min-height: 0;
    grid-template-columns: 1fr;
    transition:
      grid-template-columns var(--motion-panel-duration) var(--motion-panel-ease),
      opacity var(--motion-panel-fade-duration) var(--motion-panel-ease);
  }

  .files-column-shell--hidden {
    grid-template-columns: 0fr;
    opacity: 0;
    pointer-events: none;
  }

  .files-column-shell--immersive {
    /* Immersive preview fills remaining space; shell must not clip. */
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    transition: none;
  }

  /* Mobile: drawer/overlay lives inside domain — shell is a transparent host. */
  .files-column-shell--mobile {
    display: contents;
  }

  .files-column-shell--mobile .files-column-shell-inner {
    display: contents;
  }

  .files-column-shell-inner {
    display: flex;
    min-width: 0;
    overflow: hidden;
  }

  .files-column-shell--immersive .files-column-shell-inner {
    flex: 1 1 auto;
    min-width: 0;
    overflow: visible;
  }

  :global(body.sidebar-resizing) .files-column-shell {
    transition: none !important;
  }

  @media (prefers-reduced-motion: reduce) {
    .files-column-shell {
      transition: none !important;
    }
  }

  @media (min-width: 960px) {
    .workspace-body--preview-immersive {
      isolation: isolate;
    }

    .workspace-body--preview-immersive .workspace-main {
      position: relative;
      z-index: 20;
      flex: 0 0 min(var(--immersive-chat-width), var(--immersive-chat-max-width));
      max-width: min(var(--immersive-chat-width), var(--immersive-chat-max-width));
      min-width: min(320px, calc(100vw - 96px));
      margin: 10px 0 10px var(--immersive-chat-edge-gap);
      overflow: hidden;
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      background: var(--bg-elevated);
      box-shadow: 0 10px 26px color-mix(in srgb, var(--overlay-scrim-strong) 14%, transparent);
    }

    .workspace-body--preview-immersive .workspace-main--immersive-hidden {
      display: none;
    }
  }

  .immersive-chat-controls {
    position: absolute;
    top: 7px;
    right: auto;
    left: 7px;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .immersive-chat-control {
    display: inline-flex;
    height: 24px;
    width: 24px;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: var(--bg-elevated);
    color: var(--text-tertiary);
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
  }

  .immersive-chat-control:hover {
    border-color: var(--border-strong);
    background: var(--bg-hover);
    color: var(--text-secondary);
  }

  .immersive-chat-resize-handle {
    position: absolute;
    top: 0;
    right: -4px;
    bottom: 0;
    z-index: 10;
    width: 8px;
    border: 0;
    padding: 0;
    cursor: col-resize;
    background: transparent;
    touch-action: none;
  }

  .immersive-chat-resize-handle::after {
    content: "";
    position: absolute;
    top: 0;
    left: 3px;
    width: 2px;
    height: 100%;
    background: transparent;
    transition: background-color 120ms ease;
  }

  .immersive-chat-resize-handle:hover::after,
  :global(body.sidebar-resizing) .immersive-chat-resize-handle::after {
    background: var(--border-subtle);
  }

  :global(.right-sidebar-resize-handle) {
    position: absolute;
    top: 0;
    left: -4px;
    width: 8px;
    height: 100%;
    border: none;
    padding: 0;
    cursor: col-resize;
    background: transparent;
    touch-action: none;
    z-index: 10;
  }
  :global(.right-sidebar-resize-handle)::after {
    content: "";
    position: absolute;
    left: 3px;
    top: 0;
    width: 2px;
    height: 100%;
    background: transparent;
    transition: background-color 120ms ease;
  }
  :global(.right-sidebar-resize-handle:hover)::after,
  :global(body.sidebar-resizing .right-sidebar-resize-handle::after) {
    background: var(--border-subtle);
  }
  :global(.inline-panel-resize-handle) {
    position: absolute;
    top: 0;
    left: -4px;
    bottom: 0;
    width: 8px;
    border: none;
    padding: 0;
    cursor: col-resize;
    background: transparent;
    touch-action: none;
    z-index: 10;
  }
  :global(.inline-panel-resize-handle)::after {
    content: "";
    position: absolute;
    left: 3px;
    top: 0;
    width: 2px;
    height: 100%;
    background: transparent;
    transition: background-color 120ms ease;
  }
  :global(.inline-panel-resize-handle:hover)::after,
  :global(body.sidebar-resizing .inline-panel-resize-handle::after) {
    background: var(--border-subtle);
  }
  .preview-tab-cleanup-toast {
    position: fixed;
    right: 1rem;
    bottom: 1rem;
    z-index: 70;
    max-width: min(22rem, calc(100vw - 2rem));
    border: 1px solid var(--color-border-subtle);
    border-radius: 0.75rem;
    background: var(--color-bg-elevated);
    box-shadow: 0 12px 30px rgb(0 0 0 / 18%);
    color: var(--color-text-secondary);
    font-size: 0.75rem;
    line-height: 1rem;
    padding: 0.625rem 0.75rem;
  }

  :global(.port-ready-toast) {
    position: fixed;
    left: 50%;
    top: 58px;
    z-index: 80;
    display: flex;
    max-width: min(680px, calc(100vw - 24px));
    min-width: min(520px, calc(100vw - 24px));
    transform: translateX(-50%);
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    border-radius: 10px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-elevated);
    padding: 9px 10px 9px 12px;
    box-shadow: 0 10px 30px color-mix(in srgb, var(--overlay-scrim-strong) 18%, transparent);
  }
  :global(.port-ready-action) {
    display: inline-flex;
    min-height: 28px;
    align-items: center;
    justify-content: center;
    gap: 5px;
    border-radius: 6px;
    border: 1px solid var(--border-subtle);
    background: transparent;
    padding: 0 8px;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 500;
    text-decoration: none;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  :global(.port-ready-action:hover) {
    border-color: var(--border-strong);
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  :global(.port-ready-action.primary) {
    border-color: color-mix(in srgb, var(--brand) 35%, var(--border-subtle));
    background: color-mix(in srgb, var(--brand) 12%, transparent);
    color: var(--brand);
  }
  :global(.port-ready-action.primary:hover) {
    border-color: color-mix(in srgb, var(--brand) 55%, var(--border-subtle));
    background: color-mix(in srgb, var(--brand) 18%, transparent);
  }
  :global(.port-ready-close) {
    display: inline-flex;
    height: 28px;
    width: 28px;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }
  :global(.port-ready-close:hover) {
    background: var(--bg-hover);
    color: var(--text-secondary);
  }
  @media (max-width: 640px) {
    :global(.port-ready-toast) {
      left: 12px;
      right: 12px;
      top: 52px;
      min-width: 0;
      max-width: none;
      transform: none;
      align-items: stretch;
      flex-direction: column;
      gap: 8px;
    }
  }
  @media (prefers-reduced-motion: no-preference) {
    :global(.port-ready-toast) {
      animation: port-ready-toast-enter 140ms ease-out;
    }
  }
  @keyframes port-ready-toast-enter {
    from {
      opacity: 0;
      transform: translate(-50%, -4px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }
  @media (max-width: 640px) and (prefers-reduced-motion: no-preference) {
    @keyframes port-ready-toast-enter {
      from {
        opacity: 0;
        transform: translateY(-4px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  }
  /* File viewer */
  :global(.icon-btn) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-tertiary);
    text-decoration: none;
    cursor: pointer;
  }
  :global(.icon-btn:hover) { background: var(--bg-hover); color: var(--text-secondary); }
  :global(.action-btn) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 32px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-hover);
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
    text-decoration: none;
  }
  :global(.action-btn:disabled) { opacity: 0.5; cursor: not-allowed; }
  :global(.action-btn.primary) {
    background: var(--brand);
    border-color: var(--brand);
    color: var(--brand-contrast-fg);
  }
  :global(.action-btn.primary:hover) { opacity: 0.9; }
  :global(.menu-item) {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  :global(.menu-item:hover) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  :global(.menu-item.danger) {
    color: var(--error-soft);
  }
  :global(.menu-item.danger:hover) {
    background: var(--error-bg);
    color: var(--error-soft);
  }
  :global(.toggle-btn) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-height: 28px;
    padding: 0 8px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-tertiary);
    font-size: 12px;
    cursor: pointer;
  }
  :global(.toggle-btn:hover) { background: var(--bg-hover); color: var(--text-secondary); }
  :global(.toggle-btn.active) {
    border-color: var(--border-subtle);
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  :global(.segmented-btn) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 24px;
    padding: 0 10px;
    border-radius: 4px;
    border: none;
    background: transparent;
    color: var(--text-tertiary);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 120ms ease;
    white-space: nowrap;
  }
  :global(.segmented-btn:hover) { color: var(--text-secondary); }
  :global(.segmented-btn.active) {
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-weight: 600;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 1px rgba(0,0,0,0.04);
  }
  :global(.zoom-btn) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--text-tertiary);
    cursor: pointer;
    flex-shrink: 0;
  }
  :global(.zoom-btn:hover) { background: var(--bg-hover); color: var(--text-secondary); }
</style>
