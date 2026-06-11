<script lang="ts">
import type { ContentBlock } from "@cohub/protocol/core";
import type {
	GenerationParameterConstraint,
	GenerationPolicy,
	PublicGenerationDeclaration,
} from "@cohub/protocol/generation";
import type {
	MessageToolCallsFile,
	SessionTurnIndexItem,
	SessionTurnRecord,
	StoredIntermediateMessage,
} from "@cohub/protocol/model";
import type { SpacePublicEndpoints } from "@cohub/protocol/ports";
import type { ChannelEnvelope } from "@cohub/protocol/realtime";
import type { CanvasSemanticOp } from "@neta-art/cohub";
import {
	type CheckpointRecord,
	type CronJobRecord,
	type GenerationStreamEvent,
	HttpError,
	type Permission,
	type PromptTemplateCatalogEntry,
	type SessionRecord,
	type SpaceAccessPolicy,
	type SpaceFsEntry,
	type SpaceFsFileResponse,
	type SpaceRecord,
	type SpaceUsageResponse,
	type TaskRunRecord,
	type WorkRecord,
} from "@neta-art/cohub";
import {
	Activity,
	AlertCircle,
	ArrowDown,
	Check,
	Clock,
	Clock3,
	Code,
	Copy,
	Download,
	ExternalLink,
	Eye,
	FolderKanban,
	GitCommitHorizontal,
	Globe,
	Link,
	ListTree,
	Loader2,
	Lock,
	Maximize2,
	MessageSquare,
	Minimize2,
	MoreHorizontal,
	Network,
	PanelRightClose,
	PanelRightOpen,
	Pencil,
	Plus,
	Power,
	PowerOff,
	Rocket,
	Save,
	Settings,
	Share2,
	Terminal,
	TextCursorInput,
	Trash2,
	Upload,
	UserRound,
	X,
} from "lucide-svelte";
import { onDestroy, onMount, tick, untrack } from "svelte";
import { goto } from "$app/navigation";
import { normalizeAvatarToWebp } from "$lib/avatar-image";
import type { SessionListForkRecord } from "$lib/cache/db";
import {
	deleteCanvasPendingTransaction,
	listCanvasPendingTransactions,
	markCanvasPendingTransactionAttempt,
	writeCanvasPendingTransaction,
} from "$lib/cache/repositories/canvas-pending-tx-repo";
import { sessionTurnsRepo } from "$lib/cache/repositories/session-turns-repo";
import { spaceFsRepo } from "$lib/cache/repositories/space-fs-repo";
import { spaceRecordRepo } from "$lib/cache/repositories/space-record-repo";
import { writeTaskRunDetail } from "$lib/cache/repositories/task-runs-repo";
import {
	canvasBootstrapToDocument,
	canvasItemToNode,
	createEmptyCovasDocument,
	parseCovasManifest,
} from "$lib/canvas/canvas-document";
import { ensureCovasExtension, isCovasFile } from "$lib/canvas/canvas-file";
import type { CovasDocument } from "$lib/canvas/canvas-schema";
import { pollCheckpointJob } from "$lib/checkpoints";
import ChatTimeline from "$lib/components/ChatTimeline.svelte";
import Dialog from "$lib/components/Dialog.svelte";
import FileUploadPane from "$lib/components/FileUploadPane.svelte";
import MobileRightDrawer from "$lib/components/MobileRightDrawer.svelte";
import ModelSelector from "$lib/components/ModelSelector.svelte";
import PageHeader from "$lib/components/PageHeader.svelte";
import PortPreview from "$lib/components/PortPreview.svelte";
import ResourceLabelPicker from "$lib/components/ResourceLabelPicker.svelte";
import SessionComposer from "$lib/components/SessionComposer.svelte";
import SessionTaskTray, {
	type GenerationTaskNotice,
	type SessionTaskNotice,
} from "$lib/components/SessionTaskTray.svelte";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import SpaceFileSidebar from "$lib/components/SpaceFileSidebar.svelte";
import ToolCallList from "$lib/components/ToolCallList.svelte";
import TurnBottomSheet from "$lib/components/TurnBottomSheet.svelte";
import TurnRail from "$lib/components/TurnRail.svelte";
import WorkPublishDialog from "$lib/components/WorkPublishDialog.svelte";
import WorkspacePreviewPane from "$lib/components/WorkspacePreviewPane.svelte";
import {
	buildComposerTextContentBlock,
	type ComposerAttachment,
	type ComposerFileAttachment,
	type ComposerImageAttachment,
	createComposerAttachmentId,
	isComposerImageFile,
	isSupportedComposerAttachmentFile,
	isSupportedComposerImageFile,
	MAX_COMPOSER_ATTACHMENTS,
	readComposerTextAttachment,
} from "$lib/composer-attachments";
// SettingsOverlay removed — settings merged inline into detail page
import {
	extractGenerationMediaItems,
	extractGenerationPromptPreview,
} from "$lib/generation-task-media";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import {
	parseResourceLabelRealtimePayload,
	syncResourceLabelsToCache,
} from "$lib/labels/resource-label-cache-sync";
import { extractSpaceMentionsFromText } from "$lib/mentions/space";
import { sdk } from "$lib/sdk";
import { mergeSessionRecord } from "$lib/session-record-merge";
import { sortSessionsByRecentActivity } from "$lib/session-sort";
import type { TimelineItem } from "$lib/session-tree";
import { buildTurnTimelineItems } from "$lib/session-turn-render";
import { validatePublicSlugInput } from "$lib/slug-rules";
import {
	buildSpaceFileDownloadUrl,
	downloadSpaceFile,
} from "$lib/space-file-download";
import type { SpaceFsNode } from "$lib/space-fs";
import {
	buildSpaceCheckpointNewRoute,
	buildSpaceCheckpointRoute,
	buildSpaceCronjobNewRoute,
	buildSpaceCronjobRoute,
	buildSpaceDetailRoute,
	buildSpaceFileRoute,
	buildSpaceSessionRoute,
	buildSpaceSessionTurnRoute,
	buildSpaceTaskRoute,
} from "$lib/space-routes";
import {
	activateSpaceStyle,
	deactivateSpaceStyle,
	isSpaceStylePath,
	refreshSpaceStyle,
} from "$lib/space-style";
import { uploadSpaceEntries } from "$lib/space-upload";
import { authStore } from "$lib/stores/auth.svelte";
import { insertComposerSnippet } from "$lib/stores/composer-insert";
import { modelsCatalogStore } from "$lib/stores/models-catalog.svelte";
import { sessionGenerationStore } from "$lib/stores/session-generation.svelte";
import {
	buildStreamingStoredIntermediateMessages,
	clearGenerationError,
	completeGeneration,
	failGeneration,
	interruptGeneration,
	replaceGenerationTurnId,
	resetGeneration,
	startGenerationRequest,
} from "$lib/stores/session-generation-controller";
import {
	applyGenerationStreamEvent,
	applyGenerationStreamSnapshot,
} from "$lib/stores/session-generation-realtime";
import {
	fetchSessionListWithCache,
	getCachedSessionListSnapshot,
	onSessionListCacheUpdated,
	patchCachedSessionList,
} from "$lib/stores/session-list-cache";
import { SessionRecoveryCoordinator } from "$lib/stores/session-recovery-coordinator";
import { unreadTracker } from "$lib/stores/session-state.svelte";
import {
	clearCachedSpaceFsSubtree,
	fetchSpaceFsDirWithCache,
	getCachedSpaceFsDir,
	patchCachedSpaceFsDir,
} from "$lib/stores/space-fs-cache";
import { patchCachedSpaceList } from "$lib/stores/space-list-cache";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";
import {
	getCachedTaskRuns,
	mergeCachedCronJobTaskRuns,
	mergeCachedTaskRun,
	onTaskRunsCacheUpdated,
	restoreCachedTaskRuns,
} from "$lib/stores/task-runs-cache";
import { mergeTurnsById } from "$lib/stores/turn-cache";
import {
	loadMessageToolCalls,
	loadTurnIntermediate,
} from "$lib/stores/turn-intermediate-cache";
import {
	RIGHT_SIDEBAR_MAX,
	RIGHT_SIDEBAR_MIN,
	uiState,
} from "$lib/stores/ui.svelte";
import {
	entriesFromDataTransfer,
	entriesFromFiles,
	type LocalUploadEntry,
} from "$lib/upload-entries";

type Props = {
	data: {
		spaceId: string;
		view:
			| "space"
			| "session"
			| "file"
			| "checkpoint"
			| "checkpoint-new"
			| "cronjob"
			| "cronjob-new"
			| "task";
		sessionId?: string | null;
		filePath?: string | null;
		checkpointId?: string | null;
		cronjobId?: string | null;
		taskId?: string | null;
		turnSequence?: string | null;
	};
};
type SelectedModel = {
	provider: string;
	id: string;
	name?: string;
};
type InlinePortPreview = {
	port: string;
	url: string;
	autoOpened: boolean;
};
type ActiveFsSource =
	| { kind: "live" }
	| { kind: "checkpoint"; checkpointId: string };
type PortReadyToast = {
	port: string;
	url: string;
};
type SessionViewState = {
	session: SessionRecord | undefined;
	turns: SessionTurnRecord[];
	loading: boolean;
	loaded: boolean;
	error: string;
	hasMore: boolean;
	hasMoreNewer: boolean;
	loadingOlder: boolean;
	loadingNewer: boolean;
	oldestCursor: number | undefined;
};
const MAX_IMAGE_EDGE = 2160;
const SAFARI_IMAGE_MEDIA_TYPE = "image/jpeg";
const SAFARI_IMAGE_QUALITY = 0.82;
const DEFAULT_IMAGE_MEDIA_TYPE = "image/webp";
const DEFAULT_IMAGE_QUALITY = 0.86;
const PRELOAD_THRESHOLD = 10;
const TURN_SCROLL_ANCHOR_OFFSET = 16;
const props = $props();
const data = $derived((props as Props).data);
const spaceId = $derived(data.spaceId);
const routeView = $derived(data.view);
const routeSessionId = $derived(data.sessionId ?? null);
const routeFilePath = $derived(data.filePath ?? null);
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
		: "Space files",
);
const routeCronjobId = $derived(data.cronjobId ?? null);
const routeTaskId = $derived(data.taskId ?? null);
const routeTurnSequence = $derived.by(() => {
	const value = data.turnSequence;
	if (!value) return null;
	const sequence = Number(value);
	return Number.isFinite(sequence) && sequence > 0
		? Math.floor(sequence)
		: null;
});
const MOBILE_BREAKPOINT = 1024;
let isMobile = $state(
	typeof window !== "undefined"
		? window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches
		: false,
);
$effect(() => {
	if (typeof window === "undefined") return;
	const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
	const handler = (event: MediaQueryListEvent) => {
		isMobile = event.matches;
	};
	mql.addEventListener("change", handler);
	return () => mql.removeEventListener("change", handler);
});
const fileMode = $derived<"chat" | "file">(
	routeView === "file" ? "file" : "chat",
);
const isRightDrawerVisible = $derived(
	uiState.rightIsDragging || uiState.mobileRightDrawerOpen,
);
let space = $state<SpaceRecord | null>(null);
function hasAccessPermission(permission: Permission): boolean {
	return space?.access?.permissions.includes(permission) === true;
}
const canManageSessionAccess = $derived(hasAccessPermission("member.manage"));
// True when the backend returned only minimal info (session-level access only)
const spaceHasMinimalAccess = $derived(space?.accessLevel === "minimal");
const canEditSpaceProfile = $derived(hasAccessPermission("space.edit"));
const canEditFiles = $derived(hasAccessPermission("file.edit"));
let spaceSessions = $state<SessionRecord[]>([]);
let sessionStateById = $state<Record<string, SessionViewState>>({});
let activeSessionId = $state<string | null>(null);
let input = $state("");
let attachments = $state<ComposerAttachment[]>([]);
let sending = $state(false);
let aborting = $state(false);
let spaceLoadError = $state("");
let renamingSpace = $state(false);
let renameInput = $state("");
let renameSaving = $state(false);
let renameError = $state("");
type SpaceProfileEditableField = "description";
let spaceProfileEditingField = $state<SpaceProfileEditableField | null>(null);
let spaceProfileDraft = $state("");
let spaceProfileSaving = $state<SpaceProfileEditableField | null>(null);
let spaceProfileError = $state("");
let spaceAvatarUploading = $state(false);
let editingSpaceSlug = $state(false);
let spaceSlugDraft = $state("");
let spaceSlugSaving = $state(false);
let spaceSlugError = $state("");
let copiedSpaceId = $state(false);
let copiedSpaceIdTimer: ReturnType<typeof setTimeout> | null = null;
let copiedSpaceSlugLink = $state(false);
let copiedSpaceSlugLinkTimer: ReturnType<typeof setTimeout> | null = null;
// Session rename (header inline edit)
let sessionRenaming = $state(false);
let sessionRenameValue = $state("");
let sessionRenameSaving = $state(false);
let sessionRenameInputEl: HTMLInputElement | null = $state(null);
let composerError = $state("");
const modelsCatalog = $derived(modelsCatalogStore.items);
const visibleModelsCatalog = $derived(modelsCatalogStore.visibleItems);
let generationModelsCatalog = $state<PublicGenerationDeclaration[] | null>(
	null,
);
let generationPolicyMode = $state<"auto" | "limited">("auto");
let selectedGenerationModels = $state<Set<string>>(new Set());
let generationEnumSelections = $state<
	Record<string, Record<string, Set<string>>>
>({});
let generationNumericConstraints = $state<
	Record<string, Record<string, { min?: number; max?: number }>>
>({});
let generationBooleanConstraints = $state<
	Record<string, Record<string, { value?: boolean }>>
>({});
type PersistedGenerationPolicy = {
	mode: "auto" | "limited";
	models: string[];
	enumSelections: Record<string, Record<string, string[]>>;
	numericConstraints?: Record<
		string,
		Record<string, { min?: number; max?: number }>
	>;
	booleanConstraints?: Record<string, Record<string, { value?: boolean }>>;
};
let promptTemplates = $state<PromptTemplateCatalogEntry[]>([]);
let promptTemplatesLoaded = $state(false);
let showModelSelector = $state(false);
let resourceActionMenuOpen = $state(false);
let fileActionMenuOpenPath = $state<string | null>(null);
let labelPickerResource = $state<{
	type: "session" | "checkpoint" | "file";
	ref: string;
} | null>(null);
let sessionModelById = $state<Record<string, SelectedModel | null>>({});
let fileTree = $state<SpaceFsNode[]>([]);
let fileTreeBySource = $state<Record<string, SpaceFsNode[]>>({});
let fileTreeSourceKey = $state("live");
let fileTreeLoading = $state(false);
let fileTreeError = $state<string | null>(null);
let fileTreeRequestToken = $state(0);
let previewEndpoints = $state<SpacePublicEndpoints>({});
let inlinePortPreview = $state<InlinePortPreview | null>(null);
let portReadyToast = $state<PortReadyToast | null>(null);
let portReadyToastTimer: ReturnType<typeof setTimeout> | null = null;
let workPublishTarget = $state<{
	targetType: "file" | "directory" | "port";
	targetRef: string;
} | null>(null);
let directoryLoadTokenByPath = $state<Record<string, number>>({});
let openFile = $state<SpaceFsFileResponse | null>(null);
let openFileDraft = $state("");
let openFileLoading = $state(false);
let openFileSaving = $state(false);
let openFileError = $state<string | null>(null);
let openFileTooLarge = $state(false);
// Inline file panel state (opened from sidebar, not via route)
let inlineFile = $state<{
	response: SpaceFsFileResponse | null;
	draft: string;
	path: string;
	loading: boolean;
	saving: boolean;
	error: string | null;
	tooLarge: boolean;
} | null>(null);
let inlineCanvas = $state<{
	path: string;
	documentId: string | null;
	document: CovasDocument | null;
	loading: boolean;
	saving: boolean;
	error: string | null;
} | null>(null);
let inlineFileRequestToken = $state(0);
let inlineCanvasRequestToken = $state(0);
let inlineCanvasSyncVersion = $state<number | null>(null);
let inlineCanvasPendingFlush = false;
let inlineCanvasPendingFlushRequested = false;
const selectedFilePath = $derived(
	inlineCanvas?.path ?? inlineFile?.path ?? routeFilePath ?? "",
);
const inlineFileDirty = $derived(
	Boolean(
		inlineFile &&
			inlineFile.response?.kind === "text" &&
			inlineFile.draft !== inlineFile.response.content,
	),
);
const isMarkdownPath = (path: string) => /\.md$/i.test(path);
const isHtmlPath = (path: string) => /\.html?$/i.test(path);
const hasRenderedFilePreview = (file: SpaceFsFileResponse) =>
	file.kind === "text" && (isMarkdownPath(file.path) || isHtmlPath(file.path));
const openWorkPublish = (
	targetType: "file" | "directory" | "port",
	targetRef: string,
) => {
	workPublishTarget = { targetType, targetRef };
};
const publishOpenFile = () => {
	if (openFile) openWorkPublish("file", openFile.path);
};
const publishInlineFile = () => {
	if (inlineFile?.response) openWorkPublish("file", inlineFile.response.path);
};

const inlineFileIsMarkdown = $derived(
	Boolean(
		inlineFile?.response?.kind === "text" &&
			isMarkdownPath(inlineFile.response.path),
	),
);
const inlineFileIsHtml = $derived(
	Boolean(
		inlineFile?.response?.kind === "text" &&
			isHtmlPath(inlineFile.response.path),
	),
);
const inlineFileHasRenderedPreview = $derived(
	inlineFileIsMarkdown || inlineFileIsHtml,
);
const inlineFileExt = $derived.by(() => {
	if (inlineFile?.response?.kind !== "text") return "plaintext";
	return (
		inlineFile.response.name.split(".").pop()?.toLowerCase() ?? "plaintext"
	);
});
const inlineFileIsImage = $derived(
	Boolean(inlineFile?.response?.mimeType?.startsWith("image/")),
);
const inlineFileIsVideo = $derived(
	Boolean(inlineFile?.response?.mimeType?.startsWith("video/")),
);
const inlineFileIsText = $derived(
	Boolean(inlineFile?.response?.kind === "text"),
);
const inlineFileDataUrl = $derived.by(() => {
	if (inlineFile?.response?.kind !== "binary") return null;
	if (inlineFile.response.delivery === "url")
		return inlineFile.response.url ?? null;
	const mime = inlineFile.response.mimeType ?? "application/octet-stream";
	return `data:${mime};base64,${inlineFile.response.content}`;
});
const inlineFileDownloadUrl = $derived.by(() => {
	if (!inlineFile) return "";
	return buildSpaceFileDownloadUrl(spaceId, inlineFile.path);
});
const inlineFileDownloadName = $derived.by(() => {
	if (!inlineFile) return "";
	return inlineFile.path.split("/").pop() ?? "download";
});
const inlinePortEndpoint = $derived.by(() => {
	if (!inlinePortPreview) return null;
	return previewEndpoints[inlinePortPreview.port] ?? null;
});
const activePreviewKind = $derived(
	inlinePortPreview
		? "port"
		: inlineCanvas
			? "canvas"
			: inlineFile
				? "file"
				: null,
);
let inlineFileEdit = $state(true);
function shouldOpenFileInEditMode(file: SpaceFsFileResponse) {
	return !hasRenderedFilePreview(file);
}
// Image zoom state (for both route-based and inline file viewers)
let openFileZoom = $state(1);
let openFilePanX = $state(0);
let openFilePanY = $state(0);
let openFileDragging = $state(false);
let inlineFileZoom = $state(1);
let inlineFilePanX = $state(0);
let inlineFilePanY = $state(0);
let inlineFileDragging = $state(false);
let inlineFileCopied = $state(false);
let inlineFileCopiedTimer: ReturnType<typeof setTimeout> | null = null;
let openFileCopied = $state(false);
let openFileCopiedTimer: ReturnType<typeof setTimeout> | null = null;
let previewPanelWidth = $state(480);
let previewPanelResizeCleanup: (() => void) | null = null;
let previewFocusMode = $state(false);
let previewFocusSnapshot: {
	leftSidebarCollapsed: boolean;
	rightSidebarCollapsed: boolean;
	previewPanelWidth: number;
} | null = null;
let workspaceBodyEl = $state<HTMLDivElement | null>(null);
const CHAT_PANEL_MIN_WIDTH = 320;
const PREVIEW_PANEL_MIN_WIDTH = 280;
const PENDING_FILE_SAVE_ECHO_TTL_MS = 3000;
let pendingFileSavePaths = $state<Set<string>>(new Set());
function markFileSavePending(path: string) {
	pendingFileSavePaths = new Set(pendingFileSavePaths).add(path);
}
function clearFileSavePendingSoon(path: string) {
	setTimeout(() => {
		const next = new Set(pendingFileSavePaths);
		next.delete(path);
		pendingFileSavePaths = next;
	}, PENDING_FILE_SAVE_ECHO_TTL_MS);
}
function isOwnPendingFileSave(
	path: string | undefined,
	source?: string,
	kind?: string,
) {
	return Boolean(
		path &&
			source === "api-fs" &&
			kind === "modify" &&
			pendingFileSavePaths.has(path),
	);
}
// ─── File upload ───
let uploadPaneVisible = $state(false);
let uploadPaneTargetDir = $state("");
let pendingUploadFiles = $state<File[]>([]);
let pendingUploadEntries = $state<LocalUploadEntry[]>([]);
function isLocalUploadEntries(
	value: File[] | LocalUploadEntry[],
): value is LocalUploadEntry[] {
	return value.length > 0 && "file" in value[0] && "relativePath" in value[0];
}
function handleUploadFiles(
	files: File[] | LocalUploadEntry[],
	targetDir: string,
) {
	if (activeFsReadonly || !canEditFiles) return;
	uploadPaneTargetDir = targetDir;
	if (isLocalUploadEntries(files)) {
		pendingUploadEntries = files;
		pendingUploadFiles = [];
	} else {
		pendingUploadFiles = files;
		pendingUploadEntries = files.map((file) => ({
			file,
			relativePath: file.name,
		}));
	}
	uploadPaneVisible = true;
}
async function handleUploadComplete() {
	await refreshFileTree();
}
const openFilePanHandlers = makeImagePanHandlers(
	() => openFileZoom,
	() => openFilePanX,
	() => openFilePanY,
	(v) => (openFilePanX = v),
	(v) => (openFilePanY = v),
	(v) => (openFileDragging = v),
);
const inlineFilePanHandlers = makeImagePanHandlers(
	() => inlineFileZoom,
	() => inlineFilePanX,
	() => inlineFilePanY,
	(v) => (inlineFilePanX = v),
	(v) => (inlineFilePanY = v),
	(v) => (inlineFileDragging = v),
);
const fileDirty = $derived(
	Boolean(
		openFile && openFile.kind === "text" && openFileDraft !== openFile.content,
	),
);
const openFileIsMarkdown = $derived(
	Boolean(openFile?.kind === "text" && isMarkdownPath(openFile.path)),
);
const openFileIsHtml = $derived(
	Boolean(openFile?.kind === "text" && isHtmlPath(openFile.path)),
);
const openFileHasRenderedPreview = $derived(
	openFileIsMarkdown || openFileIsHtml,
);
const openFileExt = $derived.by(() => {
	if (openFile?.kind !== "text") return "plaintext";
	return openFile.name.split(".").pop()?.toLowerCase() ?? "plaintext";
});
const openFileIsImage = $derived(
	Boolean(openFile?.mimeType?.startsWith("image/")),
);
const openFileIsVideo = $derived(
	Boolean(openFile?.mimeType?.startsWith("video/")),
);
const openFileIsText = $derived(Boolean(openFile?.kind === "text"));
const openFileDataUrl = $derived.by(() => {
	if (openFile?.kind !== "binary") return null;
	if (openFile.delivery === "url") return openFile.url ?? null;
	const mime = openFile.mimeType ?? "application/octet-stream";
	return `data:${mime};base64,${openFile.content}`;
});
const openFileDownloadUrl = $derived.by(() => {
	if (!routeFilePath) return "";
	return buildSpaceFileDownloadUrl(spaceId, routeFilePath);
});
const openFileDownloadName = $derived.by(() => {
	if (!routeFilePath) return "";
	return routeFilePath.split("/").pop() ?? "download";
});
let fileEdit = $state(true);
$effect(() => {
	if (openFile) fileEdit = shouldOpenFileInEditMode(openFile);
});
$effect(() => {
	if (inlineFile?.response)
		inlineFileEdit = shouldOpenFileInEditMode(inlineFile.response);
});
let loadedSpaceId = $state<string | null>(null);
let pageMounted = false;
let pageVisible = true;
let pageOnline = true;
let wsConnectionState = $state<
	"idle" | "connecting" | "reconnecting" | "open" | "closed" | "error"
>("idle");
let wsCanRecover = $state(false);
let statusRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let statusRefreshInFlight = false;
let creatingSession = $state(false);
let createSessionError = $state("");
let loadingSessionIds = $state<Record<string, boolean>>({});
let bootstrapping = $state(true);
let spaceStatusNotice = $state("");
let spaceStatusNoticeTimer: ReturnType<typeof setTimeout> | null = null;
let shouldAutoFollow = $state(true);
let bottomFollowFrame: number | null = null;
let bottomFollowActive = false;
let composerHostEl = $state<HTMLDivElement | null>(null);
let composerHeight = $state(0);
let hasUnread = $derived.by(() => {
	const session = activeSessionState?.session;
	if (
		!session ||
		!activeSessionState.loaded ||
		activeSessionState.turns.length === 0
	)
		return false;
	return unreadTracker.isUnread(session, session.lastMessageId);
});
let autoScrollGuard = $state(false);
let restoringBottomSessionId = $state<string | null>(null);
let programmaticScrollActive = false;
let programmaticScrollTarget: number | null = null;
let userScrollActive = false;
let rightSidebarResizeCleanup: (() => void) | null = null;
let listEl = $state<HTMLDivElement | null>(null);
let chatTimelineRef = $state<{
	preparePrepend: () => void;
	finalizePrepend: () => void;
} | null>(null);
let turnIndexBySessionId = $state<Record<string, SessionTurnIndexItem[]>>({});
let turnIndexLoadingBySessionId = $state<Record<string, boolean>>({});
let turnIndexRetryAfterBySessionId = $state<Record<string, number>>({});
let loadingTurnSequence = $state<number | null>(null);
let currentTurnSequence = $state<number | null>(null);
let highlightedTurnSequence = $state<number | null>(null);
let turnMarkerPositions = $state<Record<number, number>>({});
let turnMarkerHeights = $state<Record<number, number>>({});
let timelineScrollTop = $state(0);
let timelineScrollHeight = $state(0);
let timelineClientHeight = $state(0);
let showTurnBottomSheet = $state(false);
let appliedRouteTurnKey = $state<string | null>(null);
let preloadingSessionIds = new Set<string>();
let turnMarkerMeasureFrame: number | null = null;
let vimScrollFrame: number | null = null;
let vimScrollVelocity = 0;
let vimScrollStopTimer: ReturnType<typeof setTimeout> | null = null;
let vimPendingGTimer: ReturnType<typeof setTimeout> | null = null;
let lastTurnIndexRefreshKey = "";
let refreshSessionsListInFlight: Promise<void> | null = null;
let refreshSessionsListQueued = false;
let refreshSessionsListQueuedForce = false;
const sessionLoadInFlight = new Map<string, Promise<void>>();
const turnWindowLoadInFlight = new Map<string, Promise<void>>();
const syncSessionNewerInFlight = new Map<string, Promise<void>>();
const turnHydrationInFlight = new Map<string, Promise<void>>();
const postSendRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let reconnectSyncInFlight: Promise<void> | null = null;
const streamSnapshotRecoveryInFlight = new Map<string, Promise<boolean>>();
const reconcileSessionTailInFlight = new Map<string, Promise<void>>();
const lastStreamSnapshotRecoveryByTurn = new Map<string, number>();
const POST_SEND_RECOVERY_GRACE_MS = 2500;
const STREAM_SNAPSHOT_RECOVERY_COOLDOWN_MS = 15000;
let lastRecoveredConnectionId: string | null = null;
let lastConnectionState:
	| "idle"
	| "connecting"
	| "reconnecting"
	| "open"
	| "closed"
	| "error" = "idle";
type SessionScrollAnchor = {
	sequence: number;
	offset: number;
	updatedAt: number;
};
const SESSION_SCROLL_ANCHOR_STORAGE_KEY = "cohub:session_scroll_anchor";
let scrollAnchorBySession = $state.raw(new Map<string, SessionScrollAnchor>());
let pendingRestoreSessionId = $state<string | null>(null);
let activeAnchorRestore = $state<
	(SessionScrollAnchor & { sessionId: string }) | null
>(null);
let pendingTimelineMarkdownRenders = 0;
let anchorRestoreWaitingForMarkdown = false;
// ─── Share ───
let showShareModal = $state(false);
let shareModalSessionId = $state<string | null>(null);
let shareCopied = $state(false);
let shareCopiedTimer: ReturnType<typeof setTimeout> | null = null;
let shareModalError = $state("");
let shareModalSaving = $state(false);
let forkingTurnId = $state<string | null>(null);
let sessionAccessById = $state<Record<string, SpaceAccessPolicy | null>>({});
let checkpointDetail = $state<CheckpointRecord | null>(null);
let spaceCheckpoints = $state<CheckpointRecord[]>([]);
let checkpointDetailLoading = $state(false);
let checkpointDetailError = $state("");
let checkpointCopied = $state(false);
let checkpointCopiedTimer: ReturnType<typeof setTimeout> | null = null;
let checkpointCreateDescription = $state("");
let checkpointCreateSubmitting = $state(false);
let checkpointCreateError = $state("");
// ─── Cronjobs ───
let cronjobDetail = $state<CronJobRecord | null>(null);
let cronjobDetailLoading = $state(false);
let cronjobDetailError = $state("");
let cronjobRuns = $state<TaskRunRecord[]>([]);
let cronjobRunsLoading = $state(false);
let cronjobActionInProgress = $state(false);
let cronjobToggleError = $state("");
// ─── Cronjob New Form ───
let cronjobNewTitle = $state("");
let cronjobNewExpression = $state("");
let cronjobNewPrompt = $state("");
let cronjobNewSubmitting = $state(false);
let cronjobNewError = $state("");
// ─── Tasks ───
let taskRunDetail = $state<TaskRunRecord | null>(null);
let taskRunDetailLoading = $state(false);
let taskRunDetailError = $state("");
let taskRunProgress = $state<unknown>(null);
let taskRunPollTimer: ReturnType<typeof setInterval> | null = null;
let taskRunRefreshInFlight: Promise<void> | null = null;
let taskRunRefreshInFlightTaskId: string | null = null;
let generationTaskRunById = $state<Record<string, TaskRunRecord>>({});
let backgroundBashTaskRunById = $state<Record<string, TaskRunRecord>>({});
let backgroundBashHydrateKey = "";
const taskHydrateRetryCounts = new Map<string, number>();
const taskHydrateRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let pendingFollowupActionIds = $state<Set<string>>(new Set());
// ─── Token Usage ───
type TokenUsageData = SpaceUsageResponse;
type TokenUsageDays = 7 | 30 | 90;
type DailyUsagePoint = {
	date: string;
	label: string;
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheTokens: number;
	costTotal: number;
	requestCount: number;
};
const TOKEN_USAGE_DAY_OPTIONS: TokenUsageDays[] = [7, 30, 90];
let tokenUsage = $state<TokenUsageData | null>(null);
let tokenUsageDays = $state<TokenUsageDays>(7);
let tokenUsageLoading = $state(false);
let tokenUsageError = $state("");

function getUsageDateKey(date: Date): string {
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
function formatUsageDateLabel(date: Date, days: number): string {
	if (days <= 7) {
		return date.toLocaleDateString(undefined, { weekday: "short" });
	}
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function buildDailyUsageSeries(
	hourlyStats: TokenUsageData["hourly"],
	days: number,
): DailyUsagePoint[] {
	const today = new Date();
	today.setUTCHours(0, 0, 0, 0);
	const dailyMap = new Map<string, DailyUsagePoint>();
	for (let i = days - 1; i >= 0; i--) {
		const date = new Date(today.getTime() - i * 86400000);
		const key = getUsageDateKey(date);
		dailyMap.set(key, {
			date: key,
			label: formatUsageDateLabel(date, days),
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheTokens: 0,
			costTotal: 0,
			requestCount: 0,
		});
	}
	for (const stat of hourlyStats) {
		const date = new Date(stat.bucketStartAt);
		const key = getUsageDateKey(date);
		const point = dailyMap.get(key);
		if (!point) continue;
		point.totalTokens += stat.totalTokens ?? 0;
		point.inputTokens += stat.inputTokens ?? 0;
		point.outputTokens += stat.outputTokens ?? 0;
		point.cacheTokens +=
			(stat.cacheReadTokens ?? 0) + (stat.cacheWriteTokens ?? 0);
		point.costTotal = Number(
			(point.costTotal + (stat.costTotal ?? 0)).toFixed(4),
		);
		point.requestCount += stat.requestCount ?? 0;
	}
	return Array.from(dailyMap.values());
}
function getUsageLinePoints(
	series: DailyUsagePoint[],
	width: number,
	height: number,
): string {
	if (series.length === 0) return "";
	const maxCost = Math.max(...series.map((point) => point.costTotal), 0);
	const step = series.length > 1 ? width / (series.length - 1) : 0;
	return series
		.map((point, index) => {
			const x = series.length > 1 ? index * step : width / 2;
			const ratio = maxCost > 0 ? point.costTotal / maxCost : 0;
			const y = height - ratio * (height - 12) - 6;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");
}
function getUsageBreakdownPercent(value: number, total: number): number {
	return total > 0 ? Math.round((value / total) * 100) : 0;
}
function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}
function formatCost(n: number): string {
	const formatted =
		n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n.toFixed(4);
	return `${formatted}`;
}

function getSessionTitle(session: SessionRecord): string {
	const candidates = [session.title, session.latestMessageText];
	for (const candidate of candidates) {
		const normalized = candidate
			?.replace(/\s+/g, " ")
			.replace(/^[:\-\s]+/, "")
			.trim();
		if (normalized) return normalized.slice(0, 36);
	}
	return "New chat";
}
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
function hasSessionPermission(sessionId: string): boolean {
	const access = sessionAccessById[sessionId];
	return (
		!!access &&
		(access.anonymous_user === "guest" ||
			access.anonymous_user === "builder" ||
			access.signed_in_user === "guest" ||
			access.signed_in_user === "builder")
	);
}
async function loadTokenUsage(days: TokenUsageDays = tokenUsageDays) {
	tokenUsageLoading = true;
	tokenUsageError = "";
	try {
		const result = await sdk.space(spaceId).usage.get(days);
		tokenUsage = result;
	} catch (error) {
		tokenUsageError =
			error instanceof Error ? error.message : "Failed to load usage data";
	} finally {
		tokenUsageLoading = false;
	}
}
function selectTokenUsageDays(days: TokenUsageDays) {
	if (tokenUsageDays === days && tokenUsage) return;
	tokenUsageDays = days;
	void loadTokenUsage(days);
}
async function removeSessionAccess(sessionId: string) {
	try {
		await sdk.sessionAccess.remove(sessionId);
		sessionAccessById = { ...sessionAccessById, [sessionId]: null };
	} catch {
		// Silently fail
	}
}
async function loadSpaceCheckpoints() {
	try {
		const result = await sdk.space(spaceId).checkpoints.list();
		spaceCheckpoints = result.checkpoints ?? [];
	} catch {
		spaceCheckpoints = [];
	}
}

async function loadCheckpointDetail(checkpointId: string) {
	const requestSpaceId = spaceId;
	const isCurrentRequest = () =>
		spaceId === requestSpaceId &&
		routeView === "checkpoint" &&
		routeCheckpointId === checkpointId;
	checkpointDetailLoading = true;
	checkpointDetailError = "";
	try {
		const result = await sdk
			.space(requestSpaceId)
			.checkpoints.get(checkpointId);
		if (!isCurrentRequest()) return;
		checkpointDetail = result.checkpoint;
	} catch (error) {
		if (!isCurrentRequest()) return;
		checkpointDetail = null;
		checkpointDetailError =
			error instanceof Error ? error.message : "Failed to load save";
	} finally {
		if (isCurrentRequest()) checkpointDetailLoading = false;
	}
}
let checkpointIdCopied = $state(false);
let checkpointIdCopiedTimer: ReturnType<typeof setTimeout> | null = null;
async function handleCopyCheckpointId() {
	if (!checkpointDetail) return;
	await navigator.clipboard.writeText(checkpointDetail.id);
	checkpointIdCopied = true;
	if (checkpointIdCopiedTimer) clearTimeout(checkpointIdCopiedTimer);
	checkpointIdCopiedTimer = setTimeout(() => {
		checkpointIdCopied = false;
	}, 1800);
}
async function handleCopyCheckpointCommitHash() {
	if (!checkpointDetail) return;
	await navigator.clipboard.writeText(checkpointDetail.commitHash);
	checkpointCopied = true;
	if (checkpointCopiedTimer) clearTimeout(checkpointCopiedTimer);
	checkpointCopiedTimer = setTimeout(() => {
		checkpointCopied = false;
	}, 1800);
}
async function handleForkCheckpoint() {
	if (!checkpointDetail) return;
	await goto(
		`/spaces/new?checkpointId=${encodeURIComponent(checkpointDetail.id)}`,
	);
}
async function handleCreateCheckpointSubmit(event: SubmitEvent) {
	event.preventDefault();
	if (checkpointCreateSubmitting) return;
	checkpointCreateError = "";
	checkpointCreateSubmitting = true;
	try {
		const { taskRunId } = await sdk
			.space(spaceId)
			.checkpoints.create(checkpointCreateDescription.trim() || null);
		const run = await pollCheckpointJob(taskRunId);
		const checkpointId =
			typeof run.result === "object" &&
			run.result !== null &&
			"checkpointId" in run.result &&
			typeof run.result.checkpointId === "string"
				? run.result.checkpointId
				: null;
		window.dispatchEvent(
			new CustomEvent("cohub:checkpoints-updated", { detail: { spaceId } }),
		);
		if (checkpointId) {
			await goto(buildSpaceCheckpointRoute(spaceId, checkpointId));
			return;
		}
		await goto(buildSpaceDetailRoute(spaceId));
	} catch (error) {
		if (error instanceof HttpError && error.status === 409) {
			checkpointCreateError = "Checkpoint save in progress.";
		} else {
			checkpointCreateError =
				error instanceof Error ? error.message : "Failed to save checkpoint";
		}
	} finally {
		checkpointCreateSubmitting = false;
	}
}
// ─── Cronjob detail & actions ───
async function loadCronjobDetail(cronjobId: string) {
	const requestSpaceId = spaceId;
	const isCurrentRequest = () =>
		spaceId === requestSpaceId &&
		routeView === "cronjob" &&
		routeCronjobId === cronjobId;
	cronjobDetailLoading = true;
	cronjobDetailError = "";
	cronjobToggleError = "";
	try {
		const { jobs } = await sdk.cronJobs.list(requestSpaceId);
		if (!isCurrentRequest()) return;
		const job = jobs.find((j) => j.id === cronjobId) ?? null;
		if (!job) {
			cronjobDetail = null;
			cronjobDetailError = "Scheduled job not found";
			return;
		}
		cronjobDetail = job;
		const { runs } = await sdk.cronJobs.runs(cronjobId);
		if (!isCurrentRequest()) return;
		cronjobRuns = runs;
		mergeCachedCronJobTaskRuns(requestSpaceId, cronjobId, runs);
	} catch (error) {
		if (!isCurrentRequest()) return;
		cronjobDetail = null;
		cronjobDetailError =
			error instanceof Error ? error.message : "Failed to load scheduled job";
	} finally {
		if (isCurrentRequest()) cronjobDetailLoading = false;
	}
}
async function handleToggleCronjob(enabled: boolean) {
	if (!cronjobDetail || cronjobActionInProgress) return;
	cronjobActionInProgress = true;
	try {
		await sdk.cronJobs.toggle(cronjobDetail.id, enabled);
		cronjobDetail = { ...cronjobDetail, enabled };
	} catch (error) {
		cronjobToggleError =
			error instanceof Error ? error.message : "Failed to toggle";
		void loadCronjobDetail(cronjobDetail.id);
	} finally {
		cronjobActionInProgress = false;
	}
}
async function handleDeleteCronjob() {
	if (
		!cronjobDetail ||
		!confirm("Are you sure you want to delete this cronjob?")
	)
		return;
	cronjobActionInProgress = true;
	try {
		await sdk.cronJobs.delete(cronjobDetail.id);
		await goto(buildSpaceDetailRoute(spaceId));
	} catch (error) {
		cronjobDetailError =
			error instanceof Error ? error.message : "Failed to delete";
		cronjobActionInProgress = false;
	}
}
async function handleCreateCronjobSubmit(event: SubmitEvent) {
	event.preventDefault();
	if (cronjobNewSubmitting) return;
	if (!cronjobNewTitle.trim()) {
		cronjobNewError = "Title is required";
		return;
	}
	if (!cronjobNewExpression.trim()) {
		cronjobNewError = "Cron expression is required";
		return;
	}
	if (!cronjobNewPrompt.trim()) {
		cronjobNewError = "Prompt message is required";
		return;
	}
	const cronParts = cronjobNewExpression.trim().split(/\s+/);
	if (cronParts.length !== 5) {
		cronjobNewError =
			"Invalid cron expression format. Expected 5 fields, e.g. 0 9 * * *.";
		return;
	}
	cronjobNewError = "";
	cronjobNewSubmitting = true;
	try {
		await sdk.space(spaceId).prompt({
			title: cronjobNewTitle.trim(),
			content: [{ type: "text", text: cronjobNewPrompt.trim() }],
			schedule: {
				mode: "repeat",
				cronExpression: cronjobNewExpression.trim(),
				timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
			},
		});
		await goto(buildSpaceDetailRoute(spaceId));
	} catch (error) {
		cronjobNewError =
			error instanceof Error ? error.message : "Failed to create cronjob";
	} finally {
		cronjobNewSubmitting = false;
	}
}
// ─── Task detail ───
function clearTaskRunPoll() {
	if (taskRunPollTimer) clearInterval(taskRunPollTimer);
	taskRunPollTimer = null;
}
function ensureTaskRunPoll(taskId: string, intervalMs = 5000) {
	if (taskRunPollTimer) return;
	taskRunPollTimer = setInterval(
		() => void refreshTaskDetail(taskId),
		intervalMs,
	);
}

const isActiveTaskRun = (run: Pick<TaskRunRecord, "status"> | null) =>
	run?.status === "pending" || run?.status === "running";
const isGenerationTaskRun = (
	run: (Partial<TaskRunRecord> & { type?: string }) | null | undefined,
) => (run?.taskType ?? run?.type) === "generation";
const taskRunSortTime = (run: Pick<TaskRunRecord, "updatedAt" | "createdAt">) =>
	Date.parse(run.updatedAt ?? run.createdAt ?? "") || 0;
function getTaskPayloadData(run: Pick<TaskRunRecord, "payload">) {
	return asRecord(asRecord(run.payload)?.data);
}
function getBackgroundBashOrigin(run: Pick<TaskRunRecord, "payload">) {
	const origin = asRecord(getTaskPayloadData(run)?.origin);
	return origin?.kind === "bash_tool_call" ? origin : null;
}
function isBackgroundBashTaskRun(
	run: (Partial<TaskRunRecord> & { type?: string }) | null | undefined,
): run is TaskRunRecord {
	return (
		(run?.taskType ?? run?.type) === "run_command" &&
		!!run?.sessionId &&
		!!getBackgroundBashOrigin(run as Pick<TaskRunRecord, "payload">)
	);
}
function tailText(value: unknown, limit = 420) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
}
function extractBackgroundBashResultPreview(result: unknown) {
	const content = asRecord(result)?.content;
	if (!Array.isArray(content)) return null;
	for (const block of content) {
		const record = asRecord(block);
		if (record?.type === "tool_result") return tailText(record.content);
	}
	return null;
}
function formatBackgroundBashSubtitle(run: TaskRunRecord) {
	const result = asRecord(run.result);
	const parts = [
		run.status === "completed"
			? "Completed"
			: run.status === "failed"
				? "Failed"
				: run.status === "pending"
					? "Queued"
					: "Running",
		typeof result?.exitCode === "number" ? `exit ${result.exitCode}` : null,
		typeof result?.durationMs === "number"
			? `${Math.max(1, Math.round(result.durationMs / 1000))}s`
			: null,
	].filter(Boolean);
	return parts.join(" · ") || null;
}
function mergeTaskRunRecord(
	current: TaskRunRecord | null,
	patch: Partial<TaskRunRecord> & {
		id: string;
		type?: string;
		userId?: string | null;
	},
): TaskRunRecord {
	const now = new Date().toISOString();
	return {
		id: patch.id,
		jobId: patch.jobId ?? current?.jobId ?? patch.id,
		cronJobId: patch.cronJobId ?? current?.cronJobId ?? null,
		taskType: patch.taskType ?? patch.type ?? current?.taskType ?? "unknown",
		status: patch.status ?? current?.status ?? "pending",
		payload: patch.payload ?? current?.payload ?? null,
		result: patch.result ?? current?.result ?? null,
		errorMessage: patch.errorMessage ?? current?.errorMessage ?? null,
		attemptCount: patch.attemptCount ?? current?.attemptCount ?? 0,
		spaceId: patch.spaceId ?? current?.spaceId ?? spaceId,
		sessionId: patch.sessionId ?? current?.sessionId ?? null,
		turnId: patch.turnId ?? current?.turnId ?? null,
		userUuid: patch.userUuid ?? patch.userId ?? current?.userUuid ?? null,
		scheduledAt: patch.scheduledAt ?? current?.scheduledAt ?? null,
		startedAt: patch.startedAt ?? current?.startedAt ?? null,
		finishedAt: patch.finishedAt ?? current?.finishedAt ?? null,
		createdAt: patch.createdAt ?? current?.createdAt ?? now,
		updatedAt: patch.updatedAt ?? current?.updatedAt ?? now,
	};
}
function mergeTaskRunList(
	runs: TaskRunRecord[],
	patch: Partial<TaskRunRecord> & {
		id: string;
		type?: string;
		userId?: string | null;
	},
) {
	const existing = runs.find((run) => run.id === patch.id) ?? null;
	const nextRun = mergeTaskRunRecord(existing, patch);
	const nextRuns = existing
		? runs.map((run) => (run.id === patch.id ? nextRun : run))
		: [nextRun, ...runs];
	return [...nextRuns].sort((a, b) => taskRunSortTime(b) - taskRunSortTime(a));
}
function isDisplayableGenerationTaskRun(
	run: TaskRunRecord,
): run is TaskRunRecord & {
	sessionId: string;
	status: GenerationTaskNotice["status"];
} {
	return (
		isGenerationTaskRun(run) &&
		!!run.sessionId &&
		(run.status === "pending" ||
			run.status === "running" ||
			run.status === "completed" ||
			run.status === "failed")
	);
}
function toGenerationTaskNotice(
	run: TaskRunRecord,
): GenerationTaskNotice | null {
	if (!isDisplayableGenerationTaskRun(run)) return null;
	return {
		id: run.id,
		kind: "generation",
		spaceId: run.spaceId ?? spaceId,
		sessionId: run.sessionId,
		turnId: run.turnId ?? null,
		status: run.status,
		title:
			run.status === "completed"
				? "Generation ready"
				: run.status === "failed"
					? "Generation failed"
					: "Generating",
		subtitle: null,
		preview: extractGenerationPromptPreview(run.payload),
		mediaItems: extractGenerationMediaItems(run.result),
		createdAt: run.createdAt,
		startedAt: run.startedAt,
		updatedAt: run.updatedAt,
		finishedAt: run.finishedAt,
	};
}
function toBackgroundBashTaskNotice(
	run: TaskRunRecord,
): SessionTaskNotice | null {
	if (!isBackgroundBashTaskRun(run)) return null;
	if (!["pending", "running", "completed", "failed"].includes(run.status))
		return null;
	const sessionId = run.sessionId;
	if (!sessionId) return null;
	const data = getTaskPayloadData(run);
	const command =
		typeof data?.command === "string"
			? data.command.trim()
			: "Background command";
	return {
		id: run.id,
		kind: "background_bash",
		spaceId: run.spaceId ?? spaceId,
		sessionId,
		turnId: run.turnId ?? null,
		status: run.status,
		title: command.split("\n")[0]?.trim() || "Background command",
		subtitle: formatBackgroundBashSubtitle(run),
		preview: extractBackgroundBashResultPreview(run.result),
		mediaItems: [],
		createdAt: run.createdAt,
		startedAt: run.startedAt,
		updatedAt: run.updatedAt,
		finishedAt: run.finishedAt,
	};
}
function upsertGenerationTaskRun(run: TaskRunRecord) {
	if (!isGenerationTaskRun(run)) return;
	generationTaskRunById = { ...generationTaskRunById, [run.id]: run };
}
function upsertBackgroundBashTaskRun(run: TaskRunRecord) {
	if (!isBackgroundBashTaskRun(run)) return;
	backgroundBashTaskRunById = { ...backgroundBashTaskRunById, [run.id]: run };
}
async function refreshTaskDetail(taskId: string, loading = false) {
	if (taskRunRefreshInFlight && taskRunRefreshInFlightTaskId === taskId)
		return taskRunRefreshInFlight;
	const requestSpaceId = spaceId;
	const isCurrentRequest = () =>
		spaceId === requestSpaceId &&
		routeView === "task" &&
		routeTaskId === taskId;
	const run = (async () => {
		if (loading) taskRunDetailLoading = true;
		taskRunDetailError = "";
		try {
			const { run, progress } = await sdk.tasks.get(taskId);
			if (!isCurrentRequest()) return;
			taskRunDetail = run;
			taskRunProgress = progress;
			if (run.spaceId) mergeCachedTaskRun(run.spaceId, run);
			if (run.status !== "pending" && run.status !== "running")
				clearTaskRunPoll();
		} catch (error) {
			if (!isCurrentRequest()) return;
			taskRunDetail = null;
			taskRunProgress = null;
			taskRunDetailError =
				error instanceof Error ? error.message : "Failed to load task run";
			clearTaskRunPoll();
		} finally {
			if (loading && isCurrentRequest()) taskRunDetailLoading = false;
		}
	})();
	taskRunRefreshInFlightTaskId = taskId;
	taskRunRefreshInFlight = run.finally(() => {
		if (taskRunRefreshInFlight === run) {
			taskRunRefreshInFlight = null;
			taskRunRefreshInFlightTaskId = null;
		}
	});
	return taskRunRefreshInFlight;
}

async function loadTaskDetail(taskId: string) {
	clearTaskRunPoll();
	taskRunProgress = null;
	await refreshTaskDetail(taskId, true);
	if (isActiveTaskRun(taskRunDetail)) ensureTaskRunPoll(taskId);
}
async function hydrateTaskRun(taskId: string) {
	try {
		const detail = await sdk.tasks.get(taskId);
		taskHydrateRetryCounts.delete(taskId);
		const retryTimer = taskHydrateRetryTimers.get(taskId);
		if (retryTimer) clearTimeout(retryTimer);
		taskHydrateRetryTimers.delete(taskId);
		if (detail.run.spaceId) mergeCachedTaskRun(detail.run.spaceId, detail.run);
		if (detail.run.spaceId)
			void writeTaskRunDetail(
				detail.run.spaceId,
				detail.run,
				detail.progress,
			).catch(() => undefined);
		if (isGenerationTaskRun(detail.run)) upsertGenerationTaskRun(detail.run);
		if (isBackgroundBashTaskRun(detail.run))
			upsertBackgroundBashTaskRun(detail.run);
	} catch {
		const retryCount = taskHydrateRetryCounts.get(taskId) ?? 0;
		if (retryCount >= 3 || taskHydrateRetryTimers.has(taskId)) return;
		taskHydrateRetryCounts.set(taskId, retryCount + 1);
		const timer = setTimeout(
			() => {
				taskHydrateRetryTimers.delete(taskId);
				void hydrateTaskRun(taskId);
			},
			1000 * 2 ** retryCount,
		);
		taskHydrateRetryTimers.set(taskId, timer);
	}
}
async function hydrateActiveSessionTasks(sessionId: string) {
	try {
		const { runs } = await sdk.tasks.list({
			spaceId,
			sessionId,
			status: "active",
			limit: 50,
		});
		for (const run of runs) {
			mergeCachedTaskRun(spaceId, run);
			if (isGenerationTaskRun(run)) upsertGenerationTaskRun(run);
			if (isBackgroundBashTaskRun(run)) upsertBackgroundBashTaskRun(run);
		}
	} catch (error) {
		console.warn("Failed to load session tasks:", error);
	}
}
function openShareModal(sessionId: string) {
	if (!canManageSessionAccess) return;
	shareModalSessionId = sessionId;
	showShareModal = true;
	shareCopied = false;
	shareModalError = "";
}
async function shareAndCopyLink() {
	if (!shareModalSessionId || !canManageSessionAccess) return;
	shareModalError = "";
	shareModalSaving = true;
	try {
		await sdk.sessionAccess.set(shareModalSessionId, {
			anonymous_user: "guest",
		});
		const url = `${window.location.origin}${buildSpaceSessionRoute(spaceId, shareModalSessionId)}`;
		await navigator.clipboard.writeText(url);
		shareCopied = true;
		if (shareCopiedTimer) clearTimeout(shareCopiedTimer);
		shareCopiedTimer = setTimeout(() => {
			shareCopied = false;
		}, 2000);
		sessionAccessById = {
			...sessionAccessById,
			[shareModalSessionId]: { signed_in_user: null, anonymous_user: "guest" },
		};
	} catch (error) {
		shareModalError =
			error instanceof Error ? error.message : "Failed to share session";
	} finally {
		shareModalSaving = false;
	}
}
async function makeSessionPrivate() {
	if (!shareModalSessionId || !canManageSessionAccess) return;
	shareModalError = "";
	shareModalSaving = true;
	try {
		await sdk.sessionAccess.remove(shareModalSessionId);
		sessionAccessById = { ...sessionAccessById, [shareModalSessionId]: null };
		showShareModal = false;
	} catch (error) {
		shareModalError =
			error instanceof Error ? error.message : "Failed to make session private";
	} finally {
		shareModalSaving = false;
	}
}
const activeSessionState = $derived(
	activeSessionId ? (sessionStateById[activeSessionId] ?? null) : null,
);
const sessionTaskNotices = $derived.by<SessionTaskNotice[]>(() => {
	if (!activeSessionId) return [];
	return [
		...Object.values(generationTaskRunById)
			.filter((run) => run.sessionId === activeSessionId)
			.map(toGenerationTaskNotice),
		...Object.values(backgroundBashTaskRunById)
			.filter((run) => run.sessionId === activeSessionId)
			.map(toBackgroundBashTaskNotice),
	]
		.filter((notice): notice is SessionTaskNotice => notice !== null)
		.sort((a, b) => taskRunSortTime(a) - taskRunSortTime(b));
});
$effect(() => {
	const sessionId = activeSessionId;
	if (!sessionId) {
		backgroundBashHydrateKey = "";
		return;
	}
	const hydrateKey = `${spaceId}:${sessionId}`;
	if (backgroundBashHydrateKey !== hydrateKey) {
		backgroundBashHydrateKey = hydrateKey;
		void restoreCachedTaskRuns(spaceId, sessionId)
			.then((runs) => {
				for (const run of runs) {
					if (isGenerationTaskRun(run)) upsertGenerationTaskRun(run);
					if (isBackgroundBashTaskRun(run)) upsertBackgroundBashTaskRun(run);
				}
			})
			.catch(() => undefined);
		void hydrateActiveSessionTasks(sessionId);
	}
});
const browserTabTitle = $derived.by(() => {
	const spaceTitle = normalizeTabTitleSegment(
		space?.name || space?.title || spaceId,
		"Space",
		42,
	);
	const routeTitle = (() => {
		if (routeView === "space") return null;
		if (routeView === "session") {
			return activeSessionState?.session
				? normalizeTabTitleSegment(
						getSessionTitle(activeSessionState.session),
						"Chat",
					)
				: "Chat";
		}
		if (routeView === "file") {
			return normalizeTabTitleSegment(
				routeFilePath?.split("/").pop(),
				"File",
				44,
			);
		}
		if (routeView === "checkpoint") {
			return normalizeTabTitleSegment(
				checkpointDetail?.description?.trim() ||
					(routeCheckpointId ? `Save ${routeCheckpointId.slice(0, 8)}` : null),
				"Save",
			);
		}
		if (routeView === "checkpoint-new") return "New save";
		if (routeView === "cronjob") {
			return normalizeTabTitleSegment(cronjobDetail?.title, "Cronjob");
		}
		if (routeView === "cronjob-new") return "New cronjob";
		if (routeView === "task") return "Task";
		return null;
	})();
	return routeTitle
		? `${routeTitle} · ${spaceTitle} — Cohub`
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
const bootstrapStage = $derived.by<string | null>(() => {
	const value = bootstrapMeta?.stage;
	return typeof value === "string" && value.trim().length > 0 ? value : null;
});
const bootstrapErrorMessage = $derived.by<string | null>(() => {
	const value = bootstrapMeta?.errorMessage;
	return typeof value === "string" && value.trim().length > 0 ? value : null;
});
const canCreateSession = $derived(Boolean(space && !creatingSession));
const firstCatalogModel = $derived(
	visibleModelsCatalog && visibleModelsCatalog.length > 0
		? {
				provider: visibleModelsCatalog[0].provider,
				id: visibleModelsCatalog[0].id,
				name: visibleModelsCatalog[0].model.name as string | undefined,
			}
		: null,
);
const TERMINAL_GENERATION_STATUSES = new Set([
	"idle",
	"completed",
	"failed",
	"interrupted",
]);
const activeSessionModel = $derived.by(() => {
	if (!activeSessionId) return null;
	return sessionModelById[activeSessionId] ?? firstCatalogModel;
});
const activeGenerationState = $derived.by(() =>
	sessionGenerationStore.get(activeSessionId),
);
const activeTurnIndex = $derived.by(() =>
	activeSessionId ? (turnIndexBySessionId[activeSessionId] ?? []) : [],
);
const activeTurnRailItems = $derived.by<SessionTurnIndexItem[]>(() => {
	const bySequence = new Map<number, SessionTurnIndexItem>();
	for (const item of activeTurnIndex) bySequence.set(item.sequence, item);
	for (const turn of activeSessionState?.turns ?? []) {
		const item = turnToIndexItem(turn);
		bySequence.set(turn.sequence, {
			...bySequence.get(turn.sequence),
			...item,
		});
	}
	return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
});
const loadedTurnSequences = $derived.by(() =>
	(activeSessionState?.turns ?? [])
		.map((turn) => turn.sequence)
		.sort((a, b) => a - b),
);
const loadedMinTurnSequence = $derived(loadedTurnSequences.at(0) ?? null);
const loadedMaxTurnSequence = $derived(loadedTurnSequences.at(-1) ?? null);
const unloadedOlderTurnCount = $derived.by(() => {
	if (loadedMinTurnSequence == null) return 0;
	return activeTurnIndex.filter((turn) => turn.sequence < loadedMinTurnSequence)
		.length;
});
const unloadedNewerTurnCount = $derived.by(() => {
	if (loadedMaxTurnSequence == null) return 0;
	return activeTurnIndex.filter((turn) => turn.sequence > loadedMaxTurnSequence)
		.length;
});
const activeStreamingIntermediateMessages = $derived.by(() => {
	if (!activeGenerationState || !activeSessionId) return [];
	return buildStreamingStoredIntermediateMessages({
		spaceId,
		sessionId: activeSessionId,
		turnId: activeGenerationState.turnId,
		intermediateMessages: activeGenerationState.intermediateMessages,
	});
});
const activeStreamError = $derived.by(() => activeGenerationState?.error ?? "");
const activeSessionIsRunning = $derived.by(() =>
	Boolean(
		activeGenerationState &&
			!TERMINAL_GENERATION_STATUSES.has(activeGenerationState.status),
	),
);
const composerNotice = $derived.by(() => activeStreamError || composerError);
const timeline = $derived.by<TimelineItem[]>(() => {
	const state = activeSessionState;
	if (!state) return [];
	return buildTurnTimelineItems({
		sessionId: activeSessionId,
		turns: state.turns,
		streaming:
			activeGenerationState &&
			(activeGenerationState.status === "streaming" ||
				activeGenerationState.status === "pending" ||
				!TERMINAL_GENERATION_STATUSES.has(activeGenerationState.status))
				? {
						sessionId: activeSessionId ?? "active",
						turnId: activeGenerationState.turnId ?? null,
						anchorUserMessageId:
							activeGenerationState.anchorUserMessageId ?? null,
						intermediateMessages: activeStreamingIntermediateMessages,
						contentBlocks: activeGenerationState.contentBlocks,
						finalizedPreview: activeGenerationState.finalizedPreview,
						status: activeGenerationState.status,
						runtimePhase: activeGenerationState.runtimePhase,
						runtimeProvider: activeGenerationState.runtimeProvider,
						runtimeModel: activeGenerationState.runtimeModel,
					}
				: null,
	});
});
function preferFollowupQueueTurn(
	current: SessionTurnRecord,
	incoming: SessionTurnRecord,
) {
	if (isOptimisticTurn(current) && !isOptimisticTurn(incoming)) return incoming;
	if (!isOptimisticTurn(current) && isOptimisticTurn(incoming)) return current;
	return Date.parse(incoming.updatedAt) >= Date.parse(current.updatedAt)
		? incoming
		: current;
}

function dedupeFollowupQueueTurns(turns: SessionTurnRecord[]) {
	const byKey = new Map<string, SessionTurnRecord>();
	for (const turn of turns) {
		const clientMessageId = getTurnClientMessageId(turn);
		const key = clientMessageId
			? `client:${clientMessageId}`
			: `turn:${turn.id}`;
		const current = byKey.get(key);
		byKey.set(key, current ? preferFollowupQueueTurn(current, turn) : turn);
	}
	return [...byKey.values()].sort(
		(a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt),
	);
}

const followupQueue = $derived.by(() =>
	dedupeFollowupQueueTurns(
		(activeSessionState?.turns ?? []).filter(
			(turn) =>
				turn.status === "queued" &&
				turn.intent === "followup" &&
				turn.id !== activeGenerationState?.turnId,
		),
	),
);

function turnPreviewText(turn: SessionTurnRecord) {
	return (turn.userText ?? "").replace(/\s+/g, " ").trim() || "Follow-up";
}

function removeQueuedFollowupDuplicates(
	turns: SessionTurnRecord[],
	resolvedTurn: SessionTurnRecord,
) {
	const clientMessageId = getTurnClientMessageId(resolvedTurn);
	if (!clientMessageId)
		return turns.filter((turn) => turn.id !== resolvedTurn.id);
	return turns.filter((turn) => {
		if (turn.id === resolvedTurn.id) return false;
		return !(
			turn.status === "queued" &&
			turn.intent === "followup" &&
			getTurnClientMessageId(turn) === clientMessageId
		);
	});
}

async function refreshSessionAfterStaleFollowupAction(sessionId: string) {
	composerError = "";
	await syncSessionNewer(sessionId, null).catch(() => undefined);
}

async function handleSteerFollowup(turnId: string) {
	if (!activeSessionId || !space || pendingFollowupActionIds.has(turnId))
		return;
	const sessionId = activeSessionId;
	pendingFollowupActionIds = new Set([...pendingFollowupActionIds, turnId]);
	composerError = "";
	try {
		const result = await sdk
			.space(spaceId)
			.session(sessionId)
			.steerTurn(turnId);
		const current = sessionStateById[sessionId];
		if (current) {
			sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					...current,
					turns: mergeTurnsById(
						removeQueuedFollowupDuplicates(current.turns, result.turn),
						result.affectedTurns,
						{ preferIncoming: true },
					),
				},
			};
		}
		startGenerationRequest(sessionId, {
			spaceId,
			turnId: result.turn.id,
		});
	} catch (error) {
		if (error instanceof HttpError && error.status === 409) {
			await refreshSessionAfterStaleFollowupAction(sessionId);
			return;
		}
		composerError =
			error instanceof Error ? error.message : "Failed to steer follow-up";
	} finally {
		const next = new Set(pendingFollowupActionIds);
		next.delete(turnId);
		pendingFollowupActionIds = next;
	}
}

async function handleCancelFollowup(turnId: string) {
	if (!activeSessionId || !space || pendingFollowupActionIds.has(turnId))
		return;
	const sessionId = activeSessionId;
	pendingFollowupActionIds = new Set([...pendingFollowupActionIds, turnId]);
	composerError = "";
	try {
		const result = await sdk
			.space(spaceId)
			.session(sessionId)
			.cancelTurn(turnId);
		const current = sessionStateById[sessionId];
		if (current) {
			sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					...current,
					turns: mergeTurnsById(
						removeQueuedFollowupDuplicates(current.turns, result.turn),
						[result.turn],
						{ preferIncoming: true },
					),
				},
			};
		}
	} catch (error) {
		if (error instanceof HttpError && error.status === 409) {
			await refreshSessionAfterStaleFollowupAction(sessionId);
			return;
		}
		composerError =
			error instanceof Error ? error.message : "Failed to cancel follow-up";
	} finally {
		const next = new Set(pendingFollowupActionIds);
		next.delete(turnId);
		pendingFollowupActionIds = next;
	}
}

function turnToIndexItem(turn: SessionTurnRecord): SessionTurnIndexItem {
	return {
		id: turn.id,
		sessionId: turn.sessionId,
		sequence: turn.sequence,
		status: turn.status,
		startedAt: turn.startedAt,
		completedAt: turn.completedAt,
		durationMs: turn.durationMs,
		createdAt: turn.createdAt,
		updatedAt: turn.updatedAt,
		userPreview: turn.userText,
		assistantPreview: turn.assistantText,
		provider: turn.provider,
		model: turn.model,
		finalUsage: turn.finalUsage,
		totalUsage: turn.totalUsage,
		errorMessage: turn.errorMessage,
	};
}
function getSessionModelKey(sessionId: string) {
	return `cohub:model:${sessionId}`;
}
function getSessionGenerationPolicyKey(sessionId: string) {
	return `cohub:generation-policy:${sessionId}`;
}
function loadSessionModel(sessionId: string): SelectedModel | null {
	try {
		const raw = localStorage.getItem(getSessionModelKey(sessionId));
		return raw ? (JSON.parse(raw) as SelectedModel) : null;
	} catch {
		return null;
	}
}
function saveSessionModel(sessionId: string, model: SelectedModel | null) {
	if (!model) {
		localStorage.removeItem(getSessionModelKey(sessionId));
	} else {
		localStorage.setItem(getSessionModelKey(sessionId), JSON.stringify(model));
	}
}
function serializeGenerationEnumSelections() {
	return Object.fromEntries(
		Object.entries(generationEnumSelections).map(([model, parameters]) => [
			model,
			Object.fromEntries(
				Object.entries(parameters).map(([parameter, values]) => [
					parameter,
					[...values],
				]),
			),
		]),
	);
}

function sanitizeGenerationNumericConstraints(
	value: unknown,
): Record<string, Record<string, { min?: number; max?: number }>> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).map(([model, parameters]) => [
			model,
			Object.fromEntries(
				Object.entries(
					parameters &&
						typeof parameters === "object" &&
						!Array.isArray(parameters)
						? parameters
						: {},
				).flatMap(([parameter, rawConstraint]) => {
					if (
						!rawConstraint ||
						typeof rawConstraint !== "object" ||
						Array.isArray(rawConstraint)
					)
						return [];
					const constraint = rawConstraint as { min?: unknown; max?: unknown };
					const next: { min?: number; max?: number } = {};
					if (
						typeof constraint.min === "number" &&
						Number.isFinite(constraint.min)
					)
						next.min = constraint.min;
					if (
						typeof constraint.max === "number" &&
						Number.isFinite(constraint.max)
					)
						next.max = constraint.max;
					return next.min === undefined && next.max === undefined
						? []
						: [[parameter, next]];
				}),
			),
		]),
	);
}

function sanitizeGenerationBooleanConstraints(
	value: unknown,
): Record<string, Record<string, { value?: boolean }>> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).map(([model, parameters]) => [
			model,
			Object.fromEntries(
				Object.entries(
					parameters &&
						typeof parameters === "object" &&
						!Array.isArray(parameters)
						? parameters
						: {},
				).flatMap(([parameter, rawConstraint]) => {
					if (
						!rawConstraint ||
						typeof rawConstraint !== "object" ||
						Array.isArray(rawConstraint)
					)
						return [];
					const value = (rawConstraint as { value?: unknown }).value;
					return typeof value === "boolean" ? [[parameter, { value }]] : [];
				}),
			),
		]),
	);
}

function loadSessionGenerationPolicy(
	sessionId: string,
): PersistedGenerationPolicy | null {
	try {
		const raw = localStorage.getItem(getSessionGenerationPolicyKey(sessionId));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<PersistedGenerationPolicy>;
		return {
			mode: parsed.mode === "limited" ? "limited" : "auto",
			models: Array.isArray(parsed.models)
				? parsed.models.filter(
						(model): model is string => typeof model === "string",
					)
				: [],
			enumSelections: Object.fromEntries(
				Object.entries(parsed.enumSelections ?? {}).map(
					([model, parameters]) => [
						model,
						Object.fromEntries(
							Object.entries(parameters ?? {}).map(([parameter, values]) => [
								parameter,
								Array.isArray(values) ? values.map(String) : [],
							]),
						),
					],
				),
			),
			numericConstraints: sanitizeGenerationNumericConstraints(
				parsed.numericConstraints,
			),
			booleanConstraints: sanitizeGenerationBooleanConstraints(
				parsed.booleanConstraints,
			),
		};
	} catch {
		return null;
	}
}
function applySessionGenerationPolicy(
	policy: PersistedGenerationPolicy | null,
) {
	generationPolicyMode = policy?.mode ?? "auto";
	selectedGenerationModels = new Set(policy?.models ?? []);
	generationEnumSelections = Object.fromEntries(
		Object.entries(policy?.enumSelections ?? {}).map(([model, parameters]) => [
			model,
			Object.fromEntries(
				Object.entries(parameters).map(([parameter, values]) => [
					parameter,
					new Set(values),
				]),
			),
		]),
	);
	generationNumericConstraints = policy?.numericConstraints ?? {};
	generationBooleanConstraints = policy?.booleanConstraints ?? {};
}
function saveSessionGenerationPolicy(sessionId: string) {
	localStorage.setItem(
		getSessionGenerationPolicyKey(sessionId),
		JSON.stringify({
			mode: generationPolicyMode,
			models: [...selectedGenerationModels],
			enumSelections: serializeGenerationEnumSelections(),
			numericConstraints: generationNumericConstraints,
			booleanConstraints: generationBooleanConstraints,
		} satisfies PersistedGenerationPolicy),
	);
}
function persistActiveSessionGenerationPolicy() {
	if (!activeSessionId) return;
	saveSessionGenerationPolicy(activeSessionId);
}
function ensureSessionModelLoaded(sessionId: string) {
	if (sessionModelById[sessionId]) return;
	sessionModelById = {
		...sessionModelById,
		[sessionId]: loadSessionModel(sessionId),
	};
}
async function loadModelsCatalog() {
	try {
		await modelsCatalogStore.load();
	} catch (error) {
		console.error("Failed to load models catalog:", error);
	}
}
async function loadGenerationModelsCatalog() {
	if (generationModelsCatalog) return;
	try {
		const response = await sdk.models.listMultimodal();
		generationModelsCatalog = response.models;
	} catch (error) {
		console.error("Failed to load generation models catalog:", error);
	}
}
function buildTurnGenerationPolicy(): GenerationPolicy | null {
	if (generationPolicyMode !== "limited") return null;
	const models = [...selectedGenerationModels]
		.filter(
			(model) =>
				generationModelsCatalog?.some((item) => item.model === model) ?? true,
		)
		.map((model) => {
			const declaration = generationModelsCatalog?.find(
				(item) => item.model === model,
			);
			const parameterPolicies: Record<string, GenerationParameterConstraint> =
				{};
			for (const [name, selectedValues] of Object.entries(
				generationEnumSelections[model] ?? {},
			)) {
				const spec = declaration?.parameters?.[name];
				const enumValues =
					spec && "enum" in spec && Array.isArray(spec.enum) ? spec.enum : [];
				if (enumValues.length === 0 || selectedValues.size >= enumValues.length)
					continue;
				const allowed = enumValues.filter((value) =>
					selectedValues.has(String(value)),
				);
				if (allowed.length > 0)
					parameterPolicies[name] = {
						kind: "enum",
						values: allowed as Array<string | number | boolean>,
					};
			}
			for (const [name, constraint] of Object.entries(
				generationNumericConstraints[model] ?? {},
			)) {
				const spec = declaration?.parameters?.[name];
				const type = spec && "type" in spec ? spec.type : null;
				if (type !== "integer" && type !== "number") continue;
				const next: Extract<
					GenerationParameterConstraint,
					{ kind: "integer" | "number" }
				> = {
					kind: type === "integer" ? "integer" : "number",
				};
				if (constraint.min !== undefined) next.min = constraint.min;
				if (constraint.max !== undefined) next.max = constraint.max;
				if (next.min !== undefined || next.max !== undefined)
					parameterPolicies[name] = next;
			}
			for (const [name, constraint] of Object.entries(
				generationBooleanConstraints[model] ?? {},
			)) {
				const spec = declaration?.parameters?.[name];
				if (!spec || !("type" in spec) || spec.type !== "boolean") continue;
				if (constraint.value !== undefined)
					parameterPolicies[name] = {
						kind: "boolean",
						value: constraint.value,
					};
			}
			return Object.keys(parameterPolicies).length > 0
				? { model, parameters: parameterPolicies }
				: { model };
		});
	return models.length > 0 ? { version: 1, mode: "limited", models } : null;
}
function getDefaultGenerationEnumSelections(
	model: PublicGenerationDeclaration,
): Record<string, Set<string>> {
	const result: Record<string, Set<string>> = {};
	for (const [name, spec] of Object.entries(model.parameters ?? {})) {
		if ("enum" in spec && Array.isArray(spec.enum) && spec.enum.length > 0) {
			result[name] = new Set(spec.enum.map(String));
		}
	}
	return result;
}
function ensureGenerationModelEnumSelections(modelId: string) {
	const model = generationModelsCatalog?.find((item) => item.model === modelId);
	if (!model || generationEnumSelections[modelId]) return;
	generationEnumSelections = {
		...generationEnumSelections,
		[modelId]: getDefaultGenerationEnumSelections(model),
	};
}
function setGenerationPolicyMode(mode: "auto" | "limited") {
	generationPolicyMode = mode;
	persistActiveSessionGenerationPolicy();
}
function setGenerationModelSelected(modelId: string, selected: boolean) {
	if (generationPolicyMode !== "limited") generationPolicyMode = "limited";
	const nextModels = new Set(selectedGenerationModels);
	if (selected) {
		nextModels.add(modelId);
		ensureGenerationModelEnumSelections(modelId);
	} else {
		nextModels.delete(modelId);
		const { [modelId]: _removedEnum, ...restEnum } = generationEnumSelections;
		generationEnumSelections = restEnum;
		const { [modelId]: _removedNumeric, ...restNumeric } =
			generationNumericConstraints;
		generationNumericConstraints = restNumeric;
		const { [modelId]: _removedBoolean, ...restBoolean } =
			generationBooleanConstraints;
		generationBooleanConstraints = restBoolean;
	}
	selectedGenerationModels = nextModels;
	persistActiveSessionGenerationPolicy();
}
function ensureGenerationModelSelectedForPolicy(modelId: string) {
	if (generationPolicyMode !== "limited") generationPolicyMode = "limited";
	if (!selectedGenerationModels.has(modelId)) {
		selectedGenerationModels = new Set([...selectedGenerationModels, modelId]);
	}
}

function setGenerationEnumValueSelected(
	modelId: string,
	parameter: string,
	value: string,
	selected: boolean,
) {
	const model = generationModelsCatalog?.find((item) => item.model === modelId);
	if (!model) return;
	const base =
		generationEnumSelections[modelId] ??
		getDefaultGenerationEnumSelections(model);
	const nextValues = new Set(base[parameter] ?? []);
	if (selected) nextValues.add(value);
	else nextValues.delete(value);
	generationEnumSelections = {
		...generationEnumSelections,
		[modelId]: {
			...base,
			[parameter]: nextValues,
		},
	};
	ensureGenerationModelSelectedForPolicy(modelId);
	persistActiveSessionGenerationPolicy();
}

function setGenerationNumericConstraint(
	modelId: string,
	parameter: string,
	constraint: { min?: number; max?: number },
) {
	const nextConstraint: { min?: number; max?: number } = {};
	if (constraint.min !== undefined && Number.isFinite(constraint.min))
		nextConstraint.min = constraint.min;
	if (constraint.max !== undefined && Number.isFinite(constraint.max))
		nextConstraint.max = constraint.max;
	generationNumericConstraints = {
		...generationNumericConstraints,
		[modelId]: {
			...(generationNumericConstraints[modelId] ?? {}),
			[parameter]: nextConstraint,
		},
	};
	ensureGenerationModelSelectedForPolicy(modelId);
	persistActiveSessionGenerationPolicy();
}

function setGenerationBooleanConstraint(
	modelId: string,
	parameter: string,
	constraint: { value?: boolean },
) {
	generationBooleanConstraints = {
		...generationBooleanConstraints,
		[modelId]: {
			...(generationBooleanConstraints[modelId] ?? {}),
			[parameter]:
				constraint.value === undefined ? {} : { value: constraint.value },
		},
	};
	ensureGenerationModelSelectedForPolicy(modelId);
	persistActiveSessionGenerationPolicy();
}
async function loadPromptTemplates() {
	if (promptTemplatesLoaded) return;
	try {
		const response = await sdk.prompts.list({ spaceId });
		promptTemplates = response.prompts;
		promptTemplatesLoaded = true;
	} catch (error) {
		console.error("Failed to load prompt templates:", error);
	}
}
function handleModelSelect(model: { provider: string; id: string }) {
	if (!activeSessionId) return;
	const catalogItem = modelsCatalog?.find(
		(item) => item.provider === model.provider && item.id === model.id,
	);
	const selected = {
		provider: model.provider,
		id: model.id,
		name: catalogItem?.model.name as string | undefined,
	} satisfies SelectedModel;
	sessionModelById = {
		...sessionModelById,
		[activeSessionId]: selected,
	};
	saveSessionModel(activeSessionId, selected);
	showModelSelector = false;
	focusComposerSoon();
}
function buildPreferredSessionRoute(sessionId: string) {
	return buildSpaceSessionRoute(spaceId, sessionId);
}
function navigateToSession(
	sessionId: string,
	options?: { replaceState?: boolean },
) {
	return goto(buildPreferredSessionRoute(sessionId), {
		replaceState: options?.replaceState ?? true,
		keepFocus: true,
		noScroll: true,
	});
}
function updateUrlSession(sessionId: string | null) {
	if (sessionId) {
		return navigateToSession(sessionId, { replaceState: true });
	}
	return goto(buildSpaceDetailRoute(spaceId), {
		replaceState: true,
		keepFocus: true,
		noScroll: true,
	});
}
function loadSessionScrollAnchors() {
	try {
		const raw = localStorage.getItem(SESSION_SCROLL_ANCHOR_STORAGE_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw) as Record<string, SessionScrollAnchor>;
		scrollAnchorBySession = new Map(
			Object.entries(parsed).filter(([, anchor]) =>
				Boolean(
					anchor &&
						typeof anchor.sequence === "number" &&
						typeof anchor.offset === "number",
				),
			),
		);
	} catch {
		// ignore
	}
}
function persistSessionScrollAnchorsNow() {
	try {
		const data = Object.fromEntries(scrollAnchorBySession.entries());
		localStorage.setItem(
			SESSION_SCROLL_ANCHOR_STORAGE_KEY,
			JSON.stringify(data),
		);
	} catch {
		// ignore
	}
}
function setSessionScrollAnchor(
	sessionId: string,
	anchor: SessionScrollAnchor,
) {
	scrollAnchorBySession.set(sessionId, anchor);
	persistSessionScrollAnchorsNow();
}
function getSessionScrollAnchor(sessionId: string) {
	const anchor = scrollAnchorBySession.get(sessionId);
	return anchor;
}
function clearSessionScrollAnchor(sessionId: string) {
	if (!scrollAnchorBySession.delete(sessionId)) return;
	persistSessionScrollAnchorsNow();
}
function getMessageElementAbsoluteTop(node: HTMLElement) {
	if (!listEl) return 0;
	const containerRect = listEl.getBoundingClientRect();
	const nodeRect = node.getBoundingClientRect();
	return listEl.scrollTop + (nodeRect.top - containerRect.top);
}
function updateTimelineScrollMetrics() {
	if (!listEl) {
		timelineScrollTop = 0;
		timelineScrollHeight = 0;
		timelineClientHeight = 0;
		return;
	}
	timelineScrollTop = listEl.scrollTop;
	timelineScrollHeight = listEl.scrollHeight;
	timelineClientHeight = listEl.clientHeight;
}
function measureTurnMarkerPositions() {
	if (!listEl) {
		turnMarkerPositions = {};
		turnMarkerHeights = {};
		updateTimelineScrollMetrics();
		return;
	}
	updateTimelineScrollMetrics();
	const scrollContainer = listEl;
	const maxScroll = Math.max(
		1,
		scrollContainer.scrollHeight - scrollContainer.clientHeight,
	);
	const railThumbHeightPercent = Math.min(
		64,
		Math.max(
			6,
			(scrollContainer.clientHeight / scrollContainer.scrollHeight) * 100,
		),
	);
	const railUsablePercent = 100 - railThumbHeightPercent;
	const toRailTopPercent = (scrollTop: number) =>
		Math.min(
			railUsablePercent,
			Math.max(0, (scrollTop / maxScroll) * railUsablePercent),
		);
	const anchors = Array.from(
		listEl.querySelectorAll<HTMLElement>('[data-turn-anchor="user"]'),
	);
	const turnRanges = anchors.map((anchor, index) => {
		const sequence = Number(anchor.dataset.turnSequence);
		const start = Math.max(
			0,
			getMessageElementAbsoluteTop(anchor) - TURN_SCROLL_ANCHOR_OFFSET,
		);
		const nextAnchor = anchors[index + 1];
		const nextStart = nextAnchor
			? Math.max(
					0,
					getMessageElementAbsoluteTop(nextAnchor) - TURN_SCROLL_ANCHOR_OFFSET,
				)
			: scrollContainer.scrollHeight;
		const end = Math.max(start, nextStart);
		return { anchor, sequence, start, end };
	});
	const positions: Record<number, number> = {};
	const heights: Record<number, number> = {};
	for (const range of turnRanges) {
		if (!Number.isFinite(range.sequence)) continue;
		const turnHeight = Math.max(
			range.anchor.offsetHeight,
			range.end - range.start,
		);
		positions[range.sequence] = toRailTopPercent(range.start);
		const scrollRatio = Math.max(0.015, turnHeight / maxScroll);
		heights[range.sequence] = Math.min(22, Math.max(8, scrollRatio * 100));
	}
	turnMarkerPositions = positions;
	turnMarkerHeights = heights;
}
function scheduleTurnMarkerMeasure() {
	if (turnMarkerMeasureFrame != null) return;
	turnMarkerMeasureFrame = requestAnimationFrame(() => {
		turnMarkerMeasureFrame = null;
		measureTurnMarkerPositions();
	});
}
function isGenerationInProgress(sessionId: string) {
	const status = sessionGenerationStore.get(sessionId)?.status;
	return Boolean(status && !TERMINAL_GENERATION_STATUSES.has(status));
}
function markVisibleLatestTurnViewed(
	sessionId: string,
	nodes: HTMLElement[],
	containerRect: DOMRect,
) {
	const state = sessionStateById[sessionId];
	if (!state?.session) return;
	const latestTurn =
		state.turns.findLast(
			(turn) => turn.status !== "running" && turn.status !== "abort_requested",
		) ?? null;
	if (!latestTurn) return;
	const latestVisibleTurnSequence = nodes.reduce((latest, node) => {
		const rect = node.getBoundingClientRect();
		if (rect.bottom <= containerRect.top + 8) return latest;
		if (rect.top >= containerRect.bottom - 8) return latest;
		const sequence = Number(node.dataset.turnSequence);
		return Number.isFinite(sequence) ? Math.max(latest, sequence) : latest;
	}, -Infinity);
	if (latestVisibleTurnSequence >= latestTurn.sequence) {
		unreadTracker.markViewed(sessionId, state.session.lastMessageId);
	}
}
function captureCurrentScrollAnchor(sessionId: string) {
	if (!listEl) return;
	const nodes = Array.from(
		listEl.querySelectorAll<HTMLElement>("[data-sequence]"),
	);
	if (nodes.length === 0) return;
	const containerRect = listEl.getBoundingClientRect();
	const firstVisible =
		nodes.find(
			(node) => node.getBoundingClientRect().bottom > containerRect.top + 8,
		) ?? nodes[0];
	if (!firstVisible) return;
	const sequence = Number(firstVisible.dataset.sequence);
	if (!Number.isFinite(sequence)) return;
	const absoluteTop = getMessageElementAbsoluteTop(firstVisible);
	setSessionScrollAnchor(sessionId, {
		sequence,
		offset: listEl.scrollTop - absoluteTop,
		updatedAt: Date.now(),
	});
	markVisibleLatestTurnViewed(sessionId, nodes, containerRect);
	updateCurrentTurnSequence();
}
function writeBottomScrollAnchor(sessionId: string) {
	if (!listEl) return;
	const nodes = Array.from(
		listEl.querySelectorAll<HTMLElement>("[data-sequence]"),
	);
	const lastNode = nodes.at(-1);
	if (!lastNode) {
		clearSessionScrollAnchor(sessionId);
		return;
	}
	const sequence = Number(lastNode.dataset.sequence);
	if (!Number.isFinite(sequence)) {
		clearSessionScrollAnchor(sessionId);
		return;
	}
	const absoluteTop = getMessageElementAbsoluteTop(lastNode);
	setSessionScrollAnchor(sessionId, {
		sequence,
		offset: listEl.scrollTop - absoluteTop,
		updatedAt: Date.now(),
	});
	const state = sessionStateById[sessionId];
	unreadTracker.markViewed(sessionId, state?.session?.lastMessageId ?? null);
}
function makeFsNode(entry: SpaceFsEntry): SpaceFsNode {
	return {
		...entry,
		children: [],
		isOpen: false,
		isLoaded: false,
		isLoading: false,
	};
}
function buildFsEntry(path: string, type: SpaceFsEntry["type"]): SpaceFsEntry {
	const normalizedPath = path.trim().replace(/^\/+|\/+$/g, "");
	const name = normalizedPath.split("/").pop() ?? normalizedPath;
	return {
		name,
		path: normalizedPath,
		type,
		size: 0,
		mimeType: null,
		mtimeMs: Date.now(),
	};
}
function getParentDirPath(path: string): string {
	const normalizedPath = path.trim().replace(/^\/+|\/+$/g, "");
	if (!normalizedPath.includes("/")) return "";
	return normalizedPath.slice(0, normalizedPath.lastIndexOf("/"));
}
function updateRootFsEntries(entries: SpaceFsEntry[]) {
	setActiveFileTree(makeFsNodes(entries, fileTree));
}
function setActiveFileTree(nodes: SpaceFsNode[]) {
	fileTree = nodes;
	fileTreeBySource = { ...fileTreeBySource, [activeFsSourceKey]: nodes };
}
function listActiveFsDir(path: string) {
	if (activeFsSource.kind === "checkpoint") {
		return sdk
			.space(spaceId)
			.checkpoints(activeFsSource.checkpointId)
			.files.list(path);
	}
	return sdk.space(spaceId).files.list(path);
}
function readActiveFsFile(path: string) {
	if (activeFsSource.kind === "checkpoint") {
		return sdk
			.space(spaceId)
			.checkpoints(activeFsSource.checkpointId)
			.files.read(path);
	}
	return sdk.space(spaceId).files.read(path);
}
async function patchFsDirectory(
	dirPath: string,
	updater: (entries: SpaceFsEntry[]) => SpaceFsEntry[],
) {
	const nextEntries = await patchCachedSpaceFsDir(spaceId, dirPath, updater);
	if (dirPath === "") {
		updateRootFsEntries(nextEntries);
		return nextEntries;
	}
	setActiveFileTree(
		replaceNodeChildren(fileTree, dirPath, makeFsNodes(nextEntries)),
	);
	return nextEntries;
}
function mergeFsNodeLists(
	nodes: SpaceFsNode[],
	previousNodes: SpaceFsNode[] = [],
): SpaceFsNode[] {
	if (previousNodes.length === 0) return nodes;
	const previousByPath = new Map(
		previousNodes.map((node) => [node.path, node]),
	);
	return nodes.map((node) => {
		const previous = previousByPath.get(node.path);
		if (!previous || previous.type !== node.type) return node;
		if (node.type !== "dir") return node;
		return {
			...node,
			children: previous.children,
			isOpen: previous.isOpen,
			isLoaded: previous.isLoaded,
			isLoading: false,
		};
	});
}
function makeFsNodes(
	entries: SpaceFsEntry[],
	previousNodes: SpaceFsNode[] = [],
): SpaceFsNode[] {
	return mergeFsNodeLists(entries.map(makeFsNode), previousNodes);
}
function replaceNodeChildren(
	nodes: SpaceFsNode[],
	nodePath: string,
	children: SpaceFsNode[],
): SpaceFsNode[] {
	return nodes.map((node) => {
		if (node.path === nodePath)
			return {
				...node,
				children: mergeFsNodeLists(children, node.children),
				isLoaded: true,
				isLoading: false,
				isOpen: true,
			};
		if (node.children.length > 0)
			return {
				...node,
				children: replaceNodeChildren(node.children, nodePath, children),
			};
		return node;
	});
}
function updateNodeState(
	nodes: SpaceFsNode[],
	nodePath: string,
	updater: (node: SpaceFsNode) => SpaceFsNode,
): SpaceFsNode[] {
	return nodes.map((node) => {
		if (node.path === nodePath) return updater(node);
		if (node.children.length > 0)
			return {
				...node,
				children: updateNodeState(node.children, nodePath, updater),
			};
		return node;
	});
}
function upsertSessionRecord(
	session: SessionRecord,
	options?: { cache?: boolean },
) {
	const existingSession = spaceSessions.find((item) => item.id === session.id);
	const nextSessions = sortSessionsByRecentActivity([
		mergeSessionRecord(existingSession, session),
		...spaceSessions.filter((item) => item.id !== session.id),
	]);
	spaceSessions = nextSessions;
	if (options?.cache !== false) {
		void patchCachedSessionList(spaceId, () => nextSessions).catch(
			() => undefined,
		);
	}
	const existing = sessionStateById[session.id];
	sessionStateById = {
		...sessionStateById,
		[session.id]: {
			session,
			turns: existing?.turns ?? [],
			loading: existing?.loading ?? false,
			loaded: existing?.loaded ?? false,
			error: existing?.error ?? "",
			hasMore: existing?.hasMore ?? true,
			hasMoreNewer: existing?.hasMoreNewer ?? false,
			loadingOlder: existing?.loadingOlder ?? false,
			loadingNewer: existing?.loadingNewer ?? false,
			oldestCursor: existing?.oldestCursor,
		},
	};
}
function applySessionRealtimeRecord(session: SessionRecord) {
	upsertSessionRecord(session);
}
function applySessionsSnapshot(sessions: SessionRecord[]) {
	const activeSession = activeSessionId
		? sessionStateById[activeSessionId]?.session
		: undefined;
	const nextSessions =
		activeSession &&
		!sessions.some((session) => session.id === activeSession.id)
			? sortSessionsByRecentActivity([activeSession, ...sessions])
			: sessions;
	spaceSessions = nextSessions;
	const nextState: Record<string, SessionViewState> = {};
	for (const session of nextSessions) {
		const existing = sessionStateById[session.id];
		nextState[session.id] = {
			session,
			turns: existing?.turns ?? [],
			loading: existing?.loading ?? false,
			loaded: existing?.loaded ?? false,
			error: existing?.error ?? "",
			hasMore: existing?.hasMore ?? true,
			hasMoreNewer: existing?.hasMoreNewer ?? false,
			loadingOlder: existing?.loadingOlder ?? false,
			loadingNewer: existing?.loadingNewer ?? false,
			oldestCursor: existing?.oldestCursor,
		};
	}
	if (
		activeSessionId &&
		sessionStateById[activeSessionId] &&
		!nextState[activeSessionId]
	) {
		nextState[activeSessionId] = sessionStateById[activeSessionId];
	}
	sessionStateById = nextState;
}
function seedSessions(sessions: SessionRecord[]) {
	applySessionsSnapshot(sessions);
}
async function syncForkResponseToSessionListCache(
	session: SessionRecord,
	fork: SessionListForkRecord | null | undefined,
	parentSession?: SessionRecord | null,
) {
	const snapshot = await getCachedSessionListSnapshot(spaceId).catch(
		() => null,
	);
	const forkByChildId = new Map(
		(snapshot?.forks ?? []).map((item) => [item.childSessionId, item]),
	);
	if (fork?.childSessionId) forkByChildId.set(fork.childSessionId, fork);
	await patchCachedSessionList(
		spaceId,
		(current) => {
			const base =
				current.length > 0 ? current : parentSession ? [parentSession] : [];
			return [session, ...base.filter((item) => item.id !== session.id)];
		},
		undefined,
		Array.from(forkByChildId.values()),
	);
}
async function refreshSessionsList(force = true) {
	if (refreshSessionsListInFlight) {
		refreshSessionsListQueued = true;
		refreshSessionsListQueuedForce ||= force;
		return refreshSessionsListInFlight;
	}
	const run = (async () => {
		try {
			const sessions = await fetchSessionListWithCache(
				spaceId,
				async () => {
					const result = await sdk.space(spaceId).sessions.list({
						includeForks: true,
					});
					return {
						sessions: result.sessions ?? [],
						forks: result.forks,
						pageInfo: result.pageInfo,
					};
				},
				{ force },
			);
			applySessionsSnapshot(sessions);
		} catch {
			// Non-blocking
		}
	})();
	refreshSessionsListInFlight = run.finally(() => {
		refreshSessionsListInFlight = null;
		if (refreshSessionsListQueued) {
			const rerunForce = refreshSessionsListQueuedForce;
			refreshSessionsListQueued = false;
			refreshSessionsListQueuedForce = false;
			void refreshSessionsList(rerunForce);
		}
	});
	return refreshSessionsListInFlight;
}
function prepareRouteSession(sessionId: string) {
	activeSessionId = sessionId;
	pendingRestoreSessionId = sessionId;
	activeAnchorRestore = null;
	anchorRestoreWaitingForMarkdown = false;
	userScrollActive = false;
	programmaticScrollActive = false;
	currentTurnSequence = null;
	showTurnBottomSheet = false;
	ensureSessionModelLoaded(sessionId);
	applySessionGenerationPolicy(loadSessionGenerationPolicy(sessionId));
	shouldAutoFollow = true;
	if (!sessionStateById[sessionId]) {
		sessionStateById = {
			...sessionStateById,
			[sessionId]: {
				session: spaceSessions.find((s) => s.id === sessionId),
				turns: [],
				loading: true,
				loaded: false,
				error: "",
				hasMore: true,
				hasMoreNewer: false,
				loadingOlder: false,
				loadingNewer: false,
				oldestCursor: undefined,
			},
		};
	}
}
function extractPublicEndpoints(value: unknown): SpacePublicEndpoints {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const sandbox = (value as { sandbox?: unknown }).sandbox;
	if (!sandbox || typeof sandbox !== "object" || Array.isArray(sandbox))
		return {};
	const endpoints = (sandbox as { publicEndpoints?: unknown }).publicEndpoints;
	if (!endpoints || typeof endpoints !== "object" || Array.isArray(endpoints))
		return {};
	return endpoints as SpacePublicEndpoints;
}

async function loadPreviewEndpoints() {
	const currentSpaceId = spaceId;
	const previous = previewEndpoints;
	try {
		const result = await sdk.space(currentSpaceId).sandbox.ports();
		if (spaceId !== currentSpaceId) return;
		const next = result.endpoints ?? {};
		previewEndpoints = next;
		maybeNotifyPortReady(previous, next);
	} catch {
		if (spaceId !== currentSpaceId) return;
		const next = extractPublicEndpoints(space);
		previewEndpoints = next;
		maybeNotifyPortReady(previous, next);
	}
}

function maybeNotifyPortReady(
	previous: SpacePublicEndpoints,
	next: SpacePublicEndpoints,
	changedPorts?: string[],
) {
	if (!pageMounted || spaceHasMinimalAccess) return;
	const entries = (
		changedPorts?.length
			? changedPorts.map((port) => [port, next[port]] as const)
			: Object.entries(next)
	).filter(([, endpoint]) => endpoint?.status === "listening" && endpoint.url);
	for (const [port, endpoint] of entries) {
		const previousStatus = previous[port]?.status;
		const cameFromPortsChangedEvent = Boolean(changedPorts?.length);
		const becameListening = previousStatus !== "listening";
		if (!(cameFromPortsChangedEvent || becameListening) || !endpoint?.url)
			continue;
		if (inlinePortPreview?.port === port) continue;
		if (!isHttpUrl(endpoint.url)) continue;
		showPortReadyToast(port, endpoint.url);
		return;
	}
}

function isHttpUrl(url: string) {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function showPortReadyToast(port: string, url: string) {
	if (!isHttpUrl(url)) return;
	portReadyToast = { port, url };
	if (portReadyToastTimer) clearTimeout(portReadyToastTimer);
	portReadyToastTimer = setTimeout(() => {
		portReadyToast = null;
		portReadyToastTimer = null;
	}, 7000);
}

function closePortReadyToast() {
	portReadyToast = null;
	if (portReadyToastTimer) {
		clearTimeout(portReadyToastTimer);
		portReadyToastTimer = null;
	}
}

function previewPortFromToast() {
	if (!portReadyToast) return;
	openInlinePort(portReadyToast.port, portReadyToast.url);
	closePortReadyToast();
}

function applyPortsChanged(payload: ChannelEnvelope) {
	const eventPayload = payload.payload as {
		ports?: Array<{
			port?: number;
			status?: "listening" | "closed";
			observedAt?: number;
		}>;
	};
	const previous = previewEndpoints;
	const next: SpacePublicEndpoints = { ...previewEndpoints };
	const changedPorts: string[] = [];
	for (const item of eventPayload.ports ?? []) {
		if (!item.port || !item.status) continue;
		const key = String(item.port);
		const current = next[key];
		if (!current) continue;
		next[key] = {
			...current,
			status: item.status,
			observedAt: item.observedAt,
		};
		changedPorts.push(key);
	}
	previewEndpoints = next;
	maybeNotifyPortReady(previous, next, changedPorts);
}

async function loadSpace() {
	spaceLoadError = "";
	try {
		const nextSpace = await sdk.space(spaceId).get();
		space = nextSpace;
		previewEndpoints = extractPublicEndpoints(nextSpace);
		cacheSpaceRecordSoon(nextSpace);
	} catch (error) {
		spaceLoadError =
			error instanceof Error ? error.message : "Failed to load space";
	}
}

function showSpaceStatusNotice(message: string) {
	spaceStatusNotice = message;
	if (spaceStatusNoticeTimer) clearTimeout(spaceStatusNoticeTimer);
	spaceStatusNoticeTimer = setTimeout(() => {
		spaceStatusNotice = "";
		spaceStatusNoticeTimer = null;
	}, 2800);
}
function getStatusRefreshIntervalMs() {
	if (!pageVisible || !pageOnline) return null;
	if (bootstrapStatus === "pending" || bootstrapStatus === "running") {
		return 4000;
	}
	if (bootstrapStatus === "failed") {
		return 15000;
	}
	return null;
}
async function refreshSpaceStatus() {
	if (statusRefreshInFlight) return;
	statusRefreshInFlight = true;
	try {
		const nextSpace = await sdk.space(spaceId).get();
		const previousBootstrapStatus = bootstrapStatus;
		space = nextSpace;
		previewEndpoints = extractPublicEndpoints(nextSpace);
		cacheSpaceRecordSoon(nextSpace);
		const nextBootstrap = (() => {
			const raw = nextSpace.meta;
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
			const bootstrap = (raw as Record<string, unknown>).bootstrap;
			if (
				!bootstrap ||
				typeof bootstrap !== "object" ||
				Array.isArray(bootstrap)
			)
				return null;
			const status = (bootstrap as Record<string, unknown>).status;
			return typeof status === "string" ? status : null;
		})();
		if (previousBootstrapStatus !== "ready" && nextBootstrap === "ready") {
			showSpaceStatusNotice("Workspace prepared");
		}
	} finally {
		statusRefreshInFlight = false;
	}
}
function formatDateTime(dateStr: string | null | undefined): string {
	if (!dateStr) return "—";
	const d = new Date(dateStr);
	return d.toLocaleString("en-US", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}
function formatShortDateTime(dateStr: string | null | undefined): string {
	if (!dateStr) return "—";
	const d = new Date(dateStr);
	return d.toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}
function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
function formatContentBlockForPreview(block: unknown): string {
	const record = asRecord(block);
	if (!record)
		return typeof block === "string" ? block : JSON.stringify(block, null, 2);
	if (record.type === "text" && typeof record.text === "string")
		return record.text;
	if (record.type === "thinking" && typeof record.thinking === "string") {
		return `[thinking]\n${record.thinking}`;
	}
	if (record.type === "image") return "[image attachment]";
	if (record.type === "tool_use" && typeof record.name === "string") {
		return `[tool use: ${record.name}]\n${JSON.stringify(record.input ?? {}, null, 2)}`;
	}
	if (record.type === "tool_result") return "[tool result]";
	return JSON.stringify(record, null, 2);
}
function cronjobPayloadContent(payload: unknown): unknown {
	return asRecord(payload)?.content;
}
function formatCronjobPrompt(payload: unknown): string {
	const content = cronjobPayloadContent(payload);
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const preview = content
			.map(formatContentBlockForPreview)
			.map((part) => part.trim())
			.filter(Boolean)
			.join("\n\n");
		return preview || JSON.stringify(content, null, 2);
	}
	if (content !== undefined) return JSON.stringify(content, null, 2);
	return "—";
}
function cronjobPromptMeta(payload: unknown): string {
	const content = cronjobPayloadContent(payload);
	if (Array.isArray(content)) {
		const textLength = content.reduce((sum, block) => {
			const record = asRecord(block);
			return sum + (typeof record?.text === "string" ? record.text.length : 0);
		}, 0);
		return `${content.length} block${content.length === 1 ? "" : "s"}${textLength ? ` · ${textLength} chars` : ""}`;
	}
	if (typeof content === "string") return `${content.length} chars`;
	return "Payload content";
}
function cronjobPayloadField(payload: unknown, key: string): string {
	const value = asRecord(payload)?.[key];
	if (typeof value === "string" && value.trim()) return value;
	return "—";
}
function fallbackUserName(userUuid: string | null | undefined): string {
	if (!userUuid) return "Unknown user";
	const compact = userUuid.replaceAll("-", "");
	return compact.slice(0, 8) || "User";
}
function formatFileSize(bytes: number): string {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	const value = bytes / 1024 ** i;
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
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
function taskTypeLabel(taskType: string) {
	if (taskType === "run_command") return "Run Command";
	return taskType;
}

function isContentBlockArray(value: unknown): value is ContentBlock[] {
	return (
		Array.isArray(value) &&
		value.every((block) => {
			return (
				block &&
				typeof block === "object" &&
				typeof (block as { type?: unknown }).type === "string"
			);
		})
	);
}

function contentBlocksFrom(value: unknown): ContentBlock[] {
	if (!value || typeof value !== "object") return [];
	const content = (value as { content?: unknown }).content;
	return isContentBlockArray(content) ? content : [];
}

function runCommandContent(run: TaskRunRecord): ContentBlock[] {
	const resultContent = contentBlocksFrom(run.result);
	if (resultContent.length > 0) return resultContent;
	return contentBlocksFrom(taskRunProgress);
}

function runCommandPayload(run: TaskRunRecord) {
	const payload =
		run.payload && typeof run.payload === "object"
			? (run.payload as { data?: unknown })
			: null;
	const data =
		payload?.data && typeof payload.data === "object"
			? (payload.data as Record<string, unknown>)
			: null;
	return {
		command: typeof data?.command === "string" ? data.command : "",
		cwd: typeof data?.cwd === "string" ? data.cwd : "/workspace",
	};
}

function runCommandResultMeta(run: TaskRunRecord) {
	const result =
		run.result && typeof run.result === "object"
			? (run.result as Record<string, unknown>)
			: null;
	return {
		exitCode: typeof result?.exitCode === "number" ? result.exitCode : null,
		durationMs:
			typeof result?.durationMs === "number" ? result.durationMs : null,
		truncated: Boolean(result?.truncated),
	};
}

function formatDurationMs(ms: number | null) {
	if (ms === null) return "—";
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function taskRunStatusBadge(run: TaskRunRecord) {
	switch (run.status) {
		case "completed":
			return {
				label: "Completed",
				color: "text-status-running",
				dot: "bg-status-running",
			};
		case "failed":
			return {
				label: "Failed",
				color: "text-status-error",
				dot: "bg-status-error",
			};
		case "running":
			return { label: "Running", color: "text-info", dot: "bg-info" };
		case "pending":
			return { label: "Pending", color: "text-warning", dot: "bg-warning" };
		default:
			return {
				label: run.status,
				color: "text-text-placeholder",
				dot: "bg-text-placeholder",
			};
	}
}
function taskRunDuration(run: TaskRunRecord): string {
	if (!run.startedAt || !run.finishedAt) return "—";
	const ms = Math.max(
		0,
		new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime(),
	);
	return `${(ms / 1000).toFixed(1)}s`;
}
function formatBootstrapStage(stage: string | null) {
	if (!stage) return "Waiting";
	if (stage === "prepare") return "Preparing workspace";
	if (stage === "import") return "Importing repository";
	if (stage === "checkpoint_restore") return "Restoring save";
	if (stage === "push") return "Pushing initial state";
	if (stage === "finalize") return "Finalizing";
	return stage.replace(/_/g, " ");
}
function formatBootstrapStatus(status: string | null) {
	if (!status) return "Pending";
	if (status === "running") return "Running";
	if (status === "ready") return "Ready";
	if (status === "failed") return "Failed";
	return "Pending";
}
async function handleRenameSpace(newName: string) {
	renameSaving = true;
	renameError = "";
	try {
		const result = await sdk.space(spaceId).rename(newName);
		space = result.space;
		cacheSpaceRecordSoon(result.space);
		renamingSpace = false;
	} catch (error) {
		renameError =
			error instanceof Error ? error.message : "Failed to rename space";
	} finally {
		renameSaving = false;
	}
}
function getSpaceOwnerUsername(record: SpaceRecord | null): string {
	return record?.ownerProfile?.username?.trim() ?? "";
}
function getSpaceSlug(record: SpaceRecord | null): string {
	return record?.slug?.trim() ?? "";
}
function getSpacePublicPath(record: SpaceRecord | null): string {
	const username = getSpaceOwnerUsername(record);
	const slug = getSpaceSlug(record);
	return username && slug ? `/${username}/${slug}` : "";
}
function getSpacePrettyUrlHint(record: SpaceRecord | null): string {
	const hasUsername = Boolean(getSpaceOwnerUsername(record));
	const hasSlug = Boolean(getSpaceSlug(record));
	if (hasUsername && hasSlug) return "";
	if (!hasUsername && !hasSlug)
		return "Add a space slug and username for a cleaner URL.";
	if (!hasUsername)
		return "Add username in Profile to complete the pretty URL.";
	return "Add a space slug for a cleaner URL.";
}
function formatCompactId(id: string): string {
	if (!id) return "";
	if (id.length <= 13) return id;
	return `${id.slice(0, 8)}…${id.slice(-4)}`;
}
function beginSpaceSlugEdit() {
	if (!canEditSpaceProfile || spaceSlugSaving) return;
	spaceSlugDraft = space?.slug ?? "";
	spaceSlugError = "";
	editingSpaceSlug = true;
}
function cancelSpaceSlugEdit() {
	if (spaceSlugSaving) return;
	editingSpaceSlug = false;
	spaceSlugDraft = "";
	spaceSlugError = "";
}
function validateSpaceSlug(value: string): string | null {
	const result = validatePublicSlugInput(value);
	if (result.error) throw new Error(result.error);
	return result.value;
}
function handleSpaceSlugKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		event.preventDefault();
		cancelSpaceSlugEdit();
		return;
	}
	if (event.key === "Enter" && !isComposingKeyboardEvent(event)) {
		event.preventDefault();
		void saveSpaceSlug();
	}
}
async function saveSpaceSlug() {
	if (!space || spaceSlugSaving) return;
	spaceSlugError = "";
	let nextSlug: string | null;
	try {
		nextSlug = validateSpaceSlug(spaceSlugDraft);
	} catch (error) {
		spaceSlugError = error instanceof Error ? error.message : "Invalid slug";
		return;
	}
	if (nextSlug === space.slug) {
		editingSpaceSlug = false;
		return;
	}
	spaceSlugSaving = true;
	try {
		const result = await sdk.space(spaceId).update({ slug: nextSlug });
		space = result.space;
		cacheSpaceRecordSoon(result.space);
		patchCachedSpaceList((items) =>
			items.map((item) => (item.id === spaceId ? result.space : item)),
		);
		editingSpaceSlug = false;
		spaceSlugDraft = "";
	} catch (error) {
		spaceSlugError =
			error instanceof Error ? error.message : "Failed to save space slug";
	} finally {
		spaceSlugSaving = false;
	}
}
async function copySpaceId() {
	if (!spaceId) return;
	try {
		await navigator.clipboard.writeText(spaceId);
		copiedSpaceId = true;
		if (copiedSpaceIdTimer) clearTimeout(copiedSpaceIdTimer);
		copiedSpaceIdTimer = setTimeout(() => {
			copiedSpaceId = false;
		}, 2000);
	} catch {
		// Clipboard failures are non-critical.
	}
}
async function copySpacePublicLink() {
	const path = getSpacePublicPath(space);
	if (!path) return;
	try {
		await navigator.clipboard.writeText(`${window.location.origin}${path}`);
		copiedSpaceSlugLink = true;
		if (copiedSpaceSlugLinkTimer) clearTimeout(copiedSpaceSlugLinkTimer);
		copiedSpaceSlugLinkTimer = setTimeout(() => {
			copiedSpaceSlugLink = false;
		}, 2000);
	} catch {
		// Clipboard failures are non-critical.
	}
}
function beginSpaceProfileEdit(field: SpaceProfileEditableField) {
	if (!canEditSpaceProfile || spaceProfileSaving || spaceAvatarUploading)
		return;
	spaceProfileError = "";
	spaceProfileEditingField = field;
	spaceProfileDraft = field === "description" ? (space?.description ?? "") : "";
}
function cancelSpaceProfileEdit() {
	if (spaceProfileSaving) return;
	spaceProfileEditingField = null;
	spaceProfileDraft = "";
	spaceProfileError = "";
}
function handleSpaceProfileEditKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		event.preventDefault();
		cancelSpaceProfileEdit();
		return;
	}
	if (
		(event.metaKey || event.ctrlKey) &&
		event.key === "Enter" &&
		!isComposingKeyboardEvent(event)
	) {
		event.preventDefault();
		void saveSpaceProfileField();
	}
}
async function saveSpaceProfileField() {
	if (!spaceProfileEditingField || spaceProfileSaving) return;
	const field = spaceProfileEditingField;
	spaceProfileSaving = field;
	spaceProfileError = "";
	try {
		const result = await sdk.space(spaceId).profile({
			description: spaceProfileDraft.trim() || null,
		});
		space = result.space;
		cacheSpaceRecordSoon(result.space);
		spaceProfileEditingField = null;
		spaceProfileDraft = "";
	} catch (error) {
		spaceProfileError =
			error instanceof Error ? error.message : "Failed to save space profile";
	} finally {
		spaceProfileSaving = null;
	}
}
async function uploadSpaceAvatar(file: File) {
	if (!canEditSpaceProfile || spaceAvatarUploading) return;
	spaceAvatarUploading = true;
	spaceProfileError = "";
	try {
		const avatarFile = await normalizeAvatarToWebp(file);
		const plan = await sdk.publicAssets.createUpload({
			purpose: "space_avatar",
			spaceId,
			file: {
				size: avatarFile.size,
				mimeType: "image/webp",
			},
		});
		const formData = new FormData();
		for (const [key, value] of Object.entries(plan.asset.uploadFields)) {
			formData.append(key, value);
		}
		formData.append("file", avatarFile);
		const response = await fetch(plan.asset.uploadUrl, {
			method: plan.asset.uploadMethod,
			body: formData,
		});
		if (!response.ok) throw new Error("Failed to upload avatar image.");
		const result = await sdk.space(spaceId).profile({
			description: space?.description ?? null,
			avatarUrl: plan.asset.publicUrl,
		});
		space = result.space;
		cacheSpaceRecordSoon(result.space);
	} catch (error) {
		spaceProfileError =
			error instanceof Error ? error.message : "Failed to upload space avatar";
	} finally {
		spaceAvatarUploading = false;
	}
}
function handleSpaceAvatarFileChange(event: Event) {
	const input = event.currentTarget as HTMLInputElement;
	const file = input.files?.[0];
	input.value = "";
	if (file && canEditSpaceProfile) void uploadSpaceAvatar(file);
}
// ── Session rename (header inline edit) ────────────────────────────────
function startSessionRename() {
	const session = activeSessionState?.session;
	if (!session) return;
	sessionRenaming = true;
	sessionRenameValue = session.title ?? getSessionTitle(session);
	void tick().then(() => {
		sessionRenameInputEl?.focus();
		sessionRenameInputEl?.select();
	});
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
		const result = await sdk
			.space(spaceId)
			.session(activeSessionId)
			.rename(trimmed);
		spaceSessions = await patchCachedSessionList(spaceId, (current) =>
			current.map((s) => (s.id === activeSessionId ? result.session : s)),
		);
		if (sessionStateById[activeSessionId]) {
			sessionStateById = {
				...sessionStateById,
				[activeSessionId]: {
					...sessionStateById[activeSessionId],
					session: result.session,
				},
			};
		}
	} catch {
		// Silently fail
	} finally {
		sessionRenameSaving = false;
		cancelSessionRename();
	}
}
async function syncGenerationStateFromTail(
	sessionId: string,
	turns: SessionTurnRecord[],
	requestStartedAt: number,
) {
	const runningTurn = turns.findLast(
		(turn) => turn.status === "running" || turn.status === "abort_requested",
	);
	if (runningTurn) {
		const current = sessionGenerationStore.get(sessionId);
		const optimisticTurn = turns.find(
			(turn) =>
				turn.meta?.optimistic === true &&
				getTurnClientMessageId(turn) === getTurnClientMessageId(runningTurn),
		);
		if (optimisticTurn?.id && optimisticTurn.id !== runningTurn.id) {
			return;
		}
		// The HTTP API response may lag behind WebSocket events. Two guards:
		//
		// 1. If the generation already reached a terminal state for the same
		//    turn, the API data is stale — skip to avoid re-activating.
		//
		// 2. If the generation is actively streaming for the same turn and
		//    the API request was sent BEFORE the last streaming event arrived,
		//    the API data is likely stale (the server may not have persisted
		//    the completed status yet). Skip to avoid replacing
		//    streaming-accumulated content with a stale snapshot, which would
		//    reset the StreamingMarkdownController and cause a re-stream.
		const isSameTurn = current?.turnId === runningTurn.id;
		const alreadyTerminalForTurn =
			current && TERMINAL_GENERATION_STATUSES.has(current.status) && isSameTurn;
		const staleApiForActiveStream =
			current &&
			isSameTurn &&
			(current.status === "streaming" || current.status === "pending") &&
			(current.lastEventAt ?? 0) > requestStartedAt;
		if (alreadyTerminalForTurn || staleApiForActiveStream) {
			return;
		}
		const anchorUserMessageId =
			typeof runningTurn.meta?.userMessageId === "string"
				? runningTurn.meta.userMessageId
				: runningTurn.id;
		sessionGenerationStore.resumePending(sessionId, {
			spaceId,
			turnId: runningTurn.id,
			anchorUserMessageId,
		});
		const state = sessionStateById[sessionId];
		if (!state?.turns.some((turn) => turn.id === runningTurn.id)) {
			await hydrateTurnOnce({
				sessionId,
				turnId: runningTurn.id,
				reason: "running-recovery",
			});
		}
		await restoreSessionStreamSnapshot(sessionId, { turnId: runningTurn.id });
		return;
	}
	const current = sessionGenerationStore.get(sessionId);
	if (
		current &&
		!TERMINAL_GENERATION_STATUSES.has(current.status) &&
		(current.lastEventAt ?? 0) <= requestStartedAt
	) {
		resetGeneration(sessionId);
	}
}
async function loadSessionState(sessionId: string, force = false) {
	const existing = sessionStateById[sessionId];
	const inFlight = sessionLoadInFlight.get(sessionId);
	if (inFlight && !force) return inFlight;
	if (existing?.loaded && !force) return;
	const run = (async () => {
		const cached = !force
			? await sessionTurnsRepo.getCached(spaceId, sessionId)
			: null;
		if (cached && (cached.turns.length > 0 || cached.session)) {
			sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					session:
						cached.session ??
						existing?.session ??
						spaceSessions.find((s) => s.id === sessionId),
					turns: cached.turns,
					loading: true,
					loaded: true,
					error: "",
					hasMore: cached.hasMoreOlder,
					hasMoreNewer: cached.hasMoreNewer,
					loadingOlder: false,
					loadingNewer: false,
					oldestCursor: cached.oldestSequence ?? undefined,
				},
			};
		}
		loadingSessionIds = { ...loadingSessionIds, [sessionId]: true };
		const currentSeed = sessionStateById[sessionId];
		sessionStateById = {
			...sessionStateById,
			[sessionId]: {
				session:
					currentSeed?.session ??
					existing?.session ??
					spaceSessions.find((s) => s.id === sessionId),
				turns: currentSeed?.turns ?? existing?.turns ?? [],
				loading: true,
				loaded: currentSeed?.loaded ?? existing?.loaded ?? false,
				error: currentSeed?.error ?? existing?.error ?? "",
				hasMore: currentSeed?.hasMore ?? existing?.hasMore ?? true,
				hasMoreNewer:
					currentSeed?.hasMoreNewer ?? existing?.hasMoreNewer ?? false,
				loadingOlder: false,
				loadingNewer: false,
				oldestCursor: currentSeed?.oldestCursor ?? existing?.oldestCursor,
			},
		};
		try {
			const requestStartedAt = Date.now();
			const response = await sdk
				.space(spaceId)
				.session(sessionId)
				.turns.listPaginated({
					limit: 30,
				});
			await syncGenerationStateFromTail(
				sessionId,
				response.turns,
				requestStartedAt,
			);
			const snapshot = await sessionTurnsRepo.replaceTail(spaceId, sessionId, {
				session: response.session,
				turns: response.turns,
				hasMore: response.hasMore,
			});
			upsertSessionRecord(response.session);
			sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					session: snapshot.session ?? response.session,
					turns: snapshot.turns,
					loading: false,
					loaded: true,
					error: "",
					hasMore: snapshot.hasMoreOlder,
					hasMoreNewer: snapshot.hasMoreNewer,
					loadingOlder: false,
					loadingNewer: false,
					oldestCursor: snapshot.oldestSequence ?? undefined,
				},
			};
		} catch (error) {
			const fallback = sessionStateById[sessionId];
			sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					session:
						fallback?.session ??
						existing?.session ??
						spaceSessions.find((s) => s.id === sessionId),
					turns: fallback?.turns ?? existing?.turns ?? [],
					loading: false,
					loaded: Boolean(fallback?.loaded ?? existing?.loaded),
					error:
						error instanceof Error ? error.message : "Failed to load session",
					hasMore: fallback?.hasMore ?? existing?.hasMore ?? true,
					hasMoreNewer:
						fallback?.hasMoreNewer ?? existing?.hasMoreNewer ?? false,
					loadingOlder: false,
					loadingNewer: false,
					oldestCursor: fallback?.oldestCursor ?? existing?.oldestCursor,
				},
			};
		} finally {
			loadingSessionIds = { ...loadingSessionIds, [sessionId]: false };
		}
	})();
	sessionLoadInFlight.set(sessionId, run);
	return run.finally(() => {
		if (sessionLoadInFlight.get(sessionId) === run) {
			sessionLoadInFlight.delete(sessionId);
		}
	});
}
async function loadTurnIndex(sessionId: string, force = false) {
	if (!force && Object.hasOwn(turnIndexBySessionId, sessionId)) return;
	if (turnIndexLoadingBySessionId[sessionId]) return;
	if (!force) {
		if (typeof navigator !== "undefined" && !navigator.onLine) return;
		const retryAfter = turnIndexRetryAfterBySessionId[sessionId] ?? 0;
		if (retryAfter > Date.now()) return;
	}
	turnIndexLoadingBySessionId = {
		...turnIndexLoadingBySessionId,
		[sessionId]: true,
	};
	try {
		let cursor: number | undefined;
		const collected: SessionTurnIndexItem[] = [];
		for (let page = 0; page < 20; page += 1) {
			const response = await sdk.space(spaceId).session(sessionId).turns.index({
				cursor,
				limit: 500,
			});
			collected.push(...response.turns);
			if (!response.hasMore || response.nextCursor == null) break;
			cursor = response.nextCursor;
		}
		turnIndexBySessionId = {
			...turnIndexBySessionId,
			[sessionId]: collected,
		};
		if (turnIndexRetryAfterBySessionId[sessionId]) {
			const nextRetryAfterBySessionId = { ...turnIndexRetryAfterBySessionId };
			delete nextRetryAfterBySessionId[sessionId];
			turnIndexRetryAfterBySessionId = nextRetryAfterBySessionId;
		}
	} catch (error) {
		const retryDelayMs =
			error instanceof HttpError && error.status === 401 ? 60_000 : 15_000;
		turnIndexRetryAfterBySessionId = {
			...turnIndexRetryAfterBySessionId,
			[sessionId]: Date.now() + retryDelayMs,
		};
		console.warn("[loadTurnIndex] Failed to load turn index:", error);
	} finally {
		turnIndexLoadingBySessionId = {
			...turnIndexLoadingBySessionId,
			[sessionId]: false,
		};
	}
}
function getTurnAnchorNode(sequence: number) {
	return (
		listEl?.querySelector<HTMLElement>(
			`[data-turn-anchor="user"][data-turn-sequence="${sequence}"]`,
		) ?? null
	);
}
function snapScrollToNearestTurn(threshold = 32) {
	if (!listEl) return false;
	const anchors = Array.from(
		listEl.querySelectorAll<HTMLElement>('[data-turn-anchor="user"]'),
	);
	let nearest: { sequence: number; distance: number } | null = null;
	for (const anchor of anchors) {
		const sequence = Number(anchor.dataset.turnSequence);
		if (!Number.isFinite(sequence)) continue;
		const targetTop = Math.max(
			0,
			getMessageElementAbsoluteTop(anchor) - TURN_SCROLL_ANCHOR_OFFSET,
		);
		const distance = Math.abs(targetTop - listEl.scrollTop);
		if (!nearest || distance < nearest.distance) {
			nearest = { sequence, distance };
		}
	}
	if (!nearest || nearest.distance > threshold) return false;
	return scrollToTurnAnchor(nearest.sequence);
}
function scrollToTurnAnchor(sequence: number) {
	if (!listEl) return false;
	const node = getTurnAnchorNode(sequence);
	if (!node) return false;
	setProgrammaticScrollTop(
		Math.max(0, getMessageElementAbsoluteTop(node) - TURN_SCROLL_ANCHOR_OFFSET),
	);
	shouldAutoFollow = false;
	currentTurnSequence = sequence;
	requestAnimationFrame(() => updateCurrentTurnSequence());
	highlightedTurnSequence = sequence;
	window.setTimeout(() => {
		if (highlightedTurnSequence === sequence) highlightedTurnSequence = null;
	}, 1400);
	return true;
}
async function ensureTurnWindowLoaded(sessionId: string, sequence: number) {
	const key = `${sessionId}:${sequence}`;
	const inFlight = turnWindowLoadInFlight.get(key);
	if (inFlight) return inFlight;
	const run = (async () => {
		const state = sessionStateById[sessionId];
		if (state?.turns.some((turn) => turn.sequence === sequence)) return;
		if (state?.loaded && !state.loading && state.turns.length === 0) return;
		loadingTurnSequence = sequence;
		try {
			const response = await sdk
				.space(spaceId)
				.session(sessionId)
				.turns.window({
					sequence,
					before: 10,
					after: 20,
				});
			const snapshot = await sessionTurnsRepo.mergeTurns(
				spaceId,
				sessionId,
				response.turns,
				{
					session: response.session,
					hasMoreOlder: response.hasMoreOlder,
					hasMoreNewer:
						"hasMoreNewer" in response ? response.hasMoreNewer : undefined,
					source: "network",
				},
			);
			const current = sessionStateById[sessionId] ?? state;
			if (current) {
				sessionStateById = {
					...sessionStateById,
					[sessionId]: {
						...current,
						session: snapshot.session ?? current.session,
						turns: snapshot.turns,
						hasMore: snapshot.hasMoreOlder,
						hasMoreNewer: snapshot.hasMoreNewer,
						oldestCursor: snapshot.oldestSequence ?? undefined,
						loaded: true,
						loading: false,
					},
				};
			}
		} catch (error) {
			const current = sessionStateById[sessionId];
			if (
				error instanceof HttpError &&
				error.status === 404 &&
				!current?.turns.some((turn) => turn.sequence === sequence)
			) {
				return;
			}
			throw error;
		} finally {
			loadingTurnSequence = null;
		}
	})();
	turnWindowLoadInFlight.set(key, run);
	return run.finally(() => {
		if (turnWindowLoadInFlight.get(key) === run) {
			turnWindowLoadInFlight.delete(key);
		}
	});
}
async function jumpToTurn(sequence: number) {
	if (!activeSessionId) return;
	try {
		composerError = "";
		if (scrollToTurnAnchor(sequence)) return;
		await ensureTurnWindowLoaded(activeSessionId, sequence);
		await tick();
		requestAnimationFrame(() => scrollToTurnAnchor(sequence));
	} catch (error) {
		console.warn("[jumpToTurn] Failed to jump to turn:", error);
		composerError =
			error instanceof Error ? error.message : "Failed to jump to turn";
	}
}
async function jumpToTurnAndUpdateUrl(sequence: number) {
	if (!activeSessionId) return;
	try {
		appliedRouteTurnKey = `${activeSessionId}:${sequence}`;
		await goto(buildSpaceSessionTurnRoute(spaceId, activeSessionId, sequence), {
			replaceState: true,
			keepFocus: true,
			noScroll: true,
		});
		await jumpToTurn(sequence);
	} catch (error) {
		console.warn("[jumpToTurnAndUpdateUrl] Failed to jump to turn:", error);
		composerError =
			error instanceof Error ? error.message : "Failed to jump to turn";
	}
}
async function syncSessionNewer(sessionId: string, _cached: unknown) {
	const inFlight = syncSessionNewerInFlight.get(sessionId);
	if (inFlight) return inFlight;
	const run = (async () => {
		const state = sessionStateById[sessionId];
		if (!state || state.turns.length === 0) return;
		const newestSeq = state.turns.at(-1)?.sequence;
		if (newestSeq == null) return;
		sessionStateById = {
			...sessionStateById,
			[sessionId]: {
				...state,
				loadingNewer: true,
			},
		};
		try {
			const response = await sdk
				.space(spaceId)
				.session(sessionId)
				.turns.listPaginated({
					cursor: newestSeq,
					direction: "newer",
					limit: 100,
				});
			if (response.turns.length > 0) {
				const snapshot = await sessionTurnsRepo.mergeTurns(
					spaceId,
					sessionId,
					response.turns,
					{ session: response.session, source: "network" },
				);
				const current = sessionStateById[sessionId];
				if (current) {
					sessionStateById = {
						...sessionStateById,
						[sessionId]: {
							...current,
							session: snapshot.session ?? current.session,
							turns: snapshot.turns,
						},
					};
				}
			}
		} catch (error) {
			console.warn("[syncSessionNewer] Failed to sync newer turns:", error);
		} finally {
			const current = sessionStateById[sessionId];
			if (current) {
				sessionStateById = {
					...sessionStateById,
					[sessionId]: {
						...current,
						loadingNewer: false,
					},
				};
			}
		}
	})();
	syncSessionNewerInFlight.set(sessionId, run);
	return run.finally(() => {
		if (syncSessionNewerInFlight.get(sessionId) === run) {
			syncSessionNewerInFlight.delete(sessionId);
		}
	});
}
async function loadOlderTurns(sessionId: string) {
	const state = sessionStateById[sessionId];
	if (!state?.hasMore || state.loadingOlder) return;
	chatTimelineRef?.preparePrepend();
	sessionStateById = {
		...sessionStateById,
		[sessionId]: {
			...state,
			loadingOlder: true,
		},
	};
	try {
		const response = await sdk
			.space(spaceId)
			.session(sessionId)
			.turns.listPaginated({
				cursor: state.oldestCursor,
				direction: "older",
				limit: 30,
			});
		const snapshot = await sessionTurnsRepo.loadOlder(spaceId, sessionId, {
			session: response.session,
			turns: response.turns,
			hasMore: response.hasMore,
		});
		sessionStateById = {
			...sessionStateById,
			[sessionId]: {
				...state,
				session: snapshot.session ?? state.session,
				turns: snapshot.turns,
				hasMore: snapshot.hasMoreOlder,
				hasMoreNewer: snapshot.hasMoreNewer,
				loadingOlder: false,
				loadingNewer: false,
				oldestCursor: snapshot.oldestSequence ?? undefined,
			},
		};
		if (response.turns.length > 0) {
			await tick();
			chatTimelineRef?.finalizePrepend();
		}
	} catch (error) {
		sessionStateById = {
			...sessionStateById,
			[sessionId]: {
				...state,
				loadingOlder: false,
				error:
					error instanceof Error ? error.message : "Failed to load older turns",
			},
		};
	}
}
function handleFirstVisible(index: number) {
	if (!activeSessionId) return;
	const state = sessionStateById[activeSessionId];
	if (!state?.hasMore || state.loadingOlder) return;
	if (
		index <= PRELOAD_THRESHOLD &&
		!preloadingSessionIds.has(activeSessionId)
	) {
		const sessionId = activeSessionId;
		preloadingSessionIds.add(sessionId);
		void loadOlderTurns(sessionId).finally(() =>
			preloadingSessionIds.delete(sessionId),
		);
	}
}
async function restoreSessionStreamSnapshot(
	sessionId: string,
	options?: { turnId?: string | null; force?: boolean },
) {
	const turnId = options?.turnId ?? null;
	const cooldownKey = turnId ? `${sessionId}:${turnId}` : sessionId;
	const now = Date.now();
	const lastRecoveryAt = lastStreamSnapshotRecoveryByTurn.get(cooldownKey) ?? 0;
	if (
		!options?.force &&
		now - lastRecoveryAt < STREAM_SNAPSHOT_RECOVERY_COOLDOWN_MS
	) {
		return false;
	}
	const inFlight = streamSnapshotRecoveryInFlight.get(sessionId);
	if (inFlight) return inFlight;
	lastStreamSnapshotRecoveryByTurn.set(cooldownKey, now);
	const run = (async () => {
		try {
			const { snapshot } = await sdk
				.space(spaceId)
				.session(sessionId)
				.turns.streamSnapshot();
			if (!snapshot) return false;
			const current = sessionGenerationStore.get(sessionId);
			if (
				current?.turnId &&
				snapshot.turnId &&
				current.turnId !== snapshot.turnId
			) {
				return false;
			}
			const result = applyGenerationStreamSnapshot(sessionId, {
				spaceId: snapshot.spaceId,
				turnId: snapshot.turnId,
				seq: snapshot.seq,
				anchorUserMessageId: snapshot.anchorUserMessageId,
				current: snapshot.current,
				intermediateMessages: snapshot.intermediateMessages,
				lifecycle: snapshot.lifecycle ?? null,
			});
			return result.applied;
		} catch (error) {
			console.warn(
				"[restoreSessionStreamSnapshot] Failed to restore stream snapshot:",
				error,
			);
			return false;
		}
	})();
	streamSnapshotRecoveryInFlight.set(sessionId, run);
	return run.finally(() => {
		if (streamSnapshotRecoveryInFlight.get(sessionId) === run) {
			streamSnapshotRecoveryInFlight.delete(sessionId);
		}
	});
}
async function reconcileSessionTail(sessionId: string) {
	const state = sessionStateById[sessionId];
	if (!state?.session) return;
	const inFlight = reconcileSessionTailInFlight.get(sessionId);
	if (inFlight) return inFlight;
	const run = (async () => {
		try {
			const requestStartedAt = Date.now();
			const response = await sdk
				.space(spaceId)
				.session(sessionId)
				.turns.listPaginated({
					limit: 30,
				});
			await syncGenerationStateFromTail(
				sessionId,
				response.turns,
				requestStartedAt,
			);
			const snapshot = await sessionTurnsRepo.replaceTail(spaceId, sessionId, {
				session: response.session,
				turns: response.turns,
				hasMore: response.hasMore,
			});
			const currentState = sessionStateById[sessionId];
			if (!currentState) return;
			sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					...currentState,
					session: snapshot.session ?? currentState.session,
					turns: snapshot.turns,
					hasMore: snapshot.hasMoreOlder,
					hasMoreNewer: snapshot.hasMoreNewer,
					loading: false,
					loaded: true,
					error: "",
					loadingOlder: false,
					loadingNewer: false,
					oldestCursor: snapshot.oldestSequence ?? undefined,
				},
			};
		} catch (error) {
			console.warn(
				"[reconcileSessionTail] Failed to reconcile session tail:",
				error,
			);
		}
	})();
	reconcileSessionTailInFlight.set(sessionId, run);
	return run.finally(() => {
		if (reconcileSessionTailInFlight.get(sessionId) === run) {
			reconcileSessionTailInFlight.delete(sessionId);
		}
	});
}
function clearPostSendRecovery(sessionId: string | null | undefined) {
	if (!sessionId) return;
	const timer = postSendRecoveryTimers.get(sessionId);
	if (!timer) return;
	clearTimeout(timer);
	postSendRecoveryTimers.delete(sessionId);
}
function clearAllPostSendRecovery() {
	for (const timer of postSendRecoveryTimers.values()) clearTimeout(timer);
	postSendRecoveryTimers.clear();
}
function schedulePostSendRecoveryCheck(sessionId: string) {
	clearPostSendRecovery(sessionId);
	if (wsConnectionState === "open") return;
	const timer = setTimeout(() => {
		postSendRecoveryTimers.delete(sessionId);
		if (
			wsConnectionState === "open" ||
			!sessionGenerationStore.isGenerating(sessionId)
		) {
			return;
		}
		void recoveryCoordinator
			.reconcileAfterSendWhileOffline(sessionId)
			.catch(() => undefined);
		recoveryCoordinator.scheduleFallbackSync(sessionId);
	}, POST_SEND_RECOVERY_GRACE_MS);
	postSendRecoveryTimers.set(sessionId, timer);
}
const recoveryCoordinator = new SessionRecoveryCoordinator({
	isTransportOpen: () => wsConnectionState === "open",
	reconcileSessionTail: (sessionId) => reconcileSessionTail(sessionId),
	refreshSessionsList: () => refreshSessionsList(true),
	onRecovered: () => {
		wsCanRecover = false;
		clearPostSendRecovery(activeSessionId);
	},
	onExhausted: (sessionId) => {
		console.warn("[SessionRecoveryCoordinator] Fallback sync exhausted", {
			sessionId,
			spaceId,
		});
	},
});
async function reconnectSync() {
	if (reconnectSyncInFlight) return reconnectSyncInFlight;
	const run = (async () => {
		await recoveryCoordinator.reconcileAfterReconnect(
			activeSessionId && sessionStateById[activeSessionId]?.loaded
				? activeSessionId
				: null,
		);
		if (activeSessionId && sessionStateById[activeSessionId]?.loaded) {
			const activeState = sessionStateById[activeSessionId];
			const latestTurn =
				activeState?.turns.findLast(
					(turn) =>
						turn.status !== "running" && turn.status !== "abort_requested",
				) ?? activeState?.turns.at(-1);
			if (latestTurn && shouldAutoFollow) {
				unreadTracker.markViewed(
					activeSessionId,
					activeState?.session?.lastMessageId ?? null,
				);
			}
		}
		wsConnectionState = "open";
		wsCanRecover = false;
	})();
	reconnectSyncInFlight = run.finally(() => {
		reconnectSyncInFlight = null;
	});
	return reconnectSyncInFlight;
}
function spaceStyleChanged(
	changes: Array<{ path?: string; oldPath?: string }> | undefined,
) {
	return changes?.some(
		(change) =>
			isSpaceStylePath(change.path) || isSpaceStylePath(change.oldPath),
	);
}
async function handleSpaceFsChanged(payload: ChannelEnvelope) {
	const sourceKey = activeFsSourceKey;
	const shouldPatchVisibleTree = () =>
		activeFsSource.kind === "live" && activeFsSourceKey === sourceKey;
	const eventPayload = payload.payload as {
		source?: string;
		resync?: boolean;
		changes?: Array<{
			path?: string;
			oldPath?: string;
			kind?: string;
			nodeType?: string;
			mtimeMs?: number;
			size?: number;
		}>;
	};
	const shouldRefreshSpaceStyle =
		eventPayload.resync || spaceStyleChanged(eventPayload.changes);
	if (shouldRefreshSpaceStyle) refreshSpaceStyle(spaceId);
	const { refreshDirs: dirsToRefresh } = await spaceFsRepo.applyFsChanged(
		spaceId,
		eventPayload as Parameters<typeof spaceFsRepo.applyFsChanged>[1],
	);
	for (const dir of dirsToRefresh) {
		const snapshot = await spaceFsRepo.getDir(spaceId, dir);
		if (!snapshot || !shouldPatchVisibleTree()) continue;
		if (dir === "") updateRootFsEntries(snapshot.entries);
		else
			setActiveFileTree(
				replaceNodeChildren(fileTree, dir, makeFsNodes(snapshot.entries)),
			);
	}
	if (!shouldPatchVisibleTree()) return;
	if (eventPayload.resync) {
		await loadFileTree(true);
		if (routeView === "file" && routeFilePath && !fileDirty) {
			await openFileFromUrl(routeFilePath).catch(() => undefined);
		}
		if (inlineFile?.path && !inlineFileDirty) {
			await openInlineFile(inlineFile.path).catch(() => undefined);
		}
		return;
	}
	for (const change of eventPayload.changes ?? []) {
		const isOwnPendingChange = isOwnPendingFileSave(
			change.path,
			eventPayload.source,
			change.kind,
		);
		if (
			openFile?.path &&
			(change.path === openFile.path || change.oldPath === openFile.path)
		) {
			if (isOwnPendingChange) {
				// The API save we just initiated broadcasts a file-change event before
				// the save response updates local content. Do not treat it as an
				// external edit conflict.
			} else if (change.kind === "delete") closeFile();
			else if (!fileDirty && change.path)
				await openFileFromUrl(change.path).catch(() => undefined);
			else if (fileDirty)
				openFileError =
					"File changed externally. Save carefully or reload before editing further.";
		}
		if (
			inlineFile?.path &&
			(change.path === inlineFile.path || change.oldPath === inlineFile.path)
		) {
			if (isOwnPendingChange) {
				// See open-file branch above: this is our own save echo, not an
				// external modification.
			} else if (change.kind === "delete") closeInlineFile();
			else if (!inlineFileDirty && change.path)
				await openInlineFile(change.path).catch(() => undefined);
			else if (inlineFileDirty)
				inlineFile.error =
					"File changed externally. Save carefully or reload before editing further.";
		}
	}
	if (dirsToRefresh.has("")) await loadFileTree(true);
	if (!shouldPatchVisibleTree()) return;
	for (const dir of dirsToRefresh) {
		if (!dir) continue;
		const node = findFsNode(fileTree, dir);
		if (node?.isOpen) {
			if (!shouldPatchVisibleTree()) return;
			setActiveFileTree(
				updateNodeState(fileTree, dir, (item) => ({
					...item,
					isLoaded: false,
				})),
			);
			await expandDirectory({ ...node, isOpen: false, isLoaded: false });
		}
	}
}

function findFsNode(nodes: SpaceFsNode[], path: string): SpaceFsNode | null {
	for (const node of nodes) {
		if (node.path === path) return node;
		const child = findFsNode(node.children, path);
		if (child) return child;
	}
	return null;
}

function getTurnClientMessageId(turn: Pick<SessionTurnRecord, "meta">) {
	const value = turn.meta?.clientMessageId;
	return typeof value === "string" && value.trim() ? value : null;
}

function isOptimisticTurn(turn: Pick<SessionTurnRecord, "meta">) {
	return turn.meta?.optimistic === true;
}

function withOptimisticMetaCleared(turn: SessionTurnRecord) {
	if (!isOptimisticTurn(turn)) return turn;
	const meta = turn.meta ? { ...turn.meta } : null;
	if (meta && "optimistic" in meta) delete meta.optimistic;
	return { ...turn, meta };
}

function isSameClientMessageTurn(
	turn: Pick<SessionTurnRecord, "meta">,
	clientMessageId: string | null,
) {
	return Boolean(
		clientMessageId && getTurnClientMessageId(turn) === clientMessageId,
	);
}

function reconcileOptimisticTurn(
	turns: SessionTurnRecord[],
	confirmedTurn: SessionTurnRecord,
) {
	const clientMessageId = getTurnClientMessageId(confirmedTurn);
	let remapped = false;
	const nextTurns = turns.map((turn) => {
		if (!isOptimisticTurn(turn)) return turn;
		if (!isSameClientMessageTurn(turn, clientMessageId)) return turn;
		remapped = true;
		const meta = {
			...(turn.meta ?? {}),
			...(confirmedTurn.meta ?? {}),
		};
		delete meta.optimistic;
		return {
			...withOptimisticMetaCleared(turn),
			id: confirmedTurn.id,
			sequence: confirmedTurn.sequence,
			status: confirmedTurn.status,
			userUuid: confirmedTurn.userUuid ?? turn.userUuid,
			userContent: confirmedTurn.userContent,
			userText: confirmedTurn.userText ?? turn.userText,
			provider: confirmedTurn.provider ?? turn.provider,
			model: confirmedTurn.model ?? turn.model,
			createdAt: confirmedTurn.createdAt,
			updatedAt: confirmedTurn.updatedAt,
			meta,
		};
	});
	return {
		turns: remapped
			? mergeTurnsById([], nextTurns, { preferIncoming: true })
			: turns,
		remapped,
	};
}

function normalizeTurnDuplicates(turns: SessionTurnRecord[]) {
	const optimistic = turns.filter((turn) => turn.meta?.optimistic === true);
	const confirmed = turns.filter((turn) => turn.meta?.optimistic !== true);
	const confirmedClientMessageIds = new Set(
		confirmed
			.map(getTurnClientMessageId)
			.filter((value): value is string => Boolean(value)),
	);
	const optimisticByClientMessageId = new Map(
		optimistic
			.map((turn) => [getTurnClientMessageId(turn), turn] as const)
			.filter((entry): entry is [string, SessionTurnRecord] =>
				Boolean(entry[0]),
			),
	);
	return mergeTurnsById(
		optimistic.filter((turn) => {
			const clientMessageId = getTurnClientMessageId(turn);
			return (
				!clientMessageId || !confirmedClientMessageIds.has(clientMessageId)
			);
		}),
		confirmed.map((turn) => {
			const optimisticTurn = optimisticByClientMessageId.get(
				getTurnClientMessageId(turn) ?? "",
			);
			if (!optimisticTurn) return turn;
			return {
				...turn,
				userUuid: turn.userUuid ?? optimisticTurn.userUuid,
				authorProfile: turn.authorProfile ?? optimisticTurn.authorProfile,
			};
		}),
		{ preferIncoming: true },
	);
}

function applyAcceptedTurnId(input: {
	sessionId: string;
	previousTurnId?: string | null;
	nextTurnId: string;
	confirmedTurn?: SessionTurnRecord | null;
}) {
	if (input.previousTurnId && input.previousTurnId !== input.nextTurnId) {
		replaceGenerationTurnId(input.sessionId, {
			previousTurnId: input.previousTurnId,
			nextTurnId: input.nextTurnId,
		});
		void sessionTurnsRepo.replaceTurnId(
			spaceId,
			input.sessionId,
			{
				previousTurnId: input.previousTurnId,
				nextTurnId: input.nextTurnId,
			},
			{ source: "indexeddb" },
		);
		const current = sessionStateById[input.sessionId];
		if (current) {
			const turns = current.turns.map((turn) => {
				if (turn.id !== input.previousTurnId) return turn;
				const meta = {
					...(turn.meta ?? {}),
					...(input.confirmedTurn?.meta ?? {}),
				};
				delete meta.optimistic;
				return {
					...turn,
					...(input.confirmedTurn ?? {}),
					id: input.nextTurnId,
					userUuid: input.confirmedTurn?.userUuid ?? turn.userUuid,
					authorProfile:
						input.confirmedTurn?.authorProfile ?? turn.authorProfile ?? null,
					meta,
				};
			});
			sessionStateById = {
				...sessionStateById,
				[input.sessionId]: {
					...current,
					turns: normalizeTurnDuplicates(turns),
				},
			};
		}
		return;
	}
	replaceGenerationTurnId(input.sessionId, { nextTurnId: input.nextTurnId });
}
function hydrateTurnOnce(input: {
	sessionId: string;
	turnId: string;
	reason: string;
	onHydrated?: () => void;
}) {
	const key = `${input.sessionId}:${input.turnId}`;
	const inFlight = turnHydrationInFlight.get(key);
	if (inFlight) return inFlight;
	const run = sdk
		.space(spaceId)
		.session(input.sessionId)
		.turns.get(input.turnId)
		.then(async (response) => {
			const current = sessionStateById[input.sessionId];
			if (!current) return;
			const snapshot = await sessionTurnsRepo.mergeTurns(
				spaceId,
				input.sessionId,
				[response.turn],
				{
					session: response.session ?? current.session ?? null,
					source: "network",
				},
			);
			sessionStateById = {
				...sessionStateById,
				[input.sessionId]: {
					...current,
					session: snapshot.session ?? current.session,
					turns: snapshot.turns,
				},
			};
			input.onHydrated?.();
		})
		.catch((error) =>
			console.warn(`[${input.reason}] Failed to load full turn:`, error),
		);
	turnHydrationInFlight.set(key, run);
	return run.finally(() => {
		if (turnHydrationInFlight.get(key) === run) {
			turnHydrationInFlight.delete(key);
		}
	});
}
function handleTaskRealtimeEvent(payload: ChannelEnvelope) {
	const eventPayload = payload.payload as {
		task?: Partial<TaskRunRecord> & {
			id?: string;
			type?: string;
			userId?: string | null;
		};
		progress?: unknown;
		changed?: string[];
	};
	const task = eventPayload.task;
	if (!task?.id) return;
	const eventSpaceId = task.spaceId ?? payload.spaceId ?? spaceId;
	if (eventSpaceId !== spaceId) return;
	mergeCachedTaskRun(spaceId, task as Parameters<typeof mergeCachedTaskRun>[1]);
	const existingGenerationTaskRun = generationTaskRunById[task.id] ?? null;
	const mergedTaskRun = mergeTaskRunRecord(existingGenerationTaskRun, {
		...(task as Partial<TaskRunRecord>),
		id: task.id,
		type: task.type,
		userId: task.userId,
	});
	if (isGenerationTaskRun(mergedTaskRun))
		upsertGenerationTaskRun(mergedTaskRun);
	if (isBackgroundBashTaskRun(mergedTaskRun))
		upsertBackgroundBashTaskRun(mergedTaskRun);
	if (
		task.sessionId === activeSessionId &&
		(task.type === "run_command" || task.type === "generation")
	) {
		void hydrateTaskRun(task.id);
	}
	if (routeTaskId === task.id) {
		const wasActive = isActiveTaskRun(taskRunDetail);
		taskRunDetail = mergeTaskRunRecord(taskRunDetail, {
			...(task as Partial<TaskRunRecord>),
			id: task.id,
			type: task.type,
			userId: task.userId,
		});
		if ("progress" in eventPayload) taskRunProgress = eventPayload.progress;
		if (isActiveTaskRun(taskRunDetail)) {
			ensureTaskRunPoll(task.id);
		} else {
			clearTaskRunPoll();
			if (wasActive || !taskRunDetail.result) void refreshTaskDetail(task.id);
		}
	}
	if (task.cronJobId && cronjobDetail?.id === task.cronJobId) {
		cronjobRuns = mergeTaskRunList(cronjobRuns, {
			...(task as Partial<TaskRunRecord>),
			id: task.id,
			type: task.type,
			userId: task.userId,
		});
	}
	if (payload.type === "task.updated") {
		if (
			eventPayload.changed?.includes("status") &&
			task.status === "completed"
		) {
			void loadSpaceCheckpoints();
		}
	}
}
async function handleWsEvent(payload: ChannelEnvelope) {
	try {
		if (payload.type === "space.fs.changed") {
			await handleSpaceFsChanged(payload);
			return;
		}
		if (payload.type === "space.ports.changed") {
			applyPortsChanged(payload);
			return;
		}
		if (payload.type === "task.created" || payload.type === "task.updated") {
			handleTaskRealtimeEvent(payload);
			return;
		}
		if (payload.type === "label.assignments.updated") {
			const snapshot = parseResourceLabelRealtimePayload({
				spaceId: payload.spaceId,
				payload: payload.payload,
			});
			if (snapshot?.spaceId === spaceId)
				await syncResourceLabelsToCache(snapshot);
			return;
		}
		if (
			payload.type === "session.created" ||
			payload.type === "session.updated"
		) {
			const session = payload.payload.session as SessionRecord | undefined;
			if (session?.id) applySessionRealtimeRecord(session);
			return;
		}
		const targetSessionId =
			typeof payload.sessionId === "string" ? payload.sessionId : null;
		if (!targetSessionId) return;
		if (typeof payload.spaceId === "string" && payload.spaceId !== spaceId) {
			return;
		}
		const currentActiveSessionId = activeSessionId;
		const isActiveSession = targetSessionId === currentActiveSessionId;
		if (payload.type === "session.request.accepted") {
			clearPostSendRecovery(targetSessionId);
			return;
		}
		if (payload.type === "session.request.error") {
			const requestError = payload.payload as {
				message?: string;
				clientMessageId?: string | null;
			};
			const message = requestError.message?.trim() || "Message request failed";
			failGeneration(targetSessionId, message);
			if (isActiveSession) composerError = message;
			clearPostSendRecovery(targetSessionId);
			return;
		}
		let state = sessionStateById[targetSessionId];
		if (!state) {
			if (payload.type === "session.turn.created") {
				void loadSessionState(targetSessionId);
			}
			if (payload.type === "session.turn.finalized") {
				const turnId =
					typeof (payload.payload.turn as { id?: unknown } | undefined)?.id ===
					"string"
						? (payload.payload.turn as { id: string }).id
						: null;
				completeGenerationForTurn(targetSessionId, turnId);
			}
			return;
		}
		if (payload.type === "session.turn.created") {
			const turn = payload.payload.turn as SessionTurnRecord | undefined;
			if (turn?.id) {
				const clientMessageId = getTurnClientMessageId(turn);
				const optimisticTurn = state.turns.find(
					(item) =>
						isOptimisticTurn(item) &&
						isSameClientMessageTurn(item, clientMessageId),
				);
				if (optimisticTurn?.id && optimisticTurn.id !== turn.id) {
					applyAcceptedTurnId({
						sessionId: targetSessionId,
						previousTurnId: optimisticTurn.id,
						nextTurnId: turn.id,
						confirmedTurn: turn,
					});
					state = sessionStateById[targetSessionId] ?? state;
				}
				const current = sessionStateById[targetSessionId] ?? state;
				const reconciled = reconcileOptimisticTurn(current.turns, turn);
				const snapshot = await sessionTurnsRepo.mergeTurns(
					spaceId,
					targetSessionId,
					[turn],
					{ session: current.session ?? null },
				);
				sessionStateById = {
					...sessionStateById,
					[targetSessionId]: {
						...current,
						turns: normalizeTurnDuplicates(
							mergeTurnsById(reconciled.turns, snapshot.turns, {
								preferIncoming: true,
							}),
						),
					},
				};
			}
			return;
		}
		if (
			payload.type === "session.turn.finalized" ||
			payload.type === "session.turn.updated"
		) {
			const turnPatch = payload.payload.turn as
				| Partial<SessionTurnRecord>
				| undefined;
			const normalizedTurnPatch = turnPatch
				? {
						...turnPatch,
						finalUsage:
							turnPatch.finalUsage ??
							(turnPatch as { usage?: SessionTurnRecord["finalUsage"] })
								.usage ??
							null,
					}
				: undefined;
			const turnId =
				typeof normalizedTurnPatch?.id === "string"
					? normalizedTurnPatch.id
					: null;
			if (!turnId) return;
			const existingTurn =
				state.turns.find((turn) => turn.id === turnId) ?? null;
			if (existingTurn) {
				const snapshot = await sessionTurnsRepo.mergeTurns(
					spaceId,
					targetSessionId,
					[{ ...existingTurn, ...normalizedTurnPatch } as SessionTurnRecord],
					{ session: state.session ?? null },
				);
				sessionStateById = {
					...sessionStateById,
					[targetSessionId]: {
						...state,
						turns: snapshot.turns,
					},
				};
			}
			if (!existingTurn || payload.type === "session.turn.finalized") {
				void hydrateTurnOnce({
					sessionId: targetSessionId,
					turnId,
					reason: "turn.event",
					onHydrated:
						payload.type === "session.turn.finalized"
							? () => completeGenerationForTurn(targetSessionId, turnId)
							: undefined,
				});
			}
			if (isActiveSession && shouldAutoFollow) {
				await tick();
				requestBottomFollow();
			}
			return;
		}
		return;
	} catch (error) {
		console.error("[WS] handleWsEvent error:", error);
	}
}
function completeGenerationForTurn(sessionId: string, turnId: string | null) {
	const current = sessionGenerationStore.get(sessionId);
	if (turnId && current?.turnId && current.turnId !== turnId) return;
	completeGeneration(sessionId);
}

async function handleGenerationStreamEvent(
	sessionId: string,
	event: GenerationStreamEvent,
) {
	try {
		const generationEffect = applyGenerationStreamEvent(sessionId, event);
		if (!generationEffect.handled) return;
		clearPostSendRecovery(sessionId);
		if (generationEffect.shouldRestoreSnapshot) {
			void restoreSessionStreamSnapshot(sessionId, {
				turnId:
					"state" in event && event.state.turnId ? event.state.turnId : null,
			});
		}
		if (generationEffect.shouldReconcile && sessionId === activeSessionId) {
			void reconcileSessionTail(sessionId);
		}
		if (generationEffect.shouldRefreshSessions) {
			void refreshSessionsList(true);
		}
		if (
			generationEffect.shouldScroll &&
			sessionId === activeSessionId &&
			shouldAutoFollow
		) {
			await tick();
			requestBottomFollow();
		}
	} catch (error) {
		console.error("[WS] handleGenerationStreamEvent error:", error);
	}
}
async function handleForkTurn(turn: SessionTurnRecord) {
	if (!activeSessionId || forkingTurnId) return;
	forkingTurnId = turn.id;
	composerError = "";
	try {
		const response = await sdk
			.space(spaceId)
			.session(activeSessionId)
			.turn(turn.sourceTurnId ?? turn.id)
			.fork();
		await sessionTurnsRepo
			.clearSession(spaceId, response.session.id)
			.catch(() => undefined);
		await syncForkResponseToSessionListCache(
			response.session,
			response.fork as SessionListForkRecord,
			activeSessionState?.session ?? null,
		).catch(() => undefined);
		await goto(buildSpaceSessionRoute(spaceId, response.session.id));
	} catch (error) {
		composerError =
			error instanceof Error ? error.message : "Failed to fork session";
	} finally {
		forkingTurnId = null;
	}
}

async function handleAbort() {
	if (!activeSessionId || !activeSessionState?.session || !space || aborting)
		return;
	aborting = true;
	composerError = "";
	try {
		await sdk
			.space(spaceId)
			.session(activeSessionId)
			.abort({
				turnId: activeGenerationState?.turnId ?? null,
			});
		interruptGeneration(activeSessionId);
	} catch (error) {
		composerError =
			error instanceof Error ? error.message : "Failed to stop generation";
	} finally {
		aborting = false;
	}
}

function escapeMarkdownPath(path: string) {
	return path.replace(/[\r\n`]/g, "_");
}

function buildFileReferencesText(paths: string[]) {
	if (paths.length === 0) return "";
	return [
		"Files:",
		...paths.map((path) => `- \`${escapeMarkdownPath(path)}\``),
	].join("\n");
}

async function uploadComposerFileAttachments(
	sessionId: string,
	fileAttachments: ComposerFileAttachment[],
) {
	if (fileAttachments.length === 0) return [];
	attachments = attachments.map((attachment) =>
		attachment.kind === "file"
			? { ...attachment, status: "uploading" as const }
			: attachment,
	);
	const uploaded = await uploadSpaceEntries({
		spaceId,
		destination: { kind: "sandbox_tmp", sessionId },
		entries: fileAttachments.map((attachment) => ({
			file: attachment.file,
			relativePath: attachment.relativePath,
		})),
	});
	return uploaded.map((file) => file.path);
}

async function handleSend() {
	if (
		!activeSessionState?.session ||
		(!input.trim() && attachments.length === 0) ||
		sending ||
		!space
	)
		return;
	sending = true;
	composerError = "";
	clearGenerationError(activeSessionId);
	const sessionId = activeSessionState.session.id;
	const pendingInput = input;
	const pendingAttachments = attachments;
	const optimisticTurnId = crypto.randomUUID();
	const clientMessageId = crypto.randomUUID();
	const currentUser = {
		uuid: authStore.userUuid ?? null,
		profile: authStore.profile,
	};
	let content: ContentBlock[] = [];
	let text = "";
	let hadFileUpload = false;
	let fileUploadCompleted = false;
	let uploadedReferenceText = "";
	let optimisticTurn: SessionTurnRecord | null = null;
	let hasActiveTurn = false;
	try {
		const fileAttachments = attachments.filter(
			(attachment): attachment is ComposerFileAttachment =>
				attachment.kind === "file",
		);
		hadFileUpload = fileAttachments.length > 0;
		const filePaths = await uploadComposerFileAttachments(
			sessionId,
			fileAttachments,
		);
		fileUploadCompleted = true;
		const userText = input.trim();
		const referenceText = buildFileReferencesText(filePaths);
		uploadedReferenceText = referenceText;
		text = [userText, referenceText].filter(Boolean).join("\n\n");
		const attachmentBlocks: ContentBlock[] = attachments.flatMap(
			(attachment) => {
				if (attachment.kind === "file") return [];
				if (attachment.kind === "text")
					return [buildComposerTextContentBlock(attachment)];
				return [
					{
						type: "image",
						source: {
							type: "base64",
							media_type: attachment.mediaType,
							data: attachment.data,
						},
						_meta: {
							filename: attachment.name,
							size: attachment.size,
						},
					} satisfies ContentBlock,
				];
			},
		);
		const mentions = extractSpaceMentionsFromText(text);
		content = [
			...(text
				? [
						{
							type: "text",
							text,
							_meta: mentions.length > 0 ? { mentions } : undefined,
						} satisfies ContentBlock,
					]
				: []),
			...attachmentBlocks,
		];

		// Clear input immediately so it disappears from the composer at the same
		// time the optimistic turn appears in the list — avoids the awkward "stuck"
		// feeling where the message shows in the list but lingers in the input.
		input = "";
		attachments = [];
		const model = activeSessionModel;
		const now = new Date().toISOString();
		const sequenceHint = (activeSessionState?.turns.at(-1)?.sequence ?? 0) + 1;
		hasActiveTurn = activeSessionIsRunning;
		optimisticTurn = {
			id: optimisticTurnId,
			sessionId,
			userUuid: currentUser.uuid,
			sequence: sequenceHint,
			status: hasActiveTurn ? "queued" : "running",
			intent: "followup",
			userContent: content,
			userText: text,
			assistantContent: null,
			assistantText: null,
			provider: model?.provider ?? null,
			model: model?.id ?? null,
			stopReason: null,
			errorMessage: null,
			finalUsage: null,
			totalUsage: null,
			summary: null,
			intermediateIndex: null,
			intermediateSummary: null,
			meta: {
				optimistic: true,
				userId: currentUser.uuid,
				clientMessageId,
			},
			authorProfile: currentUser.profile,
			startedAt: now,
			completedAt: null,
			durationMs: null,
			createdAt: now,
			updatedAt: now,
		} as SessionTurnRecord;
		sessionStateById = {
			...sessionStateById,
			[sessionId]: {
				...activeSessionState,
				turns: mergeTurnsById(activeSessionState.turns, [optimisticTurn], {
					preferIncoming: true,
				}),
			},
		};
		// Sending a message is an explicit intent to jump back to the live edge.
		// This keeps the optimistic user turn and the following streaming reply in view,
		// even if the user was previously reading older context.
		shouldAutoFollow = true;
		await tick();
		requestBottomFollow({ immediate: true });
		void sessionTurnsRepo.mergeTurns(spaceId, sessionId, [optimisticTurn], {
			session: activeSessionState.session,
		});
		if (!hasActiveTurn)
			startGenerationRequest(sessionId, { spaceId, turnId: optimisticTurnId });
		const sendResult = await sdk.space(spaceId).prompt({
			sessionId,
			content,
			model: model?.id,
			provider: model?.provider,
			clientMessageId,
			generationPolicy: buildTurnGenerationPolicy(),
			intent: "followup",
			schedule: { mode: "immediate" },
		});
		if (sendResult.mode !== "immediate") {
			throw new Error("Expected immediate prompt response");
		}
		const acceptedTurn = sendResult.turn;
		applyAcceptedTurnId({
			sessionId,
			previousTurnId: optimisticTurnId,
			nextTurnId: acceptedTurn.id,
			confirmedTurn: acceptedTurn,
		});
		const current = sessionStateById[sessionId];
		if (current) {
			const snapshot = await sessionTurnsRepo.mergeTurns(
				spaceId,
				sessionId,
				[
					{
						...acceptedTurn,
						userUuid: acceptedTurn.userUuid ?? currentUser.uuid,
						authorProfile:
							acceptedTurn.authorProfile ?? currentUser.profile ?? null,
					},
				],
				{ session: sendResult.session ?? current.session ?? null },
			);
			sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					...current,
					session: snapshot.session ?? current.session,
					turns: normalizeTurnDuplicates(snapshot.turns),
				},
			};
		}
		if (wsConnectionState !== "open") {
			schedulePostSendRecoveryCheck(sessionId);
		}
	} catch (error) {
		// Restore input and attachments on failure so user doesn't lose their message
		if (hadFileUpload && fileUploadCompleted) {
			input = [pendingInput.trim(), uploadedReferenceText]
				.filter(Boolean)
				.join("\n\n");
			attachments = pendingAttachments.filter(
				(attachment) => attachment.kind !== "file",
			);
		} else {
			input = pendingInput;
			attachments = pendingAttachments;
		}
		if (hadFileUpload && !fileUploadCompleted) {
			attachments = attachments.map((attachment) =>
				attachment.kind === "file"
					? { ...attachment, status: "failed" as const }
					: attachment,
			);
		}
		const sendError =
			error instanceof Error ? error.message : "Failed to send message";
		const displayError = hadFileUpload
			? fileUploadCompleted
				? "Message failed. Files were uploaded."
				: "Upload failed. Please try again."
			: sendError;
		composerError = displayError;
		failGeneration(sessionId, sendError);
		const current = sessionStateById[sessionId];
		if (current && optimisticTurn) {
			const failedAt = new Date().toISOString();
			const failedTurn = {
				id: optimisticTurnId,
				sessionId,
				userUuid: currentUser.uuid,
				sequence: optimisticTurn.sequence,
				status: hasActiveTurn ? "cancelled" : "failed",
				intent: "followup",
				userContent: content,
				userText: text,
				assistantContent: null,
				assistantText: null,
				provider: optimisticTurn.provider,
				model: optimisticTurn.model,
				stopReason: "error",
				errorMessage: displayError,
				finalUsage: null,
				totalUsage: null,
				summary: null,
				intermediateIndex: null,
				intermediateSummary: null,
				meta: {
					...(optimisticTurn.meta ?? {}),
					localOnly: true,
					failedAt,
				},
				authorProfile: currentUser.profile,
				startedAt: optimisticTurn.startedAt,
				completedAt: failedAt,
				durationMs: null,
				createdAt: optimisticTurn.createdAt,
				updatedAt: failedAt,
			} as SessionTurnRecord;
			sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					...current,
					turns: mergeTurnsById(
						current.turns.filter((turn) => turn.id !== optimisticTurnId),
						[failedTurn],
						{ preferIncoming: true },
					),
				},
			};
		}
	} finally {
		sending = false;
	}
}
function scrollToBottomNow() {
	if (!listEl) return;
	autoScrollGuard = true;
	setProgrammaticScrollTop(listEl.scrollHeight - listEl.clientHeight);
	if (activeSessionId) {
		writeBottomScrollAnchor(activeSessionId);
	}
	requestAnimationFrame(() => {
		autoScrollGuard = false;
	});
}
function stopBottomFollow() {
	bottomFollowActive = false;
	if (bottomFollowFrame != null) {
		cancelAnimationFrame(bottomFollowFrame);
		bottomFollowFrame = null;
	}
}
function requestBottomFollow(options?: { immediate?: boolean }) {
	if (!listEl || !shouldAutoFollow) return;
	if (options?.immediate) {
		scrollToBottomNow();
		return;
	}
	bottomFollowActive = true;
	if (bottomFollowFrame == null) {
		bottomFollowFrame = requestAnimationFrame(runBottomFollowFrame);
	}
}
function runBottomFollowFrame() {
	bottomFollowFrame = null;
	if (!bottomFollowActive || !listEl || !shouldAutoFollow) {
		bottomFollowActive = false;
		return;
	}
	const maxScroll = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
	const distance = maxScroll - listEl.scrollTop;
	if (Math.abs(distance) <= 1) {
		setProgrammaticScrollTop(maxScroll);
		bottomFollowActive = false;
		return;
	}
	const velocity = Math.max(8, Math.min(96, Math.abs(distance) * 0.34));
	const next = listEl.scrollTop + Math.sign(distance) * velocity;
	setProgrammaticScrollTop(
		distance > 0 ? Math.min(next, maxScroll) : Math.max(next, maxScroll),
	);
	if (activeSessionId) writeBottomScrollAnchor(activeSessionId);
	bottomFollowFrame = requestAnimationFrame(runBottomFollowFrame);
}
async function forceScrollToBottom() {
	await tick();
	await new Promise<void>((resolve) => {
		requestAnimationFrame(() => {
			scrollToBottomNow();
			resolve();
		});
	});
}
function updateAutoFollow() {
	if (!listEl) return;
	const threshold = 60;
	const distanceFromBottom =
		listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight;
	shouldAutoFollow = distanceFromBottom <= threshold;
}
function updateCurrentTurnSequence() {
	if (!listEl) return;
	const nodes = Array.from(
		listEl.querySelectorAll<HTMLElement>('[data-turn-anchor="user"]'),
	);
	if (nodes.length === 0) {
		currentTurnSequence = null;
		return;
	}
	const containerRect = listEl.getBoundingClientRect();
	const probeY = containerRect.top + Math.min(160, containerRect.height * 0.35);
	let best: { sequence: number; distance: number } | null = null;
	for (const node of nodes) {
		const sequence = Number(node.dataset.turnSequence);
		if (!Number.isFinite(sequence)) continue;
		const rect = node.getBoundingClientRect();
		const distance =
			rect.top <= probeY ? probeY - rect.top : rect.top - probeY + 1000;
		if (!best || distance < best.distance) best = { sequence, distance };
	}
	currentTurnSequence = best?.sequence ?? null;
}
function setProgrammaticScrollTop(scrollTop: number) {
	if (!listEl) return;
	const nextScrollTop = Math.min(
		Math.max(0, listEl.scrollHeight - listEl.clientHeight),
		Math.max(0, scrollTop),
	);
	programmaticScrollActive = true;
	programmaticScrollTarget = nextScrollTop;
	userScrollActive = false;
	listEl.scrollTop = nextScrollTop;
	updateTimelineScrollMetrics();
	requestAnimationFrame(() => {
		programmaticScrollActive = false;
	});
}
function beginUserScroll() {
	if (!activeSessionId) return;
	stopBottomFollow();
	userScrollActive = true;
	programmaticScrollActive = false;
	programmaticScrollTarget = null;
	if (activeAnchorRestore?.sessionId === activeSessionId) {
		activeAnchorRestore = null;
		anchorRestoreWaitingForMarkdown = false;
	}
	if (pendingRestoreSessionId === activeSessionId) {
		pendingRestoreSessionId = null;
	}
	if (restoringBottomSessionId === activeSessionId) {
		restoringBottomSessionId = null;
	}
}
function handleScrollKeydown(event: KeyboardEvent) {
	if (
		event.key === "ArrowDown" ||
		event.key === "ArrowUp" ||
		event.key === "PageDown" ||
		event.key === "PageUp" ||
		event.key === "Home" ||
		event.key === "End" ||
		event.key === " "
	) {
		beginUserScroll();
	}
}
function maybeCompleteAnchorRestore() {
	if (!activeAnchorRestore || !anchorRestoreWaitingForMarkdown) return;
	if (pendingTimelineMarkdownRenders > 0) return;
	activeAnchorRestore = null;
	anchorRestoreWaitingForMarkdown = false;
	updateAutoFollow();
}
function applyActiveAnchorRestore(restore = activeAnchorRestore) {
	if (!restore || !listEl || activeSessionId !== restore.sessionId)
		return false;
	const node = listEl.querySelector<HTMLElement>(
		`[data-sequence="${restore.sequence}"]`,
	);
	if (!node) return false;
	setProgrammaticScrollTop(getMessageElementAbsoluteTop(node) + restore.offset);
	shouldAutoFollow = false;
	return true;
}
function handleTimelineMarkdownRenderStart() {
	pendingTimelineMarkdownRenders += 1;
}
function handleTimelineMarkdownRendered() {
	if (pendingTimelineMarkdownRenders > 0) pendingTimelineMarkdownRenders -= 1;
	scheduleTurnMarkerMeasure();
	const restore = activeAnchorRestore;
	if (restore?.sessionId === activeSessionId) {
		requestAnimationFrame(() => {
			applyActiveAnchorRestore(restore);
			maybeCompleteAnchorRestore();
		});
		return;
	}
	if (
		activeSessionId &&
		(restoringBottomSessionId === activeSessionId || shouldAutoFollow)
	) {
		requestAnimationFrame(() => requestBottomFollow());
	}
	maybeCompleteAnchorRestore();
}
async function fileToDataUrl(file: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result ?? ""));
		reader.onerror = () =>
			reject(reader.error ?? new Error("Failed to read file"));
		reader.readAsDataURL(file);
	});
}
async function loadImageElement(file: File): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const objectUrl = URL.createObjectURL(file);
		const image = new Image();
		image.onload = () => {
			URL.revokeObjectURL(objectUrl);
			resolve(image);
		};
		image.onerror = () => {
			URL.revokeObjectURL(objectUrl);
			reject(new Error("Failed to decode image"));
		};
		image.src = objectUrl;
	});
}
async function canvasToImageBlob(
	canvas: HTMLCanvasElement,
	mediaType: string,
	quality: number,
): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (blob) resolve(blob);
				else reject(new Error("Failed to encode image"));
			},
			mediaType,
			quality,
		);
	});
}
function isSafariBrowser() {
	const userAgent = navigator.userAgent;
	return /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(userAgent);
}
function getCompressedImageName(name: string, mediaType: string) {
	const baseName = name.replace(/\.[^.]+$/, "") || name;
	return `${baseName}.${mediaType === SAFARI_IMAGE_MEDIA_TYPE ? "jpg" : "webp"}`;
}
async function compressImageFile(file: File) {
	try {
		const image = await loadImageElement(file);
		const longestEdge = Math.max(image.naturalWidth, image.naturalHeight);
		const scale =
			longestEdge > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / longestEdge : 1;
		const width = Math.max(1, Math.round(image.naturalWidth * scale));
		const height = Math.max(1, Math.round(image.naturalHeight * scale));
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas is not supported");
		context.drawImage(image, 0, 0, width, height);
		const targetMediaType = isSafariBrowser()
			? SAFARI_IMAGE_MEDIA_TYPE
			: DEFAULT_IMAGE_MEDIA_TYPE;
		const targetQuality = isSafariBrowser()
			? SAFARI_IMAGE_QUALITY
			: DEFAULT_IMAGE_QUALITY;
		const blob = await canvasToImageBlob(
			canvas,
			targetMediaType,
			targetQuality,
		);
		const dataUrl = await fileToDataUrl(blob);
		return {
			blob,
			dataUrl,
			mediaType: blob.type || targetMediaType,
			size: blob.size,
		};
	} catch {
		throw new Error(
			`Could not process image "${file.name}". Use JPG, PNG, GIF, or WebP.`,
		);
	}
}
async function handlePickAttachments(
	files: FileList | File[] | LocalUploadEntry[] | null,
) {
	if (!files) return;
	let pickedEntries: LocalUploadEntry[];
	try {
		pickedEntries =
			Array.isArray(files) &&
			files.every((item) => "file" in item && "relativePath" in item)
				? (files as LocalUploadEntry[])
				: entriesFromFiles(Array.from(files as FileList | File[]));
	} catch {
		composerError = "Invalid upload path.";
		return;
	}
	if (pickedEntries.length === 0) return;

	const remainingSlots = MAX_COMPOSER_ATTACHMENTS - attachments.length;
	if (remainingSlots <= 0) {
		composerError = `You can attach up to ${MAX_COMPOSER_ATTACHMENTS} files.`;
		return;
	}
	const acceptedEntries = pickedEntries.slice(0, remainingSlots);
	if (acceptedEntries.length < pickedEntries.length) {
		composerError = `Only the first ${remainingSlots} file${remainingSlots === 1 ? "" : "s"} were attached.`;
	} else {
		composerError = "";
	}

	try {
		const nextAttachments = await Promise.all(
			acceptedEntries.map(async (entry): Promise<ComposerAttachment> => {
				const { file, relativePath } = entry;
				if (!isSupportedComposerAttachmentFile(file)) {
					return {
						kind: "file",
						id: createComposerAttachmentId(file),
						name: file.name,
						relativePath,
						mediaType: file.type || null,
						file,
						size: file.size,
						status: "ready",
					} satisfies ComposerFileAttachment;
				}
				if (!isComposerImageFile(file)) {
					try {
						return await readComposerTextAttachment(file);
					} catch (error) {
						if (error instanceof Error && !error.message.includes("exceeds"))
							throw error;
						return {
							kind: "file",
							id: createComposerAttachmentId(file),
							name: file.name,
							relativePath,
							mediaType: file.type || null,
							file,
							size: file.size,
							status: "ready",
						} satisfies ComposerFileAttachment;
					}
				}
				if (!isSupportedComposerImageFile(file)) {
					return {
						kind: "file",
						id: createComposerAttachmentId(file),
						name: file.name,
						relativePath,
						mediaType: file.type || null,
						file,
						size: file.size,
						status: "ready",
					} satisfies ComposerFileAttachment;
				}
				const compressed = await compressImageFile(file);
				const [, base64 = ""] = compressed.dataUrl.split(",");
				return {
					kind: "image",
					id: createComposerAttachmentId(file),
					name: getCompressedImageName(file.name, compressed.mediaType),
					mediaType: compressed.mediaType,
					data: base64,
					previewUrl: compressed.dataUrl,
					size: compressed.size,
				} satisfies ComposerImageAttachment;
			}),
		);
		attachments = [...attachments, ...nextAttachments];
	} catch (error) {
		composerError =
			error instanceof Error ? error.message : "Failed to read attachment";
	}
}
function handleRemoveAttachment(id: string) {
	attachments = attachments.filter((attachment) => attachment.id !== id);
}
function beginRightSidebarResize(event: PointerEvent) {
	event.preventDefault();
	if (window.innerWidth < 1024 || uiState.rightSidebarCollapsed) return;
	const target = event.currentTarget as HTMLElement | null;
	target?.setPointerCapture?.(event.pointerId);
	rightSidebarResizeCleanup?.();
	const startX = event.clientX;
	const startWidth = uiState.rightSidebarWidth;
	const minMainWidth = 720;
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
function getRightSidebarReservedWidth() {
	if (uiState.rightSidebarCollapsed || spaceHasMinimalAccess) return 0;
	return uiState.rightSidebarWidth;
}
function getMaxPreviewPanelWidth() {
	if (typeof window === "undefined") return previewPanelWidth;
	const layoutWidth = workspaceBodyEl?.clientWidth ?? window.innerWidth;
	return Math.max(
		PREVIEW_PANEL_MIN_WIDTH,
		layoutWidth - CHAT_PANEL_MIN_WIDTH - getRightSidebarReservedWidth(),
	);
}
function setPreviewPanelWidth(width: number) {
	previewPanelWidth = Math.min(
		Math.max(PREVIEW_PANEL_MIN_WIDTH, width),
		getMaxPreviewPanelWidth(),
	);
}
function ensurePreviewPanelFits() {
	setPreviewPanelWidth(previewPanelWidth);
}
function restorePreviewFocusSnapshot() {
	const snapshot = previewFocusSnapshot;
	previewFocusSnapshot = null;
	if (!snapshot) return;
	uiState.setLeftSidebarCollapsed(snapshot.leftSidebarCollapsed);
	uiState.setRightSidebarCollapsed(snapshot.rightSidebarCollapsed);
	previewPanelWidth = snapshot.previewPanelWidth;
	ensurePreviewPanelFits();
}
async function togglePreviewFocusMode() {
	if (isMobile) return;
	if (previewFocusMode) {
		previewFocusMode = false;
		restorePreviewFocusSnapshot();
		return;
	}
	previewFocusSnapshot = {
		leftSidebarCollapsed: uiState.leftSidebarCollapsed,
		rightSidebarCollapsed: uiState.rightSidebarCollapsed,
		previewPanelWidth,
	};
	previewFocusMode = true;
	uiState.setLeftSidebarCollapsed(true);
	uiState.setRightSidebarCollapsed(true);
	await tick();
	setPreviewPanelWidth(getMaxPreviewPanelWidth());
}
function closePreviewFocusMode() {
	if (!previewFocusMode && !previewFocusSnapshot) return;
	previewFocusMode = false;
	restorePreviewFocusSnapshot();
}
function handlePreviewWindowResize() {
	if (previewFocusMode) {
		setPreviewPanelWidth(getMaxPreviewPanelWidth());
		return;
	}
	if (activePreviewKind) ensurePreviewPanelFits();
}
function beginPreviewPanelResize(event: PointerEvent) {
	event.preventDefault();
	if (window.innerWidth < 1024) return;
	previewFocusMode = false;
	previewFocusSnapshot = null;
	const target = event.currentTarget as HTMLElement | null;
	target?.setPointerCapture?.(event.pointerId);
	previewPanelResizeCleanup?.();
	const startX = event.clientX;
	const startWidth = previewPanelWidth;
	const onPointerMove = (moveEvent: PointerEvent) => {
		const delta = startX - moveEvent.clientX;
		setPreviewPanelWidth(startWidth + delta);
	};
	const stop = () => {
		if (target?.hasPointerCapture?.(event.pointerId)) {
			target.releasePointerCapture(event.pointerId);
		}
		document.body.classList.remove("sidebar-resizing");
		window.removeEventListener("pointermove", onPointerMove);
		window.removeEventListener("pointerup", stop);
		window.removeEventListener("pointercancel", stop);
		if (previewPanelResizeCleanup === stop) previewPanelResizeCleanup = null;
	};
	previewPanelResizeCleanup = stop;
	document.body.classList.add("sidebar-resizing");
	window.addEventListener("pointermove", onPointerMove);
	window.addEventListener("pointerup", stop);
	window.addEventListener("pointercancel", stop);
}
async function toggleRightSidebar() {
	if (window.innerWidth < 1024) {
		uiState.mobileRightDrawerOpen = !uiState.mobileRightDrawerOpen;
		return;
	}
	const nextCollapsed = !uiState.rightSidebarCollapsed;
	const rightWidth = uiState.rightSidebarWidth;
	uiState.setRightSidebarCollapsed(nextCollapsed);
	if (!activePreviewKind) return;
	closePreviewFocusMode();
	await tick();
	setPreviewPanelWidth(
		previewPanelWidth + (nextCollapsed ? rightWidth : -rightWidth),
	);
}
async function loadFileTree(force = false) {
	const source = activeFsSource;
	const sourceKey = activeFsSourceKey;
	if (fileTreeLoading && !force) return;
	const requestToken = fileTreeRequestToken + 1;
	fileTreeRequestToken = requestToken;
	if (!force) {
		if (source.kind === "live") {
			const cached = await getCachedSpaceFsDir(spaceId, "");
			if (
				requestToken !== fileTreeRequestToken ||
				sourceKey !== activeFsSourceKey
			)
				return;
			if (cached && cached.length > 0) {
				setActiveFileTree(makeFsNodes(cached, fileTree));
			}
		} else {
			const cached = fileTreeBySource[sourceKey];
			if (cached) setActiveFileTree(cached);
		}
	}
	const shouldShowLoading = fileTree.length === 0 || force;
	if (shouldShowLoading) {
		fileTreeLoading = true;
	}
	fileTreeError = null;
	try {
		const entries =
			source.kind === "live"
				? await fetchSpaceFsDirWithCache(
						spaceId,
						"",
						async () => {
							const tree = await sdk.space(spaceId).files.list("");
							return tree.entries;
						},
						{ force: true },
					)
				: (
						await sdk
							.space(spaceId)
							.checkpoints(source.checkpointId)
							.files.list("")
					).entries;
		if (
			requestToken !== fileTreeRequestToken ||
			sourceKey !== activeFsSourceKey
		)
			return;
		setActiveFileTree(makeFsNodes(entries, fileTree));
	} catch (error) {
		if (
			requestToken !== fileTreeRequestToken ||
			sourceKey !== activeFsSourceKey
		)
			return;
		fileTreeError =
			error instanceof Error ? error.message : "Failed to load files";
	} finally {
		if (
			requestToken === fileTreeRequestToken &&
			sourceKey === activeFsSourceKey
		) {
			fileTreeLoading = false;
		}
	}
}
async function expandDirectory(node: SpaceFsNode) {
	if (node.type !== "dir") return;
	if (node.isOpen) {
		directoryLoadTokenByPath = {
			...directoryLoadTokenByPath,
			[node.path]: (directoryLoadTokenByPath[node.path] ?? 0) + 1,
		};
		setActiveFileTree(
			updateNodeState(fileTree, node.path, (item) => ({
				...item,
				isOpen: false,
				isLoading: false,
			})),
		);
		return;
	}

	const requestToken = (directoryLoadTokenByPath[node.path] ?? 0) + 1;
	directoryLoadTokenByPath = {
		...directoryLoadTokenByPath,
		[node.path]: requestToken,
	};

	const source = activeFsSource;
	const sourceKey = activeFsSourceKey;
	const hasExistingChildren = node.children.length > 0;
	const cached =
		source.kind === "live"
			? await getCachedSpaceFsDir(spaceId, node.path)
			: null;
	if (directoryLoadTokenByPath[node.path] !== requestToken) return;

	if (cached) {
		setActiveFileTree(
			replaceNodeChildren(fileTree, node.path, makeFsNodes(cached)),
		);
	} else {
		setActiveFileTree(
			updateNodeState(fileTree, node.path, (item) => ({
				...item,
				isLoading: !hasExistingChildren,
				isOpen: true,
			})),
		);
	}

	try {
		const entries =
			source.kind === "live"
				? await fetchSpaceFsDirWithCache(
						spaceId,
						node.path,
						async () => {
							const tree = await sdk.space(spaceId).files.list(node.path);
							return tree.entries;
						},
						{ force: true },
					)
				: (
						await sdk
							.space(spaceId)
							.checkpoints(source.checkpointId)
							.files.list(node.path)
					).entries;
		if (
			directoryLoadTokenByPath[node.path] !== requestToken ||
			sourceKey !== activeFsSourceKey
		)
			return;
		setActiveFileTree(
			replaceNodeChildren(fileTree, node.path, makeFsNodes(entries)),
		);
	} catch (error) {
		if (directoryLoadTokenByPath[node.path] !== requestToken) return;
		setActiveFileTree(
			updateNodeState(fileTree, node.path, (item) => ({
				...item,
				isLoading: false,
			})),
		);
		fileTreeError =
			error instanceof Error ? error.message : "Failed to load directory";
	}
}
async function openSpaceFile(path: string) {
	void goto(buildSpaceFileRoute(spaceId, path), {
		replaceState: true,
		noScroll: true,
		keepFocus: true,
	});
}
async function refreshFileTree() {
	await loadFileTree(true);
}
async function openFileFromUrl(path: string) {
	const requestSpaceId = spaceId;
	const isCurrentRequest = () =>
		spaceId === requestSpaceId &&
		routeView === "file" &&
		routeFilePath === path;
	inlinePortPreview = null;
	openFileLoading = true;
	openFileError = null;
	openFileTooLarge = false;
	try {
		const file = await sdk.space(requestSpaceId).files.read(path);
		if (!isCurrentRequest()) return;
		if (!("content" in file)) {
			openFile = null;
			openFileDraft = "";
			openFileError = "File is being prepared. Please retry shortly.";
			return;
		}
		fileEdit = shouldOpenFileInEditMode(file);
		openFile = file;
		openFileDraft = file.kind === "text" ? file.content : "";
	} catch (error) {
		if (!isCurrentRequest()) return;
		if (error instanceof HttpError && error.status === 413) {
			openFileTooLarge = true;
			openFile = null;
			openFileDraft = "";
			openFileError = null;
		} else {
			openFileError =
				error instanceof Error ? error.message : "Failed to open file";
		}
	} finally {
		if (isCurrentRequest()) openFileLoading = false;
	}
}
async function saveOpenFile() {
	if (!canEditFiles || openFile?.kind !== "text") return;
	const savingPath = openFile.path;
	markFileSavePending(savingPath);
	openFileSaving = true;
	openFileError = null;
	try {
		await sdk.space(spaceId).files.write({
			path: savingPath,
			content: openFileDraft,
			encoding: "utf-8",
		});
		openFile = {
			...openFile,
			content: openFileDraft,
			size: new Blob([openFileDraft]).size,
		};
		openFileError = null;
		const updatedPath = openFile.path;
		await patchFsDirectory(getParentDirPath(updatedPath), (entries) =>
			entries.map((entry) =>
				entry.path === updatedPath
					? {
							...entry,
							size: new Blob([openFileDraft]).size,
							mtimeMs: Date.now(),
						}
					: entry,
			),
		);
	} catch (error) {
		openFileError =
			error instanceof Error ? error.message : "Failed to save file";
	} finally {
		openFileSaving = false;
		clearFileSavePendingSoon(savingPath);
	}
}
async function handleCreateFile(parentPath: string) {
	if (activeFsReadonly || !canEditFiles) return;
	const name = prompt("New file name");
	if (!name?.trim()) return;
	const path = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
	try {
		await sdk
			.space(spaceId)
			.files.write({ path, content: "", encoding: "utf-8" });
		await patchFsDirectory(parentPath, (entries) => [
			...entries,
			buildFsEntry(path, "file"),
		]);
		if (isCovasFile(path)) await openInlineCanvas(path);
		else await openInlineFile(path);
	} catch (error) {
		fileTreeError =
			error instanceof Error ? error.message : "Failed to create file";
	}
}
async function handleCreateCanvas(parentPath: string) {
	if (activeFsReadonly || !canEditFiles) return;
	const name = prompt("New canvas name", "Untitled.covas");
	if (!name?.trim()) return;
	const fileName = ensureCovasExtension(name);
	const path = parentPath ? `${parentPath}/${fileName}` : fileName;
	try {
		await sdk.space(spaceId).canvas.create({
			path,
			title: fileName,
			nodes: createEmptyCovasDocument().items.map(canvasItemToNode),
		});
		await patchFsDirectory(parentPath, (entries) => [
			...entries,
			buildFsEntry(path, "file"),
		]);
		await openInlineCanvas(path);
	} catch (error) {
		fileTreeError =
			error instanceof Error ? error.message : "Failed to create canvas";
	}
}
async function handleCreateDir(parentPath: string) {
	if (activeFsReadonly || !canEditFiles) return;
	const name = prompt("New folder name");
	if (!name?.trim()) return;
	const path = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
	try {
		await sdk.space(spaceId).files.createDir(path);
		await patchFsDirectory(parentPath, (entries) => [
			...entries,
			buildFsEntry(path, "dir"),
		]);
	} catch (error) {
		fileTreeError =
			error instanceof Error ? error.message : "Failed to create folder";
	}
}
async function handleRenameNode(node: SpaceFsNode) {
	if (activeFsReadonly) return;
	if (!canEditFiles) return;
	const nextName = prompt("Rename", node.name);
	if (!nextName?.trim() || nextName.trim() === node.name) return;
	const parent = node.path.includes("/")
		? node.path.slice(0, node.path.lastIndexOf("/"))
		: "";
	const toPath = parent ? `${parent}/${nextName.trim()}` : nextName.trim();
	const isDirectoryRename = node.type === "dir";
	try {
		await sdk.space(spaceId).files.move({ fromPath: node.path, toPath });
		if (parent === getParentDirPath(toPath)) {
			await patchFsDirectory(parent, (entries) =>
				entries.map((entry) =>
					entry.path === node.path
						? {
								...entry,
								name: nextName.trim(),
								path: toPath,
								mtimeMs: Date.now(),
							}
						: entry,
				),
			);
		} else {
			await patchFsDirectory(parent, (entries) =>
				entries.filter((entry) => entry.path !== node.path),
			);
			await patchFsDirectory(getParentDirPath(toPath), (entries) => [
				...entries,
				{
					...buildFsEntry(toPath, node.type),
					size: node.size,
					mimeType: node.mimeType,
					mtimeMs: Date.now(),
				},
			]);
		}
		if (isDirectoryRename) {
			await clearCachedSpaceFsSubtree(spaceId, node.path);
		}
		if (openFile?.path === node.path) {
			closeFile();
		}
		if (inlineFile?.path === node.path) {
			await openInlineFile(toPath);
		}
		if (inlineCanvas?.path === node.path) {
			inlineCanvas = { ...inlineCanvas, path: toPath };
		}
	} catch (error) {
		fileTreeError = error instanceof Error ? error.message : "Failed to rename";
	}
}
async function handleDownloadNode(node: SpaceFsNode) {
	if (node.type !== "file") return;
	try {
		await downloadSpaceFile(spaceId, node.path, node.name);
	} catch (error) {
		fileTreeError =
			error instanceof Error ? error.message : "Failed to download";
	}
}
async function handleDeleteNode(node: SpaceFsNode) {
	if (activeFsReadonly || !canEditFiles) return;
	if (!confirm(`Delete ${node.name}?`)) return;
	try {
		await sdk.space(spaceId).files.delete(node.path, node.type === "dir");
		await patchFsDirectory(getParentDirPath(node.path), (entries) =>
			entries.filter((entry) => entry.path !== node.path),
		);
		if (node.type === "dir") {
			await clearCachedSpaceFsSubtree(spaceId, node.path);
		}
		if (openFile?.path === node.path) closeFile();
		if (inlineFile?.path === node.path) closeInlineFile();
		if (inlineCanvas?.path === node.path) closeInlineCanvas();
	} catch (error) {
		fileTreeError = error instanceof Error ? error.message : "Failed to delete";
	}
}
function closeFile() {
	void goto(buildSpaceDetailRoute(spaceId), {
		replaceState: true,
		noScroll: true,
		keepFocus: true,
	});
}
async function openInlineFile(path: string) {
	const sourceKey = activeFsSourceKey;
	const requestToken = inlineFileRequestToken + 1;
	inlineFileRequestToken = requestToken;
	closePreviewFocusMode();
	ensurePreviewPanelFits();
	inlinePortPreview = null;
	inlineCanvas = null;
	inlineFile = {
		response: null,
		draft: "",
		path,
		loading: true,
		saving: false,
		error: null,
		tooLarge: false,
	};
	try {
		const file = await readActiveFsFile(path);
		if (
			requestToken !== inlineFileRequestToken ||
			sourceKey !== activeFsSourceKey
		)
			return;
		if (!("content" in file)) {
			inlineFile = {
				response: null,
				draft: "",
				path,
				loading: false,
				saving: false,
				error: "File is being prepared. Please retry shortly.",
				tooLarge: false,
			};
			return;
		}
		inlineFileEdit = shouldOpenFileInEditMode(file);
		inlineFile = {
			response: file,
			draft: file.kind === "text" ? file.content : "",
			path,
			loading: false,
			saving: false,
			error: null,
			tooLarge: false,
		};
	} catch (error) {
		if (
			requestToken !== inlineFileRequestToken ||
			sourceKey !== activeFsSourceKey
		)
			return;
		if (error instanceof HttpError && error.status === 413) {
			inlineFile = {
				response: null,
				draft: "",
				path,
				loading: false,
				saving: false,
				error: null,
				tooLarge: true,
			};
		} else {
			inlineFile = {
				response: null,
				draft: "",
				path,
				loading: false,
				saving: false,
				error: error instanceof Error ? error.message : "Failed to open file",
				tooLarge: false,
			};
		}
	}
}
function closeInlineFile() {
	inlineFileRequestToken += 1;
	inlineFile = null;
	closePreviewFocusMode();
}
async function openInlineCanvas(path: string) {
	const sourceKey = activeFsSourceKey;
	closePreviewFocusMode();
	ensurePreviewPanelFits();
	const requestToken = inlineCanvasRequestToken + 1;
	inlineCanvasRequestToken = requestToken;
	inlineFile = null;
	inlinePortPreview = null;
	inlineCanvas = {
		path,
		documentId: null,
		document: null,
		loading: true,
		saving: false,
		error: null,
	};
	try {
		const file = await readActiveFsFile(path);
		if (
			requestToken !== inlineCanvasRequestToken ||
			inlineCanvas?.path !== path ||
			sourceKey !== activeFsSourceKey
		)
			return;
		if (!("content" in file) || file.kind !== "text") {
			throw new Error("Canvas manifest must be a text file.");
		}
		const manifest = parseCovasManifest(file.content);
		if (!manifest) throw new Error("Canvas manifest is invalid.");
		const bootstrap = await sdk
			.space(spaceId)
			.canvas.bootstrap(manifest.documentId);
		if (
			requestToken !== inlineCanvasRequestToken ||
			inlineCanvas?.path !== path ||
			sourceKey !== activeFsSourceKey
		)
			return;
		inlineCanvasSyncVersion = bootstrap.document.version;
		inlineCanvas = {
			path,
			documentId: bootstrap.document.id,
			document: canvasBootstrapToDocument(bootstrap),
			loading: false,
			saving: false,
			error: null,
		};
		void flushInlineCanvasPendingTransactions(bootstrap.document.id).catch(
			(error) => {
				if (inlineCanvas?.documentId !== bootstrap.document.id) return;
				inlineCanvas = {
					...inlineCanvas,
					error:
						error instanceof Error
							? error.message
							: "Canvas changes are saved locally and will retry.",
				};
			},
		);
	} catch (error) {
		if (
			requestToken !== inlineCanvasRequestToken ||
			inlineCanvas?.path !== path ||
			sourceKey !== activeFsSourceKey
		)
			return;
		inlineCanvas = {
			path,
			documentId: null,
			document: null,
			loading: false,
			saving: false,
			error: error instanceof Error ? error.message : "Failed to open canvas",
		};
	}
}
function closeInlineCanvas() {
	inlineCanvasRequestToken += 1;
	inlineCanvas = null;
	closePreviewFocusMode();
}
async function flushInlineCanvasPendingTransactions(documentId: string) {
	if (inlineCanvasPendingFlush) {
		inlineCanvasPendingFlushRequested = true;
		return;
	}
	inlineCanvasPendingFlush = true;
	try {
		do {
			inlineCanvasPendingFlushRequested = false;
			while (true) {
				const pending = await listCanvasPendingTransactions(
					spaceId,
					documentId,
				);
				if (pending.length === 0) break;
				const tx = pending[0];
				if (!tx) break;
				await markCanvasPendingTransactionAttempt(tx);
				const result = await sdk
					.space(spaceId)
					.sendCanvasTransactionRealtime(documentId, {
						txId: tx.txId,
						baseVersion: tx.baseVersion,
						ops: tx.ops,
					});
				inlineCanvasSyncVersion = result.document.version;
				await deleteCanvasPendingTransaction({
					spaceId,
					documentId,
					txId: tx.txId,
				});
			}
		} while (inlineCanvasPendingFlushRequested);
	} finally {
		inlineCanvasPendingFlush = false;
	}
}

async function commitInlineCanvas(
	document: CovasDocument,
	ops: CanvasSemanticOp[],
) {
	if (!inlineCanvas?.documentId || ops.length === 0) return;
	const documentId = inlineCanvas.documentId;
	const savingPath = inlineCanvas.path;
	const txId = crypto.randomUUID();
	markFileSavePending(savingPath);
	inlineCanvas.saving = true;
	inlineCanvas.error = null;
	await writeCanvasPendingTransaction({
		spaceId,
		documentId,
		txId,
		baseVersion: inlineCanvasSyncVersion,
		ops,
	});
	inlineCanvas = { ...inlineCanvas, document };
	try {
		await flushInlineCanvasPendingTransactions(documentId);
		if (inlineCanvas)
			inlineCanvas = { ...inlineCanvas, saving: false, error: null };
	} catch (error) {
		if (inlineCanvas) {
			inlineCanvas = {
				...inlineCanvas,
				saving: false,
				error:
					error instanceof Error
						? error.message
						: "Canvas changes are saved locally and will retry.",
			};
		}
	} finally {
		clearFileSavePendingSoon(savingPath);
	}
}
function openInlinePort(
	port: string,
	url: string,
	options: { autoOpened?: boolean } = {},
) {
	closePreviewFocusMode();
	ensurePreviewPanelFits();
	inlineFile = null;
	inlineCanvas = null;
	inlinePortPreview = { port, url, autoOpened: options.autoOpened ?? false };
}
function closeInlinePort() {
	inlinePortPreview = null;
	closePreviewFocusMode();
}
async function downloadOpenFile() {
	if (!routeFilePath) return;
	await downloadSpaceFile(
		spaceId,
		routeFilePath,
		openFileDownloadName,
		openFile,
	);
}
async function downloadInlineFile() {
	if (!inlineFile) return;
	await downloadSpaceFile(
		spaceId,
		inlineFile.path,
		inlineFileDownloadName,
		inlineFile.response,
	);
}
async function saveInlineFile() {
	if (
		activeFsReadonly ||
		!canEditFiles ||
		inlineFile?.response?.kind !== "text"
	)
		return;
	const savingPath = inlineFile.path;
	const nextContent = inlineFile.draft;
	markFileSavePending(savingPath);
	inlineFile.saving = true;
	inlineFile.error = null;
	try {
		await sdk.space(spaceId).files.write({
			path: savingPath,
			content: nextContent,
			encoding: "utf-8",
		});
		inlineFile = {
			...inlineFile,
			response: {
				...inlineFile.response,
				content: nextContent,
				size: new Blob([nextContent]).size,
			} as SpaceFsFileResponse,
			error: null,
		};
		await patchFsDirectory(getParentDirPath(savingPath), (entries) =>
			entries.map((entry) =>
				entry.path === savingPath
					? {
							...entry,
							size: new Blob([nextContent]).size,
							mtimeMs: Date.now(),
						}
					: entry,
			),
		);
	} catch (error) {
		inlineFile.error =
			error instanceof Error ? error.message : "Failed to save file";
	} finally {
		if (inlineFile) inlineFile.saving = false;
		clearFileSavePendingSoon(savingPath);
	}
}
async function handleFileKeyboardSave(event: KeyboardEvent) {
	if (
		(event.metaKey || event.ctrlKey) &&
		event.key.toLowerCase() === "s" &&
		(fileMode === "file" || inlineFile)
	) {
		event.preventDefault();
		if (inlineFile) {
			await saveInlineFile();
		} else {
			await saveOpenFile();
		}
	}
	if (event.key === "Escape" && (inlineFile || inlinePortPreview)) {
		event.preventDefault();
		if (inlinePortPreview) closeInlinePort();
		else closeInlineFile();
	}
}
async function copyFileContent() {
	if (openFile?.kind !== "text") return;
	await navigator.clipboard.writeText(openFileDraft);
	openFileCopied = true;
	if (openFileCopiedTimer) clearTimeout(openFileCopiedTimer);
	openFileCopiedTimer = setTimeout(() => {
		openFileCopied = false;
	}, 1500);
}
async function copyInlineFileContent() {
	if (inlineFile?.response?.kind !== "text") return;
	await navigator.clipboard.writeText(inlineFile.draft);
	inlineFileCopied = true;
	if (inlineFileCopiedTimer) clearTimeout(inlineFileCopiedTimer);
	inlineFileCopiedTimer = setTimeout(() => {
		inlineFileCopied = false;
	}, 1500);
}
function formatCheckpointTimestamp(dateStr: string | null | undefined): string {
	if (!dateStr) return "—";
	const d = new Date(dateStr);
	return d.toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
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
) {
	labelPickerResource = { type: resourceType, ref: resourceRef };
}

function getHeaderFileActionPath() {
	if (routeView === "file" && openFile?.path) return openFile.path;
	return inlineFile?.path ?? null;
}

function hasResourceActions() {
	return Boolean(activeSessionState?.session || getHeaderFileActionPath());
}

function closeResourceActionMenu() {
	resourceActionMenuOpen = false;
	fileActionMenuOpenPath = null;
}

function insertHeaderReference() {
	const filePath = getHeaderFileActionPath();
	if (filePath) {
		insertFilePathReference(filePath);
		closeResourceActionMenu();
		return;
	}
	insertActiveSessionReference();
	closeResourceActionMenu();
}

function getHeaderResourceLabel() {
	return getHeaderFileActionPath() ? "file" : "chat";
}

function handleCreateNewSession() {
	if (!canCreateSession || !space) return;
	creatingSession = true;
	createSessionError = "";
	const createSpaceId = space.id;
	void sdk
		.space(createSpaceId)
		.sessions.create({ source: "web" })
		.then(async (result) => {
			const newSession = result.session;
			const nextSessions = await patchCachedSessionList(
				createSpaceId,
				(current) => [
					newSession,
					...current.filter((session) => session.id !== newSession.id),
				],
			);
			seedSessions(nextSessions);
			// New session has no turns yet — seed it before navigation so the route
			// loader does not issue an unnecessary listPaginated request for split mode.
			sessionStateById = {
				...sessionStateById,
				[newSession.id]: {
					session: newSession,
					turns: [],
					loading: false,
					loaded: true,
					error: "",
					hasMore: false,
					hasMoreNewer: false,
					loadingOlder: false,
					loadingNewer: false,
					oldestCursor: undefined,
				},
			};
			// Navigate before switching the local active session. Otherwise split mode
			// can briefly combine the new empty session with the previous URL/turn and
			// try to load that old turn from the new session.
			await updateUrlSession(newSession.id);
			activeSessionId = newSession.id;
			ensureSessionModelLoaded(newSession.id);
			applySessionGenerationPolicy(loadSessionGenerationPolicy(newSession.id));
			shouldAutoFollow = true;
			await forceScrollToBottom();
			focusComposerSoon();
		})
		.catch((error) => {
			createSessionError =
				error instanceof Error ? error.message : "Failed to create session";
		})
		.finally(() => {
			creatingSession = false;
		});
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

function stopVimScroll() {
	vimScrollVelocity = 0;
	if (vimScrollStopTimer) {
		clearTimeout(vimScrollStopTimer);
		vimScrollStopTimer = null;
	}
	if (vimScrollFrame != null) {
		cancelAnimationFrame(vimScrollFrame);
		vimScrollFrame = null;
	}
}

function runVimScrollFrame() {
	if (!listEl || vimScrollVelocity === 0) {
		stopVimScroll();
		return;
	}
	listEl.scrollTop = Math.min(
		Math.max(0, listEl.scrollHeight - listEl.clientHeight),
		Math.max(0, listEl.scrollTop + vimScrollVelocity),
	);
	vimScrollFrame = requestAnimationFrame(runVimScrollFrame);
}

function scrollTimelineByLines(direction: 1 | -1) {
	if (!listEl) return;
	beginUserScroll();
	vimScrollVelocity = direction * 10;
	if (vimScrollFrame == null) {
		vimScrollFrame = requestAnimationFrame(runVimScrollFrame);
	}
	if (vimScrollStopTimer) clearTimeout(vimScrollStopTimer);
	vimScrollStopTimer = setTimeout(stopVimScroll, 110);
}

function clearPendingVimG() {
	if (!vimPendingGTimer) return;
	clearTimeout(vimPendingGTimer);
	vimPendingGTimer = null;
}

function scrollTimelineToTop() {
	if (!listEl) return;
	beginUserScroll();
	shouldAutoFollow = false;
	setProgrammaticScrollTop(0);
	requestAnimationFrame(() => updateCurrentTurnSequence());
}

function scrollTimelineToBottom() {
	if (!listEl) return;
	shouldAutoFollow = true;
	stopVimScroll();
	scrollToBottomNow();
}

async function jumpRelativeTurn(direction: 1 | -1) {
	if (!activeSessionId || activeTurnRailItems.length === 0) return;
	const current = currentTurnSequence;
	const sorted = activeTurnRailItems
		.map((turn) => turn.sequence)
		.sort((a, b) => a - b);
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
	await jumpToTurn(target);
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
		showModelSelector = true;
		void loadModelsCatalog();
		void loadGenerationModelsCatalog();
		return;
	}
	if (isEditableShortcutTarget(event.target)) return;
	if (key !== "g") clearPendingVimG();
	if (
		event.shiftKey &&
		!event.altKey &&
		!event.metaKey &&
		!event.ctrlKey &&
		key === "g"
	) {
		event.preventDefault();
		clearPendingVimG();
		scrollTimelineToBottom();
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
		if (vimPendingGTimer) {
			clearPendingVimG();
			scrollTimelineToTop();
			return;
		}
		vimPendingGTimer = setTimeout(() => {
			vimPendingGTimer = null;
		}, 550);
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
		scrollTimelineByLines(1);
		return;
	}
	if (key === "k") {
		event.preventDefault();
		scrollTimelineByLines(-1);
	}
}

function scheduleStatusRefresh() {
	if (statusRefreshTimer) {
		clearTimeout(statusRefreshTimer);
		statusRefreshTimer = null;
	}
	const intervalMs = getStatusRefreshIntervalMs();
	if (!intervalMs || !pageMounted) return;
	statusRefreshTimer = setTimeout(async () => {
		await refreshSpaceStatus().catch(() => undefined);
		scheduleStatusRefresh();
	}, intervalMs);
}
onMount(() => {
	pageMounted = true;
	pageVisible = !document.hidden;
	pageOnline = navigator.onLine;
	loadSessionScrollAnchors();
	window.addEventListener("keydown", handleSessionVimKeydown);
	const offSessionListCacheUpdated = onSessionListCacheUpdated(
		({ spaceId: updatedSpaceId, sessions }) => {
			if (updatedSpaceId !== spaceId) return;
			applySessionsSnapshot(sessions);
		},
	);
	for (const run of getCachedTaskRuns(spaceId)) {
		if (isGenerationTaskRun(run)) upsertGenerationTaskRun(run);
		if (isBackgroundBashTaskRun(run)) upsertBackgroundBashTaskRun(run);
	}
	void restoreCachedTaskRuns(spaceId)
		.then((runs) => {
			for (const run of runs) {
				if (isGenerationTaskRun(run)) upsertGenerationTaskRun(run);
				if (isBackgroundBashTaskRun(run)) upsertBackgroundBashTaskRun(run);
			}
		})
		.catch(() => undefined);
	const offCanvasTxApplied = sdk
		.space(spaceId)
		.on("canvas.tx.applied", (event) => {
			const payload = event.payload as {
				documentId?: unknown;
				version?: unknown;
				actorId?: unknown;
			};
			if (
				typeof payload.documentId !== "string" ||
				payload.documentId !== inlineCanvas?.documentId
			)
				return;
			if (inlineCanvas?.saving) return;
			void sdk
				.space(spaceId)
				.canvas.bootstrap(payload.documentId)
				.then((bootstrap) => {
					if (
						inlineCanvas?.documentId !== payload.documentId ||
						!inlineCanvas ||
						inlineCanvas.saving
					)
						return;
					inlineCanvasSyncVersion = bootstrap.document.version;
					inlineCanvas = {
						...inlineCanvas,
						document: canvasBootstrapToDocument(bootstrap),
						saving: false,
						error: null,
					};
				})
				.catch((error) => {
					if (inlineCanvas?.documentId !== payload.documentId || !inlineCanvas)
						return;
					inlineCanvas = {
						...inlineCanvas,
						error:
							error instanceof Error ? error.message : "Failed to sync canvas",
					};
				});
		});
	const offTaskRunsCacheUpdated = onTaskRunsCacheUpdated(
		({ spaceId: updatedSpaceId, runs }) => {
			if (updatedSpaceId !== spaceId) return;
			for (const run of runs) {
				if (isGenerationTaskRun(run)) upsertGenerationTaskRun(run);
				if (isBackgroundBashTaskRun(run)) upsertBackgroundBashTaskRun(run);
			}
			if (cronjobDetail) {
				cronjobRuns = runs.filter((run) => run.cronJobId === cronjobDetail?.id);
			}
			if (routeTaskId) {
				const run = runs.find((item) => item.id === routeTaskId);
				if (run)
					taskRunDetail = taskRunDetail ? { ...taskRunDetail, ...run } : run;
			}
		},
	);
	// Preload model catalogs so the selector is ready immediately
	void loadModelsCatalog();
	void loadGenerationModelsCatalog();
	void loadPromptTemplates();
	const wsConnectionCleanup = sdk.onConnection((state) => {
		const previousState = lastConnectionState;
		lastConnectionState = state.state;
		if (state.state === "open") {
			recoveryCoordinator.onTransportOpen();
			wsConnectionState = "open";
			wsCanRecover = false;
			if (inlineCanvas?.documentId) {
				void flushInlineCanvasPendingTransactions(
					inlineCanvas.documentId,
				).catch(() => undefined);
			}
			const connectionId = state.connectionId ?? null;
			const recoveredFromDisconnect =
				previousState === "reconnecting" ||
				previousState === "closed" ||
				previousState === "error";
			const isNewRecoveredConnection =
				Boolean(connectionId) && connectionId !== lastRecoveredConnectionId;
			if (recoveredFromDisconnect || isNewRecoveredConnection) {
				lastRecoveredConnectionId = connectionId;
				void reconnectSync();
			}
			return;
		}
		if (state.state === "connecting") {
			wsConnectionState = "connecting";
			wsCanRecover = false;
			return;
		}
		if (state.state === "reconnecting") {
			wsConnectionState = "reconnecting";
			wsCanRecover = true;
			return;
		}
		if (state.state === "error") {
			wsConnectionState = "error";
			wsCanRecover = state.recoverable ?? false;
			return;
		}
		if (state.state === "closed") {
			wsConnectionState = "closed";
			wsCanRecover = state.willReconnect;
		}
	});
	const handleVisibility = () => {
		pageVisible = !document.hidden;
		scheduleStatusRefresh();
		if (pageVisible) {
			void refreshSessionsList(false);
			if (activeSessionId && sessionStateById[activeSessionId]?.loaded) {
				void reconcileSessionTail(activeSessionId);
			}
		}
	};
	const handleOnline = () => {
		pageOnline = true;
		scheduleStatusRefresh();
		if (wsConnectionState === "open") {
			void refreshSessionsList(false);
		}
		if (inlineCanvas?.documentId) {
			void flushInlineCanvasPendingTransactions(inlineCanvas.documentId).catch(
				() => undefined,
			);
		}
	};
	const handleOffline = () => {
		pageOnline = false;
		scheduleStatusRefresh();
	};
	const handleOpenInlineFileEvent = (e: Event) => {
		const custom = e as CustomEvent<{ spaceId?: string; path?: string }>;
		if (custom.detail?.spaceId !== spaceId || !custom.detail?.path) return;
		void openInlineFile(custom.detail.path);
	};
	const handleResourceActionMenuKeydown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			closeResourceActionMenu();
			fileActionMenuOpenPath = null;
		}
	};
	const handleResourceActionMenuClickOutside = (e: MouseEvent) => {
		const target = e.target as HTMLElement;
		if (!target.closest("[data-resource-actions]")) {
			closeResourceActionMenu();
			fileActionMenuOpenPath = null;
		}
	};
	window.addEventListener("visibilitychange", handleVisibility);
	window.addEventListener("online", handleOnline);
	window.addEventListener("offline", handleOffline);
	window.addEventListener("resize", handlePreviewWindowResize);
	window.addEventListener("cohub:open-inline-file", handleOpenInlineFileEvent);
	window.addEventListener("keydown", handleFileKeyboardSave);
	window.addEventListener("keydown", handleResourceActionMenuKeydown);
	document.addEventListener("click", handleResourceActionMenuClickOutside);
	scheduleStatusRefresh();
	return () => {
		window.removeEventListener("keydown", handleSessionVimKeydown);
		offSessionListCacheUpdated();
		offCanvasTxApplied();
		offTaskRunsCacheUpdated();
		if (checkpointCopiedTimer) clearTimeout(checkpointCopiedTimer);
		if (spaceStatusNoticeTimer) clearTimeout(spaceStatusNoticeTimer);
		if (portReadyToastTimer) clearTimeout(portReadyToastTimer);
		if (copiedSpaceIdTimer) clearTimeout(copiedSpaceIdTimer);
		if (copiedSpaceSlugLinkTimer) clearTimeout(copiedSpaceSlugLinkTimer);
		if (statusRefreshTimer) clearTimeout(statusRefreshTimer);
		clearTaskRunPoll();
		for (const timer of taskHydrateRetryTimers.values()) clearTimeout(timer);
		taskHydrateRetryTimers.clear();
		taskHydrateRetryCounts.clear();
		if (turnMarkerMeasureFrame != null)
			cancelAnimationFrame(turnMarkerMeasureFrame);
		stopVimScroll();
		clearPendingVimG();
		stopBottomFollow();
		recoveryCoordinator.dispose();
		clearAllPostSendRecovery();
		persistSessionScrollAnchorsNow();
		pageMounted = false;
		wsConnectionCleanup();
		window.removeEventListener("visibilitychange", handleVisibility);
		window.removeEventListener("online", handleOnline);
		window.removeEventListener("offline", handleOffline);
		window.removeEventListener("resize", handlePreviewWindowResize);
		window.removeEventListener(
			"cohub:open-inline-file",
			handleOpenInlineFileEvent,
		);
		window.removeEventListener("keydown", handleFileKeyboardSave);
		window.removeEventListener("keydown", handleResourceActionMenuKeydown);
		document.removeEventListener("click", handleResourceActionMenuClickOutside);
		rightSidebarResizeCleanup?.();
		previewPanelResizeCleanup?.();
		deactivateSpaceStyle();
	};
});
// React to space changes: reset state and reload data
$effect(() => {
	const currentSpaceId = spaceId;
	if (!pageMounted || !currentSpaceId || loadedSpaceId === currentSpaceId)
		return;
	loadedSpaceId = currentSpaceId;
	activateSpaceStyle(currentSpaceId);
	// Reset space-specific state
	space = null;
	spaceLoadError = "";
	spaceSessions = [];
	sessionStateById = {};
	loadingSessionIds = {};
	sessionLoadInFlight.clear();
	turnWindowLoadInFlight.clear();
	syncSessionNewerInFlight.clear();
	turnHydrationInFlight.clear();
	clearAllPostSendRecovery();
	lastStreamSnapshotRecoveryByTurn.clear();
	activeSessionId = null;
	turnIndexBySessionId = {};
	turnIndexLoadingBySessionId = {};
	turnIndexRetryAfterBySessionId = {};
	currentTurnSequence = null;
	loadingTurnSequence = null;
	turnMarkerPositions = {};
	turnMarkerHeights = {};
	lastTurnIndexRefreshKey = "";
	showTurnBottomSheet = false;
	appliedRouteTurnKey = null;
	fileTree = [];
	fileTreeBySource = {};
	fileTreeSourceKey = "live";
	fileTreeLoading = false;
	fileTreeError = null;
	previewEndpoints = {};
	inlinePortPreview = null;
	closePortReadyToast();
	openFile = null;
	openFileDraft = "";
	inlineFile = null;
	resourceActionMenuOpen = false;
	showShareModal = false;
	shareModalSessionId = null;
	sessionAccessById = {};
	checkpointDetail = null;
	cronjobDetail = null;
	taskRunDetail = null;
	spaceCheckpoints = [];
	tokenUsage = null;
	creatingSession = false;
	createSessionError = "";
	sessionGenerationStore.resetAll();
	bootstrapping = true;
	untrack(() => {
		void (async () => {
			let sessionLoad: Promise<void> | null = null;
			let hasCachedSpace = false;
			try {
				if (routeView === "session" && routeSessionId) {
					prepareRouteSession(routeSessionId);
					sessionLoad = loadSessionState(routeSessionId).catch(() => undefined);
				}
				const cachedSpace = await spaceRecordRepo.getCached(spaceId);
				const cachedSnapshot = await getCachedSessionListSnapshot(spaceId);
				const cachedSessions = cachedSnapshot?.sessions;
				if (cachedSessions && cachedSessions.length > 0) {
					seedSessions(cachedSessions);
				}
				if (routeView === "session" && routeSessionId) {
					prepareRouteSession(routeSessionId);
				}
				const cachedSessionLoad = sessionLoad;
				if (cachedSpace?.space) {
					space = cachedSpace.space;
					previewEndpoints = extractPublicEndpoints(cachedSpace.space);
					hasCachedSpace = true;
				}
				if (hasCachedSpace) {
					void loadSpace();
				} else {
					await loadSpace();
				}
				if (spaceId !== currentSpaceId) return;
				void refreshSessionsList(false);
				void loadPreviewEndpoints();
				void loadFileTree();
				void loadSpaceCheckpoints();
				if (routeView === "space") void loadTokenUsage(7);
				if (routeView === "session" && routeSessionId) {
					prepareRouteSession(routeSessionId);
					await cachedSessionLoad;
					void loadTurnIndex(routeSessionId);
				}
			} catch {
				// Non-blocking; bootstrapping released below
			} finally {
				if (spaceId === currentSpaceId) {
					bootstrapping = false;
				}
			}
		})();
	});
});
// React to space changes: subscribe to WS events for the new space
$effect(() => {
	const currentSpaceId = spaceId;
	if (!pageMounted || !currentSpaceId) return;
	const wsEventCleanup = sdk.space(currentSpaceId).subscribe((event) => {
		void handleWsEvent(event as ChannelEnvelope);
	});
	return wsEventCleanup;
});
$effect(() => {
	const currentSpaceId = spaceId;
	const sessionId = activeSessionId;
	if (!pageMounted || !currentSpaceId || !sessionId) return;
	return sdk
		.space(currentSpaceId)
		.session(sessionId)
		.subscribeGeneration({
			event: (event) => {
				void handleGenerationStreamEvent(sessionId, event);
			},
		});
});
$effect(() => {
	const currentSpaceId = spaceId;
	const sessionId = activeSessionId;
	if (!pageMounted || !currentSpaceId || !sessionId) return;
	return sessionTurnsRepo.subscribe(currentSpaceId, sessionId, (snapshot) => {
		const current = sessionStateById[sessionId];
		if (!current) return;
		sessionStateById = {
			...sessionStateById,
			[sessionId]: {
				...current,
				session: snapshot.session ?? current.session,
				turns: normalizeTurnDuplicates(
					mergeTurnsById(current.turns, snapshot.turns, {
						preferIncoming: true,
					}),
				),
				hasMore: snapshot.hasMoreOlder,
				hasMoreNewer: snapshot.hasMoreNewer,
				oldestCursor: snapshot.oldestSequence ?? undefined,
			},
		};
	});
});
$effect(() => {
	const sessionId = routeSessionId;
	const sequence = routeTurnSequence;
	if (
		!pageMounted ||
		routeView !== "session" ||
		!sessionId ||
		activeSessionId !== sessionId ||
		!sequence
	)
		return;
	const key = `${sessionId}:${sequence}`;
	if (appliedRouteTurnKey === key) return;
	appliedRouteTurnKey = key;
	void jumpToTurn(sequence);
});
$effect(() => {
	if (routeView === "session" && routeSessionId) return;
	appliedRouteTurnKey = null;
});
$effect(() => {
	if (routeView === "session" && activeSessionId) return;
	showTurnBottomSheet = false;
});
$effect(() => {
	const sessionId = activeSessionId;
	if (!sessionId) return;
	untrack(() => {
		void loadTurnIndex(sessionId);
	});
});
$effect(() => {
	if (!listEl || timeline.length === 0) {
		turnMarkerPositions = {};
		turnMarkerHeights = {};
		return;
	}
	void tick().then(() => {
		updateCurrentTurnSequence();
		scheduleTurnMarkerMeasure();
	});
});
$effect(() => {
	const el = listEl;
	if (!el) return;
	const observer = new ResizeObserver(() => scheduleTurnMarkerMeasure());
	observer.observe(el);
	for (const child of Array.from(el.children)) observer.observe(child);
	scheduleTurnMarkerMeasure();
	return () => observer.disconnect();
});
$effect(() => {
	const sessionId = activeSessionId;
	const loadedCount = activeSessionState?.turns.length ?? 0;
	const indexedCount = activeTurnIndex.length;
	if (!sessionId || loadedCount < 2 || indexedCount >= loadedCount) return;
	const key = `${sessionId}:${loadedCount}:${indexedCount}`;
	if (lastTurnIndexRefreshKey === key) return;
	lastTurnIndexRefreshKey = key;
	untrack(() => {
		void loadTurnIndex(sessionId, true);
	});
});
$effect(() => {
	if (
		routeView === "session" &&
		routeSessionId &&
		routeSessionId !== activeSessionId
	) {
		prepareRouteSession(routeSessionId);
		const state = sessionStateById[routeSessionId];
		unreadTracker.markViewed(
			routeSessionId,
			state?.session?.lastMessageId ?? null,
		);
		untrack(() => {
			void loadSessionState(routeSessionId);
			void loadTurnIndex(routeSessionId);
		});
		return;
	}
	if (routeView !== "session" && activeSessionId) {
		activeSessionId = null;
		pendingRestoreSessionId = null;
		activeAnchorRestore = null;
		anchorRestoreWaitingForMarkdown = false;
		userScrollActive = false;
		programmaticScrollActive = false;
		programmaticScrollTarget = null;
		currentTurnSequence = null;
		showTurnBottomSheet = false;
	}
});
$effect(() => {
	const el = listEl;
	if (!el) return;
	const container = el as HTMLDivElement;
	function handleScrollTrack() {
		const isProgrammatic =
			programmaticScrollActive ||
			(programmaticScrollTarget != null &&
				Math.abs(container.scrollTop - programmaticScrollTarget) <= 1);
		if (isProgrammatic) {
			programmaticScrollActive = false;
			programmaticScrollTarget = null;
			updateTimelineScrollMetrics();
			updateAutoFollow();
			updateCurrentTurnSequence();
			scheduleTurnMarkerMeasure();
			return;
		}
		updateTimelineScrollMetrics();
		if (activeSessionId && userScrollActive) {
			captureCurrentScrollAnchor(activeSessionId);
		}
		updateAutoFollow();
		updateCurrentTurnSequence();
		scheduleTurnMarkerMeasure();
	}
	container.addEventListener("wheel", beginUserScroll, { passive: true });
	container.addEventListener("touchstart", beginUserScroll, { passive: true });
	container.addEventListener("touchmove", beginUserScroll, { passive: true });
	container.addEventListener("pointerdown", beginUserScroll, { passive: true });
	container.addEventListener("keydown", handleScrollKeydown);
	container.addEventListener("scroll", handleScrollTrack, { passive: true });
	return () => {
		container.removeEventListener("wheel", beginUserScroll);
		container.removeEventListener("touchstart", beginUserScroll);
		container.removeEventListener("touchmove", beginUserScroll);
		container.removeEventListener("pointerdown", beginUserScroll);
		container.removeEventListener("keydown", handleScrollKeydown);
		container.removeEventListener("scroll", handleScrollTrack);
	};
});
$effect(() => {
	if (!listEl) return;
	const targetId = pendingRestoreSessionId;
	if (!targetId || targetId !== activeSessionId) return;
	const state = sessionStateById[targetId];
	if (!state?.loaded) return;
	const anchor = getSessionScrollAnchor(targetId);
	const hasCachedAnchor =
		anchor &&
		state.turns.some((turn) => turn.sequence * 10 === anchor.sequence);
	const finishRestore = () => {
		pendingRestoreSessionId = null;
		if (restoringBottomSessionId === targetId) {
			restoringBottomSessionId = null;
		}
		updateAutoFollow();
	};
	const finishAnchorRestore = () => {
		pendingRestoreSessionId = null;
		if (restoringBottomSessionId === targetId) {
			restoringBottomSessionId = null;
		}
		updateAutoFollow();
		anchorRestoreWaitingForMarkdown = true;
		requestAnimationFrame(() => {
			maybeCompleteAnchorRestore();
		});
	};
	const restoreToBottom = () => {
		activeAnchorRestore = null;
		anchorRestoreWaitingForMarkdown = false;
		restoringBottomSessionId = targetId;
		shouldAutoFollow = true;
		requestAnimationFrame(() => {
			if (!listEl || activeSessionId !== targetId) {
				finishRestore();
				return;
			}
			scrollToBottomNow();
			finishRestore();
		});
	};
	if (!anchor || !hasCachedAnchor) {
		clearSessionScrollAnchor(targetId);
		void tick().then(restoreToBottom);
		return;
	}
	const restoreByAnchor = (retries = 2) => {
		requestAnimationFrame(() => {
			if (!listEl) {
				finishRestore();
				return;
			}
			const node = listEl.querySelector<HTMLElement>(
				`[data-sequence="${anchor.sequence}"]`,
			);
			if (!node) {
				if (retries > 0) {
					restoreByAnchor(retries - 1);
					return;
				}
				clearSessionScrollAnchor(targetId);
				restoreToBottom();
				return;
			}
			activeAnchorRestore = {
				sessionId: targetId,
				sequence: anchor.sequence,
				offset: anchor.offset,
				updatedAt: anchor.updatedAt,
			};
			requestAnimationFrame(() => {
				if (!listEl || activeSessionId !== targetId) {
					finishAnchorRestore();
					return;
				}
				if (!applyActiveAnchorRestore(activeAnchorRestore)) {
					clearSessionScrollAnchor(targetId);
					restoreToBottom();
					return;
				}
				finishAnchorRestore();
			});
		});
	};
	void tick().then(() => restoreByAnchor());
});
$effect(() => {
	const sessionId = activeSessionId;
	if (!sessionId) return;
	const state = sessionStateById[sessionId];
	if (!state?.loaded && !state?.loading) {
		untrack(() => {
			void loadSessionState(sessionId);
		});
	}
});
$effect(() => {
	if (routeView !== "file" || !routeFilePath) {
		openFile = null;
		openFileDraft = "";
		openFileError = null;
		openFileTooLarge = false;
		fileEdit = true;
		return;
	}
	void openFileFromUrl(routeFilePath);
});
$effect(() => {
	const sourceKey = activeFsSourceKey;
	if (fileTreeSourceKey === sourceKey) return;
	fileTreeBySource = { ...fileTreeBySource, [fileTreeSourceKey]: fileTree };
	fileTreeSourceKey = sourceKey;
	fileTree = fileTreeBySource[sourceKey] ?? [];
	directoryLoadTokenByPath = {};
	fileTreeError = null;
	fileTreeLoading = false;
	fileTreeRequestToken += 1;
	inlineFileRequestToken += 1;
	inlineCanvasRequestToken += 1;
	inlineFile = null;
	inlineCanvas = null;
	void loadFileTree(false);
});
$effect(() => {
	if (routeView === "checkpoint" && routeCheckpointId) {
		void loadCheckpointDetail(routeCheckpointId);
		return;
	}
	checkpointDetail = null;
	checkpointDetailError = "";
});
$effect(() => {
	if (routeView === "checkpoint-new") {
		checkpointCreateError = "";
	}
});
$effect(() => {
	if (
		(routeView === "cronjob" || routeView === "cronjob-new") &&
		routeCronjobId
	) {
		void loadCronjobDetail(routeCronjobId);
		return;
	}
	if (routeView === "cronjob-new") {
		cronjobNewTitle = "";
		cronjobNewExpression = "";
		cronjobNewPrompt = "";
		cronjobNewError = "";
		cronjobDetail = null;
		cronjobDetailError = "";
		cronjobRuns = [];
		cronjobToggleError = "";
		return;
	}
	cronjobDetail = null;
	cronjobDetailError = "";
	cronjobRuns = [];
	cronjobToggleError = "";
});
$effect(() => {
	if (routeView === "task" && routeTaskId) {
		void loadTaskDetail(routeTaskId);
		return;
	}
	clearTaskRunPoll();
	taskRunRefreshInFlight = null;
	taskRunDetail = null;
	taskRunProgress = null;
	taskRunDetailError = "";
});
$effect(() => {
	const el = composerHostEl;
	if (!el) {
		composerHeight = 0;
		return;
	}
	const updateComposerHeight = () => {
		composerHeight = el.offsetHeight;
	};
	updateComposerHeight();
	const ro = new ResizeObserver(() => updateComposerHeight());
	ro.observe(el);
	return () => ro.disconnect();
});
$effect(() => {
	if (!listEl || !activeSessionId) return;
	requestAnimationFrame(() => {
		updateTimelineScrollMetrics();
		updateAutoFollow();
	});
});
// ResizeObserver: when the scroll container's content grows and the user
// is already near the bottom (shouldAutoFollow), keep them pinned. This
// replaces fragile tick()/setTimeout-based scroll logic and naturally
// catches async markdown rendering, image loading, etc.
$effect(() => {
	const el = listEl;
	if (!el) return;
	let prevHeight = el.scrollHeight;
	const ro = new ResizeObserver(() => {
		if (!listEl) return;
		const currentHeight = listEl.scrollHeight;
		if (
			currentHeight > prevHeight &&
			(shouldAutoFollow || restoringBottomSessionId === activeSessionId) &&
			!autoScrollGuard
		) {
			requestBottomFollow();
		}
		prevHeight = currentHeight;
		updateTimelineScrollMetrics();
		updateAutoFollow();
	});
	ro.observe(el);
	return () => ro.disconnect();
});
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
				fileActionMenuOpenPath = fileActionMenuOpenPath === path ? null : path;
			}}
			title="More actions"
			aria-haspopup="menu"
			aria-expanded={fileActionMenuOpenPath === path}
		>
			<MoreHorizontal class="w-4 h-4" />
		</button>
		{#if fileActionMenuOpenPath === path}
			<div
				class="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-md border border-border-subtle bg-bg-primary py-1 shadow-lg"
				role="menu"
			>
				<button
					type="button"
					class="menu-item"
					onclick={() => {
						void editResourceLabels("file", path);
						fileActionMenuOpenPath = null;
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
						fileActionMenuOpenPath = null;
					}}
					role="menuitem"
				>
					<TextCursorInput class="w-3.5 h-3.5" />
					<span>Insert reference</span>
				</button>
			</div>
		{/if}
	</div>
{/snippet}

{#snippet PreviewFocusButton()}
	{#if !isMobile}
		<button
			type="button"
			class="icon-btn"
			onclick={() => void togglePreviewFocusMode()}
			title={previewFocusMode ? "Exit preview focus" : "Focus preview"}
			aria-label={previewFocusMode ? "Exit preview focus" : "Focus preview"}
		>
			{#if previewFocusMode}
				<Minimize2 class="w-4 h-4" />
			{:else}
				<Maximize2 class="w-4 h-4" />
			{/if}
		</button>
	{/if}
{/snippet}

{#snippet PanelLoadingState(label: string, compact = false)}
	<div class={compact ? "flex min-h-36 items-center justify-center gap-2 text-[12px] text-text-tertiary" : "flex min-h-[42vh] flex-1 items-center justify-center gap-2 text-[12px] text-text-tertiary"}>
		<Loader2 class="h-4 w-4 animate-spin" aria-label={label} />
		<span>{label}</span>
	</div>
{/snippet}

<PageHeader>
  {#snippet left()}
    <div class="flex items-center gap-1.5 min-w-0 overflow-hidden">
      {#if routeView === "session" && activeSessionState?.session}
        <button
          type="button"
          class="inline-flex shrink-0 items-center text-text-primary transition-colors hover:text-text-secondary lg:hidden"
          title={space?.name || space?.title || spaceId}
          aria-label="Space details"
        >
          <SpaceAvatar name={space?.name || space?.title || spaceId} profile={space?.publicProfile} size="xs" />
        </button>
        <div class="min-w-0 flex flex-1 items-center gap-1.5 overflow-hidden">
          {#if sessionRenaming}
            <input
              bind:this={sessionRenameInputEl}
              bind:value={sessionRenameValue}
              type="text"
              class="min-w-0 flex-1 bg-bg-hover-strong text-[13px] text-text-primary outline-none rounded px-1 py-0.5 leading-tight max-w-[40vw]"
              placeholder="Session name"
              maxlength={80}
              disabled={sessionRenameSaving}
              onkeydown={(e) => {
                if (
                  e.key === "Enter" &&
                  !sessionRenameSaving &&
                  !isComposingKeyboardEvent(e)
                ) {
                  e.preventDefault();
                  void submitSessionRename();
                }
                if (e.key === "Escape" && !sessionRenameSaving) {
                  e.preventDefault();
                  cancelSessionRename();
                }
              }}
            />
            <button
              type="button"
              class="p-0.5 rounded text-status-running hover:bg-bg-hover transition-colors shrink-0"
              disabled={sessionRenameSaving}
              onclick={() => void submitSessionRename()}
              title="Save"
            >
              <Check class="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              class="p-0.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0"
              disabled={sessionRenameSaving}
              onclick={cancelSessionRename}
              title="Cancel"
            >
              <X class="w-3.5 h-3.5" />
            </button>
          {:else}
            <button
              type="button"
              class="min-w-0 flex-1 truncate text-[13px] text-text-secondary hover:text-text-primary transition-colors"
              onclick={startSessionRename}
              title="Click to rename"
            >
              {getSessionTitle(activeSessionState.session)}
            </button>
            {#if activeSessionState.loading && activeSessionState.loaded}
              <Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin text-text-placeholder" aria-label="Syncing" />
            {/if}
            {#if wsConnectionState === 'reconnecting'}
              <span class="inline-flex shrink-0 items-center text-[12px] text-warning">
                Reconnecting...
              </span>
            {/if}
          {/if}
        </div>
      {:else if routeView === "checkpoint" && checkpointDetail}
        <button
          type="button"
          class="inline-flex max-w-[35%] items-center gap-1.5 truncate text-left text-[13px] text-text-primary transition-colors hover:text-text-secondary"
          title="Space details"
        ><SpaceAvatar name={space?.name || space?.title || spaceId} profile={space?.publicProfile} size="xs" />{space?.name || space?.title || spaceId}</button>
        <span class="text-text-tertiary shrink-0 text-[13px] select-none">/</span>
        <span class="text-[13px] text-text-secondary truncate">{checkpointDetail.description ? checkpointDetail.description.slice(0, 36) : 'Checkpoint'}</span>
        {#if checkpointDetailLoading}<Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin text-text-placeholder" aria-label="Syncing" />{/if}
      {:else if routeView === "checkpoint-new"}
        <button
          type="button"
          class="inline-flex max-w-[35%] items-center gap-1.5 truncate text-left text-[13px] text-text-primary transition-colors hover:text-text-secondary"
          title="Space details"
        ><SpaceAvatar name={space?.name || space?.title || spaceId} profile={space?.publicProfile} size="xs" />{space?.name || space?.title || spaceId}</button>
        <span class="text-text-tertiary shrink-0 text-[13px] select-none">/</span>
        <span class="text-[13px] text-text-secondary truncate">New save</span>
      {:else if routeView === "cronjob" && cronjobDetail}
        <button
          type="button"
          class="inline-flex max-w-[35%] items-center gap-1.5 truncate text-left text-[13px] text-text-primary transition-colors hover:text-text-secondary"
          title="Space details"
        ><SpaceAvatar name={space?.name || space?.title || spaceId} profile={space?.publicProfile} size="xs" />{space?.name || space?.title || spaceId}</button>
        <span class="text-text-tertiary shrink-0 text-[13px] select-none">/</span>
        <span class="text-[13px] text-text-secondary truncate">{cronjobDetail.title}</span>
        {#if cronjobDetailLoading}<Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin text-text-placeholder" aria-label="Syncing" />{/if}
      {:else if routeView === "cronjob-new"}
        <button
          type="button"
          class="inline-flex max-w-[35%] items-center gap-1.5 truncate text-left text-[13px] text-text-primary transition-colors hover:text-text-secondary"
          title="Space details"
        ><SpaceAvatar name={space?.name || space?.title || spaceId} profile={space?.publicProfile} size="xs" />{space?.name || space?.title || spaceId}</button>
        <span class="text-text-tertiary shrink-0 text-[13px] select-none">/</span>
        <span class="text-[13px] text-text-secondary truncate">New cronjob</span>
      {:else if routeView === "task" && taskRunDetail}
        <button
          type="button"
          class="inline-flex max-w-[35%] items-center gap-1.5 truncate text-left text-[13px] text-text-primary transition-colors hover:text-text-secondary"
          title="Space details"
        ><SpaceAvatar name={space?.name || space?.title || spaceId} profile={space?.publicProfile} size="xs" />{space?.name || space?.title || spaceId}</button>
        <span class="text-text-tertiary shrink-0 text-[13px] select-none">/</span>
        <span class="text-[13px] text-text-secondary truncate">Task run</span>
        {#if taskRunDetailLoading}<Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin text-text-placeholder" aria-label="Syncing" />{/if}
      {:else}
        <button
          type="button"
          class="inline-flex min-w-0 items-center gap-1.5 truncate text-left text-[13px] text-text-primary transition-colors hover:text-text-secondary"
        ><SpaceAvatar name={space?.name || space?.title || spaceId} profile={space?.publicProfile} size="xs" />{space?.name || space?.title || spaceId}</button>
      {/if}
    </div>
  {/snippet}
  {#snippet right()}
    <!-- Session Share -->
    {#if activeSessionId && canManageSessionAccess}
      {@const isPublic = hasSessionPermission(activeSessionId)}
      <button
        type="button"
        class="flex items-center gap-1.5 px-2 h-8 rounded-[5px] transition-colors duration-100 {isPublic ? 'text-success-soft hover:text-success hover:bg-success-bg' : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'}"
        onclick={() => { openShareModal(activeSessionId!); }}
        title={isPublic ? 'Session is public' : 'Share session'}
      >
        {#if isPublic}
          <Globe class="w-4 h-4 shrink-0" />
          <span class="hidden lg:inline text-[13px] font-medium">Shared</span>
        {:else}
          <Share2 class="w-4 h-4 shrink-0" />
          <span class="hidden lg:inline text-[13px] font-medium">Share</span>
        {/if}
      </button>
    {/if}
    {#if hasResourceActions()}
      <div class="relative" data-resource-actions>
        <button
          type="button"
          class="flex items-center justify-center w-8 h-8 rounded-[5px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
          onclick={(event) => {
            event.stopPropagation();
            resourceActionMenuOpen = !resourceActionMenuOpen;
          }}
          title="More actions"
          aria-haspopup="menu"
          aria-expanded={resourceActionMenuOpen}
        >
          <MoreHorizontal class="w-4 h-4 shrink-0" />
        </button>
        {#if resourceActionMenuOpen}
          <div class="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-md border border-border-subtle bg-bg-primary py-1 shadow-lg" role="menu">
            <button
              type="button"
              class="menu-item"
              onclick={() => {
                const filePath = getHeaderFileActionPath();
                if (filePath) void editResourceLabels("file", filePath);
                else if (activeSessionState?.session) void editResourceLabels("session", activeSessionState.session.id);
                closeResourceActionMenu();
              }}
              role="menuitem"
            >
              <ListTree class="w-3.5 h-3.5" />
              <span>Label as…</span>
            </button>
            <button type="button" class="menu-item" onclick={insertHeaderReference} role="menuitem">
              <TextCursorInput class="w-3.5 h-3.5" />
              <span>Insert reference</span>
            </button>
          </div>
        {/if}
      </div>
    {/if}
    <!-- Toggle right sidebar -->
    {#if !spaceHasMinimalAccess}
      <div class="relative">
        <button
          type="button"
          class="flex items-center gap-1.5 px-2 h-8 rounded-[5px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
          onclick={() => void toggleRightSidebar()}
          title={uiState.rightSidebarCollapsed ? "Show files" : "Hide files"}
        >
          {#if uiState.rightSidebarCollapsed}
            <PanelRightOpen class="w-4 h-4 shrink-0" />
            <span class="hidden 2xl:inline text-[13px] font-medium">Show files</span>
          {:else}
            <PanelRightClose class="w-4 h-4 shrink-0" />
            <span class="hidden 2xl:inline text-[13px] font-medium">Hide files</span>
          {/if}
        </button>
      </div>
    {/if}
  {/snippet}
</PageHeader>
{#if portReadyToast}
	<div class="port-ready-toast" role="status" aria-live="polite">
		<div class="flex min-w-0 items-center gap-2.5">
			<div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-success-soft/25 bg-success-bg text-success-soft">
				<Globe class="h-3.5 w-3.5" />
			</div>
			<div class="min-w-0 flex-1">
				<div class="text-[12px] font-medium text-text-primary">Port :{portReadyToast.port} is ready</div>
				<div class="truncate text-[11px] text-text-tertiary" title={portReadyToast.url}>{portReadyToast.url}</div>
			</div>
		</div>
		<div class="flex shrink-0 items-center gap-1.5">
			<button type="button" class="port-ready-action primary" onclick={previewPortFromToast}>Preview</button>
			<a class="port-ready-action" href={portReadyToast.url} target="_blank" rel="noreferrer" onclick={closePortReadyToast}>
				<ExternalLink class="h-3 w-3" />
				<span>Open externally</span>
			</a>
			<button type="button" class="port-ready-close" onclick={closePortReadyToast} title="Dismiss port notification" aria-label="Dismiss port notification">
				<X class="h-3.5 w-3.5" />
			</button>
		</div>
	</div>
{/if}
<div bind:this={workspaceBodyEl} class="relative flex-1 min-h-0 flex overflow-hidden bg-bg-content">
  <div class="flex-1 flex flex-col min-w-0 bg-bg-content">
    {#if routeView === 'checkpoint-new'}
      <div class="flex-1 p-4 overflow-y-auto max-w-2xl">
        {#if spaceLoadError && !spaceHasMinimalAccess}
          <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{spaceLoadError}</div>
        {:else}
          <form onsubmit={handleCreateCheckpointSubmit} class="space-y-3">
            <div class="border border-border-subtle rounded-md bg-bg-surface p-4 space-y-3">
              <div>
                <div class="text-[10px] uppercase tracking-wider text-text-placeholder font-medium">Save</div>
                <p class="text-[13px] text-text-tertiary mt-1">Save the current workspace state of <span class="text-text-primary font-medium">{space?.name ?? space?.title ?? spaceId}</span> as a reusable checkpoint.</p>
              </div>
              <div>
                <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary mb-1.5" for="checkpoint-description">Description</label>
                <textarea
                  id="checkpoint-description"
                  bind:value={checkpointCreateDescription}
                  rows="4"
                  placeholder="What changed? What is this save for?"
                  class="w-full px-3 py-[8px] rounded-[5px] bg-bg-input border border-border-subtle text-[13px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none transition-colors resize-y"
                ></textarea>
              </div>
              <div class="rounded-[6px] border border-border-subtle bg-bg-elevated/50 p-3 text-[12px] text-text-secondary">
                If left empty, the checkpoint will still be saved and shown using its commit hash.
              </div>
            </div>
            {#if checkpointCreateError}
              <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{checkpointCreateError}</div>
            {/if}
            <div class="flex items-center justify-end gap-2">
              <button
                type="button"
                class="px-3 py-2 rounded-[5px] border border-border-subtle text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                onclick={() => goto(buildSpaceDetailRoute(spaceId))}
              >
                Cancel
              </button>
              <button
                type="submit"
                class="inline-flex items-center gap-2 px-3 py-2 rounded-[5px] bg-brand text-brand-contrast-fg text-[12px] font-medium hover:bg-brand-hover transition-colors disabled:opacity-50"
                disabled={checkpointCreateSubmitting}
              >
                {#if checkpointCreateSubmitting}
                  <Loader2 class="w-3.5 h-3.5 animate-spin" />
                {:else}
                  <Save class="w-3.5 h-3.5" />
                {/if}
                <span>Save Checkpoint</span>
              </button>
            </div>
          </form>
        {/if}
      </div>
    {:else if routeView === 'checkpoint'}
      <div class="flex-1 min-h-0 overflow-y-auto p-4 max-w-3xl">
        {#if checkpointDetailLoading && checkpointDetail?.id !== routeCheckpointId}
          {@render PanelLoadingState("Loading save…")}
        {:else if checkpointDetailError}
          <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{checkpointDetailError}</div>
        {:else if checkpointDetail && checkpointDetail.id === routeCheckpointId}
          <div class="border border-border-subtle rounded-md bg-bg-surface">
            <!-- Hero section: ID + description -->
            <div class="p-5 space-y-4">
              <div class="space-y-2">
                <div class="text-[10px] uppercase tracking-wider text-text-placeholder font-medium">Checkpoint ID</div>
                <div class="flex items-center gap-3">
                  <div class="font-mono text-[18px] font-semibold text-text-primary tracking-tight break-all leading-snug">{checkpointDetail.id}</div>
                  <div class="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[5px] bg-brand-muted border border-brand-border text-[12px] text-brand hover:bg-brand-muted-hover transition-colors"
                      onclick={handleForkCheckpoint}
                    >
                      <Rocket class="w-3.5 h-3.5" />
                      <span>New space</span>
                    </button>
                    <button
                      type="button"
                      class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[5px] border border-border-subtle text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                      onclick={handleCopyCheckpointId}
                    >
                      {#if checkpointIdCopied}
                        <Check class="w-3.5 h-3.5 text-success-soft" />
                        <span class="text-success-soft">Copied</span>
                      {:else}
                        <Copy class="w-3.5 h-3.5" />
                        <span>Copy</span>
                      {/if}
                    </button>
                  </div>
                </div>
              </div>
              {#if checkpointDetail.description?.trim()}
                <div class="text-[14px] leading-6 text-text-secondary">{checkpointDetail.description.trim()}</div>
              {/if}
              <p class="text-[13px] text-text-tertiary">Saved from <span class="text-text-primary">{space?.name ?? space?.title ?? spaceId}</span> · {formatCheckpointTimestamp(checkpointDetail.createdAt)}</p>
            </div>
            <!-- Divider -->
            <div class="border-t border-border-subtle"></div>
            <!-- Metadata: flattened label-value list -->
            <div class="p-5">
              <div class="space-y-4">
                <!-- Commit Hash -->
                <div class="flex items-start justify-between gap-4">
                  <div class="min-w-0">
                    <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-placeholder font-medium">
                      <GitCommitHorizontal class="w-3.5 h-3.5 shrink-0" />
                      Commit Hash
                    </div>
                    <div class="mt-1.5 font-mono text-[12px] text-text-secondary break-all leading-snug">{checkpointDetail.commitHash}</div>
                  </div>
                  <button
                    type="button"
                    class="shrink-0 inline-flex items-center gap-1 px-2 py-1.5 rounded-[4px] text-[11px] text-text-placeholder hover:text-text-secondary hover:bg-bg-hover transition-colors"
                    onclick={handleCopyCheckpointCommitHash}
                  >
                    {#if checkpointCopied}
                      <Check class="w-3 h-3 text-success-soft" />
                    {:else}
                      <Copy class="w-3 h-3" />
                    {/if}
                  </button>
                </div>
                <!-- Parent Checkpoint -->
                <div>
                  <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-placeholder font-medium">
                    <Network class="w-3.5 h-3.5 shrink-0" />
                    Parent
                  </div>
                  <div class="mt-1.5">
                    {#if checkpointDetail.parentCheckpointId}
                      <a
                        href="/spaces/{spaceId}/checkpoints/{checkpointDetail.parentCheckpointId}"
                        class="font-mono text-[12px] text-brand hover:underline break-all leading-snug"
                        data-sveltekit-preload-data="hover"
                      >{checkpointDetail.parentCheckpointId}</a>
                    {:else}
                      <span class="text-[12px] text-text-secondary">None (root checkpoint)</span>
                    {/if}
                  </div>
                </div>
                <!-- Fork Count -->
                <div>
                  <div class="text-[11px] uppercase tracking-wider text-text-placeholder font-medium">Forks</div>
                  <div class="mt-1.5 text-[13px] text-text-secondary">{checkpointDetail.forkCount}</div>
                </div>
              </div>
            </div>
          </div>
        {:else}
          <div class="rounded-md border border-border-subtle bg-bg-surface p-4 text-[13px] text-text-tertiary">Checkpoint not found.</div>
        {/if}
      </div>
    {:else if routeView === 'cronjob-new'}
      <div class="flex-1 p-4 overflow-y-auto max-w-2xl">
        {#if spaceLoadError && !spaceHasMinimalAccess}
          <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{spaceLoadError}</div>
        {:else}
          <form onsubmit={handleCreateCronjobSubmit} class="space-y-3">
            <div class="border border-border-subtle rounded-md bg-bg-surface p-4 space-y-3">
              <div>
                <div class="text-[10px] uppercase tracking-wider text-text-placeholder font-medium">Scheduled</div>
                <p class="text-[13px] text-text-tertiary mt-1">Create a repeating task that sends a message to <span class="text-text-primary font-medium">{space?.name ?? space?.title ?? spaceId}</span> on a schedule.</p>
              </div>
              <div>
                <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary mb-1.5" for="cronjob-title">Title</label>
                <input
                  id="cronjob-title"
                  type="text"
                  bind:value={cronjobNewTitle}
                  placeholder="e.g. Daily report"
                  class="w-full px-3 py-[8px] rounded-[5px] bg-bg-input border border-border-subtle text-[13px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none transition-colors"
                />
              </div>
              <div>
                <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary mb-1.5" for="cronjob-expression">Cron Expression</label>
                <input
                  id="cronjob-expression"
                  type="text"
                  bind:value={cronjobNewExpression}
                  placeholder="e.g. 0 10 * * * (daily at 10 AM)"
                  class="w-full px-3 py-[8px] rounded-[5px] bg-bg-input border border-border-subtle text-[13px] font-mono text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none transition-colors"
                />
                <p class="mt-1 text-[11px] text-text-placeholder">Format: min hour day month weekday · Example: */30 * * * * (every 30 min)</p>
              </div>
              <div>
                <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary mb-1.5" for="cronjob-prompt">Prompt Message</label>
                <textarea
                  id="cronjob-prompt"
                  bind:value={cronjobNewPrompt}
                  rows="4"
                  placeholder="Message content to send to the space..."
                  class="w-full px-3 py-[8px] rounded-[5px] bg-bg-input border border-border-subtle text-[13px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none transition-colors resize-y"
                ></textarea>
              </div>
              <div class="rounded-[6px] border border-border-subtle bg-bg-elevated/50 p-3 text-[12px] text-text-secondary">
                The cronjob will send this message to the space on every scheduled run.
              </div>
            </div>
            {#if cronjobNewError}
              <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{cronjobNewError}</div>
            {/if}
            <div class="flex items-center justify-end gap-2">
              <button
                type="button"
                class="px-3 py-2 rounded-[5px] border border-border-subtle text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                onclick={() => goto(buildSpaceDetailRoute(spaceId))}
              >
                Cancel
              </button>
              <button
                type="submit"
                class="inline-flex items-center gap-2 px-3 py-2 rounded-[5px] bg-brand text-brand-contrast-fg text-[12px] font-medium hover:bg-brand-hover transition-colors disabled:opacity-50"
                disabled={cronjobNewSubmitting}
              >
                {#if cronjobNewSubmitting}
                  <Loader2 class="w-3.5 h-3.5 animate-spin" />
                {:else}
                  <Plus class="w-3.5 h-3.5" />
                {/if}
                <span>Create Cronjob</span>
              </button>
            </div>
          </form>
        {/if}
      </div>
    {:else if routeView === 'cronjob'}
      <div class="flex-1 min-h-0 overflow-y-auto px-5 py-6 lg:px-8">
        <div class="max-w-5xl">
        {#if cronjobDetailLoading && cronjobDetail?.id !== routeCronjobId}
          {@render PanelLoadingState("Loading scheduled…")}
        {:else if cronjobDetailError}
          <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{cronjobDetailError}</div>
        {:else if cronjobDetail && cronjobDetail.id === routeCronjobId}
          <div class="space-y-8">
            <div class="flex flex-col gap-5 border-b border-border-subtle/70 pb-6 lg:flex-row lg:items-start lg:justify-between">
              <div class="min-w-0 space-y-3">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="inline-flex items-center gap-1.5 rounded-full bg-brand/10 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-brand">
                    <span class="h-1.5 w-1.5 rounded-full {cronjobDetail.enabled ? 'bg-status-running' : 'bg-text-placeholder'}"></span>
                    {cronjobDetail.enabled ? 'Scheduled · Active' : 'Scheduled · Paused'}
                  </span>
                  <span class="font-mono text-[11px] text-text-placeholder">{cronjobDetail.id}</span>
                </div>
                <div>
                  <h1 class="text-[26px] font-semibold tracking-tight text-text-primary break-words lg:text-[32px]">{cronjobDetail.title}</h1>
                  <p class="mt-2 text-[13px] leading-6 text-text-tertiary">Sends a prepared prompt to <span class="text-text-primary">{space?.name ?? space?.title ?? spaceId}</span> on every matching run.</p>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  class="inline-flex items-center gap-1.5 rounded-[5px] bg-bg-elevated px-3 py-2 text-[12px] font-medium transition-colors hover:bg-bg-hover disabled:opacity-50 {cronjobDetail!.enabled ? 'text-status-running' : 'text-text-secondary'}"
                  onclick={() => handleToggleCronjob(!cronjobDetail!.enabled)}
                  disabled={cronjobActionInProgress}
                >
                  {#if cronjobActionInProgress}
                    <Loader2 class="w-3.5 h-3.5 animate-spin" />
                  {:else if cronjobDetail.enabled}
                    <Power class="w-3.5 h-3.5" />
                  {:else}
                    <PowerOff class="w-3.5 h-3.5" />
                  {/if}
                  <span>{cronjobDetail.enabled ? 'Disable' : 'Enable'}</span>
                </button>
                <button
                  type="button"
                  class="inline-flex items-center gap-1.5 rounded-[5px] px-3 py-2 text-[12px] font-medium text-text-tertiary transition-colors hover:bg-bg-hover hover:text-error-soft disabled:opacity-50"
                  onclick={handleDeleteCronjob}
                  disabled={cronjobActionInProgress}
                >
                  <Trash2 class="w-3.5 h-3.5" />
                  <span>Delete</span>
                </button>
              </div>
            </div>

            {#if cronjobToggleError}
              <div class="rounded-[6px] border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft">{cronjobToggleError}</div>
            {/if}

            <div class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
              <section class="min-w-0 space-y-3">
                <div class="flex items-end justify-between gap-3">
                  <div>
                    <div class="text-[10px] uppercase tracking-[0.18em] text-text-placeholder font-medium">Prompt to send</div>
                    <div class="mt-1 text-[12px] text-text-tertiary">{cronjobPromptMeta(cronjobDetail.payload)}</div>
                  </div>
                </div>
                <div class="relative overflow-hidden rounded-[8px] bg-bg-elevated/45 ring-1 ring-border-subtle/60">
                  <div class="absolute left-0 top-0 h-full w-[3px] bg-brand"></div>
                  <pre class="max-h-[460px] overflow-auto px-5 py-4 pl-6 text-[13px] leading-6 text-text-secondary whitespace-pre-wrap break-words">{formatCronjobPrompt(cronjobDetail.payload)}</pre>
                </div>
              </section>

              <aside class="space-y-6 text-[13px]">
                <div class="space-y-4">
                  <div class="text-[10px] uppercase tracking-[0.18em] text-text-placeholder font-medium">Timing</div>
                  <div class="space-y-4">
                    <div>
                      <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-placeholder font-medium">
                        <Clock class="w-3.5 h-3.5" />
                        Schedule
                      </div>
                      <div class="mt-1.5 font-mono text-[15px] text-text-primary">{cronjobDetail.cronExpression}</div>
                    </div>
                    <div>
                      <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-placeholder font-medium">
                        <Clock3 class="w-3.5 h-3.5" />
                        Timezone
                      </div>
                      <div class="mt-1.5 text-text-primary">{cronjobDetail.timezone}</div>
                    </div>
                  </div>
                </div>

                <div class="h-px bg-border-subtle/70"></div>

                <div class="space-y-4">
                  <div class="text-[10px] uppercase tracking-[0.18em] text-text-placeholder font-medium">Execution</div>
                  <div>
                    <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-placeholder font-medium">
                      <Terminal class="w-3.5 h-3.5" />
                      Task Type
                    </div>
                  <div>
                    <div class="text-[11px] uppercase tracking-wider text-text-placeholder font-medium">Owner</div>
                    <div class="mt-2 flex min-w-0 items-center gap-2">
                      {#if cronjobDetail.userProfile?.avatarUrl}
                        <img src={cronjobDetail.userProfile.avatarUrl} alt="" class="h-7 w-7 shrink-0 rounded-full object-cover" />
                      {:else}
                        <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand">
                          <UserRound class="h-4 w-4" aria-hidden="true" />
                        </span>
                      {/if}
                      <div class="min-w-0">
                        <div class="truncate text-[13px] font-medium text-text-primary">{cronjobDetail.userProfile?.displayName?.trim() || fallbackUserName(cronjobDetail.userUuid)}</div>
                        <div class="truncate font-mono text-[10px] text-text-placeholder" title={cronjobDetail.userUuid}>{cronjobDetail.userUuid}</div>
                      </div>
                    </div>
                  </div>
                    <div class="mt-1.5 font-mono text-[13px] text-text-primary">{taskTypeLabel(cronjobDetail.taskType)}</div>
                  </div>
                  <div>
                    <div class="text-[11px] uppercase tracking-wider text-text-placeholder font-medium">Session</div>
                    <div class="mt-1.5 font-mono text-[12px] text-text-secondary break-all">{cronjobDetail.sessionId ?? 'New session on run'}</div>
                  </div>
                  <div>
                    <div class="text-[11px] uppercase tracking-wider text-text-placeholder font-medium">Created</div>
                    <div class="mt-1.5 text-text-primary">{formatDateTime(cronjobDetail.createdAt)}</div>
                  </div>
                </div>

                <div class="h-px bg-border-subtle/70"></div>

                <div class="space-y-4">
                  <div class="text-[10px] uppercase tracking-[0.18em] text-text-placeholder font-medium">Prompt options</div>
                  <div class="grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12px]">
                    <div class="text-text-placeholder">Title</div>
                    <div class="text-text-secondary break-words">{cronjobPayloadField(cronjobDetail.payload, 'title')}</div>
                    <div class="text-text-placeholder">Model</div>
                    <div class="font-mono text-text-secondary break-all">{cronjobPayloadField(cronjobDetail.payload, 'model')}</div>
                    <div class="text-text-placeholder">Provider</div>
                    <div class="font-mono text-text-secondary break-all">{cronjobPayloadField(cronjobDetail.payload, 'provider')}</div>
                  </div>
                </div>
              </aside>
            </div>

            <section class="border-t border-border-subtle/70 pt-6">
              <div class="mb-3 flex items-center justify-between gap-3">
                <div>
                  <div class="text-[10px] uppercase tracking-[0.18em] text-text-placeholder font-medium">Recent Runs</div>
                  <div class="mt-1 text-[12px] text-text-tertiary">{cronjobRuns.length ? `${Math.min(cronjobRuns.length, 20)} latest executions` : 'No runs yet'}</div>
                </div>
              </div>
              {#if cronjobRuns.length > 0}
                <div class="divide-y divide-border-subtle/60">
                  {#each cronjobRuns.slice(0, 20) as run (run.id)}
                    {@const badge = taskRunStatusBadge(run)}
                    <a
                      href={buildSpaceTaskRoute(spaceId, run.id)}
                      class="grid grid-cols-[minmax(92px,0.8fr)_minmax(132px,1fr)_80px_minmax(0,1.5fr)] items-center gap-3 py-2.5 text-[12px] transition-colors hover:bg-bg-hover/70"
                      onclick={(e) => { e.preventDefault(); goto(buildSpaceTaskRoute(spaceId, run.id)); }}
                    >
                      <span class="flex items-center gap-2 px-1">
                        <span class="w-[6px] h-[6px] rounded-full shrink-0 {badge.dot}"></span>
                        <span class="{badge.color}">{badge.label}</span>
                      </span>
                      <span class="font-mono text-text-placeholder">{formatShortDateTime(run.scheduledAt)}</span>
                      <span class="font-mono text-text-placeholder">{taskRunDuration(run)}</span>
                      <span class="truncate text-[11px] {run.errorMessage ? 'text-status-error' : 'text-text-placeholder'}" title={run.errorMessage ?? run.id}>{run.errorMessage ?? run.id}</span>
                    </a>
                  {/each}
                </div>
              {:else}
                <div class="py-6 text-[13px] text-text-tertiary">Runs will appear here after the first scheduled execution.</div>
              {/if}
            </section>
          </div>
        {:else}
          <div class="text-[12px] text-text-tertiary">Scheduled job not found.</div>
        {/if}
        </div>
      </div>
    {:else if routeView === 'task'}
      <div class="flex-1 min-h-0 overflow-y-auto px-3 py-4 sm:p-4 max-w-4xl w-full space-y-4">
        {#if taskRunDetailLoading && taskRunDetail?.id !== routeTaskId}
          {@render PanelLoadingState("Loading task…")}
        {:else if taskRunDetailError}
          <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{taskRunDetailError}</div>
        {:else if taskRunDetail && taskRunDetail.id === routeTaskId}
          {@const badge = taskRunStatusBadge(taskRunDetail)}
          {#if taskRunDetail.taskType === "run_command"}
            {@const commandInfo = runCommandPayload(taskRunDetail)}
            {@const commandMeta = runCommandResultMeta(taskRunDetail)}
            {@const commandContent = runCommandContent(taskRunDetail)}
            <div class="mx-auto w-full max-w-4xl px-1 sm:px-2">
              <div class="border-b border-border-subtle/80 pb-4 sm:pb-5">
                <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div class="min-w-0 space-y-2">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="text-[10px] uppercase tracking-[0.18em] text-text-placeholder font-medium">Run Command</span>
                      <span class="inline-flex items-center gap-1.5 rounded-full bg-bg-elevated px-2 py-1 text-[11px] text-text-secondary">
                        <span class="h-1.5 w-1.5 rounded-full {badge.dot}"></span>
                        {badge.label}
                      </span>
                      {#if commandMeta.exitCode !== null}
                        <span class="rounded-full bg-bg-elevated px-2 py-1 font-mono text-[11px] text-text-secondary">exit {commandMeta.exitCode}</span>
                      {/if}
                    </div>
                    <pre class="max-w-full whitespace-pre-wrap break-words font-mono text-[14px] leading-relaxed text-text-primary sm:text-[15px]">{commandInfo.command}</pre>
                  </div>
                  <div class="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-text-tertiary sm:justify-end">
                    <span class="font-mono">{commandInfo.cwd}</span>
                    <span>{formatDurationMs(commandMeta.durationMs)}</span>
                    <span>{formatDateTime(taskRunDetail.createdAt)}</span>
                  </div>
                </div>
              </div>

              <div class="py-4 sm:py-5">
                {#if commandContent.length > 0}
                  <ToolCallList content={commandContent} streaming={taskRunDetail.status === "pending" || taskRunDetail.status === "running"} defaultExpanded flush />
                {:else}
                  <div class="py-8 text-[13px] text-text-tertiary">Waiting for command output…</div>
                {/if}
              </div>

              {#if taskRunDetail.errorMessage}
                <div class="border-t border-error-soft/30 py-4 text-[13px] text-error-soft whitespace-pre-wrap break-all">{taskRunDetail.errorMessage}</div>
              {/if}
            </div>
          {:else}
            <div class="border border-border-subtle rounded-md bg-bg-surface p-5 space-y-4">
              <div class="space-y-1">
                <div class="text-[10px] uppercase tracking-wider text-text-placeholder font-medium">Task Run</div>
                <div class="flex items-center gap-3">
                  <span class="flex items-center gap-2">
                    <span class="w-3 h-3 rounded-full {badge.dot}"></span>
                    <span class="text-[16px] font-semibold text-text-primary {badge.color}">{badge.label}</span>
                  </span>
                </div>
                <p class="text-[13px] text-text-tertiary">
                  {#if taskRunDetail.cronJobId}
                    From cronjob
                    <a
                      href={buildSpaceCronjobRoute(spaceId, taskRunDetail!.cronJobId!)}
                      class="text-text-primary hover:text-brand transition-colors"
                      onclick={(e) => { e.preventDefault(); goto(buildSpaceCronjobRoute(spaceId, taskRunDetail!.cronJobId!)); }}
                    >view</a>
                  {:else}
                    One-time task
                  {/if}
                </p>
              </div>
              <div class="grid gap-3 md:grid-cols-2">
                <div class="rounded-[6px] border border-border-subtle bg-bg-elevated/40 p-3">
                  <div class="text-[11px] uppercase tracking-wider text-text-placeholder font-medium">Task Type</div>
                  <div class="mt-2 text-[13px] text-text-primary">{taskTypeLabel(taskRunDetail.taskType)}</div>
                </div>
                <div class="rounded-[6px] border border-border-subtle bg-bg-elevated/40 p-3">
                  <div class="text-[11px] uppercase tracking-wider text-text-placeholder font-medium">Attempts</div>
                  <div class="mt-2 text-[13px] text-text-primary">{taskRunDetail.attemptCount}</div>
                </div>
                <div class="rounded-[6px] border border-border-subtle bg-bg-elevated/40 p-3">
                  <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-placeholder font-medium">
                    <Clock class="w-3.5 h-3.5" />
                    Scheduled
                  </div>
                  <div class="mt-2 text-[13px] text-text-primary">{formatDateTime(taskRunDetail.scheduledAt)}</div>
                </div>
                <div class="rounded-[6px] border border-border-subtle bg-bg-elevated/40 p-3">
                  <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-placeholder font-medium">
                    <Clock3 class="w-3.5 h-3.5" />
                    Duration
                  </div>
                  <div class="mt-2 text-[13px] text-text-primary">{taskRunDuration(taskRunDetail)}</div>
                </div>
              </div>
              {#if taskRunDetail.startedAt || taskRunDetail.finishedAt}
                <div class="grid gap-3 md:grid-cols-2">
                  <div class="rounded-[6px] border border-border-subtle bg-bg-elevated/40 p-3">
                    <div class="text-[11px] uppercase tracking-wider text-text-placeholder font-medium">Started At</div>
                    <div class="mt-2 text-[13px] text-text-primary">{formatDateTime(taskRunDetail.startedAt)}</div>
                  </div>
                  <div class="rounded-[6px] border border-border-subtle bg-bg-elevated/40 p-3">
                    <div class="text-[11px] uppercase tracking-wider text-text-placeholder font-medium">Finished At</div>
                    <div class="mt-2 text-[13px] text-text-primary">{formatDateTime(taskRunDetail.finishedAt)}</div>
                  </div>
                </div>
              {/if}
              <div class="rounded-[6px] border border-border-subtle bg-bg-elevated/20 p-4">
                <div class="text-[11px] uppercase tracking-wider text-text-placeholder font-medium">Payload</div>
                <pre class="mt-2 text-[12px] font-mono text-text-secondary whitespace-pre-wrap break-all">{JSON.stringify(taskRunDetail.payload, null, 2)}</pre>
              </div>
              {#if taskRunDetail.result}
                <div class="rounded-[6px] border border-border-subtle bg-bg-elevated/20 p-4">
                  <div class="text-[11px] uppercase tracking-wider text-text-placeholder font-medium">Result</div>
                  <pre class="mt-2 text-[12px] font-mono text-text-secondary whitespace-pre-wrap break-all">{JSON.stringify(taskRunDetail.result, null, 2)}</pre>
                </div>
              {/if}
              {#if taskRunDetail.errorMessage}
                <div class="rounded-[6px] border border-error-soft/30 bg-error-bg p-4">
                  <div class="text-[11px] uppercase tracking-wider text-error-soft font-medium">Error</div>
                  <div class="mt-2 text-[13px] text-error-soft whitespace-pre-wrap break-all">{taskRunDetail.errorMessage}</div>
                </div>
              {/if}
            </div>
          {/if}
        {:else}
          <div class="rounded-md border border-border-subtle bg-bg-surface p-4 text-[12px] text-text-tertiary">Task run not found.</div>
        {/if}
      </div>
    {:else if fileMode === 'file'}
      <!-- File Viewer -->
      {#if openFileLoading && openFile?.path !== routeFilePath}
        {@render PanelLoadingState("Loading file…")}
      {:else if openFileError}
        <div class="m-4 flex items-start gap-2 rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] text-error-soft">
          {openFileError}
        </div>
      {:else if openFileTooLarge}
        <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
          <div class="flex h-10 items-center gap-1.5 sm:gap-2 border-b border-border-subtle px-2 sm:px-3 shrink-0">
            <div class="min-w-0 flex-1 truncate text-[11px] sm:text-[12px] text-text-secondary">
              {routeFilePath}
            </div>
            {#if routeFilePath}
              {@render FileHeaderCoreActions(routeFilePath)}
            {/if}
            <a
              href={openFileDownloadUrl}
              download={openFileDownloadName}
              class="action-btn"
              title="Download file"
              onclick={(e) => { e.preventDefault(); void downloadOpenFile(); }}
            >
              <Download class="w-3.5 h-3.5 shrink-0" />
              <span class="hidden sm:inline">Download</span>
            </a>
            <button type="button" class="icon-btn" onclick={closeFile} title="Close file">
              <X class="w-4 h-4" />
            </button>
          </div>
          <div class="flex-1 flex items-center justify-center">
            <div class="m-4 rounded-lg border border-warning-soft/30 bg-warning-bg p-6 text-center max-w-sm">
              <div class="text-[40px] mb-3">📦</div>
              <div class="text-[14px] font-semibold text-text-primary mb-1">File too large to preview</div>
              <div class="text-[12px] text-text-secondary mb-4">This file exceeds 10MB and cannot be opened in the web editor.</div>
              <a
                href={openFileDownloadUrl}
                download={openFileDownloadName}
                class="action-btn primary"
                onclick={(e) => { e.preventDefault(); void downloadOpenFile(); }}
              >
                <Download class="w-3.5 h-3.5" />
                Download file
              </a>
            </div>
          </div>
        </div>
      {:else if openFile}
        <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
          {#if openFileIsText}
            <div class="flex h-10 items-center gap-1.5 sm:gap-2 border-b border-border-subtle px-2 sm:px-3 shrink-0">
              <div class="min-w-0 flex-1 truncate text-[11px] sm:text-[12px] text-text-secondary">
                {openFile.path}
              </div>
              {#if openFileHasRenderedPreview}
                <div class="flex items-center gap-0 rounded-md border border-border-subtle bg-bg-input p-[2px]">
                  <button
                    type="button"
                    class="segmented-btn"
                    class:active={fileEdit}
                    onclick={() => fileEdit = true}
                    title="Edit source"
                  >
                    Source
                  </button>
                  <button
                    type="button"
                    class="segmented-btn"
                    class:active={!fileEdit}
                    onclick={() => fileEdit = false}
                    title={openFileIsMarkdown ? "Preview markdown" : "Preview HTML"}
                  >
                    Preview
                  </button>
                </div>
              {/if}
              {@render FileHeaderCoreActions(openFile.path)}
              {#if openFileIsHtml && !fileEdit}
                <button type="button" class="action-btn" onclick={publishOpenFile} title="Publish work">
                  <Rocket class="w-3.5 h-3.5 shrink-0" />
                  <span class="hidden sm:inline">Publish</span>
                </button>
              {/if}
              <a
                href={openFileDownloadUrl}
                download={openFileDownloadName}
                class="icon-btn"
                title="Download file"
                onclick={(e) => { e.preventDefault(); void downloadOpenFile(); }}
              >
                <Download class="w-4 h-4" />
              </a>
              <button type="button" class="icon-btn" onclick={() => void copyFileContent()} title="Copy content">
                {#if openFileCopied}
                  <Check class="w-4 h-4 text-success-soft" />
                {:else}
                  <Copy class="w-4 h-4" />
                {/if}
              </button>
              <button
                type="button"
                class="action-btn"
                onclick={saveOpenFile}
                disabled={openFileSaving || !fileDirty || !canEditFiles}
                title="Save (Ctrl+S)"
              >
                <Save class="w-3.5 h-3.5 shrink-0" />
                <span class="hidden sm:inline">Save</span>
              </button>
              <button type="button" class="icon-btn" onclick={closeFile} title="Close file">
                <X class="w-4 h-4" />
              </button>
            </div>
            <div class="flex-1 min-h-0">
              {#if fileEdit}
                {#await import("$lib/components/CodeEditor.svelte") then editorModule}
                  {@const LazyCodeEditor = editorModule.default}
                  <LazyCodeEditor
                    value={openFileDraft}
                    language={openFileExt}
                    onInput={(v) => openFileDraft = v}
                    readonly={!canEditFiles}
                  />
                {:catch}
                  <div class="flex h-full items-center justify-center text-[12px] text-error-soft">Editor failed to load.</div>
                {/await}
              {:else if openFileHasRenderedPreview}
                {#await import("$lib/components/RenderedFilePreview.svelte") then previewModule}
                  {@const LazyRenderedFilePreview = previewModule.default}
                  <LazyRenderedFilePreview
                    name={openFile.name}
                    source={openFileDraft}
                    type={openFileIsMarkdown ? "markdown" : "html"}
                  />
                {:catch}
                  <div class="flex h-full items-center justify-center text-[12px] text-error-soft">Preview failed to load.</div>
                {/await}
              {:else}
                {#await import("$lib/components/CodeEditor.svelte") then editorModule}
                  {@const LazyCodeEditor = editorModule.default}
                  <LazyCodeEditor
                    value={openFileDraft}
                    language={openFileExt}
                    readonly={true}
                  />
                {:catch}
                  <div class="flex h-full items-center justify-center text-[12px] text-error-soft">Editor failed to load.</div>
                {/await}
              {/if}
            </div>
          {:else if openFileIsImage && openFileDataUrl}
            <div class="flex h-10 items-center gap-1.5 sm:gap-2 border-b border-border-subtle px-2 sm:px-3 shrink-0">
              <div class="min-w-0 flex-1 truncate text-[11px] sm:text-[12px] text-text-secondary">
                {openFile.path}
              </div>
              <div class="text-[11px] text-text-tertiary hidden sm:inline">{formatFileSize(openFile.size)}</div>
              {@render FileHeaderCoreActions(openFile.path)}
              <button type="button" class="zoom-btn" onclick={() => { openFileZoom = Math.max(0.25, openFileZoom - 0.25); openFilePanX = 0; openFilePanY = 0; }} title="Zoom out">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="7" y1="11" x2="15" y2="11"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </button>
              <span class="text-[11px] text-text-tertiary tabular-nums w-10 text-center">{Math.round(openFileZoom * 100)}%</span>
              <button type="button" class="zoom-btn" onclick={() => { openFileZoom = Math.min(4, openFileZoom + 0.25); openFilePanX = 0; openFilePanY = 0; }} title="Zoom in">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="11" y1="7" x2="11" y2="15"/><line x1="7" y1="11" x2="15" y2="11"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </button>
              <a
                href={openFileDownloadUrl}
                download={openFileDownloadName}
                class="icon-btn"
                title="Download file"
                onclick={(e) => { e.preventDefault(); void downloadOpenFile(); }}
              >
                <Download class="w-4 h-4" />
              </a>
              <button type="button" class="icon-btn" onclick={closeFile} title="Close file">
                <X class="w-4 h-4" />
              </button>
            </div>
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div class="flex flex-1 items-center justify-center overflow-hidden p-4" tabindex="-1" role="group" aria-label="Image preview — scroll to zoom, drag to pan, double-click to reset" onwheel={(e) => {
              if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                openFileZoom = Math.max(0.25, Math.min(4, openFileZoom + (e.deltaY < 0 ? 0.1 : -0.1)));
                openFilePanX = 0;
                openFilePanY = 0;
              }
            }} ondblclick={() => { openFileZoom = 1; openFilePanX = 0; openFilePanY = 0; }} onmousedown={openFilePanHandlers.start} style={openFileDragging ? 'cursor: grabbing;' : (openFileZoom > 1 ? 'cursor: grab;' : '')}>
              <img src={openFileDataUrl} alt={openFile.name} style={`transform: translate(${openFilePanX}px, ${openFilePanY}px) scale(${openFileZoom}); ${openFileDragging ? '' : 'transition: transform 150ms ease;'}`} class="max-h-full max-w-full rounded-md select-none" />
            </div>
          {:else if openFileIsVideo && openFileDataUrl}
            <div class="flex h-10 items-center gap-1.5 sm:gap-2 border-b border-border-subtle px-2 sm:px-3 shrink-0">
              <div class="min-w-0 flex-1 truncate text-[11px] sm:text-[12px] text-text-secondary">
                {openFile.path}
              </div>
              <div class="text-[11px] text-text-tertiary hidden sm:inline">{formatFileSize(openFile.size)}</div>
              {@render FileHeaderCoreActions(openFile.path)}
              <a
                href={openFileDownloadUrl}
                download={openFileDownloadName}
                class="icon-btn"
                title="Download file"
                onclick={(e) => { e.preventDefault(); void downloadOpenFile(); }}
              >
                <Download class="w-4 h-4" />
              </a>
              <button type="button" class="icon-btn" onclick={closeFile} title="Close file">
                <X class="w-4 h-4" />
              </button>
            </div>
            <div class="flex flex-1 items-center justify-center p-4">
              <video src={openFileDataUrl} controls class="max-h-full max-w-full rounded-md">
                <track kind="captions" />
              </video>
            </div>
          {:else}
            <div class="flex h-10 items-center gap-1.5 sm:gap-2 border-b border-border-subtle px-2 sm:px-3 shrink-0">
              <div class="min-w-0 flex-1 truncate text-[11px] sm:text-[12px] text-text-secondary">
                {openFile.path}
              </div>
              <div class="text-[11px] text-text-tertiary hidden sm:inline">{formatFileSize(openFile.size)}</div>
              {@render FileHeaderCoreActions(openFile.path)}
              <a
                href={openFileDownloadUrl}
                download={openFileDownloadName}
                class="icon-btn"
                title="Download file"
                onclick={(e) => { e.preventDefault(); void downloadOpenFile(); }}
              >
                <Download class="w-4 h-4" />
              </a>
              <button type="button" class="icon-btn" onclick={closeFile} title="Close file">
                <X class="w-4 h-4" />
              </button>
            </div>
            <div class="m-4 rounded-md border border-border-subtle bg-bg-primary p-4 text-[12px] text-text-secondary">
              <div><strong>Name:</strong> {openFile.name}</div>
              <div><strong>Type:</strong> {openFile.mimeType ?? 'application/octet-stream'}</div>
              <div><strong>Size:</strong> {openFile.size} bytes</div>
              <div class="mt-3 text-text-tertiary">This file type cannot be previewed in the browser.</div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="flex-1 flex items-center justify-center text-[12px] text-text-tertiary">No file selected</div>
      {/if}
    {:else}
      <!-- Chat -->
    {#if spaceLoadError && !spaceHasMinimalAccess}
      <div class="m-4 rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{spaceLoadError}</div>
    {/if}
    {#if createSessionError}
      <div class="m-4 mt-0 rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{createSessionError}</div>
    {/if}
    {#if bootstrapping && !activeSessionState}
      <div class="flex-1 flex items-center justify-center">
        <div class="flex flex-col items-center gap-3 text-text-tertiary">
          <div class="w-6 h-6 rounded-full border-2 border-border-subtle border-t-brand animate-spin"></div>
          <div class="text-[12px]">Loading space…</div>
        </div>
      </div>
    {:else if !activeSessionState && routeView === "space"}
      <div class="flex-1 overflow-y-auto px-4 py-6">
        <div class="mx-auto flex w-full max-w-3xl flex-col gap-5">
          {#if spaceStatusNotice}
            <div class="inline-flex items-center gap-2 self-start rounded-full border border-success-soft/20 bg-success-soft/8 px-3 py-1.5 text-[12px] text-success-soft">
              <Check class="w-3.5 h-3.5" />
              <span>{spaceStatusNotice}</span>
            </div>
          {/if}
          <!-- Space Profile -->
          <section class="rounded-[12px] border border-border-subtle bg-bg-surface p-4 sm:p-5">
            <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div class="flex min-w-0 flex-1 items-start gap-4">
                <div class="flex w-16 shrink-0 flex-col items-center gap-1.5">
                  {#if canEditSpaceProfile}
                    <label class="group relative h-14 w-14 cursor-pointer overflow-hidden rounded-full border border-border-subtle bg-bg-hover-strong transition-colors hover:border-brand/50 focus-within:border-brand/50" title="Change space avatar" aria-label="Change space avatar">
                      <SpaceAvatar name={space?.name || space?.title || spaceId} profile={space?.publicProfile} size="lg" class="h-full w-full rounded-full border-0 shadow-none" />
                      <span class="absolute inset-0 flex items-center justify-center bg-overlay-scrim-strong opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                        {#if spaceAvatarUploading}
                          <Loader2 class="h-4 w-4 animate-spin text-overlay-control-text" />
                        {:else}
                          <Upload class="h-4 w-4 text-overlay-control-text" />
                        {/if}
                      </span>
                      <input type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" disabled={spaceAvatarUploading} onchange={handleSpaceAvatarFileChange} />
                    </label>
                    <label class="inline-flex cursor-pointer items-center gap-1 rounded-[4px] px-1 py-0.5 text-[11px] leading-none text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary focus-within:bg-bg-hover focus-within:text-text-secondary {spaceAvatarUploading ? 'pointer-events-none opacity-50' : ''}">
                      {#if spaceAvatarUploading}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Upload class="h-3 w-3" />{/if}
                      <span>{space?.publicProfile?.avatarUrl ? "Change" : "Upload"}</span>
                      <input type="file" accept="image/jpeg,image/png,image/webp" class="sr-only" disabled={spaceAvatarUploading} onchange={handleSpaceAvatarFileChange} />
                    </label>
                  {:else}
                    <SpaceAvatar name={space?.name || space?.title || spaceId} profile={space?.publicProfile} size="lg" class="h-14 w-14 rounded-full" />
                  {/if}
                </div>
                <div class="min-w-0 flex-1 pt-0.5">
                  <div class="flex min-w-0 items-center gap-1.5 group">
                    {#if renamingSpace && canEditSpaceProfile}
                      <input
                        type="text"
                        bind:value={renameInput}
                        disabled={renameSaving}
                        class="min-w-0 flex-1 rounded-[6px] border border-brand/40 bg-bg-input px-2 py-1 text-[20px] font-medium text-text-primary transition-colors focus:outline-none disabled:opacity-60"
                        onkeydown={(e) => {
                          if (e.key === "Enter" && !renameSaving && !isComposingKeyboardEvent(e)) {
                            e.preventDefault();
                            const trimmed = renameInput.trim();
                            if (trimmed && trimmed !== space?.name) void handleRenameSpace(trimmed);
                            else { renamingSpace = false; renameError = ""; }
                          }
                          if (e.key === "Escape" && !renameSaving) { renamingSpace = false; renameError = ""; }
                        }}
                      />
                      <button type="button" class="shrink-0 rounded-[5px] p-1.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title="Save" disabled={renameSaving} onclick={() => { const trimmed = renameInput.trim(); if (trimmed && trimmed !== space?.name) void handleRenameSpace(trimmed); else { renamingSpace = false; renameError = ""; } }}>
                        {#if renameSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Check class="h-3.5 w-3.5" />{/if}
                      </button>
                      <button type="button" class="shrink-0 rounded-[5px] p-1.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title="Cancel" disabled={renameSaving} onclick={() => { renamingSpace = false; renameError = ""; }}>
                        <X class="h-3.5 w-3.5" />
                      </button>
                    {:else if canEditSpaceProfile}
                      <button type="button" onclick={() => { renameInput = space?.name ?? ""; renamingSpace = true; renameError = ""; }} class="group/edit -ml-1 flex max-w-full items-center gap-1.5 rounded-[5px] px-1 py-0.5 text-left transition-colors hover:bg-bg-hover" title="Rename space">
                        <span class="min-w-0 truncate text-[20px] font-medium text-text-primary group-hover/edit:text-brand">{space?.name || space?.title || spaceId}</span>
                        <Pencil class="h-3.5 w-3.5 shrink-0 text-text-placeholder opacity-0 transition-opacity group-hover/edit:opacity-100" />
                      </button>
                    {:else}
                      <h1 class="min-w-0 truncate text-[20px] font-medium text-text-primary">{space?.name || space?.title || spaceId}</h1>
                    {/if}
                  </div>
                  {#if renameError}
                    <div class="mt-1 text-[11px] text-status-error">{renameError}</div>
                  {/if}

                  <div class="mt-2 space-y-1.5">
                    <div class="flex min-w-0 items-center gap-1.5 text-[11px] text-text-tertiary">
                      <span class="shrink-0 uppercase tracking-wider">ID</span>
                      <code class="min-w-0 truncate font-mono" title={spaceId}>{formatCompactId(spaceId)}</code>
                      <button type="button" onclick={() => void copySpaceId()} class="shrink-0 rounded-[4px] p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary" title="Copy space ID">
                        {#if copiedSpaceId}<Check class="h-3 w-3 text-success-soft" />{:else}<Copy class="h-3 w-3" />{/if}
                      </button>
                    </div>

                    <div class="min-w-0">
                      {#if editingSpaceSlug && canEditSpaceProfile}
                        <div class="min-w-0">
                          <div class="flex min-w-0 items-center gap-2">
                            <div class="flex min-w-0 flex-1 items-center rounded-[5px] border border-brand/40 bg-bg-input px-2.5 py-1.5">
                              <span class="mr-0.5 shrink-0 font-mono text-[12px] {getSpaceOwnerUsername(space) ? 'text-text-tertiary' : 'text-text-placeholder'}">/{getSpaceOwnerUsername(space) || 'username'}/</span>
                              <input aria-label="Space slug" bind:value={spaceSlugDraft} placeholder="my-space" maxlength="80" onkeydown={handleSpaceSlugKeydown} disabled={spaceSlugSaving} class="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-text-primary placeholder:text-text-placeholder focus:outline-none" />
                            </div>
                            <button type="button" onclick={() => void saveSpaceSlug()} disabled={spaceSlugSaving} class="shrink-0 rounded-[5px] p-1.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title="Save slug">
                              {#if spaceSlugSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Check class="h-3.5 w-3.5" />{/if}
                            </button>
                            <button type="button" onclick={cancelSpaceSlugEdit} disabled={spaceSlugSaving} class="shrink-0 rounded-[5px] p-1.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" title="Cancel">
                              <X class="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <p class="mt-1.5 text-[11px] leading-4 text-text-tertiary">Optional. Adds a cleaner URL; the space remains public by ID.</p>
                          {#if spaceSlugError}<div class="mt-1.5 text-[11px] text-error-soft break-words">{spaceSlugError}</div>{/if}
                        </div>
                      {:else}
                        <div class="min-w-0">
                          <div class="flex min-w-0 items-center gap-1.5 text-[11px] text-text-tertiary">
                            <span class="shrink-0 uppercase tracking-wider">Slug</span>
                            {#if getSpacePublicPath(space)}
                              <button type="button" onclick={() => void copySpacePublicLink()} class="group/copy inline-flex min-w-0 items-center gap-1 rounded-[4px] px-1 py-0.5 text-left transition-colors hover:bg-bg-hover hover:text-text-secondary" title="Copy pretty URL">
                                <code class="min-w-0 truncate font-mono">{getSpacePublicPath(space)}</code>
                                {#if copiedSpaceSlugLink}<Check class="h-3 w-3 shrink-0 text-success-soft" />{:else}<Copy class="h-3 w-3 shrink-0" />{/if}
                              </button>
                            {:else if getSpaceSlug(space)}
                              <code class="inline-flex min-w-0 rounded-[4px] px-1 py-0.5 font-mono text-text-tertiary"><span class="text-text-placeholder">/username/</span><span class="min-w-0 truncate">{getSpaceSlug(space)}</span></code>
                            {:else if getSpaceOwnerUsername(space)}
                              <button type="button" onclick={beginSpaceSlugEdit} class="min-w-0 truncate rounded-[4px] px-1 py-0.5 text-left text-text-placeholder transition-colors hover:bg-bg-hover hover:text-text-secondary" title="Add space slug">Add space slug</button>
                            {:else}
                              <button type="button" onclick={beginSpaceSlugEdit} class="min-w-0 truncate rounded-[4px] px-1 py-0.5 text-left text-text-placeholder transition-colors hover:bg-bg-hover hover:text-text-secondary" title="Add pretty URL">Add pretty URL</button>
                            {/if}
                            {#if canEditSpaceProfile}
                              <button type="button" onclick={beginSpaceSlugEdit} class="shrink-0 rounded-[4px] p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary" title="Edit slug">
                                <Pencil class="h-3 w-3" />
                              </button>
                            {/if}
                          </div>
                          {#if getSpacePrettyUrlHint(space)}
                            <p class="mt-1 text-[11px] leading-4 text-text-placeholder">
                              {#if !getSpaceOwnerUsername(space)}
                                Add username in <a href="/settings/profile" class="text-text-tertiary transition-colors hover:text-text-secondary hover:underline">Profile</a>{getSpaceSlug(space) ? ' to complete the pretty URL.' : ' and a space slug for a cleaner URL.'}
                              {:else}
                                {getSpacePrettyUrlHint(space)}
                              {/if}
                            </p>
                          {/if}
                        </div>
                      {/if}
                    </div>
                  </div>
                </div>
              </div>
              {#if !spaceHasMinimalAccess}
                <div class="flex shrink-0 items-center gap-2">
                  <a
                    href={`/spaces/${spaceId}/settings`}
                    class="inline-flex items-center justify-center gap-1.5 rounded-[7px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] font-medium text-text-secondary transition-colors hover:text-text-primary hover:bg-bg-hover"
                    title="Space settings"
                  >
                    <Settings class="w-3.5 h-3.5" />
                    Settings
                  </a>
                </div>
              {/if}
            </div>

            <div class="mt-4 border-t border-border-subtle pt-4">
              {#if spaceProfileEditingField === "description" && canEditSpaceProfile}
                <div class="space-y-2">
                  <textarea
                    aria-label="Space description"
                    bind:value={spaceProfileDraft}
                    rows="3"
                    maxlength="2000"
                    disabled={spaceProfileSaving === "description"}
                    onkeydown={handleSpaceProfileEditKeydown}
                    class="min-h-20 w-full resize-y rounded-[6px] border border-brand/40 bg-bg-input px-2.5 py-2 text-[13px] leading-5 text-text-primary placeholder:text-text-placeholder transition-colors focus:outline-none disabled:opacity-60"
                    placeholder="Describe what this space is for…"
                  ></textarea>
                  <div class="flex items-center gap-2">
                    <button type="button" onclick={() => void saveSpaceProfileField()} disabled={spaceProfileSaving === "description"} class="inline-flex items-center gap-1.5 rounded-[5px] border border-border-subtle bg-bg-input px-2 py-1.5 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50">
                      {#if spaceProfileSaving === "description"}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Check class="h-3.5 w-3.5" />{/if}
                      Save
                    </button>
                    <button type="button" onclick={cancelSpaceProfileEdit} disabled={spaceProfileSaving === "description"} class="rounded-[5px] px-2 py-1.5 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50">Cancel</button>
                    <span class="text-[11px] text-text-placeholder">⌘/Ctrl + Enter to save</span>
                  </div>
                </div>
              {:else if canEditSpaceProfile}
                <button type="button" onclick={() => beginSpaceProfileEdit("description")} class="group/edit -ml-1 block w-full rounded-[5px] px-1 py-0.5 text-left transition-colors hover:bg-bg-hover" title="Edit description">
                  <span class="text-[13px] leading-6 {space?.description ? 'text-text-secondary' : 'text-text-placeholder'}">{space?.description || "Add a short description for this space."}</span>
                  <Pencil class="ml-1 inline h-3 w-3 text-text-placeholder opacity-0 transition-opacity group-hover/edit:opacity-100" />
                </button>
              {:else if space?.description}
                <p class="text-[13px] leading-6 text-text-secondary">{space.description}</p>
              {/if}
            </div>

            {#if spaceProfileError}
              <div class="mt-3 rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] text-error-soft break-all">{spaceProfileError}</div>
            {/if}

            {#if bootstrapStatus === "failed"}
              <div class="mt-4 rounded-[6px] border border-error-soft/20 bg-error-soft/8 p-3">
                <div class="flex items-center gap-1.5 text-[12px] text-error-soft font-medium mb-1">
                  <AlertCircle class="w-3.5 h-3.5" />
                  Initialization failed
                </div>
                {#if bootstrapErrorMessage}
                  <div class="text-[11px] font-mono text-error-soft/80 break-all">{bootstrapErrorMessage}</div>
                {/if}
              </div>
            {/if}
          </section>
          <!-- Token Usage -->
          <section class="rounded-[10px] border border-border-subtle bg-bg-surface p-4 sm:p-5">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div class="flex items-center gap-2">
                <Activity class="w-4 h-4 text-text-tertiary" />
                <div>
                  <div class="text-[11px] uppercase tracking-[0.16em] text-text-placeholder">Usage</div>
                  <div class="mt-0.5 flex items-center gap-2 text-[15px] font-medium text-text-primary">
                    <span>Token consumption & cost</span>
                    {#if tokenUsageLoading && tokenUsage}
                      <Loader2 class="h-3.5 w-3.5 animate-spin text-text-placeholder" aria-label="Syncing" />
                    {/if}
                  </div>
                </div>
              </div>
              <div class="inline-flex w-fit rounded-[6px] border border-border-subtle bg-bg-primary p-0.5">
                {#each TOKEN_USAGE_DAY_OPTIONS as days}
                  <button
                    type="button"
                    class="rounded-[4px] px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 {tokenUsageDays === days ? 'bg-brand text-brand-contrast-fg' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}"
                    onclick={() => selectTokenUsageDays(days)}
                    disabled={tokenUsageLoading && tokenUsageDays === days}
                  >
                    {days}d
                  </button>
                {/each}
              </div>
            </div>
            {#if tokenUsageLoading && !tokenUsage}
              {@render PanelLoadingState("Loading usage…", true)}
            {:else if tokenUsageError}
              <div class="mt-4 rounded-[6px] border border-error-soft/20 bg-error-bg px-3 py-2 text-[12px] text-error-soft">
                Failed to load usage: {tokenUsageError}
              </div>
            {:else if tokenUsage}
              {@const usageSeries = buildDailyUsageSeries(tokenUsage.hourly, tokenUsage.days)}
              {@const maxDailyTokens = Math.max(...usageSeries.map((point) => point.totalTokens), 0)}
              {@const maxDailyCost = Math.max(...usageSeries.map((point) => point.costTotal), 0)}
              {@const avgTokensPerRequest = tokenUsage.summary.requestCount > 0 ? tokenUsage.summary.totalTokens / tokenUsage.summary.requestCount : 0}
              {@const cacheTokens = tokenUsage.summary.cacheReadTokens + tokenUsage.summary.cacheWriteTokens}
              {@const inputPercent = getUsageBreakdownPercent(tokenUsage.summary.inputTokens, tokenUsage.summary.totalTokens)}
              {@const outputPercent = getUsageBreakdownPercent(tokenUsage.summary.outputTokens, tokenUsage.summary.totalTokens)}
              {@const cachePercent = getUsageBreakdownPercent(cacheTokens, tokenUsage.summary.totalTokens)}
              <div class="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-[8px] border border-border-subtle bg-border-subtle sm:grid-cols-4">
                <div class="bg-bg-primary px-3 py-3">
                  <div class="text-[11px] text-text-tertiary">Total tokens</div>
                  <div class="mt-1 text-[18px] font-semibold text-text-primary tabular-nums">{formatTokenCount(tokenUsage.summary.totalTokens)}</div>
                </div>
                <div class="bg-bg-primary px-3 py-3">
                  <div class="text-[11px] text-text-tertiary">Cost</div>
                  <div class="mt-1 text-[18px] font-semibold text-text-primary tabular-nums">{formatCost(tokenUsage.summary.costTotal)}</div>
                </div>
                <div class="bg-bg-primary px-3 py-3">
                  <div class="text-[11px] text-text-tertiary">Requests</div>
                  <div class="mt-1 text-[18px] font-semibold text-text-primary tabular-nums">{tokenUsage.summary.requestCount}</div>
                </div>
                <div class="bg-bg-primary px-3 py-3">
                  <div class="text-[11px] text-text-tertiary">Avg / request</div>
                  <div class="mt-1 text-[18px] font-semibold text-text-primary tabular-nums">{formatTokenCount(avgTokensPerRequest)}</div>
                </div>
              </div>
              {#if tokenUsage.summary.totalTokens > 0}
                <div class="mt-4">
                  <div class="h-1.5 overflow-hidden rounded-full bg-bg-hover">
                    <div class="flex h-full">
                      <div class="bg-brand" style="width: {inputPercent}%;"></div>
                      <div class="bg-text-tertiary" style="width: {outputPercent}%;"></div>
                      <div class="bg-border-primary" style="width: {cachePercent}%;"></div>
                    </div>
                  </div>
                  <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-tertiary">
                    <span><span class="text-text-primary">Input</span> {inputPercent}%</span>
                    <span><span class="text-text-primary">Output</span> {outputPercent}%</span>
                    <span><span class="text-text-primary">Cache</span> {cachePercent}%</span>
                    {#if tokenUsage.summary.errorCount > 0}
                      <span class="text-error-soft">{tokenUsage.summary.errorCount} errors</span>
                    {/if}
                  </div>
                </div>
              {/if}
              {#if tokenUsage.hourly.length > 0 && maxDailyTokens > 0}
                <div class="mt-5 rounded-[8px] border border-border-subtle bg-bg-primary px-3 py-3">
                  <div class="mb-3 flex items-center justify-between gap-3 text-[11px] text-text-tertiary">
                    <div>
                      Peak <span class="text-text-secondary tabular-nums">{formatTokenCount(maxDailyTokens)}</span> tokens
                    </div>
                    <div class="flex items-center gap-3">
                      <span class="inline-flex items-center gap-1.5"><span class="h-2 w-2 rounded-[2px] bg-brand"></span>Tokens</span>
                      <span class="inline-flex items-center gap-1.5"><span class="h-px w-4 bg-text-tertiary"></span>Cost</span>
                    </div>
                  </div>
                  <div class="relative h-[150px] overflow-hidden rounded-[6px] border border-border-subtle bg-bg-surface px-2 pt-3 pb-8">
                    <div class="pointer-events-none absolute inset-x-2 top-3 bottom-8 grid grid-rows-3">
                      <div class="border-b border-border-subtle/70"></div>
                      <div class="border-b border-border-subtle/70"></div>
                      <div></div>
                    </div>
                    <svg class="pointer-events-none absolute left-2 right-2 top-3 bottom-8 z-10 h-[calc(100%-44px)] w-[calc(100%-16px)] overflow-visible" viewBox="0 0 100 72" preserveAspectRatio="none" aria-hidden="true">
                      <polyline
                        points={getUsageLinePoints(usageSeries, 100, 72)}
                        fill="none"
                        stroke="var(--text-tertiary)"
                        stroke-width="1.4"
                        vector-effect="non-scaling-stroke"
                      />
                    </svg>
                    <div class="absolute inset-x-2 top-3 bottom-8 grid items-end gap-1" style="grid-template-columns: repeat({usageSeries.length}, minmax(6px, 1fr));">
                      {#each usageSeries as point}
                        {@const barHeight = maxDailyTokens > 0 ? Math.max(3, (point.totalTokens / maxDailyTokens) * 100) : 0}
                        <div class="group relative flex h-full items-end" title="{point.date}: {formatTokenCount(point.totalTokens)} tokens · {formatCost(point.costTotal)} · {point.requestCount} requests">
                          <div class="w-full rounded-t-[3px] bg-brand/75 transition-colors group-hover:bg-brand" style="height: {barHeight}%;"></div>
                        </div>
                      {/each}
                    </div>
                    <div class="absolute inset-x-2 bottom-2 grid gap-1 text-[10px] text-text-placeholder" style="grid-template-columns: repeat({usageSeries.length}, minmax(6px, 1fr));">
                      {#each usageSeries as point, index}
                        <div class="truncate text-center {tokenUsage.days <= 7 || index % 5 === 0 || index === usageSeries.length - 1 ? '' : 'opacity-0'}">{point.label}</div>
                      {/each}
                    </div>
                  </div>
                  {#if maxDailyCost > 0}
                    <div class="mt-2 text-[11px] text-text-tertiary">
                      Peak cost <span class="text-text-secondary tabular-nums">{formatCost(maxDailyCost)}</span> / day
                    </div>
                  {/if}
                </div>
              {:else}
                <div class="mt-5 flex items-center justify-center rounded-[8px] border border-border-subtle bg-bg-primary py-8 text-[13px] text-text-tertiary">
                  No usage in the last {tokenUsage.days} days.
                </div>
              {/if}
            {:else}
              <div class="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-[8px] border border-border-subtle bg-border-subtle sm:grid-cols-4">
                {#each Array(4) as _}
                  <div class="bg-bg-primary px-3 py-3">
                    <div class="h-3 w-16 rounded bg-bg-hover"></div>
                    <div class="mt-2 h-5 w-20 rounded bg-bg-hover"></div>
                  </div>
                {/each}
              </div>
              <div class="mt-5 flex h-[150px] items-center justify-center rounded-[8px] border border-border-subtle bg-bg-primary text-[13px] text-text-tertiary">
                Loading usage data…
              </div>
            {/if}
          </section>
          <section class="rounded-[10px] border border-border-subtle bg-bg-surface p-4 sm:p-5 space-y-3">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-2">
                <Save class="w-4 h-4 text-text-tertiary" />
                <div>
                  <div class="text-[11px] uppercase tracking-[0.16em] text-text-placeholder">Saves</div>
                  <div class="text-[15px] font-medium text-text-primary">Checkpoint history</div>
                </div>
              </div>
              <a href={buildSpaceCheckpointNewRoute(spaceId)} class="text-[12px] text-brand hover:underline">New save</a>
            </div>
            {#if spaceCheckpoints.length === 0}
              <div class="rounded-[6px] border border-border-subtle bg-bg-primary p-3 text-[13px] text-text-tertiary">No saves yet.</div>
            {:else}
              <div class="divide-y divide-border-subtle overflow-hidden rounded-[7px] border border-border-subtle">
                {#each spaceCheckpoints.slice(0, 8) as checkpoint (checkpoint.id)}
                  <a href={buildSpaceCheckpointRoute(spaceId, checkpoint.id)} class="block bg-bg-primary px-3 py-2.5 hover:bg-bg-hover transition-colors">
                    <div class="flex items-center justify-between gap-3">
                      <div class="min-w-0">
                        <div class="truncate text-[13px] font-medium text-text-primary">{checkpoint.description || checkpoint.commitHash.slice(0, 12)}</div>
                        <div class="mt-0.5 text-[11px] text-text-tertiary">{formatCheckpointTimestamp(checkpoint.createdAt)} · {checkpoint.forkCount} forks</div>
                      </div>
                      <span class="shrink-0 font-mono text-[11px] text-text-placeholder">{checkpoint.commitHash.slice(0, 8)}</span>
                    </div>
                  </a>
                {/each}
              </div>
            {/if}
          </section>
        </div>
      </div>
    {:else if !activeSessionState}
      <div class="flex-1 flex flex-col items-center justify-center text-text-tertiary gap-4">
        <div class="text-[14px]">No chat selected</div>
        {#if !spaceHasMinimalAccess}
          <button
            type="button"
            class="flex items-center gap-1.5 px-3 py-2 rounded-[5px] bg-bg-hover hover:bg-bg-hover-strong border border-border-subtle text-[12px] text-text-secondary hover:text-text-primary transition-colors duration-100 disabled:opacity-50"
            onclick={() => handleCreateNewSession()}
            disabled={!canCreateSession}
          >
            <Plus class="w-3.5 h-3.5" />
            Create a session
          </button>
        {/if}
      </div>
    {:else if activeSessionState.loading && !activeSessionState.loaded}
      <div class="flex-1 flex items-center justify-center">
        <div class="flex flex-col items-center gap-3 text-text-tertiary">
          <div class="w-6 h-6 rounded-full border-2 border-border-subtle border-t-brand animate-spin"></div>
          <div class="text-[12px]">Loading turns…</div>
        </div>
      </div>
    {:else}
      {#if activeSessionState.error}
        <div class="m-4 rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">
          {activeSessionState.error}
        </div>
      {/if}
      <div class="relative flex-1 min-h-0 flex flex-col">
        <ChatTimeline
            bind:this={chatTimelineRef}
            bind:bindListEl={listEl}
            timeline={timeline}
            preloadThreshold={10}
            onFirstVisible={handleFirstVisible}
            onLoadToolCalls={(input) => loadMessageToolCalls({ spaceId, sessionId: input.turn.sessionId, turnId: input.turn.sourceTurnId ?? input.turn.id, message: input.message })}
            onLoadIntermediate={(turn) => loadTurnIntermediate({ spaceId, sessionId: turn.sessionId, turnId: turn.sourceTurnId ?? turn.id, messagesObjectKey: turn.intermediateIndex?.messagesObjectKey ?? null })}
            onMarkdownRenderStart={handleTimelineMarkdownRenderStart}
            onMarkdownRendered={handleTimelineMarkdownRendered}
            onForkTurn={handleForkTurn}
            forkingTurnId={forkingTurnId}
            loading={activeSessionState?.loading ?? false}
            refreshing={Boolean(activeSessionState?.loading && activeSessionState.loaded)}
            loadingOlder={activeSessionState?.loadingOlder ?? false}
            loadingNewer={activeSessionState?.loadingNewer ?? false}
            onOpenFile={openInlineFile}
            modelsCatalog={modelsCatalog ?? undefined}
          />
          <SessionTaskTray notices={sessionTaskNotices} />
          {#if followupQueue.length > 0}
            <div class="mx-auto w-full max-w-4xl border-t border-border-subtle/70 bg-bg-content px-4 py-2 sm:px-6">
              <div class="mb-1 flex items-center gap-2 text-[11px] text-text-placeholder">
                <span class="font-medium text-text-secondary">Follow-up</span>
                <span>{followupQueue.length} queued</span>
              </div>
              <div class="max-h-[min(22dvh,9rem)] space-y-1 overflow-y-auto overscroll-contain pr-1 sm:max-h-[min(28vh,12rem)]">
                {#each followupQueue as turn (turn.id)}
                  <div class="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-text-tertiary hover:bg-bg-hover/60">
                    <div class="min-w-0 flex-1 truncate">{turnPreviewText(turn)}</div>
                    <button type="button" class="shrink-0 rounded px-1.5 py-1 text-text-secondary hover:bg-bg-surface hover:text-text-primary disabled:cursor-default disabled:opacity-50" disabled={pendingFollowupActionIds.has(turn.id)} onclick={() => { void handleSteerFollowup(turn.id); }}>Steer now</button>
                    <button type="button" class="shrink-0 rounded px-1.5 py-1 text-text-placeholder hover:bg-bg-surface hover:text-text-secondary disabled:cursor-default disabled:opacity-50" disabled={pendingFollowupActionIds.has(turn.id)} onclick={() => { void handleCancelFollowup(turn.id); }}>Cancel</button>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
          <TurnRail
            turns={activeTurnRailItems}
            loadedTurns={activeSessionState.turns}
            markerPositions={turnMarkerPositions}
            markerHeights={turnMarkerHeights}
            scrollTop={timelineScrollTop}
            scrollHeight={timelineScrollHeight}
            clientHeight={timelineClientHeight}
            bottomOffset={composerHeight}
            olderCount={unloadedOlderTurnCount}
            newerCount={unloadedNewerTurnCount}
            hasMoreOlder={activeSessionState.hasMore}
            hasMoreNewer={activeSessionState.hasMoreNewer}
            loadingOlder={activeSessionState.loadingOlder}
            loadingNewer={activeSessionState.loadingNewer}
            currentSequence={currentTurnSequence}
            loadingSequence={loadingTurnSequence}
            onJump={(sequence) => { void jumpToTurnAndUpdateUrl(sequence); }}
            onScrollTo={(scrollTop) => { setProgrammaticScrollTop(scrollTop); }}
            onScrollCommit={() => { snapScrollToNearestTurn(); }}
            onLoadOlder={() => { if (activeSessionId) void loadOlderTurns(activeSessionId); }}
            onLoadNewer={() => { if (activeSessionId) void syncSessionNewer(activeSessionId, null); }}
          />
        {#if highlightedTurnSequence}
          <div class="pointer-events-none absolute left-0 right-0 top-0 z-10 h-px bg-brand/70"></div>
        {/if}
        {#if hasUnread || !shouldAutoFollow || activeTurnRailItems.length > 1}
          <div class={`pointer-events-none absolute left-1/2 z-20 -translate-x-1/2 ${!hasUnread && shouldAutoFollow ? 'lg:hidden' : ''}`}
            style:bottom={`${Math.max(composerHeight + 12, 96)}px`}
            style="animation: cohub-scroll-to-bottom-in 180ms cubic-bezier(0.22, 1, 0.36, 1);">
            <div class="pointer-events-auto flex items-center gap-0.5 rounded-full border border-border-subtle/80 bg-bg-primary/95 p-1 shadow-[0_4px_18px_rgba(0,0,0,0.16)] backdrop-blur-sm">
              {#if hasUnread}
                <button
                  type="button"
                  aria-label="Jump to new messages"
                  class="flex h-7 items-center justify-center rounded-full bg-brand px-2.5 text-[11px] font-semibold leading-none text-brand-contrast-fg transition-colors duration-150 hover:bg-brand-hover active:scale-95"
                  onclick={() => {
                    shouldAutoFollow = true;
                    void forceScrollToBottom();
                  }}
                >
                  New
                </button>
              {/if}
              {#if !shouldAutoFollow}
                <button
                  type="button"
                  aria-label="Jump to bottom"
                  class="flex h-7 min-w-7 items-center justify-center rounded-full px-1.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary active:scale-95"
                  onclick={() => {
                    shouldAutoFollow = true;
                    void forceScrollToBottom();
                  }}
                >
                  <ArrowDown class="w-4 h-4" />
                </button>
              {/if}
              {#if activeTurnRailItems.length > 1}
                <button
                  type="button"
                  aria-label="Open turn list"
                  class="flex h-7 min-w-7 items-center justify-center rounded-full px-1.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary active:scale-95 lg:hidden"
                  onclick={() => { showTurnBottomSheet = true; if (activeSessionId) void loadTurnIndex(activeSessionId, true); }}
                >
                  <ListTree class="w-4 h-4" />
                </button>
              {/if}
            </div>
          </div>
        {/if}
        <TurnBottomSheet
          open={showTurnBottomSheet}
          turns={activeTurnRailItems}
          currentSequence={currentTurnSequence}
          onClose={() => { showTurnBottomSheet = false; }}
          onJump={(sequence) => { void jumpToTurnAndUpdateUrl(sequence); }}
        />
        <div bind:this={composerHostEl}>
          <SessionComposer
            bind:value={input}
            disabled={!activeSessionState}
            sending={sending}
            isRunning={activeSessionIsRunning}
            aborting={aborting}
            streamError={composerNotice}
            attachments={attachments}
            currentModel={activeSessionModel}
            currentSpaceId={spaceId}
            promptTemplates={promptTemplates}
            promptTemplatesLoaded={promptTemplatesLoaded}
            onpickattachment={handlePickAttachments}
            onremoveattachment={handleRemoveAttachment}
            onsubmit={handleSend}
            onabort={handleAbort}
            onModelSelect={() => {
              void loadModelsCatalog();
              void loadGenerationModelsCatalog();
              showModelSelector = true;
            }}
          />
        </div>
      </div>
    {/if}
  {/if}
  </div>
  <!-- Inline file panel — desktop: side panel, mobile: full-screen overlay -->
  {#if inlineFile}
    <!-- Mobile full-screen overlay -->
    <div class="lg:hidden fixed inset-0 z-50 flex flex-col bg-bg-content">
      <div class="flex h-11 items-center gap-2 border-b border-border-subtle px-3 shrink-0 bg-bg-surface">
        <button type="button" class="icon-btn" onclick={closeInlineFile} title="Close file">
          <X class="w-5 h-5" />
        </button>
        <div class="min-w-0 flex-1 truncate text-sm text-text-secondary">
          {#if inlineFile.response}{inlineFile.response.path}{:else}{inlineFile.path}{/if}
        </div>
        {@render FileHeaderCoreActions(inlineFile.path)}
        {#if inlineFile.response && inlineFile.response.kind === "text"}
          <a href={inlineFileDownloadUrl} download={inlineFileDownloadName} class="icon-btn" title="Download file" onclick={(e) => { e.preventDefault(); void downloadInlineFile(); }}>
            <Download class="w-4 h-4" />
          </a>
        {/if}
      </div>
      {#if inlineFile.loading}
        {@render PanelLoadingState("Loading file…")}
      {:else if inlineFile.error}
        <div class="m-4 flex items-start gap-2 rounded-md border border-error-soft/30 bg-error-bg p-3 text-sm text-error-soft">
          {inlineFile.error}
        </div>
      {:else if inlineFile.tooLarge}
        <div class="flex flex-1 items-center justify-center">
          <div class="m-4 rounded-lg border border-warning-soft/30 bg-warning-bg p-6 text-center max-w-sm">
            <div class="text-4xl mb-3">📦</div>
            <div class="text-sm font-semibold text-text-primary mb-1">File too large to preview</div>
            <div class="text-xs text-text-secondary mb-4">This file exceeds 10MB and cannot be opened in the web editor.</div>
            <a href={inlineFileDownloadUrl} download={inlineFileDownloadName} class="action-btn primary" onclick={(e) => { e.preventDefault(); void downloadInlineFile(); }}>
              <Download class="w-3.5 h-3.5" />
              Download file
            </a>
          </div>
        </div>
      {:else if inlineFile.response}
        {#if inlineFileIsText}
          <div class="flex h-11 items-center gap-2 border-b border-border-subtle px-3 shrink-0">
            {#if inlineFileHasRenderedPreview}
              <div class="flex items-center gap-0 rounded-md border border-border-subtle bg-bg-input p-[2px]">
                <button type="button" class="segmented-btn" class:active={inlineFileEdit} onclick={() => inlineFileEdit = true} title="Edit source">Source</button>
                <button type="button" class="segmented-btn" class:active={!inlineFileEdit} onclick={() => inlineFileEdit = false} title={inlineFileIsMarkdown ? "Preview markdown" : "Preview HTML"}>Preview</button>
              </div>
            {/if}
            <div class="flex-1"></div>
            <button type="button" class="icon-btn" onclick={() => void copyInlineFileContent()} title="Copy content">
              {#if inlineFileCopied}<Check class="w-4 h-4 text-success-soft" />{:else}<Copy class="w-4 h-4" />{/if}
            </button>
            {#if !activeFsReadonly}
              <button type="button" class="action-btn" onclick={() => void saveInlineFile()} disabled={inlineFile.saving || !inlineFileDirty || !canEditFiles} title="Save">
                <Save class="w-4 h-4 shrink-0" />
              </button>
            {:else}
              <span class="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-text-tertiary">Read-only snapshot</span>
            {/if}
          </div>
          <div class="flex-1 min-h-0">
            {#if inlineFileEdit}
              {#await import("$lib/components/CodeEditor.svelte") then editorModule}
                {@const LazyCodeEditor = editorModule.default}
                <LazyCodeEditor value={inlineFile.draft} language={inlineFileExt} onInput={(v) => { if (inlineFile) inlineFile.draft = v; }} readonly={!canEditFiles || activeFsReadonly} />
              {:catch}
                <div class="flex h-full items-center justify-center text-[12px] text-error-soft">Editor failed to load.</div>
              {/await}
            {:else if inlineFileHasRenderedPreview}
              {#await import("$lib/components/RenderedFilePreview.svelte") then previewModule}
                {@const LazyRenderedFilePreview = previewModule.default}
                <LazyRenderedFilePreview
                  name={inlineFile.response.name}
                  source={inlineFile.draft}
                  type={inlineFileIsMarkdown ? "markdown" : "html"}
                />
              {:catch}
                <div class="flex h-full items-center justify-center text-[12px] text-error-soft">Preview failed to load.</div>
              {/await}
            {:else}
              {#await import("$lib/components/CodeEditor.svelte") then editorModule}
                {@const LazyCodeEditor = editorModule.default}
                <LazyCodeEditor value={inlineFile.draft} language={inlineFileExt} readonly={true} />
              {:catch}
                <div class="flex h-full items-center justify-center text-[12px] text-error-soft">Editor failed to load.</div>
              {/await}
            {/if}
          </div>
        {:else if inlineFileIsImage && inlineFileDataUrl}
          <div class="flex flex-1 items-center justify-center overflow-hidden p-4">
            <img src={inlineFileDataUrl} alt={inlineFile.response.name} class="max-h-full max-w-full rounded-md" />
          </div>
        {:else if inlineFileIsVideo && inlineFileDataUrl}
          <div class="flex flex-1 items-center justify-center p-4">
            <video src={inlineFileDataUrl} controls class="max-h-full max-w-full rounded-md">
              <track kind="captions" />
            </video>
          </div>
        {:else}
          <div class="m-4 rounded-md border border-border-subtle bg-bg-primary p-4 text-sm text-text-secondary">
            <div><strong>Name:</strong> {inlineFile.response.name}</div>
            <div><strong>Type:</strong> {inlineFile.response.mimeType ?? 'application/octet-stream'}</div>
            <div><strong>Size:</strong> {formatFileSize(inlineFile.response.size)}</div>
            <div class="mt-3 text-text-tertiary">This file type cannot be previewed in the browser.</div>
            <div class="mt-3">
              <a href={inlineFileDownloadUrl} download={inlineFileDownloadName} class="action-btn primary" onclick={(e) => { e.preventDefault(); void downloadInlineFile(); }}>
                <Download class="w-3.5 h-3.5" />
                Download file
              </a>
            </div>
          </div>
        {/if}
      {:else}
        <div class="flex-1 flex items-center justify-center text-sm text-text-tertiary">No file selected</div>
      {/if}
    </div>
    <!-- Desktop side panel -->
    <WorkspacePreviewPane
      desktopOnly={true}
      width={previewPanelWidth}
      ariaLabel="File preview"
      onResizeStart={beginPreviewPanelResize}
    >
      <div class="flex h-full min-w-0 flex-col bg-bg-content">
        {#if inlineFile.loading}
          <div class="flex h-10 items-center border-b border-border-subtle px-3 shrink-0">
            <span class="flex-1 truncate text-xs text-text-secondary">{inlineFile.path}</span>
            {@render FileHeaderCoreActions(inlineFile.path)}
            {@render PreviewFocusButton()}
            <button type="button" class="icon-btn" onclick={closeInlineFile} title="Close file">
              <X class="w-4 h-4" />
            </button>
          </div>
          {@render PanelLoadingState("Loading file…")}
        {:else if inlineFile.error}
          <div class="flex h-10 items-center border-b border-border-subtle px-3 shrink-0">
            <span class="flex-1 truncate text-xs text-text-secondary">{inlineFile.path}</span>
            {@render FileHeaderCoreActions(inlineFile.path)}
            {@render PreviewFocusButton()}
            <button type="button" class="icon-btn" onclick={closeInlineFile} title="Close file">
              <X class="w-4 h-4" />
            </button>
          </div>
          <div class="m-4 flex items-start gap-2 rounded-md border border-error-soft/30 bg-error-bg p-3 text-xs text-error-soft">
            {inlineFile.error}
          </div>
        {:else if inlineFile.tooLarge}
          <div class="flex h-10 items-center gap-2 border-b border-border-subtle px-3 shrink-0">
            <span class="flex-1 truncate text-xs text-text-secondary">{inlineFile.path}</span>
            {@render FileHeaderCoreActions(inlineFile.path)}
            <a href={inlineFileDownloadUrl} download={inlineFileDownloadName} class="action-btn" title="Download file" onclick={(e) => { e.preventDefault(); void downloadInlineFile(); }}>
              <Download class="w-3.5 h-3.5 shrink-0" />
              <span class="hidden sm:inline">Download</span>
            </a>
            {@render PreviewFocusButton()}
            <button type="button" class="icon-btn" onclick={closeInlineFile} title="Close file">
              <X class="w-4 h-4" />
            </button>
          </div>
          <div class="flex flex-1 items-center justify-center">
            <div class="m-4 rounded-lg border border-warning-soft/30 bg-warning-bg p-6 text-center max-w-sm">
              <div class="text-4xl mb-3">📦</div>
              <div class="text-sm font-semibold text-text-primary mb-1">File too large to preview</div>
              <div class="text-xs text-text-secondary mb-4">This file exceeds 10MB and cannot be opened in the web editor.</div>
              <a href={inlineFileDownloadUrl} download={inlineFileDownloadName} class="action-btn primary" onclick={(e) => { e.preventDefault(); void downloadInlineFile(); }}>
                <Download class="w-3.5 h-3.5" />
                Download file
              </a>
            </div>
          </div>
        {:else if inlineFile.response}
          {#if inlineFileIsText}
            <div class="flex h-10 items-center gap-1.5 sm:gap-2 border-b border-border-subtle px-2 sm:px-3 shrink-0">
              <div class="min-w-0 flex-1 truncate text-xs sm:text-sm text-text-secondary">
                {inlineFile.response.path}
              </div>
              {@render FileHeaderCoreActions(inlineFile.response.path)}
              {#if inlineFileIsHtml && !inlineFileEdit}
                <button type="button" class="action-btn" onclick={publishInlineFile} title="Publish work">
                  <Rocket class="w-3.5 h-3.5 shrink-0" />
                  <span class="hidden sm:inline">Publish</span>
                </button>
              {/if}
              {#if inlineFileHasRenderedPreview}
                <div class="flex items-center gap-0 rounded-md border border-border-subtle bg-bg-input p-[2px]">
                  <button
                    type="button"
                    class="segmented-btn"
                    class:active={inlineFileEdit}
                    onclick={() => inlineFileEdit = true}
                    title="Edit source"
                  >
                    Source
                  </button>
                  <button
                    type="button"
                    class="segmented-btn"
                    class:active={!inlineFileEdit}
                    onclick={() => inlineFileEdit = false}
                    title={inlineFileIsMarkdown ? "Preview markdown" : "Preview HTML"}
                  >
                    Preview
                  </button>
                </div>
              {/if}
              <a
                href={inlineFileDownloadUrl}
                download={inlineFileDownloadName}
                class="icon-btn"
                title="Download file"
                onclick={(e) => { e.preventDefault(); void downloadInlineFile(); }}
              >
                <Download class="w-4 h-4" />
              </a>
              <button type="button" class="icon-btn" onclick={() => void copyInlineFileContent()} title="Copy content">
                {#if inlineFileCopied}
                  <Check class="w-4 h-4 text-success-soft" />
                {:else}
                  <Copy class="w-4 h-4" />
                {/if}
              </button>
              <button
                type="button"
                class="action-btn"
                onclick={() => void saveInlineFile()}
                disabled={inlineFile.saving || !inlineFileDirty || !canEditFiles}
                title="Save (Ctrl+S)"
              >
                <Save class="w-3.5 h-3.5 shrink-0" />
                <span class="hidden sm:inline">Save</span>
              </button>
              {@render PreviewFocusButton()}
                <button type="button" class="icon-btn" onclick={closeInlineFile} title="Close file">
                <X class="w-4 h-4" />
              </button>
            </div>
            <div class="flex-1 min-h-0">
              {#if inlineFileEdit}
                {#await import("$lib/components/CodeEditor.svelte") then editorModule}
                  {@const LazyCodeEditor = editorModule.default}
                  <LazyCodeEditor
                    value={inlineFile.draft}
                    language={inlineFileExt}
                    onInput={(v) => { if (inlineFile) inlineFile.draft = v; }}
                    readonly={!canEditFiles}
                  />
                {:catch}
                  <div class="flex h-full items-center justify-center text-[12px] text-error-soft">Editor failed to load.</div>
                {/await}
              {:else if inlineFileHasRenderedPreview}
                {#await import("$lib/components/RenderedFilePreview.svelte") then previewModule}
                  {@const LazyRenderedFilePreview = previewModule.default}
                  <LazyRenderedFilePreview
                    name={inlineFile.response.name}
                    source={inlineFile.draft}
                    type={inlineFileIsMarkdown ? "markdown" : "html"}
                  />
                {:catch}
                  <div class="flex h-full items-center justify-center text-[12px] text-error-soft">Preview failed to load.</div>
                {/await}
              {:else}
                {#await import("$lib/components/CodeEditor.svelte") then editorModule}
                  {@const LazyCodeEditor = editorModule.default}
                  <LazyCodeEditor
                    value={inlineFile.draft}
                    language={inlineFileExt}
                    readonly={true}
                  />
                {:catch}
                  <div class="flex h-full items-center justify-center text-[12px] text-error-soft">Editor failed to load.</div>
                {/await}
              {/if}
            </div>
          {:else if inlineFileIsImage && inlineFileDataUrl}
            <div class="flex h-10 items-center gap-1.5 sm:gap-2 border-b border-border-subtle px-2 sm:px-3 shrink-0">
              <div class="min-w-0 flex-1 truncate text-xs sm:text-sm text-text-secondary">
                {inlineFile.response.path}
              </div>
              <div class="text-xs text-text-tertiary hidden sm:inline">{formatFileSize(inlineFile.response.size)}</div>
              {@render FileHeaderCoreActions(inlineFile.response.path)}
              <button type="button" class="zoom-btn" onclick={() => { inlineFileZoom = Math.max(0.25, inlineFileZoom - 0.25); inlineFilePanX = 0; inlineFilePanY = 0; }} title="Zoom out">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="7" y1="11" x2="15" y2="11"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </button>
              <span class="text-xs text-text-tertiary tabular-nums w-10 text-center">{Math.round(inlineFileZoom * 100)}%</span>
              <button type="button" class="zoom-btn" onclick={() => { inlineFileZoom = Math.min(4, inlineFileZoom + 0.25); inlineFilePanX = 0; inlineFilePanY = 0; }} title="Zoom in">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="11" y1="7" x2="11" y2="15"/><line x1="7" y1="11" x2="15" y2="11"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </button>
              <a
                href={inlineFileDownloadUrl}
                download={inlineFileDownloadName}
                class="icon-btn"
                title="Download file"
                onclick={(e) => { e.preventDefault(); void downloadInlineFile(); }}
              >
                <Download class="w-4 h-4" />
              </a>
              {@render PreviewFocusButton()}
                <button type="button" class="icon-btn" onclick={closeInlineFile} title="Close file">
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
          {:else if inlineFileIsVideo && inlineFileDataUrl}
            <div class="flex h-10 items-center gap-1.5 sm:gap-2 border-b border-border-subtle px-2 sm:px-3 shrink-0">
              <div class="min-w-0 flex-1 truncate text-xs sm:text-sm text-text-secondary">
                {inlineFile.response.path}
              </div>
              <div class="text-xs text-text-tertiary hidden sm:inline">{formatFileSize(inlineFile.response.size)}</div>
              {@render FileHeaderCoreActions(inlineFile.response.path)}
              <a
                href={inlineFileDownloadUrl}
                download={inlineFileDownloadName}
                class="icon-btn"
                title="Download file"
                onclick={(e) => { e.preventDefault(); void downloadInlineFile(); }}
              >
                <Download class="w-4 h-4" />
              </a>
              {@render PreviewFocusButton()}
                <button type="button" class="icon-btn" onclick={closeInlineFile} title="Close file">
                <X class="w-4 h-4" />
              </button>
            </div>
            <div class="flex flex-1 items-center justify-center p-4">
              <video src={inlineFileDataUrl} controls class="max-h-full max-w-full rounded-md">
                <track kind="captions" />
              </video>
            </div>
          {:else}
            <div class="flex h-10 items-center gap-1.5 sm:gap-2 border-b border-border-subtle px-2 sm:px-3 shrink-0">
              <div class="min-w-0 flex-1 truncate text-xs sm:text-sm text-text-secondary">
                {inlineFile.response.path}
              </div>
              <div class="text-xs text-text-tertiary hidden sm:inline">{formatFileSize(inlineFile.response.size)}</div>
              {@render FileHeaderCoreActions(inlineFile.response.path)}
              <a
                href={inlineFileDownloadUrl}
                download={inlineFileDownloadName}
                class="icon-btn"
                title="Download file"
                onclick={(e) => { e.preventDefault(); void downloadInlineFile(); }}
              >
                <Download class="w-4 h-4" />
              </a>
              {@render PreviewFocusButton()}
                <button type="button" class="icon-btn" onclick={closeInlineFile} title="Close file">
                <X class="w-4 h-4" />
              </button>
            </div>
            <div class="m-4 rounded-md border border-border-subtle bg-bg-primary p-4 text-xs text-text-secondary">
              <div><strong>Name:</strong> {inlineFile.response.name}</div>
              <div><strong>Type:</strong> {inlineFile.response.mimeType ?? 'application/octet-stream'}</div>
              <div><strong>Size:</strong> {inlineFile.response.size} bytes</div>
              <div class="mt-3 text-text-tertiary">This file type cannot be previewed in the browser.</div>
            </div>
          {/if}
        {:else}
          <div class="flex-1 flex items-center justify-center text-xs text-text-tertiary">No file selected</div>
        {/if}
      </div>
    </WorkspacePreviewPane>
  {/if}
  {#if inlineCanvas}
    <WorkspacePreviewPane
      width={previewPanelWidth}
      ariaLabel={`Canvas ${inlineCanvas.path}`}
      onResizeStart={beginPreviewPanelResize}
    >
      {#if inlineCanvas.loading}
        <div class="flex h-full min-w-0 flex-col bg-bg-content">
          <div class="flex h-10 items-center border-b border-border-subtle px-3 text-xs text-text-tertiary">Loading canvas…</div>
          <div class="flex flex-1 items-center justify-center text-xs text-text-tertiary">Loading…</div>
        </div>
      {:else if inlineCanvas.error}
        <div class="flex h-full min-w-0 flex-col bg-bg-content">
          <div class="flex h-10 items-center gap-2 border-b border-border-subtle px-3">
            <span class="min-w-0 flex-1 truncate text-xs text-text-secondary">{inlineCanvas.path}</span>
            <button type="button" class="icon-btn" onclick={closeInlineCanvas} title="Close canvas"><X class="w-4 h-4" /></button>
          </div>
          <div class="m-4 rounded-lg border border-error-soft/30 bg-error-bg p-4 text-sm text-error-soft">{inlineCanvas.error}</div>
        </div>
      {:else if inlineCanvas.document}
        {#await import("$lib/components/canvas/CanvasPanel.svelte") then canvasPanelModule}
          {@const LazyCanvasPanel = canvasPanelModule.default}
          <LazyCanvasPanel
            path={inlineCanvas.path}
            document={inlineCanvas.document}
            saving={inlineCanvas.saving}
            focused={previewFocusMode}
            onToggleFocus={isMobile ? undefined : togglePreviewFocusMode}
            onCommit={(document, ops) => commitInlineCanvas(document, ops)}
            onClose={closeInlineCanvas}
          />
        {:catch}
          <div class="flex h-full min-w-0 flex-col bg-bg-content">
            <div class="flex h-10 items-center gap-2 border-b border-border-subtle px-3">
              <span class="min-w-0 flex-1 truncate text-xs text-text-secondary">{inlineCanvas.path}</span>
              <button type="button" class="icon-btn" onclick={closeInlineCanvas} title="Close canvas"><X class="w-4 h-4" /></button>
            </div>
            <div class="m-4 rounded-lg border border-error-soft/30 bg-error-bg p-4 text-sm text-error-soft">Canvas failed to load.</div>
          </div>
        {/await}
      {:else}
        <div class="flex h-full min-w-0 flex-col bg-bg-content">
          <div class="flex h-10 items-center gap-2 border-b border-border-subtle px-3">
            <span class="min-w-0 flex-1 truncate text-xs text-text-secondary">{inlineCanvas.path}</span>
            <button type="button" class="icon-btn" onclick={closeInlineCanvas} title="Close canvas"><X class="w-4 h-4" /></button>
          </div>
          <div class="m-4 rounded-lg border border-error-soft/30 bg-error-bg p-4 text-sm text-error-soft">Canvas data is unavailable.</div>
        </div>
      {/if}
    </WorkspacePreviewPane>
  {/if}
  {#if inlinePortPreview}
    <WorkspacePreviewPane
      width={previewPanelWidth}
      ariaLabel={`Port ${inlinePortPreview.port} preview`}
      onResizeStart={beginPreviewPanelResize}
    >
      <PortPreview
        port={inlinePortPreview.port}
        url={inlinePortEndpoint?.url ?? inlinePortPreview.url}
        status={inlinePortEndpoint?.status ?? "unknown"}
        observedAt={inlinePortEndpoint?.observedAt}
        focused={previewFocusMode}
        onToggleFocus={isMobile ? undefined : togglePreviewFocusMode}
        onPublish={() => openWorkPublish("port", inlinePortPreview!.port)}
        onClose={closeInlinePort}
      />
    </WorkspacePreviewPane>
  {/if}
  <!-- Desktop right sidebar — file tree only -->
  {#if !uiState.rightSidebarCollapsed && !spaceHasMinimalAccess}
    <div class="hidden shrink-0 lg:flex border-l border-border-subtle" style={`width: ${uiState.rightSidebarWidth}px`}>
      <div class="w-full relative">
        <SpaceFileSidebar
          nodes={fileTree}
          selectedPath={selectedFilePath}
          loading={fileTreeLoading}
          error={fileTreeError}
          subtitle={activeFsSidebarSubtitle}
          onToggle={expandDirectory}
          onSelect={(node) => { if (node.type === "file") { if (isCovasFile(node.path)) void openInlineCanvas(node.path); else void openInlineFile(node.path); } }}
          onRefresh={refreshFileTree}
          onCreateFile={handleCreateFile}
          onCreateCanvas={handleCreateCanvas}
          onCreateDir={handleCreateDir}
          onRename={handleRenameNode}
          onDelete={handleDeleteNode}
          onDownload={handleDownloadNode}
          onUpload={handleUploadFiles}
          onInsertReference={insertPathReference}
          onPublishDirectory={(path) => openWorkPublish("directory", path)}
          onOpenPort={(port, url) => openInlinePort(port, url)}
          activePort={inlinePortPreview?.port ?? null}
          draggable={true}
          showItemActions={!activeFsReadonly}
          canWrite={canEditFiles && !activeFsReadonly}
          previewEndpoints={previewEndpoints}
        />
        <FileUploadPane
          {spaceId}
          targetDir={uploadPaneTargetDir}
          files={pendingUploadFiles}
          entries={pendingUploadEntries}
          open={uploadPaneVisible}
          onClose={() => { uploadPaneVisible = false; }}
          onComplete={handleUploadComplete}
        />
        <button
          type="button"
          class="right-sidebar-resize-handle"
          aria-label="Resize files sidebar"
          title="Resize files sidebar"
          onpointerdown={beginRightSidebarResize}
        ></button>
      </div>
    </div>
  {/if}
  <MobileRightDrawer
    dragOffsetPx={uiState.rightDragOffsetPx}
    isDragging={uiState.rightIsDragging}
    isDrawerVisible={isRightDrawerVisible}
  >
    {#if !spaceHasMinimalAccess}
      <SpaceFileSidebar
        nodes={fileTree}
        selectedPath={selectedFilePath}
        loading={fileTreeLoading}
        error={fileTreeError}
        subtitle={activeFsSidebarSubtitle}
        onToggle={expandDirectory}
        onSelect={(node) => { if (node.type === "file") { if (isCovasFile(node.path)) void openInlineCanvas(node.path); else void openInlineFile(node.path); uiState.mobileRightDrawerOpen = false; } }}
        onRefresh={refreshFileTree}
        onCreateFile={handleCreateFile}
        onCreateCanvas={handleCreateCanvas}
        onCreateDir={handleCreateDir}
        onRename={handleRenameNode}
        onDelete={handleDeleteNode}
        onDownload={handleDownloadNode}
        onUpload={handleUploadFiles}
        onInsertReference={insertPathReference}
        onPublishDirectory={(path) => { openWorkPublish("directory", path); uiState.mobileRightDrawerOpen = false; }}
        onOpenPort={(port, url) => { openInlinePort(port, url); uiState.mobileRightDrawerOpen = false; }}
        activePort={inlinePortPreview?.port ?? null}
        draggable={false}
        showItemActions={false}
        canWrite={canEditFiles && !activeFsReadonly}
        previewEndpoints={previewEndpoints}
      />
      <FileUploadPane
        {spaceId}
        targetDir={uploadPaneTargetDir}
        files={pendingUploadFiles}
        entries={pendingUploadEntries}
        open={uploadPaneVisible}
        onClose={() => { uploadPaneVisible = false; }}
        onComplete={handleUploadComplete}
      />
    {/if}
  </MobileRightDrawer>
  <WorkPublishDialog
    open={Boolean(workPublishTarget)}
    {spaceId}
    ownerUsername={space?.ownerProfile?.username ?? (space?.userUuid === authStore.userUuid ? (authStore.profile?.username ?? null) : null)}
    spaceSlug={space?.slug ?? null}
    targetType={workPublishTarget?.targetType ?? "file"}
    targetRef={workPublishTarget?.targetRef ?? ""}
    onSpaceUpdated={(nextSpace) => {
      space = nextSpace;
      cacheSpaceRecordSoon(nextSpace);
      patchCachedSpaceList((items) => items.map((item) => item.id === spaceId ? nextSpace : item));
    }}
    onClose={() => workPublishTarget = null}
  />
  <!-- Share Modal -->
  <Dialog open={showShareModal && !!shareModalSessionId} onClose={() => { showShareModal = false; }} title={hasSessionPermission(shareModalSessionId!) ? 'Session is public' : 'Share session'} maxWidth="380px">
    <div class="p-4 space-y-4">
      {#if hasSessionPermission(shareModalSessionId!)}
        <p class="text-[13px] text-text-secondary leading-relaxed">Anyone with the link can view this session. Choose how to manage access:</p>
        <div class="space-y-2">
          <button
            type="button"
            class="w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-[6px] border border-border-subtle bg-bg-surface hover:bg-bg-hover transition-colors disabled:opacity-50"
            onclick={() => { void removeSessionAccess(shareModalSessionId!); showShareModal = false; }}
            disabled={shareModalSaving}
          >
            <Globe class="w-4 h-4 text-text-tertiary shrink-0 mt-0.5" />
            <div class="min-w-0">
              <div class="text-[13px] text-text-primary font-medium">Remove permission</div>
              <div class="text-[11px] text-text-placeholder mt-0.5 leading-relaxed">Delete this session's access rule.</div>
            </div>
          </button>
          <button
            type="button"
            class="w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-[6px] border border-border-subtle bg-bg-surface hover:bg-bg-hover transition-colors disabled:opacity-50"
            onclick={() => { void makeSessionPrivate(); }}
            disabled={shareModalSaving}
          >
            <Lock class="w-4 h-4 text-text-tertiary shrink-0 mt-0.5" />
            <div class="min-w-0">
              <div class="text-[13px] text-text-primary font-medium">Make private</div>
              <div class="text-[11px] text-text-placeholder mt-0.5 leading-relaxed">Block all external access.</div>
            </div>
          </button>
        </div>
        <button
          type="button"
          class="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-[5px] text-[13px] text-text-secondary hover:text-text-primary border border-border-subtle hover:bg-bg-hover transition-colors disabled:opacity-50"
          onclick={() => {
            const url = `${window.location.origin}${buildSpaceSessionRoute(spaceId, shareModalSessionId!)}`;
            void navigator.clipboard.writeText(url);
            shareCopied = true;
            if (shareCopiedTimer) clearTimeout(shareCopiedTimer);
            shareCopiedTimer = setTimeout(() => { shareCopied = false; }, 2000);
          }}
          disabled={shareModalSaving}
        >
          {#if shareCopied}
            <Check class="w-3.5 h-3.5 text-status-success" />
            Copied
          {:else}
            <Copy class="w-3.5 h-3.5" />
            Copy link
          {/if}
        </button>
      {:else}
        <p class="text-[13px] text-text-secondary leading-relaxed">This session will become publicly accessible. Anyone with the link can view the conversation.</p>
        <button
          type="button"
          class="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-[5px] bg-bg-primary hover:bg-bg-hover-strong border border-border-subtle text-[13px] text-text-primary font-medium transition-colors disabled:opacity-50"
          onclick={() => { void shareAndCopyLink(); }}
          disabled={shareModalSaving}
        >
          {#if shareModalSaving}
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
            Sharing…
          {:else}
            <Share2 class="w-3.5 h-3.5" />
            Share &amp; copy link
          {/if}
        </button>
      {/if}
      {#if shareModalError}
        <div class="text-[12px] text-error-soft break-all">{shareModalError}</div>
      {/if}
    </div>
  </Dialog>
  <ModelSelector
    open={showModelSelector}
    onClose={() => { showModelSelector = false; }}
    onSelect={handleModelSelect}
    models={modelsCatalog ?? []}
    currentModel={activeSessionModel}
    generationModels={generationModelsCatalog ?? []}
    {generationPolicyMode}
    {selectedGenerationModels}
    {generationEnumSelections}
    {generationNumericConstraints}
    {generationBooleanConstraints}
    onGenerationTabOpen={() => { void loadGenerationModelsCatalog(); }}
    onGenerationPolicyModeChange={setGenerationPolicyMode}
    onGenerationModelToggle={setGenerationModelSelected}
    onGenerationEnumValueToggle={setGenerationEnumValueSelected}
    onGenerationNumericConstraintChange={setGenerationNumericConstraint}
    onGenerationBooleanConstraintChange={setGenerationBooleanConstraint}
  />
</div>

{#if labelPickerResource}
	<ResourceLabelPicker
		{spaceId}
		resourceType={labelPickerResource.type}
		resourceRef={labelPickerResource.ref}
		onClose={() => { labelPickerResource = null; }}
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
  .right-sidebar-resize-handle {
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
  .right-sidebar-resize-handle::after {
    content: "";
    position: absolute;
    left: 3px;
    top: 0;
    width: 2px;
    height: 100%;
    background: transparent;
    transition: background-color 120ms ease;
  }
  .right-sidebar-resize-handle:hover::after,
  :global(body.sidebar-resizing) .right-sidebar-resize-handle::after {
    background: var(--border-subtle);
  }
  .inline-panel-resize-handle {
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
  .inline-panel-resize-handle::after {
    content: "";
    position: absolute;
    left: 3px;
    top: 0;
    width: 2px;
    height: 100%;
    background: transparent;
    transition: background-color 120ms ease;
  }
  .inline-panel-resize-handle:hover::after,
  :global(body.sidebar-resizing) .inline-panel-resize-handle::after {
    background: var(--border-subtle);
  }
  .port-ready-toast {
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
  .port-ready-action {
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
  .port-ready-action:hover {
    border-color: var(--border-strong);
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .port-ready-action.primary {
    border-color: color-mix(in srgb, var(--brand) 35%, var(--border-subtle));
    background: color-mix(in srgb, var(--brand) 12%, transparent);
    color: var(--brand);
  }
  .port-ready-action.primary:hover {
    border-color: color-mix(in srgb, var(--brand) 55%, var(--border-subtle));
    background: color-mix(in srgb, var(--brand) 18%, transparent);
  }
  .port-ready-close {
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
  .port-ready-close:hover {
    background: var(--bg-hover);
    color: var(--text-secondary);
  }
  @media (max-width: 640px) {
    .port-ready-toast {
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
    .port-ready-toast {
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
  .icon-btn {
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
  .icon-btn:hover { background: var(--bg-hover); color: var(--text-secondary); }
  .action-btn {
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
  .action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .action-btn.primary {
    background: var(--brand);
    border-color: var(--brand);
    color: var(--brand-contrast-fg);
  }
  .action-btn.primary:hover { opacity: 0.9; }
  .menu-item {
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
  .menu-item:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .toggle-btn {
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
  .toggle-btn:hover { background: var(--bg-hover); color: var(--text-secondary); }
  .toggle-btn.active {
    border-color: var(--border-subtle);
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .segmented-btn {
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
  .segmented-btn:hover { color: var(--text-secondary); }
  .segmented-btn.active {
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-weight: 600;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 1px rgba(0,0,0,0.04);
  }
  .zoom-btn {
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
  .zoom-btn:hover { background: var(--bg-hover); color: var(--text-secondary); }
</style>
