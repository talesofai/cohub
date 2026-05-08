<script lang="ts">
import {
	type CheckpointRecord,
	type CronJobRecord,
	HttpError,
	type PromptTemplateCatalogEntry,
	type SessionRecord,
	type SpaceAccessPolicy,
	type SpaceFsEntry,
	type SpaceFsFileResponse,
	type SpaceMarkListItem,
	type SpaceRecord,
	type SpaceUsageResponse,
	type TaskRunRecord,
} from "@neta-art/cohub";
import type { ContentBlock } from "@neta-art/cohub-protocol/core";
import type {
	MessageToolCallsFile,
	SessionTurnIndexItem,
	SessionTurnRecord,
	StoredIntermediateMessage,
} from "@neta-art/cohub-protocol/model";
import type { SpacePublicEndpoints } from "@neta-art/cohub-protocol/ports";
import type { ChannelEnvelope } from "@neta-art/cohub-protocol/realtime";
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
	Eye,
	FileText,
	FolderKanban,
	GitCommitHorizontal,
	Globe,
	Link,
	ListTree,
	Loader2,
	Lock,
	MessageSquare,
	MoreHorizontal,
	Network,
	PanelLeftClose,
	PanelRightClose,
	PanelRightOpen,
	Pencil,
	Pin,
	PinOff,
	Plus,
	Power,
	PowerOff,
	RefreshCw,
	Save,
	Settings,
	Share2,
	Terminal,
	Trash2,
	X,
} from "lucide-svelte";
import { onDestroy, onMount, tick, untrack } from "svelte";
import { goto } from "$app/navigation";
import { sessionTurnsRepo } from "$lib/cache/repositories/session-turns-repo";
import { spaceFsRepo } from "$lib/cache/repositories/space-fs-repo";
import { spaceRecordRepo } from "$lib/cache/repositories/space-record-repo";
import { pollCheckpointJob } from "$lib/checkpoints";
import ChatTimeline from "$lib/components/ChatTimeline.svelte";
import CodeEditor from "$lib/components/CodeEditor.svelte";
import Dialog from "$lib/components/Dialog.svelte";
import FileUploadPane from "$lib/components/FileUploadPane.svelte";
import MarkdownView from "$lib/components/MarkdownView.svelte";
import MobileRightDrawer from "$lib/components/MobileRightDrawer.svelte";
import ModelSelector from "$lib/components/ModelSelector.svelte";
import PageHeader from "$lib/components/PageHeader.svelte";
import PortPreview from "$lib/components/PortPreview.svelte";
import SessionComposer from "$lib/components/SessionComposer.svelte";
// SettingsOverlay removed — settings merged inline into detail page
import SpaceFileSidebar from "$lib/components/SpaceFileSidebar.svelte";
import TurnBottomSheet from "$lib/components/TurnBottomSheet.svelte";
import TurnRail from "$lib/components/TurnRail.svelte";
import WorkspacePreviewPane from "$lib/components/WorkspacePreviewPane.svelte";
import { sdk } from "$lib/sdk";
import type { TimelineItem } from "$lib/session-tree";
import { buildTurnTimelineItems } from "$lib/session-turn-render";
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
	buildSpaceTaskRoute,
} from "$lib/space-routes";
import { authStore } from "$lib/stores/auth.svelte";
import { insertComposerSnippet } from "$lib/stores/composer-insert";
import { sessionGenerationStore } from "$lib/stores/session-generation.svelte";
import {
	applyRealtimeGenerationSnapshot,
	buildStreamingStoredIntermediateMessages,
	clearGenerationError,
	completeGeneration,
	failGeneration,
	replaceGenerationTurnId,
	startGenerationRequest,
} from "$lib/stores/session-generation-controller";
import { applyGenerationRealtimeEnvelope } from "$lib/stores/session-generation-realtime";
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
	getCachedSpaceFsDirMeta,
	patchCachedSpaceFsDir,
} from "$lib/stores/space-fs-cache";
import {
	getCachedSpacePins,
	onSpacePinsCacheUpdated,
} from "$lib/stores/space-marks-cache";
import {
	fetchSpacePins,
	getPinnedFilePaths,
	isSpacePin,
	toggleSpacePin,
} from "$lib/stores/space-pins";
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
import type { LocalUploadEntry } from "$lib/upload-entries";

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
type ComposerImageAttachment = {
	id: string;
	name: string;
	mediaType: string;
	data: string;
	previewUrl: string;
	size: number;
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
type SessionViewState = {
	session: SessionRecord | undefined;
	turns: SessionTurnRecord[];
	loading: boolean;
	loaded: boolean;
	error: string;
	hasMore: boolean;
	hasMoreNewer: boolean;
	loadingOlder: boolean;
	oldestCursor: number | undefined;
};
const MAX_IMAGE_EDGE = 2160;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const WEBP_QUALITIES = [0.88, 0.82, 0.76, 0.7, 0.62, 0.54];
const PRELOAD_THRESHOLD = 10;
const TURN_SCROLL_ANCHOR_OFFSET = 16;
const props = $props();
const data = $derived((props as Props).data);
const spaceId = $derived(data.spaceId);
const routeView = $derived(data.view);
const routeSessionId = $derived(data.sessionId ?? null);
const routeFilePath = $derived(data.filePath ?? null);
const routeCheckpointId = $derived(data.checkpointId ?? null);
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
const fileMode = $derived<"chat" | "file">(
	routeView === "file" ? "file" : "chat",
);
const isRightDrawerVisible = $derived(
	uiState.rightIsDragging || uiState.mobileRightDrawerOpen,
);
let space = $state<SpaceRecord | null>(null);
// True when the backend returned only minimal info (session-level access only)
const spaceHasMinimalAccess = $derived(space?.accessLevel === "minimal");
let spaceSessions = $state<SessionRecord[]>([]);
let sessionStateById = $state<Record<string, SessionViewState>>({});
let activeSessionId = $state<string | null>(null);
let input = $state("");
let imageAttachments = $state<ComposerImageAttachment[]>([]);
let sending = $state(false);
let spaceLoadError = $state("");
let renamingSpace = $state(false);
let renameInput = $state("");
let renameSaving = $state(false);
let renameError = $state("");
// Session rename (header inline edit)
let sessionRenaming = $state(false);
let sessionRenameValue = $state("");
let sessionRenameSaving = $state(false);
let sessionRenameInputEl: HTMLInputElement | null = $state(null);
let composerError = $state("");
let modelsCatalog = $state<Array<{
	provider: string;
	id: string;
	model: Record<string, unknown>;
}> | null>(null);
let promptTemplates = $state<PromptTemplateCatalogEntry[]>([]);
let promptTemplatesLoaded = $state(false);
let showModelSelector = $state(false);
let resourceActionMenuOpen = $state(false);
let fileActionMenuOpenPath = $state<string | null>(null);
let sessionModelById = $state<Record<string, SelectedModel | null>>({});
let fileTree = $state<SpaceFsNode[]>([]);
let pinnedMarks = $state<SpaceMarkListItem[]>([]);
let pinnedFilePaths = $state<Set<string>>(new Set());
let fileTreeLoading = $state(false);
let fileTreeError = $state<string | null>(null);
let fileTreeRequestToken = $state(0);
let previewEndpoints = $state<SpacePublicEndpoints>({});
let inlinePortPreview = $state<InlinePortPreview | null>(null);
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
const selectedFilePath = $derived(inlineFile?.path ?? routeFilePath ?? "");
const inlineFileDirty = $derived(
	Boolean(
		inlineFile &&
			inlineFile.response?.kind === "text" &&
			inlineFile.draft !== inlineFile.response.content,
	),
);
const inlineFileIsMarkdown = $derived(
	Boolean(
		inlineFile?.response?.kind === "text" &&
			/\.md$/i.test(inlineFile.response.path),
	),
);
const inlineFileExt = $derived.by(() => {
	if (!inlineFile || inlineFile.response?.kind !== "text") return "plaintext";
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
	if (!inlineFile || inlineFile.response?.kind !== "binary") return null;
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
	inlinePortPreview ? "port" : inlineFile ? "file" : null,
);
let inlineFileEdit = $state(true);
function shouldOpenFileInEditMode(file: SpaceFsFileResponse) {
	return !(file.kind === "text" && /\.md$/i.test(file.path));
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
let gitRepoCopied = $state(false);
let gitRepoCopiedTimer: ReturnType<typeof setTimeout> | null = null;
let previewPanelWidth = $state(480);
let previewPanelResizeCleanup: (() => void) | null = null;
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
	Boolean(openFile?.kind === "text" && /\.md$/i.test(openFile.path)),
);
const openFileExt = $derived.by(() => {
	if (!openFile || openFile.kind !== "text") return "plaintext";
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
	if (!openFile || openFile.kind !== "binary") return null;
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
let lastTurnIndexRefreshKey = "";
let refreshSessionsListInFlight: Promise<void> | null = null;
let refreshSessionsListQueued = false;
let refreshSessionsListQueuedForce = false;
let reconnectSyncInFlight: Promise<void> | null = null;
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
// ─── Token Usage ───
type TokenUsageData = SpaceUsageResponse;
let tokenUsage = $state<TokenUsageData | null>(null);

// ─── Heatmap helpers ───
type HeatmapCell = { date: string; tokens: number; dayOfWeek: number };
function buildHeatmapWeeks(
	hourlyStats: TokenUsageData["hourly"],
	days: number,
): HeatmapCell[][] {
	const dateTotals = new Map<string, number>();
	for (const stat of hourlyStats) {
		const d = new Date(stat.bucketStartAt);
		const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
		dateTotals.set(key, (dateTotals.get(key) ?? 0) + (stat.totalTokens ?? 0));
	}
	const today = new Date();
	today.setUTCHours(0, 0, 0, 0);
	const grid: HeatmapCell[] = [];
	for (let i = days - 1; i >= 0; i--) {
		const d = new Date(today.getTime() - i * 86400000);
		const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
		grid.push({
			date: key,
			tokens: dateTotals.get(key) ?? 0,
			dayOfWeek: d.getUTCDay(),
		});
	}
	const weeks: HeatmapCell[][] = [];
	for (let i = 0; i < grid.length; i += 7) weeks.push(grid.slice(i, i + 7));
	return weeks;
}
function heatmapIntensity(tokens: number, maxTokens: number): number {
	if (maxTokens === 0 || tokens === 0) return 0;
	return Math.min(
		4,
		Math.round((Math.log1p(tokens) / Math.log1p(maxTokens)) * 4),
	);
}
function heatmapLevelClass(level: number): string {
	return `heatmap-${level}`;
}
function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}
function formatCost(n: number): string {
	const formatted =
		n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n.toFixed(4);
	return `$${formatted}`;
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
async function loadTokenUsage() {
	try {
		const result = await sdk.space(spaceId).usage.get(30);
		tokenUsage = result;
	} catch {
		// Non-blocking
	}
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
	checkpointDetailLoading = true;
	checkpointDetailError = "";
	try {
		const result = await sdk.space(spaceId).checkpoints.get(checkpointId);
		checkpointDetail = result.checkpoint;
	} catch (error) {
		checkpointDetail = null;
		checkpointDetailError =
			error instanceof Error ? error.message : "Failed to load save";
	} finally {
		checkpointDetailLoading = false;
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
		checkpointCreateError =
			error instanceof Error ? error.message : "Failed to save checkpoint";
	} finally {
		checkpointCreateSubmitting = false;
	}
}
// ─── Cronjob detail & actions ───
async function loadCronjobDetail(cronjobId: string) {
	cronjobDetailLoading = true;
	cronjobDetailError = "";
	cronjobToggleError = "";
	try {
		const { jobs } = await sdk.cronJobs.list(spaceId);
		const job = jobs.find((j) => j.id === cronjobId) ?? null;
		if (!job) {
			cronjobDetail = null;
			cronjobDetailError = "Scheduled job not found";
			return;
		}
		cronjobDetail = job;
		const { runs } = await sdk.cronJobs.runs(cronjobId);
		cronjobRuns = runs;
	} catch (error) {
		cronjobDetail = null;
		cronjobDetailError =
			error instanceof Error ? error.message : "Failed to load scheduled job";
	} finally {
		cronjobDetailLoading = false;
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
	if (cronParts.length < 5 || cronParts.length > 6) {
		cronjobNewError =
			"Invalid cron expression format. Expected 5 or 6 space-separated fields.";
		return;
	}
	cronjobNewError = "";
	cronjobNewSubmitting = true;
	try {
		await sdk.cronJobs.create({
			title: cronjobNewTitle.trim(),
			taskType: "send_message",
			payload: {
				content: [{ type: "text", text: cronjobNewPrompt.trim() }],
			},
			cronExpression: cronjobNewExpression.trim(),
			spaceId,
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
async function loadTaskDetail(taskId: string) {
	taskRunDetailLoading = true;
	taskRunDetailError = "";
	try {
		const { run } = await sdk.tasks.get(taskId);
		taskRunDetail = run;
	} catch (error) {
		taskRunDetail = null;
		taskRunDetailError =
			error instanceof Error ? error.message : "Failed to load task run";
	} finally {
		taskRunDetailLoading = false;
	}
}
function openShareModal(sessionId: string) {
	shareModalSessionId = sessionId;
	showShareModal = true;
	shareCopied = false;
	shareModalError = "";
}
async function shareAndCopyLink() {
	if (!shareModalSessionId) return;
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
	if (!shareModalSessionId) return;
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
const bootstrapSourceLabel = $derived.by(() => {
	const source = bootstrapMeta?.source;
	if (!source || typeof source !== "object" || Array.isArray(source))
		return "Blank";
	const type = (source as Record<string, unknown>).type;
	if (type === "git_repo") return "Git Repo";
	if (type === "checkpoint") return "Checkpoint";
	return "Blank";
});
const bootstrapStatusTone = $derived.by(() => {
	if (bootstrapStatus === "failed")
		return "text-error-soft border-error-soft/20 bg-error-soft/8";
	if (bootstrapStatus === "ready")
		return "text-success-soft border-success-soft/20 bg-success-soft/8";
	return "text-text-secondary border-border-subtle bg-bg-surface";
});
const gitSshUrl = $derived.by(() => {
	const info = space?.gitInfo;
	const repoName = space?.storageRepoName;
	if (!info || !repoName) return null;
	return `git@${info.giteaHost}:${info.giteaUsername}/${repoName}.git`;
});
async function handleCopyGitUrl() {
	if (!gitSshUrl) return;
	await navigator.clipboard.writeText(gitSshUrl);
	gitRepoCopied = true;
	if (gitRepoCopiedTimer) clearTimeout(gitRepoCopiedTimer);
	gitRepoCopiedTimer = setTimeout(() => {
		gitRepoCopied = false;
	}, 1800);
}
const canCreateSession = $derived(Boolean(space && !creatingSession));
const firstCatalogModel = $derived(
	modelsCatalog && modelsCatalog.length > 0
		? {
				provider: modelsCatalog[0].provider,
				id: modelsCatalog[0].id,
				name: modelsCatalog[0].model.name as string | undefined,
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
						truncatedStart: activeGenerationState.truncatedStart,
						status: activeGenerationState.status,
					}
				: null,
	});
});
function turnToIndexItem(turn: SessionTurnRecord): SessionTurnIndexItem {
	return {
		id: turn.id,
		sessionId: turn.sessionId,
		sequence: turn.sequence,
		status: turn.status,
		startedAt: turn.startedAt,
		completedAt: turn.completedAt,
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
function ensureSessionModelLoaded(sessionId: string) {
	if (sessionModelById[sessionId]) return;
	sessionModelById = {
		...sessionModelById,
		[sessionId]: loadSessionModel(sessionId),
	};
}
async function loadModelsCatalog() {
	if (modelsCatalog) return;
	try {
		const catalog = await sdk.models.list();
		const items: Array<{
			provider: string;
			id: string;
			model: Record<string, unknown>;
		}> = [];
		for (const entries of Object.values(catalog)) {
			for (const entry of entries) items.push(entry);
		}
		modelsCatalog = items;
	} catch (error) {
		console.error("Failed to load models catalog:", error);
	}
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
}
function navigateToSession(
	sessionId: string,
	options?: { replaceState?: boolean },
) {
	void goto(buildSpaceSessionRoute(spaceId, sessionId), {
		replaceState: options?.replaceState ?? true,
		keepFocus: true,
		noScroll: true,
	});
}
function updateUrlSession(sessionId: string | null) {
	if (sessionId) {
		navigateToSession(sessionId, { replaceState: true });
		return;
	}
	void goto(buildSpaceDetailRoute(spaceId), {
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
		state.turns.findLast((turn) => turn.status !== "running") ?? null;
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
	fileTree = makeFsNodes(entries);
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
	fileTree = replaceNodeChildren(fileTree, dirPath, makeFsNodes(nextEntries));
	return nextEntries;
}
function makeFsNodes(entries: SpaceFsEntry[]): SpaceFsNode[] {
	return entries.map(makeFsNode);
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
				children,
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
function applySessionsSnapshot(sessions: SessionRecord[]) {
	spaceSessions = sessions;
	const nextState: Record<string, SessionViewState> = {};
	for (const session of sessions) {
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
					const result = await sdk.space(spaceId).sessions.list();
					return result.sessions ?? [];
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
	const previous = previewEndpoints;
	try {
		const result = await sdk.space(spaceId).sandbox.ports();
		const next = result.endpoints ?? {};
		previewEndpoints = next;
		maybeAutoOpenPortPreview(previous, next);
	} catch {
		const next = extractPublicEndpoints(space);
		previewEndpoints = next;
		maybeAutoOpenPortPreview(previous, next);
	}
}

function maybeAutoOpenPortPreview(
	previous: SpacePublicEndpoints,
	next: SpacePublicEndpoints,
	changedPorts?: string[],
) {
	if (!pageMounted || activePreviewKind || routeView === "file") return;
	if (spaceHasMinimalAccess) return;
	const entries = (
		changedPorts?.length
			? changedPorts.map((port) => [port, next[port]] as const)
			: Object.entries(next)
	).filter(([, endpoint]) => endpoint?.status === "listening" && endpoint.url);
	for (const [port, endpoint] of entries) {
		const previousStatus = previous[port]?.status;
		const becameListening = previousStatus !== "listening";
		if (!becameListening || !endpoint?.url) continue;
		openInlinePort(port, endpoint.url, { autoOpened: true });
		return;
	}
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
	maybeAutoOpenPortPreview(previous, next, changedPorts);
}

async function loadSpace() {
	spaceLoadError = "";
	try {
		const nextSpace = await sdk.space(spaceId).get();
		space = nextSpace;
		previewEndpoints = extractPublicEndpoints(nextSpace);
		void spaceRecordRepo.set(spaceId, nextSpace).catch(() => undefined);
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
		void spaceRecordRepo.set(spaceId, nextSpace).catch(() => undefined);
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
		void spaceRecordRepo.set(spaceId, result.space).catch(() => undefined);
		renamingSpace = false;
	} catch (error) {
		renameError =
			error instanceof Error ? error.message : "Failed to rename space";
	} finally {
		renameSaving = false;
	}
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
async function loadSessionState(sessionId: string, force = false) {
	const existing = sessionStateById[sessionId];
	if (loadingSessionIds[sessionId] && !force) return;
	if (existing?.loaded && !force) return;
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
			oldestCursor: currentSeed?.oldestCursor ?? existing?.oldestCursor,
		},
	};
	try {
		const response = await sdk
			.space(spaceId)
			.session(sessionId)
			.turns.listPaginated({
				limit: 30,
			});
		const runningTurn = response.turns.findLast(
			(turn) => turn.status === "running",
		);
		if (runningTurn) {
			sessionGenerationStore.resumePending(sessionId, {
				spaceId,
				turnId: runningTurn.id,
				anchorUserMessageId: runningTurn.id,
			});
			await restoreSessionStreamSnapshot(sessionId);
		}
		const snapshot = await sessionTurnsRepo.replaceTail(spaceId, sessionId, {
			session: response.session,
			turns: response.turns,
			hasMore: response.hasMore,
		});
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
				hasMoreNewer: fallback?.hasMoreNewer ?? existing?.hasMoreNewer ?? false,
				loadingOlder: false,
				oldestCursor: fallback?.oldestCursor ?? existing?.oldestCursor,
			},
		};
	} finally {
		loadingSessionIds = { ...loadingSessionIds, [sessionId]: false };
	}
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
	const state = sessionStateById[sessionId];
	loadingTurnSequence = sequence;
	try {
		const response = await sdk.space(spaceId).session(sessionId).turns.window({
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
	} finally {
		loadingTurnSequence = null;
	}
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
async function syncSessionNewer(sessionId: string, _cached: unknown) {
	const state = sessionStateById[sessionId];
	if (!state || state.turns.length === 0) return;
	const newestSeq = state.turns.at(-1)?.sequence;
	if (newestSeq == null) return;
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
	}
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
async function restoreSessionStreamSnapshot(sessionId: string) {
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
		const result = applyRealtimeGenerationSnapshot(sessionId, {
			spaceId: snapshot.spaceId,
			turnId: snapshot.turnId,
			seq: snapshot.seq,
			anchorUserMessageId: snapshot.anchorUserMessageId,
			current: snapshot.current,
			intermediateMessages: snapshot.intermediateMessages,
		});
		return result.applied;
	} catch (error) {
		console.warn(
			"[restoreSessionStreamSnapshot] Failed to restore stream snapshot:",
			error,
		);
		return false;
	}
}
async function reconcileSessionTail(sessionId: string) {
	const state = sessionStateById[sessionId];
	if (!state?.session) return;
	try {
		const response = await sdk
			.space(spaceId)
			.session(sessionId)
			.turns.listPaginated({
				limit: 30,
			});
		const snapshot = await sessionTurnsRepo.replaceTail(spaceId, sessionId, {
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
				loading: false,
				loaded: true,
				error: "",
				loadingOlder: false,
				oldestCursor: snapshot.oldestSequence ?? undefined,
			},
		};
	} catch (error) {
		console.warn(
			"[reconcileSessionTail] Failed to reconcile session tail:",
			error,
		);
	}
}
const recoveryCoordinator = new SessionRecoveryCoordinator({
	isTransportOpen: () => wsConnectionState === "open",
	reconcileSessionTail: (sessionId) => reconcileSessionTail(sessionId),
	refreshSessionsList: () => refreshSessionsList(true),
	onRecovered: () => {
		wsCanRecover = false;
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
				activeState?.turns.findLast((turn) => turn.status !== "running") ??
				activeState?.turns.at(-1);
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
async function handleSpaceFsChanged(payload: ChannelEnvelope) {
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
	const { refreshDirs: dirsToRefresh } = await spaceFsRepo.applyFsChanged(
		spaceId,
		eventPayload as Parameters<typeof spaceFsRepo.applyFsChanged>[1],
	);
	for (const dir of dirsToRefresh) {
		const snapshot = await spaceFsRepo.getDir(spaceId, dir);
		if (!snapshot) continue;
		if (dir === "") updateRootFsEntries(snapshot.entries);
		else
			fileTree = replaceNodeChildren(
				fileTree,
				dir,
				makeFsNodes(snapshot.entries),
			);
	}
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
	for (const dir of dirsToRefresh) {
		if (!dir) continue;
		const node = findFsNode(fileTree, dir);
		if (node?.isOpen) {
			fileTree = updateNodeState(fileTree, dir, (item) => ({
				...item,
				isLoaded: false,
			}));
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
		const targetSessionId =
			typeof payload.sessionId === "string" ? payload.sessionId : null;
		if (!targetSessionId) return;
		if (typeof payload.spaceId === "string" && payload.spaceId !== spaceId) {
			// Keep cross-space generation state warm for the current user, but avoid
			// mutating this space view's turns/list state.
			applyGenerationRealtimeEnvelope(targetSessionId, payload);
			return;
		}
		const currentActiveSessionId = activeSessionId;
		const isActiveSession = targetSessionId === currentActiveSessionId;
		const state = sessionStateById[targetSessionId];
		const generationEffect = applyGenerationRealtimeEnvelope(
			targetSessionId,
			payload,
		);
		if (generationEffect.handled) {
			if (generationEffect.shouldRestoreSnapshot && isActiveSession) {
				void restoreSessionStreamSnapshot(targetSessionId).then((restored) => {
					if (!restored) void reconcileSessionTail(targetSessionId);
				});
			} else if (generationEffect.shouldReconcile && isActiveSession) {
				void reconcileSessionTail(targetSessionId);
			}
			if (generationEffect.shouldRefreshSessions) {
				void refreshSessionsList(true);
			}
			if (
				generationEffect.shouldScroll &&
				isActiveSession &&
				shouldAutoFollow
			) {
				await tick();
				scrollToBottomNow();
			}
			return;
		}
		if (!state) {
			if (payload.type === "session.turn.finalized")
				completeGeneration(targetSessionId);
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
				void sdk
					.space(spaceId)
					.session(targetSessionId)
					.turns.get(turnId)
					.then(async (response) => {
						const current = sessionStateById[targetSessionId];
						if (!current) return;
						const snapshot = await sessionTurnsRepo.mergeTurns(
							spaceId,
							targetSessionId,
							[response.turn],
							{
								session: response.session ?? current.session ?? null,
								source: "network",
							},
						);
						sessionStateById = {
							...sessionStateById,
							[targetSessionId]: {
								...current,
								session: snapshot.session ?? current.session,
								turns: snapshot.turns,
							},
						};
						if (payload.type === "session.turn.finalized") {
							completeGeneration(targetSessionId);
						}
					})
					.catch((error) =>
						console.warn("[turn.event] Failed to load full turn:", error),
					);
			}
			if (isActiveSession && shouldAutoFollow) {
				await tick();
				scrollToBottomNow();
			}
			return;
		}
		return;
	} catch (error) {
		console.error("[WS] handleWsEvent error:", error);
	}
}
async function handleSend() {
	if (
		!activeSessionState?.session ||
		(!input.trim() && imageAttachments.length === 0) ||
		sending ||
		!space
	)
		return;
	sending = true;
	composerError = "";
	clearGenerationError(activeSessionId);
	const text = input.trim();
	const attachmentBlocks: ContentBlock[] = imageAttachments.map(
		(attachment) => ({
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
		}),
	);
	const content: ContentBlock[] = [
		...attachmentBlocks,
		...(text ? [{ type: "text", text } satisfies ContentBlock] : []),
	];
	const sessionId = activeSessionState.session.id;
	const optimisticTurnId = crypto.randomUUID();
	const currentUser = {
		uuid: authStore.userUuid ?? null,
		profile: authStore.profile,
	};
	// Clear input immediately so it disappears from the composer at the same
	// time the optimistic turn appears in the list — avoids the awkward "stuck"
	// feeling where the message shows in the list but lingers in the input.
	const pendingInput = input;
	const pendingAttachments = imageAttachments;
	input = "";
	imageAttachments = [];
	try {
		const model = activeSessionModel;
		const now = new Date().toISOString();
		const sequenceHint = (activeSessionState?.turns.at(-1)?.sequence ?? 0) + 1;
		const optimisticTurn = {
			id: optimisticTurnId,
			sessionId,
			userUuid: currentUser.uuid,
			sequence: sequenceHint,
			status: "running",
			intent: "steer",
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
				authorUuid: currentUser.uuid,
			},
			authorProfile: currentUser.profile,
			startedAt: now,
			completedAt: null,
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
		void sessionTurnsRepo.mergeTurns(spaceId, sessionId, [optimisticTurn], {
			session: activeSessionState.session,
		});
		startGenerationRequest(sessionId, { spaceId, turnId: optimisticTurnId });
		const sendResult = await sdk
			.space(spaceId)
			.session(sessionId)
			.messages.send({
				content,
				model: model?.id,
				provider: model?.provider,
			});
		if (sendResult.turnId) {
			replaceGenerationTurnId(sessionId, {
				previousTurnId: optimisticTurnId,
				nextTurnId: sendResult.turnId,
			});
			void sessionTurnsRepo.replaceTurnId(
				spaceId,
				sessionId,
				{
					previousTurnId: optimisticTurnId,
					nextTurnId: sendResult.turnId,
				},
				{ source: "indexeddb" },
			);
			const current = sessionStateById[sessionId];
			if (current) {
				sessionStateById = {
					...sessionStateById,
					[sessionId]: {
						...current,
						turns: current.turns.map((turn) =>
							turn.id === optimisticTurnId
								? {
										...turn,
										id: sendResult.turnId,
										userUuid: currentUser.uuid ?? turn.userUuid,
										meta: {
											...(turn.meta ?? {}),
											optimistic: true,
											authorUuid: currentUser.uuid,
										},
										authorProfile: currentUser.profile ?? turn.authorProfile,
									}
								: turn,
						),
					},
				};
			}
			void sdk
				.space(spaceId)
				.session(sessionId)
				.turns.get(sendResult.turnId)
				.then(async (response) => {
					const latest = sessionStateById[sessionId];
					if (!latest) return;
					const snapshot = await sessionTurnsRepo.mergeTurns(
						spaceId,
						sessionId,
						[response.turn],
						{
							session: response.session ?? latest.session ?? null,
							source: "network",
						},
					);
					sessionStateById = {
						...sessionStateById,
						[sessionId]: {
							...latest,
							session: snapshot.session ?? latest.session,
							turns: snapshot.turns,
						},
					};
				})
				.catch((error) =>
					console.warn("[send] Failed to refresh created turn:", error),
				);
		}
		if (wsConnectionState !== "open") {
			void recoveryCoordinator
				.reconcileAfterSendWhileOffline(sessionId)
				.then(() => {
					completeGeneration(sessionId);
				})
				.catch(() => undefined);
			recoveryCoordinator.scheduleFallbackSync(sessionId);
		}
	} catch (error) {
		// Restore input and attachments on failure so user doesn't lose their message
		input = pendingInput;
		imageAttachments = pendingAttachments;
		const sendError =
			error instanceof Error ? error.message : "Failed to send message";
		failGeneration(sessionId, sendError);
		const current = sessionStateById[sessionId];
		if (current) {
			sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					...current,
					turns: current.turns.filter((turn) => turn.id !== optimisticTurnId),
				},
			};
		}
		await loadSessionState(sessionId, true).catch(() => undefined);
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
		requestAnimationFrame(() => scrollToBottomNow());
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
async function canvasToWebpBlob(
	canvas: HTMLCanvasElement,
	quality: number,
): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (blob) resolve(blob);
				else reject(new Error("Failed to encode image"));
			},
			"image/webp",
			quality,
		);
	});
}
async function compressImageFile(file: File) {
	const image = await loadImageElement(file);
	const longestEdge = Math.max(image.naturalWidth, image.naturalHeight);
	const scale = longestEdge > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / longestEdge : 1;
	const width = Math.max(1, Math.round(image.naturalWidth * scale));
	const height = Math.max(1, Math.round(image.naturalHeight * scale));
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Canvas is not supported");
	context.drawImage(image, 0, 0, width, height);
	let blob = await canvasToWebpBlob(canvas, WEBP_QUALITIES[0]);
	for (const quality of WEBP_QUALITIES.slice(1)) {
		if (blob.size <= MAX_IMAGE_BYTES) break;
		blob = await canvasToWebpBlob(canvas, quality);
	}
	if (blob.size > MAX_IMAGE_BYTES)
		throw new Error("Image is too large after compression");
	const dataUrl = await fileToDataUrl(blob);
	return { blob, dataUrl, mediaType: "image/webp", size: blob.size };
}
async function handlePickImages(files: FileList | File[] | null) {
	if (!files) return;
	const validFiles = Array.from(files).filter((file) =>
		file.type.startsWith("image/"),
	);
	if (validFiles.length === 0) return;
	try {
		const nextAttachments = await Promise.all(
			validFiles.map(async (file) => {
				const compressed = await compressImageFile(file);
				const [, base64 = ""] = compressed.dataUrl.split(",");
				const webpName = file.name.replace(/\.[^.]+$/, "") || file.name;
				return {
					id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
					name: `${webpName}.webp`,
					mediaType: compressed.mediaType,
					data: base64,
					previewUrl: compressed.dataUrl,
					size: compressed.size,
				} satisfies ComposerImageAttachment;
			}),
		);
		imageAttachments = [...imageAttachments, ...nextAttachments];
	} catch (error) {
		composerError =
			error instanceof Error ? error.message : "Failed to read image";
	}
}
function handleRemoveAttachment(id: string) {
	imageAttachments = imageAttachments.filter(
		(attachment) => attachment.id !== id,
	);
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
function beginPreviewPanelResize(event: PointerEvent) {
	event.preventDefault();
	if (window.innerWidth < 1024) return;
	const target = event.currentTarget as HTMLElement | null;
	target?.setPointerCapture?.(event.pointerId);
	previewPanelResizeCleanup?.();
	const startX = event.clientX;
	const startWidth = previewPanelWidth;
	const minMainWidth = 400;
	const onPointerMove = (moveEvent: PointerEvent) => {
		const delta = startX - moveEvent.clientX;
		const maxAllowed = window.innerWidth - minMainWidth - RIGHT_SIDEBAR_MIN;
		const nextWidth = Math.min(Math.max(280, startWidth + delta), maxAllowed);
		previewPanelWidth = nextWidth;
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
async function loadFileTree(force = false) {
	const requestToken = fileTreeRequestToken + 1;
	fileTreeRequestToken = requestToken;
	if (!force) {
		const cached = await getCachedSpaceFsDir(spaceId, "");
		if (cached && cached.length > 0) {
			fileTree = makeFsNodes(cached);
		}
	}
	if (fileTreeLoading && !force) return;
	const shouldShowLoading = fileTree.length === 0 || force;
	if (shouldShowLoading) {
		fileTreeLoading = true;
	}
	fileTreeError = null;
	const cacheMeta = await getCachedSpaceFsDirMeta(spaceId, "");
	const shouldFetch = force || !cacheMeta || cacheMeta.isStale;
	if (!shouldFetch) {
		fileTreeLoading = false;
		return;
	}
	try {
		const entries = await fetchSpaceFsDirWithCache(
			spaceId,
			"",
			async () => {
				const tree = await sdk.space(spaceId).files.list("");
				return tree.entries;
			},
			{ force },
		);
		if (requestToken !== fileTreeRequestToken) return;
		fileTree = makeFsNodes(entries);
	} catch (error) {
		if (requestToken !== fileTreeRequestToken) return;
		fileTreeError =
			error instanceof Error ? error.message : "Failed to load files";
	} finally {
		if (requestToken === fileTreeRequestToken) {
			fileTreeLoading = false;
		}
	}
}
async function expandDirectory(node: SpaceFsNode) {
	if (node.type !== "dir") return;
	if (node.isOpen) {
		fileTree = updateNodeState(fileTree, node.path, (item) => ({
			...item,
			isOpen: false,
		}));
		return;
	}
	if (node.isLoaded) {
		fileTree = updateNodeState(fileTree, node.path, (item) => ({
			...item,
			isOpen: true,
		}));
		return;
	}
	const requestToken = (directoryLoadTokenByPath[node.path] ?? 0) + 1;
	directoryLoadTokenByPath = {
		...directoryLoadTokenByPath,
		[node.path]: requestToken,
	};
	const cached = await getCachedSpaceFsDir(spaceId, node.path);
	if (cached) {
		fileTree = replaceNodeChildren(fileTree, node.path, makeFsNodes(cached));
	}
	if (!cached) {
		fileTree = updateNodeState(fileTree, node.path, (item) => ({
			...item,
			isLoading: true,
			isOpen: true,
		}));
	}
	const cacheMeta = await getCachedSpaceFsDirMeta(spaceId, node.path);
	const shouldFetch = !cacheMeta || cacheMeta.isStale;
	if (!shouldFetch) {
		fileTree = updateNodeState(fileTree, node.path, (item) => ({
			...item,
			isLoading: false,
			isOpen: true,
			isLoaded: true,
		}));
		return;
	}
	try {
		const entries = await fetchSpaceFsDirWithCache(
			spaceId,
			node.path,
			async () => {
				const tree = await sdk.space(spaceId).files.list(node.path);
				return tree.entries;
			},
		);
		if (directoryLoadTokenByPath[node.path] !== requestToken) return;
		fileTree = replaceNodeChildren(fileTree, node.path, makeFsNodes(entries));
	} catch (error) {
		if (directoryLoadTokenByPath[node.path] !== requestToken) return;
		fileTree = updateNodeState(fileTree, node.path, (item) => ({
			...item,
			isLoading: false,
		}));
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
	inlinePortPreview = null;
	openFileLoading = true;
	openFileError = null;
	openFileTooLarge = false;
	try {
		const file = await sdk.space(spaceId).files.read(path);
		fileEdit = shouldOpenFileInEditMode(file);
		openFile = file;
		openFileDraft = file.kind === "text" ? file.content : "";
	} catch (error) {
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
		openFileLoading = false;
	}
}
async function saveOpenFile() {
	if (!openFile || openFile.kind !== "text") return;
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
		await openInlineFile(path);
	} catch (error) {
		fileTreeError =
			error instanceof Error ? error.message : "Failed to create file";
	}
}
async function handleCreateDir(parentPath: string) {
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
	} catch (error) {
		fileTreeError = error instanceof Error ? error.message : "Failed to rename";
	}
}
async function handleDeleteNode(node: SpaceFsNode) {
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
	inlinePortPreview = null;
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
		const file = await sdk.space(spaceId).files.read(path);
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
	inlineFile = null;
}
function openInlinePort(
	port: string,
	url: string,
	options: { autoOpened?: boolean } = {},
) {
	inlineFile = null;
	inlinePortPreview = { port, url, autoOpened: options.autoOpened ?? false };
}
function closeInlinePort() {
	inlinePortPreview = null;
}
async function downloadOpenFile() {
	if (!routeFilePath) return;
	await downloadSpaceFile(spaceId, routeFilePath, openFileDownloadName);
}
async function downloadInlineFile() {
	if (!inlineFile) return;
	await downloadSpaceFile(spaceId, inlineFile.path, inlineFileDownloadName);
}
async function saveInlineFile() {
	if (!inlineFile || inlineFile.response?.kind !== "text") return;
	const savingPath = inlineFile.path;
	markFileSavePending(savingPath);
	inlineFile.saving = true;
	inlineFile.error = null;
	try {
		await sdk.space(spaceId).files.write({
			path: savingPath,
			content: inlineFile.draft,
			encoding: "utf-8",
		});
		inlineFile = {
			...inlineFile,
			response: {
				...inlineFile.response,
				content: inlineFile.draft,
				size: new Blob([inlineFile.draft]).size,
			} as SpaceFsFileResponse,
			error: null,
		};
		await loadFileTree(true);
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
	if (!openFile || openFile.kind !== "text") return;
	await navigator.clipboard.writeText(openFileDraft);
	openFileCopied = true;
	if (openFileCopiedTimer) clearTimeout(openFileCopiedTimer);
	openFileCopiedTimer = setTimeout(() => {
		openFileCopied = false;
	}, 1500);
}
async function copyInlineFileContent() {
	if (!inlineFile || inlineFile.response?.kind !== "text") return;
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
async function loadSpacePins(force = false) {
	const currentSpaceId = spaceId;
	if (!currentSpaceId) return;
	if (!force) {
		const cached = getCachedSpacePins(currentSpaceId);
		if (cached) {
			pinnedMarks = cached;
			pinnedFilePaths = getPinnedFilePaths(cached);
		}
	}
	try {
		const marks = await fetchSpacePins(currentSpaceId, force);
		pinnedMarks = marks;
		pinnedFilePaths = getPinnedFilePaths(marks);
	} catch {
		if (!getCachedSpacePins(currentSpaceId)) {
			pinnedMarks = [];
			pinnedFilePaths = new Set();
		}
	}
}

function insertPathReference(path: string) {
	insertComposerSnippet(` \`${path}\` `);
	uiState.mobileRightDrawerOpen = false;
}

function isActiveSessionPinned() {
	const session = activeSessionState?.session;
	if (!session) return false;
	return isSpacePin(pinnedMarks, "session", session.id);
}

function insertActiveSessionReference() {
	if (!activeSessionId) return;
	insertPathReference(`/sessions/${activeSessionId}.jsonl`);
}

async function togglePinActiveSession() {
	const session = activeSessionState?.session;
	if (!session) return;
	try {
		const marks = await toggleSpacePin({
			spaceId,
			resourceType: "session",
			resourceRef: session.id,
			label: session.title ?? getSessionTitle(session),
		});
		pinnedMarks = marks;
		pinnedFilePaths = getPinnedFilePaths(marks);
	} catch {
		// Pin is host-only; silently ignore for users without permission.
	}
}

function isFilePathPinned(path: string) {
	return pinnedFilePaths.has(path);
}

function insertFilePathReference(path: string) {
	insertPathReference(path);
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

function toggleHeaderPin() {
	const filePath = getHeaderFileActionPath();
	if (filePath) {
		void togglePinFilePath(filePath);
		closeResourceActionMenu();
		return;
	}
	void togglePinActiveSession();
	closeResourceActionMenu();
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

function isHeaderResourcePinned() {
	const filePath = getHeaderFileActionPath();
	if (filePath) return isFilePathPinned(filePath);
	return isActiveSessionPinned();
}

function getHeaderResourceLabel() {
	return getHeaderFileActionPath() ? "file" : "chat";
}

async function togglePinFilePath(path: string) {
	try {
		const marks = await toggleSpacePin({
			spaceId,
			resourceType: "file",
			resourceRef: path,
			label: path.split("/").pop() ?? path,
		});
		pinnedMarks = marks;
		pinnedFilePaths = getPinnedFilePaths(marks);
	} catch {
		// Pin is host-only; silently ignore for users without permission.
	}
}

async function handleForkLatestCheckpoint() {
	const latest = spaceCheckpoints[0];
	if (!latest || !space) return;
	try {
		const result = await sdk.spaces.create({
			name: `${space.name ?? "space"}-fork-${Date.now().toString(36).slice(-4)}`,
			description: space.description ?? undefined,
			source: "web",
			bootstrapSource: { type: "checkpoint", checkpointId: latest.id },
		});
		window.dispatchEvent(new CustomEvent("cohub:space-created"));
		await goto(`/spaces/${result.space.id}`);
	} catch (error) {
		createSessionError =
			error instanceof Error ? error.message : "Failed to fork";
	}
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
			activeSessionId = newSession.id;
			ensureSessionModelLoaded(newSession.id);
			updateUrlSession(newSession.id);
			// New session has no turns yet — skip the unnecessary listPaginated call
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
					oldestCursor: undefined,
				},
			};
			shouldAutoFollow = true;
			await forceScrollToBottom();
		})
		.catch((error) => {
			createSessionError =
				error instanceof Error ? error.message : "Failed to create session";
		})
		.finally(() => {
			creatingSession = false;
		});
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
	const offSessionListCacheUpdated = onSessionListCacheUpdated(
		({ spaceId: updatedSpaceId, sessions }) => {
			if (updatedSpaceId !== spaceId) return;
			applySessionsSnapshot(sessions);
		},
	);
	const offSpacePinsCacheUpdated = onSpacePinsCacheUpdated(
		({ spaceId: updatedSpaceId, marks }) => {
			if (updatedSpaceId !== spaceId) return;
			pinnedMarks = marks;
			pinnedFilePaths = getPinnedFilePaths(marks);
		},
	);
	// Preload models catalog so model selector is ready immediately
	void loadModelsCatalog();
	void loadPromptTemplates();
	const wsConnectionCleanup = sdk.onConnection((state) => {
		const previousState = lastConnectionState;
		lastConnectionState = state.state;
		if (state.state === "open") {
			recoveryCoordinator.onTransportOpen();
			wsConnectionState = "open";
			wsCanRecover = false;
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
	};
	const handleOffline = () => {
		pageOnline = false;
		scheduleStatusRefresh();
	};
	const handleMarksUpdated = (e: Event) => {
		const custom = e as CustomEvent;
		if (custom.detail?.spaceId === spaceId) void loadSpacePins(true);
	};
	const handleOpenInlineFileEvent = (e: Event) => {
		const custom = e as CustomEvent<{ spaceId?: string; path?: string }>;
		if (custom.detail?.spaceId !== spaceId || !custom.detail?.path) return;
		void openInlineFile(custom.detail.path);
	};
	const handleResourceActionMenuKeydown = (e: KeyboardEvent) => {
		if (e.key === "Escape") closeResourceActionMenu();
	};
	const handleResourceActionMenuClickOutside = (e: MouseEvent) => {
		const target = e.target as HTMLElement;
		if (!target.closest("[data-resource-actions]")) closeResourceActionMenu();
	};
	window.addEventListener("visibilitychange", handleVisibility);
	window.addEventListener("online", handleOnline);
	window.addEventListener("offline", handleOffline);
	window.addEventListener("cohub:marks-updated", handleMarksUpdated);
	window.addEventListener("cohub:open-inline-file", handleOpenInlineFileEvent);
	window.addEventListener("keydown", handleFileKeyboardSave);
	window.addEventListener("keydown", handleResourceActionMenuKeydown);
	document.addEventListener("click", handleResourceActionMenuClickOutside);
	scheduleStatusRefresh();
	return () => {
		offSessionListCacheUpdated();
		offSpacePinsCacheUpdated();
		if (checkpointCopiedTimer) clearTimeout(checkpointCopiedTimer);
		if (spaceStatusNoticeTimer) clearTimeout(spaceStatusNoticeTimer);
		if (statusRefreshTimer) clearTimeout(statusRefreshTimer);
		if (turnMarkerMeasureFrame != null)
			cancelAnimationFrame(turnMarkerMeasureFrame);
		recoveryCoordinator.dispose();
		persistSessionScrollAnchorsNow();
		pageMounted = false;
		wsConnectionCleanup();
		window.removeEventListener("visibilitychange", handleVisibility);
		window.removeEventListener("online", handleOnline);
		window.removeEventListener("offline", handleOffline);
		window.removeEventListener("cohub:marks-updated", handleMarksUpdated);
		window.removeEventListener(
			"cohub:open-inline-file",
			handleOpenInlineFileEvent,
		);
		window.removeEventListener("keydown", handleFileKeyboardSave);
		window.removeEventListener("keydown", handleResourceActionMenuKeydown);
		document.removeEventListener("click", handleResourceActionMenuClickOutside);
		rightSidebarResizeCleanup?.();
		previewPanelResizeCleanup?.();
	};
});
// React to space changes: reset state and reload data
$effect(() => {
	const currentSpaceId = spaceId;
	if (!pageMounted || !currentSpaceId || loadedSpaceId === currentSpaceId)
		return;
	loadedSpaceId = currentSpaceId;
	// Reset space-specific state
	space = null;
	spaceLoadError = "";
	spaceSessions = [];
	sessionStateById = {};
	loadingSessionIds = {};
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
	pinnedMarks = [];
	pinnedFilePaths = new Set();
	fileTreeLoading = false;
	fileTreeError = null;
	previewEndpoints = {};
	inlinePortPreview = null;
	openFile = null;
	openFileDraft = "";
	inlineFile = null;
	resourceActionMenuOpen = false;
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
				if (cachedSpace?.space) {
					space = cachedSpace.space;
					previewEndpoints = extractPublicEndpoints(cachedSpace.space);
					hasCachedSpace = true;
				}
				const cachedSnapshot = await getCachedSessionListSnapshot(spaceId);
				const cachedSessions = cachedSnapshot?.sessions;
				if (cachedSessions && cachedSessions.length > 0) {
					seedSessions(cachedSessions);
				}
				if (hasCachedSpace) {
					void loadSpace();
				} else {
					await loadSpace();
				}
				if (spaceId !== currentSpaceId) return;
				void refreshSessionsList(false);
				void loadSpacePins();
				void loadPreviewEndpoints();
				void loadFileTree(true);
				void loadSpaceCheckpoints();
				if (routeView === "space") void loadTokenUsage();
				if (routeView === "session" && routeSessionId) {
					prepareRouteSession(routeSessionId);
					await sessionLoad;
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
/** DEV：与 web 自管 reducer 对照，同一条 WS 上额外挂 session.subscribe 的 patchState */
$effect(() => {
	const currentSpaceId = spaceId;
	const sessionId = activeSessionId;
	if (!import.meta.env.DEV || !pageMounted || !currentSpaceId || !sessionId)
		return;
	const stop = sdk
		.space(currentSpaceId)
		.session(sessionId)
		.subscribe({
			patchState: (result) => {
				console.log("[cohub][sdk:session.subscribe] patchState", {
					spaceId: currentSpaceId,
					sessionId,
					result,
				});
			},
		});
	return stop;
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
				turns: snapshot.turns,
				hasMore: snapshot.hasMoreOlder,
				hasMoreNewer: snapshot.hasMoreNewer,
				oldestCursor: snapshot.oldestSequence ?? undefined,
			},
		};
	});
});
$effect(() => {
	const sessionId = activeSessionId;
	const sequence = routeTurnSequence;
	if (!pageMounted || !sessionId || !sequence) return;
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
	taskRunDetail = null;
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
			scrollToBottomNow();
		}
		prevHeight = currentHeight;
		updateTimelineScrollMetrics();
		updateAutoFollow();
	});
	ro.observe(el);
	return () => ro.disconnect();
});
</script>

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
						void togglePinFilePath(path);
						fileActionMenuOpenPath = null;
					}}
					role="menuitem"
				>
					{#if isFilePathPinned(path)}
						<PinOff class="w-3.5 h-3.5" />
						<span>Unpin file</span>
					{:else}
						<Pin class="w-3.5 h-3.5" />
						<span>Pin file</span>
					{/if}
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
					<FileText class="w-3.5 h-3.5" />
					<span>Insert reference</span>
				</button>
			</div>
		{/if}
	</div>
{/snippet}

<PageHeader>
  {#snippet left()}
    <div class="flex items-center gap-1.5 min-w-0 overflow-hidden">
      {#if routeView === "session" && activeSessionState?.session}
        <button
          type="button"
          class="text-[13px] text-text-primary truncate max-w-[35%] min-w-0 select-none text-left hover:text-text-secondary transition-colors"
          title="Space details"
        >{space?.name || space?.title || spaceId}</button>
        <span class="text-text-tertiary shrink-0 text-[13px] select-none">/</span>
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
                if (e.key === "Enter" && !sessionRenameSaving) {
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
          class="text-[13px] text-text-primary truncate max-w-[35%] select-none text-left hover:text-text-secondary transition-colors"
          title="Space details"
        >{space?.name || space?.title || spaceId}</button>
        <span class="text-text-tertiary shrink-0 text-[13px] select-none">/</span>
        <span class="text-[13px] text-text-secondary truncate">{checkpointDetail.description ? checkpointDetail.description.slice(0, 36) : 'Checkpoint'}</span>
      {:else if routeView === "checkpoint-new"}
        <button
          type="button"
          class="text-[13px] text-text-primary truncate max-w-[35%] select-none text-left hover:text-text-secondary transition-colors"
          title="Space details"
        >{space?.name || space?.title || spaceId}</button>
        <span class="text-text-tertiary shrink-0 text-[13px] select-none">/</span>
        <span class="text-[13px] text-text-secondary truncate">New save</span>
      {:else if routeView === "cronjob" && cronjobDetail}
        <button
          type="button"
          class="text-[13px] text-text-primary truncate max-w-[35%] select-none text-left hover:text-text-secondary transition-colors"
          title="Space details"
        >{space?.name || space?.title || spaceId}</button>
        <span class="text-text-tertiary shrink-0 text-[13px] select-none">/</span>
        <span class="text-[13px] text-text-secondary truncate">{cronjobDetail.title}</span>
      {:else if routeView === "cronjob-new"}
        <button
          type="button"
          class="text-[13px] text-text-primary truncate max-w-[35%] select-none text-left hover:text-text-secondary transition-colors"
          title="Space details"
        >{space?.name || space?.title || spaceId}</button>
        <span class="text-text-tertiary shrink-0 text-[13px] select-none">/</span>
        <span class="text-[13px] text-text-secondary truncate">New cronjob</span>
      {:else if routeView === "task" && taskRunDetail}
        <button
          type="button"
          class="text-[13px] text-text-primary truncate max-w-[35%] select-none text-left hover:text-text-secondary transition-colors"
          title="Space details"
        >{space?.name || space?.title || spaceId}</button>
        <span class="text-text-tertiary shrink-0 text-[13px] select-none">/</span>
        <span class="text-[13px] text-text-secondary truncate">Task run</span>
      {:else}
        <button
          type="button"
          class="text-[13px] text-text-primary truncate select-none text-left hover:text-text-secondary transition-colors"
        >{space?.name || space?.title || spaceId}</button>
      {/if}
    </div>
  {/snippet}
  {#snippet right()}
    <!-- Session Share -->
    {#if activeSessionId}
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
            <button type="button" class="menu-item" onclick={toggleHeaderPin} role="menuitem">
              {#if isHeaderResourcePinned()}
                <PinOff class="w-3.5 h-3.5" />
                <span>Unpin {getHeaderResourceLabel()}</span>
              {:else}
                <Pin class="w-3.5 h-3.5" />
                <span>Pin {getHeaderResourceLabel()}</span>
              {/if}
            </button>
            <button type="button" class="menu-item" onclick={insertHeaderReference} role="menuitem">
              <FileText class="w-3.5 h-3.5" />
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
          onclick={() => {
            if (window.innerWidth < 1024) {
              uiState.mobileRightDrawerOpen = !uiState.mobileRightDrawerOpen;
              return;
            }
            uiState.setRightSidebarCollapsed(!uiState.rightSidebarCollapsed);
          }}
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
<div class="relative flex-1 min-h-0 flex bg-bg-content">
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
                class="inline-flex items-center gap-2 px-3 py-2 rounded-[5px] bg-brand text-white text-[12px] font-medium hover:bg-brand-hover transition-colors disabled:opacity-50"
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
        {#if checkpointDetailLoading}
          <div class="flex items-center gap-3 rounded-md border border-border-subtle bg-bg-surface p-4 text-[13px] text-text-tertiary">
            <Loader2 class="w-4 h-4 animate-spin shrink-0" />
            Loading checkpoint…
          </div>
        {:else if checkpointDetailError}
          <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{checkpointDetailError}</div>
        {:else if checkpointDetail}
          <div class="border border-border-subtle rounded-md bg-bg-surface">
            <!-- Hero section: ID + description -->
            <div class="p-5 space-y-4">
              <div class="space-y-2">
                <div class="text-[10px] uppercase tracking-wider text-text-placeholder font-medium">Checkpoint ID</div>
                <div class="flex items-center gap-3">
                  <div class="font-mono text-[18px] font-semibold text-text-primary tracking-tight break-all leading-snug">{checkpointDetail.id}</div>
                  <button
                    type="button"
                    class="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[5px] border border-border-subtle text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
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
                class="inline-flex items-center gap-2 px-3 py-2 rounded-[5px] bg-brand text-white text-[12px] font-medium hover:bg-brand-hover transition-colors disabled:opacity-50"
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
      <div class="flex-1 min-h-0 overflow-y-auto p-4 max-w-3xl space-y-4">
        {#if cronjobDetailLoading}
          <div class="rounded-md border border-border-subtle bg-bg-surface p-4 text-[12px] text-text-tertiary">
            Loading scheduled job...
          </div>
        {:else if cronjobDetailError}
          <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{cronjobDetailError}</div>
        {:else if cronjobDetail}
          <div class="border border-border-subtle rounded-md bg-bg-surface p-5 space-y-4">
            <div class="space-y-1">
              <div class="text-[10px] uppercase tracking-wider text-text-placeholder font-medium">Scheduled</div>
              <div class="flex items-center gap-3">
                <h1 class="text-[22px] font-semibold text-text-primary tracking-tight break-words">{cronjobDetail.title}</h1>
                <span class="w-2.5 h-2.5 rounded-full shrink-0 {cronjobDetail.enabled ? 'bg-status-running' : 'bg-text-placeholder'}"></span>
              </div>
              <p class="text-[13px] text-text-tertiary">Running in <span class="text-text-primary">{space?.name ?? space?.title ?? spaceId}</span>.</p>
            </div>
            <div class="grid gap-3 md:grid-cols-2">
              <div class="rounded-[6px] border border-border-subtle bg-bg-elevated/40 p-3">
                <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-placeholder font-medium">
                  <Clock class="w-3.5 h-3.5" />
                  Schedule
                </div>
                <div class="mt-2 font-mono text-[14px] text-text-primary">{cronjobDetail.cronExpression}</div>
              </div>
              <div class="rounded-[6px] border border-border-subtle bg-bg-elevated/40 p-3">
                <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-placeholder font-medium">
                  <Clock3 class="w-3.5 h-3.5" />
                  Timezone
                </div>
                <div class="mt-2 text-[13px] text-text-primary">{cronjobDetail.timezone}</div>
              </div>
              <div class="rounded-[6px] border border-border-subtle bg-bg-elevated/40 p-3">
                <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-placeholder font-medium">
                  <Terminal class="w-3.5 h-3.5" />
                  Task Type
                </div>
                <div class="mt-2 text-[13px] text-text-primary">{cronjobDetail.taskType}</div>
              </div>
              <div class="rounded-[6px] border border-border-subtle bg-bg-elevated/40 p-3">
                <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-placeholder font-medium">
                  <Clock3 class="w-3.5 h-3.5" />
                  Created At
                </div>
                <div class="mt-2 text-[13px] text-text-primary">{formatDateTime(cronjobDetail.createdAt)}</div>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="inline-flex items-center gap-1.5 px-3 py-2 rounded-[5px] border border-border-subtle text-[12px] font-medium transition-colors {cronjobDetail!.enabled ? 'text-status-running hover:bg-bg-hover' : 'text-text-tertiary hover:bg-bg-hover'}"
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
                class="inline-flex items-center gap-1.5 px-3 py-2 rounded-[5px] border border-border-subtle text-[12px] font-medium text-text-tertiary hover:text-error-soft hover:bg-bg-hover transition-colors disabled:opacity-50"
                onclick={handleDeleteCronjob}
                disabled={cronjobActionInProgress}
              >
                <Trash2 class="w-3.5 h-3.5" />
                <span>Delete</span>
              </button>
            </div>
            {#if cronjobToggleError}
              <div class="rounded-[6px] border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft">{cronjobToggleError}</div>
            {/if}
            {#if cronjobRuns.length > 0}
              <div class="border-t border-border-subtle pt-4">
                <div class="text-[11px] uppercase tracking-wider text-text-placeholder font-medium mb-3">Recent Runs</div>
                <div class="space-y-2">
                  {#each cronjobRuns.slice(0, 20) as run (run.id)}
                    {@const badge = taskRunStatusBadge(run)}
                    <a
                      href={buildSpaceTaskRoute(spaceId, run.id)}
                      class="flex items-center gap-3 px-3 py-2 rounded-[6px] hover:bg-bg-hover transition-colors"
                      onclick={(e) => { e.preventDefault(); goto(buildSpaceTaskRoute(spaceId, run.id)); }}
                    >
                      <span class="flex items-center gap-2 min-w-[100px]">
                        <span class="w-[6px] h-[6px] rounded-full shrink-0 {badge.dot}"></span>
                        <span class="text-[12px] {badge.color}">{badge.label}</span>
                      </span>
                      <span class="text-[12px] text-text-placeholder font-mono">{formatShortDateTime(run.scheduledAt)}</span>
                      <span class="text-[12px] text-text-placeholder font-mono">{taskRunDuration(run)}</span>
                      {#if run.errorMessage}
                        <span class="text-[11px] text-status-error truncate flex-1" title={run.errorMessage}>{run.errorMessage}</span>
                      {/if}
                    </a>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {:else}
          <div class="rounded-md border border-border-subtle bg-bg-surface p-4 text-[12px] text-text-tertiary">Scheduled job not found.</div>
        {/if}
      </div>
    {:else if routeView === 'task'}
      <div class="flex-1 min-h-0 overflow-y-auto p-4 max-w-3xl space-y-4">
        {#if taskRunDetailLoading}
          <div class="rounded-md border border-border-subtle bg-bg-surface p-4 text-[12px] text-text-tertiary">
            Loading task run...
          </div>
        {:else if taskRunDetailError}
          <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{taskRunDetailError}</div>
        {:else if taskRunDetail}
          {@const badge = taskRunStatusBadge(taskRunDetail)}
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
                <div class="mt-2 text-[13px] text-text-primary">{taskRunDetail.taskType}</div>
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
        {:else}
          <div class="rounded-md border border-border-subtle bg-bg-surface p-4 text-[12px] text-text-tertiary">Task run not found.</div>
        {/if}
      </div>
    {:else if fileMode === 'file'}
      <!-- File Viewer -->
      {#if openFileLoading}
        <div class="flex-1 flex items-center justify-center text-[12px] text-text-tertiary">Loading file…</div>
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
              {#if openFileIsMarkdown}
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
                    title="Preview markdown"
                  >
                    Preview
                  </button>
                </div>
              {/if}
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
                disabled={openFileSaving || !fileDirty}
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
                <CodeEditor
                  value={openFileDraft}
                  language={openFileExt}
                  onInput={(v) => openFileDraft = v}
                />
              {:else if openFileIsMarkdown}
                <MarkdownView source={openFileDraft} variant="document" />
              {:else}
                <CodeEditor
                  value={openFileDraft}
                  language={openFileExt}
                  readonly={true}
                />
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
          <!-- Space Header -->
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0 space-y-1.5">
              <div class="text-[11px] uppercase tracking-[0.18em] text-text-placeholder">Space</div>
              <div class="flex items-center gap-1.5 group">
                {#if renamingSpace}
                  <input
                    type="text"
                    bind:value={renameInput}
                    disabled={renameSaving}
                    class="text-[20px] font-medium text-text-primary bg-bg-input border border-border-subtle rounded-[6px] px-2 py-1 focus:border-brand/40 focus:outline-none transition-colors w-full max-w-xs disabled:opacity-60"
                    onkeydown={(e) => {
                      if (e.key === "Enter" && !renameSaving) {
                        e.preventDefault();
                        const trimmed = renameInput.trim();
                        if (trimmed && trimmed !== space?.name) {
                          void handleRenameSpace(trimmed);
                        } else {
                          renamingSpace = false;
                          renameError = "";
                        }
                      }
                      if (e.key === "Escape" && !renameSaving) {
                        renamingSpace = false;
                        renameError = "";
                      }
                    }}
                  />
                  <button
                    type="button"
                    class="shrink-0 p-1 rounded text-success-soft hover:text-success hover:bg-bg-hover transition-colors disabled:opacity-50"
                    title="Save"
                    disabled={renameSaving}
                    onclick={() => {
                      const trimmed = renameInput.trim();
                      if (trimmed && trimmed !== space?.name) {
                        void handleRenameSpace(trimmed);
                      } else {
                        renamingSpace = false;
                        renameError = "";
                      }
                    }}
                  >
                    {#if renameSaving}
                      <Loader2 class="w-4 h-4 animate-spin" />
                    {:else}
                      <Check class="w-4 h-4" />
                    {/if}
                  </button>
                  <button
                    type="button"
                    class="shrink-0 p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors disabled:opacity-50"
                    title="Cancel"
                    disabled={renameSaving}
                    onclick={() => { renamingSpace = false; renameError = ""; }}
                  >
                    <X class="w-4 h-4" />
                  </button>
                  {#if renameError}
                    <span class="text-[11px] text-status-error ml-1">{renameError}</span>
                  {/if}
                {:else}
                  <h1 class="truncate text-[20px] font-medium text-text-primary">{space?.name || space?.title || spaceId}</h1>
                  <button
                    type="button"
                    class="shrink-0 p-1 rounded text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-text-secondary hover:bg-bg-hover transition-all"
                    title="Rename space"
                    onclick={() => { renameInput = space?.name ?? ""; renamingSpace = true; renameError = ""; }}
                  >
                    <Pencil class="w-3.5 h-3.5" />
                  </button>
                {/if}
              </div>
              {#if space?.description}
                <p class="text-[13px] leading-6 text-text-secondary">{space.description}</p>
              {/if}
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
                <button
                  type="button"
                  class="inline-flex items-center justify-center gap-1.5 rounded-[7px] border px-3 py-2 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 {spaceCheckpoints.length > 0 ? 'border-border-subtle bg-bg-input text-text-secondary hover:text-text-primary hover:bg-bg-hover' : 'border-border-subtle bg-bg-input text-text-tertiary'}"
                  onclick={() => void handleForkLatestCheckpoint()}
                  disabled={spaceCheckpoints.length === 0}
                  title={spaceCheckpoints.length === 0 ? 'No saves yet' : 'Fork latest save'}
                >
                  <GitCommitHorizontal class="w-3.5 h-3.5" />
                  Fork
                </button>
                <button
                  type="button"
                  class="inline-flex items-center justify-center gap-1.5 rounded-[7px] border px-3 py-2 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 {canCreateSession ? 'border-[#FF3E00]/20 bg-[#FF3E00]/10 text-brand hover:bg-[#FF3E00]/15' : 'border-border-subtle bg-bg-input text-text-tertiary'}"
                  onclick={() => handleCreateNewSession()}
                  disabled={!canCreateSession}
                >
                {#if creatingSession}
                  <Loader2 class="w-3.5 h-3.5 animate-spin" />
                  Creating…
                {:else}
                  <Plus class="w-3.5 h-3.5" />
                  New chat
                {/if}
                </button>
              </div>
            {/if}
          </div>
          <!-- Repository -->
          <section class="rounded-[10px] border border-border-subtle bg-bg-surface p-4 sm:p-5 space-y-4">
            {#if gitSshUrl}
              <div>
                <div class="flex items-center gap-2">
                  <GitCommitHorizontal class="w-4 h-4 text-text-tertiary" />
                  <div class="text-[11px] uppercase tracking-[0.16em] text-text-placeholder">Repository</div>
                </div>
                <div class="mt-2 flex items-center gap-2">
                  <code class="flex-1 text-[12px] font-mono text-text-secondary bg-bg-code px-2.5 py-1.5 rounded-[5px] border border-border-subtle truncate select-all">{gitSshUrl}</code>
                  <button
                    type="button"
                    class="shrink-0 p-2 rounded-[5px] border border-border-subtle bg-bg-hover hover:bg-bg-hover-strong text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer"
                    title="Copy SSH URL"
                    onclick={() => void handleCopyGitUrl()}
                  >
                    {#if gitRepoCopied}
                      <Check class="w-4 h-4 text-status-running" />
                    {:else}
                      <Copy class="w-4 h-4" />
                    {/if}
                  </button>
                </div>
              </div>
            {/if}
            {#if bootstrapSourceLabel !== "Blank"}
              {@const source = bootstrapMeta?.source as Record<string, unknown> | undefined}
              <div class="text-[13px] text-text-secondary">
                Source: <span class="text-text-primary">{bootstrapSourceLabel}</span>
                {#if bootstrapSourceLabel === "Git Repo" && source?.repoUrl}
                  <span class="text-text-tertiary ml-1 font-mono text-[11px]">{String(source.repoUrl)}</span>
                {:else if bootstrapSourceLabel === "Checkpoint" && source?.checkpointId}
                  <span class="text-text-tertiary ml-1 font-mono text-[11px]">{String(source.checkpointId).slice(0, 8)}</span>
                {/if}
              </div>
            {/if}
            {#if bootstrapStatus === "failed"}
              <div class="rounded-[6px] border border-error-soft/20 bg-error-soft/8 p-3">
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
          <!-- Token Usage Heatmap -->
          <section class="rounded-[10px] border border-border-subtle bg-bg-surface p-4 sm:p-5">
            <div class="flex items-center justify-between gap-3 mb-4">
              <div class="flex items-center gap-2">
                <Activity class="w-4 h-4 text-text-tertiary" />
                <div>
                  <div class="text-[11px] uppercase tracking-[0.16em] text-text-placeholder">Usage</div>
                  <div class="mt-0.5 text-[15px] font-medium text-text-primary">Token consumption</div>
                </div>
              </div>
              {#if tokenUsage}
                <div class="text-right">
                  <div class="text-[18px] font-semibold text-text-primary tabular-nums">{formatTokenCount(tokenUsage.summary.totalTokens)}</div>
                  <div class="text-[11px] text-text-tertiary">tokens</div>
                </div>
              {/if}
            </div>
            {#if tokenUsage && tokenUsage.hourly.length > 0}
              {@const heatmapWeeks = buildHeatmapWeeks(tokenUsage.hourly, tokenUsage.days)}
              {@const allCells = heatmapWeeks.flat()}
              {@const maxTokens = Math.max(...allCells.map(d => d.tokens), 1)}
              <!-- Heatmap grid -->
              <div class="flex gap-[3px] overflow-x-auto pb-2">
                {#each heatmapWeeks as week (week)}
                  <div class="flex flex-col gap-[3px]">
                    {#each week as cell (cell.date)}
                      {@const level = heatmapIntensity(cell.tokens, maxTokens)}
                      <div
                        class="heatmap-cell {heatmapLevelClass(level)}"
                        title="{cell.date}: {formatTokenCount(cell.tokens)} tokens"
                      ></div>
                    {/each}
                    {#each Array(7 - week.length) as _}
                      <div class="heatmap-cell heatmap-0"></div>
                    {/each}
                  </div>
                {/each}
              </div>
              <!-- Legend -->
              <div class="flex items-center justify-between mt-3 text-[11px] text-text-tertiary">
                <span>Less</span>
                <div class="flex gap-[3px]">
                  <div class="heatmap-cell heatmap-0"></div>
                  <div class="heatmap-cell heatmap-1"></div>
                  <div class="heatmap-cell heatmap-2"></div>
                  <div class="heatmap-cell heatmap-3"></div>
                  <div class="heatmap-cell heatmap-4"></div>
                </div>
                <span>More</span>
              </div>
              <!-- Summary stats -->
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 pt-4 border-t border-border-subtle">
                <div class="text-center">
                  <div class="text-[16px] font-semibold text-text-primary tabular-nums">{tokenUsage.summary.requestCount}</div>
                  <div class="text-[11px] text-text-tertiary mt-0.5">Requests</div>
                </div>
                <div class="text-center">
                  <div class="text-[16px] font-semibold text-text-primary tabular-nums">{formatTokenCount(tokenUsage.summary.inputTokens)}</div>
                  <div class="text-[11px] text-text-tertiary mt-0.5">Input</div>
                </div>
                <div class="text-center">
                  <div class="text-[16px] font-semibold text-text-primary tabular-nums">{formatTokenCount(tokenUsage.summary.outputTokens)}</div>
                  <div class="text-[11px] text-text-tertiary mt-0.5">Output</div>
                </div>
                <div class="text-center">
                  <div class="text-[16px] font-semibold text-text-primary tabular-nums">{formatCost(tokenUsage.summary.costTotal)}</div>
                  <div class="text-[11px] text-text-tertiary mt-0.5">Cost</div>
                </div>
              </div>
            {:else}
              <div class="flex items-center justify-center py-8 text-[13px] text-text-tertiary">
                {#if tokenUsage}No usage data for the last {tokenUsage.days} days.{:else}Loading usage data…{/if}
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
          onLoadToolCalls={(input) => loadMessageToolCalls({ spaceId, sessionId: input.turn.sessionId, turnId: input.turn.id, message: input.message })}
          onLoadIntermediate={(turn) => loadTurnIntermediate({ spaceId, sessionId: turn.sessionId, turnId: turn.id, messagesObjectKey: turn.intermediateIndex?.messagesObjectKey ?? null })}
          onMarkdownRenderStart={handleTimelineMarkdownRenderStart}
          onMarkdownRendered={handleTimelineMarkdownRendered}
          loadingOlder={activeSessionState?.loadingOlder ?? false}
          onOpenFile={openInlineFile}
          modelsCatalog={modelsCatalog ?? undefined}
        />
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
          currentSequence={currentTurnSequence}
          loadingSequence={loadingTurnSequence}
          onJump={(sequence) => { void jumpToTurn(sequence); }}
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
                  class="flex h-7 items-center justify-center rounded-full bg-brand px-2.5 text-[11px] font-semibold leading-none text-white transition-colors duration-150 hover:bg-brand-hover active:scale-95"
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
          onJump={(sequence) => { void jumpToTurn(sequence); }}
        />
        <div bind:this={composerHostEl}>
          <SessionComposer
            bind:value={input}
            disabled={sending || !activeSessionState}
            streamError={composerNotice}
            attachments={imageAttachments}
            currentModel={activeSessionModel}
            promptTemplates={promptTemplates}
            onpickimage={handlePickImages}
            onremoveattachment={handleRemoveAttachment}
            onsubmit={handleSend}
            onModelSelect={() => {
              void loadModelsCatalog();
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
        <div class="flex flex-1 items-center justify-center text-sm text-text-tertiary">Loading…</div>
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
            {#if inlineFileIsMarkdown}
              <div class="flex items-center gap-0 rounded-md border border-border-subtle bg-bg-input p-[2px]">
                <button type="button" class="segmented-btn" class:active={inlineFileEdit} onclick={() => inlineFileEdit = true} title="Edit source">Source</button>
                <button type="button" class="segmented-btn" class:active={!inlineFileEdit} onclick={() => inlineFileEdit = false} title="Preview markdown">Preview</button>
              </div>
            {/if}
            <div class="flex-1"></div>
            <button type="button" class="icon-btn" onclick={() => void copyInlineFileContent()} title="Copy content">
              {#if inlineFileCopied}<Check class="w-4 h-4 text-success-soft" />{:else}<Copy class="w-4 h-4" />{/if}
            </button>
            <button type="button" class="action-btn" onclick={() => void saveInlineFile()} disabled={inlineFile.saving || !inlineFileDirty} title="Save">
              <Save class="w-4 h-4 shrink-0" />
            </button>
          </div>
          <div class="flex-1 min-h-0">
            {#if inlineFileEdit}
              <CodeEditor value={inlineFile.draft} language={inlineFileExt} onInput={(v) => { if (inlineFile) inlineFile.draft = v; }} />
            {:else if inlineFileIsMarkdown}
              <MarkdownView source={inlineFile.draft} variant="document" />
            {:else}
              <CodeEditor value={inlineFile.draft} language={inlineFileExt} readonly={true} />
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
            <span class="text-xs text-text-tertiary">Loading file…</span>
          </div>
          <div class="flex flex-1 items-center justify-center text-xs text-text-tertiary">Loading…</div>
        {:else if inlineFile.error}
          <div class="flex h-10 items-center border-b border-border-subtle px-3 shrink-0">
            <span class="flex-1 truncate text-xs text-text-secondary">{inlineFile.path}</span>
            {@render FileHeaderCoreActions(inlineFile.path)}
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
              {#if inlineFileIsMarkdown}
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
                    title="Preview markdown"
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
                disabled={inlineFile.saving || !inlineFileDirty}
                title="Save (Ctrl+S)"
              >
                <Save class="w-3.5 h-3.5 shrink-0" />
                <span class="hidden sm:inline">Save</span>
              </button>
              <button type="button" class="icon-btn" onclick={closeInlineFile} title="Close file">
                <X class="w-4 h-4" />
              </button>
            </div>
            <div class="flex-1 min-h-0">
              {#if inlineFileEdit}
                <CodeEditor
                  value={inlineFile.draft}
                  language={inlineFileExt}
                  onInput={(v) => { if (inlineFile) inlineFile.draft = v; }}
                />
              {:else if inlineFileIsMarkdown}
                <MarkdownView source={inlineFile.draft} variant="document" />
              {:else}
                <CodeEditor
                  value={inlineFile.draft}
                  language={inlineFileExt}
                  readonly={true}
                />
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
          onToggle={expandDirectory}
          onSelect={(node) => { if (node.type === "file") void openInlineFile(node.path); }}
          onRefresh={refreshFileTree}
          onCreateFile={handleCreateFile}
          onCreateDir={handleCreateDir}
          onRename={handleRenameNode}
          onDelete={handleDeleteNode}
          onUpload={handleUploadFiles}
          isPinned={(node) => node.type === "file" && pinnedFilePaths.has(node.path)}
          onTogglePin={(node) => { if (node.type === "file") void togglePinFilePath(node.path); }}
          onInsertReference={insertPathReference}
          onOpenPort={(port, url) => openInlinePort(port, url)}
          activePort={inlinePortPreview?.port ?? null}
          draggable={true}
          showItemActions={true}
          canWrite={true}
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
        onToggle={expandDirectory}
        onSelect={(node) => { if (node.type === "file") { void openInlineFile(node.path); uiState.mobileRightDrawerOpen = false; } }}
        onRefresh={refreshFileTree}
        onCreateFile={handleCreateFile}
        onCreateDir={handleCreateDir}
        onRename={handleRenameNode}
        onDelete={handleDeleteNode}
        onUpload={handleUploadFiles}
        isPinned={(node) => node.type === "file" && pinnedFilePaths.has(node.path)}
        onTogglePin={(node) => { if (node.type === "file") void togglePinFilePath(node.path); }}
        onInsertReference={insertPathReference}
        onOpenPort={(port, url) => { openInlinePort(port, url); uiState.mobileRightDrawerOpen = false; }}
        activePort={inlinePortPreview?.port ?? null}
        draggable={false}
        showItemActions={false}
        canWrite={true}
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
  />
</div>
<style>
  /* Heatmap */
  .heatmap-cell {
    width: 12px;
    height: 12px;
    border-radius: 2px;
    transition: background-color 120ms ease;
  }
  .heatmap-0 { background: var(--bg-elevated, rgba(0,0,0,0.03)); }
  .heatmap-1 { background: oklch(0.55 0.22 25 / 0.35); }
  .heatmap-2 { background: oklch(0.55 0.22 25 / 0.55); }
  .heatmap-3 { background: oklch(0.55 0.22 25 / 0.75); }
  .heatmap-4 { background: oklch(0.55 0.22 25 / 0.95); }
  @media (prefers-color-scheme: dark) {
    .heatmap-0 { background: var(--bg-elevated, rgba(255,255,255,0.05)); }
    .heatmap-1 { background: oklch(0.65 0.2 25 / 0.35); }
    .heatmap-2 { background: oklch(0.65 0.2 25 / 0.55); }
    .heatmap-3 { background: oklch(0.65 0.2 25 / 0.75); }
    .heatmap-4 { background: oklch(0.65 0.2 25 / 0.95); }
  }
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
    background: var(--brand, #FF3E00);
    border-color: var(--brand, #FF3E00);
    color: #fff;
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
