<script lang="ts">
import type {
	BillingCreditStatus,
	CheckpointRecord,
	CronJobRecord,
	LabelAssignmentListItem,
	LabelListItem,
	LabelResourceType,
	SessionForkRecord,
	SessionRecord,
	SpaceRecord,
	TaskRunRecord,
	WorkRecord,
} from "@neta-art/cohub";
import {
	Activity,
	ArrowLeft,
	BarChart3,
	Check,
	ChevronDown,
	Clock,
	Compass,
	CreditCard,
	Download,
	FolderKanban,
	History,
	Keyboard,
	Loader2,
	LogOut,
	MessageSquare,
	Network,
	NotebookPen,
	PanelLeftClose,
	PanelLeftOpen,
	Pencil,
	Plus,
	Rocket,
	Save,
	Search,
	Settings,
	Tags,
	Trash2,
	User,
	X,
} from "lucide-svelte";
import { onMount, tick, untrack } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { logtoClient } from "$lib/auth";
import { handleUnauthorizedError } from "$lib/auth-redirect";
import { clearAllIndexedDbCache } from "$lib/cache/clear";
import { getCacheUserKey } from "$lib/cache/keys";
import NewLabelPopover from "$lib/components/NewLabelPopover.svelte";
import SidebarFlyout from "$lib/components/SidebarFlyout.svelte";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import SidebarCheckpointRow from "$lib/components/sidebar/SidebarCheckpointRow.svelte";
import SidebarFallbackResourceRow from "$lib/components/sidebar/SidebarFallbackResourceRow.svelte";
import SidebarFileRow from "$lib/components/sidebar/SidebarFileRow.svelte";
import SidebarSessionRow from "$lib/components/sidebar/SidebarSessionRow.svelte";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import { downloadCohubDebugBundle } from "$lib/debugger";
import {
	type CohubResourceDragPayload,
	getCohubResourceDragData,
	getFirstCohubResource,
	hasCohubResourceDragData,
	isLabelAssignableResource,
	type LabelAssignableCohubResource,
	setCohubResourceDragData,
} from "$lib/drag/cohub-resource-drag";
import { extractGenerationPromptPreview } from "$lib/generation-task-media";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import { hydrateLabelItemsById } from "$lib/labels/label-resource-hydrator";
import {
	addResourceToLabel,
	moveResourceToLabel,
	type ResourceLabelMutationResult,
	removeResourceFromLabel,
} from "$lib/labels/resource-label-actions";
import { formatSpaceMentionTextForDisplay } from "$lib/mentions/space";
import { sdk } from "$lib/sdk";
import { mergeSessionRecords } from "$lib/session-record-merge";
import {
	getSessionSortTime,
	sortSessionsByRecentActivity,
} from "$lib/session-sort";
import {
	buildSpaceCheckpointNewRoute,
	buildSpaceCheckpointRoute,
	buildSpaceCronjobNewRoute,
	buildSpaceCronjobRoute,
	buildSpaceNewSessionRoute,
	buildSpaceSessionRoute,
	buildSpaceSettingsRoute,
	buildSpaceTaskRoute,
	buildSpaceWorkRoute,
} from "$lib/space-routes";
import { authStore } from "$lib/stores/auth.svelte";
import { billingCatalogStore } from "$lib/stores/billing-catalog.svelte";
import { insertComposerSnippet } from "$lib/stores/composer-insert";
import { modelsCatalogStore } from "$lib/stores/models-catalog.svelte";
import { clearRecentSpace, setRecentSpace } from "$lib/stores/recent-space";
import {
	fetchSessionDetailWithCache,
	getCachedSessionDetails,
	setCachedSessionDetails,
} from "$lib/stores/session-detail-cache";
import {
	clearAllCachedSessionLists,
	getCachedSessionListSnapshot,
	onSessionListCacheUpdated,
	patchCachedSessionList,
	setCachedSessionList,
} from "$lib/stores/session-list-cache";
import { unreadTracker } from "$lib/stores/session-state.svelte";
import {
	getCachedExpandedLabelIdsSnapshot,
	setCachedExpandedLabelIds,
} from "$lib/stores/sidebar-label-expanded";
import {
	ALL_CHATS_LABEL_ID,
	buildOptimisticWebAppLabelSessionItem,
	findDefaultExpandedLabelId,
	findWebAppSourceLabel,
	getDisplayLabels,
	getSourceLabels,
	getSystemUserLabels,
	isWebSessionSource,
	SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX,
} from "$lib/stores/sidebar-source-labels";
import {
	fetchLabelItemsFirstPageFresh,
	fetchSpaceLabelsFresh,
	flattenLabels,
	flattenLabelsWithRefs,
	getCachedLabelItemsSnapshot,
	getCachedSpaceLabelsSnapshot,
	getLabelDisplayName,
	getLabelDisplayTitle,
	getLabelRefById,
	getLabelUserProfile,
	hydrateUserProfilesForLabels,
	isSessionUserLabel,
	LABEL_ITEMS_PAGE_SIZE,
	markLabelItemsStale,
	onSpaceLabelsCacheUpdated,
	onUserLabelProfilesUpdated,
} from "$lib/stores/space-labels";
import {
	clearAllCachedSpaceLists,
	fetchSpaceListWithCache,
	getCachedSpaceList,
	getCachedSpaceListMeta,
	onSpaceListCacheUpdated,
} from "$lib/stores/space-list-cache";
import {
	cacheSpaceRecordSoon,
	getCachedSpaceRecord,
} from "$lib/stores/space-record-cache";
import {
	getCachedTaskRuns,
	onTaskRunsCacheUpdated,
	restoreCachedTaskRuns,
	setCachedTaskRuns,
} from "$lib/stores/task-runs-cache";
import { uiState } from "$lib/stores/ui.svelte";
import { clearGrantedWorkScopes } from "$lib/stores/work-grant-cache";
import { formatCompactAbsoluteTime } from "$lib/time-format";

const {
	isMobile = false,
	onClose,
	mode = "space",
	collapsed = false,
}: {
	isMobile?: boolean;
	onClose?: () => void;
	mode?: "space" | "settings";
	collapsed?: boolean;
} = $props();

const SESSION_PAGE_SIZE = 20;
const CHECKPOINT_PAGE_SIZE = 20;
const TASK_PAGE_SIZE = 10;

let showUserMenu = $state(false);
// Hydrate synchronously from the local cache so a freshly mounted sidebar
// (e.g. the mobile drawer, which unmounts on close) can resolve the current
// space on first paint instead of flashing the empty "Select a space" state
// while loadSpaces() awaits auth + IndexedDB + network.
let spaces = $state<SpaceRecord[]>(getCachedSpaceList() ?? []);
let sessions = $state<SessionRecord[]>([]);
type SessionForkSidebarRecord = Partial<SessionForkRecord> & {
	childSessionId: string;
	parentSessionId?: string | null;
	depth: number;
	anchorSequence?: number | null;
	createdAt?: string;
	firstUserTextAfterFork?: string | null;
	parentTitle?: string | null;
};
type SidebarSessionItem = {
	session: SessionRecord;
	depth: number;
	visualDepth: number;
	isFork: boolean;
	parentVisible: boolean;
	isLastVisibleChild: boolean;
	fork: SessionForkSidebarRecord | null;
	displayTitle: string;
	titleText: string | undefined;
	ariaLabel: string;
};
let sessionForks = $state<SessionForkSidebarRecord[]>([]);
let checkpoints = $state<CheckpointRecord[]>([]);
let labels = $state<LabelListItem[]>([]);
let labelItemsBySpace = $state<
	Record<string, Record<string, LabelAssignmentListItem[]>>
>({});
let userLabelProfileVersion = $state(0);
let labelSessionDetailsBySpace = $state<
	Record<string, Record<string, SessionRecord>>
>({});
let labelSessionDetailsLoadingBySpace = $state<Record<string, Set<string>>>({});
let labelItemsPageInfoBySpace = $state<
	Record<
		string,
		Record<string, { hasMore: boolean; nextCursor: string | null }>
	>
>({});
let expandedLabelIdsBySpace = $state<Record<string, Set<string>>>({});
let loadingLabelIdsBySpace = $state<Record<string, Set<string>>>({});
let showNewLabelPopover = $state(false);
let loadingSessions = $state(false);
let loadingSessionsSpaceId = $state<string | null>(null);
let loadingMoreSessions = $state(false);
let refreshingSessions = $state(false);
let sessionsPageInfo = $state<{ hasMore: boolean; nextCursor: string | null }>({
	hasMore: false,
	nextCursor: null,
});
let exhaustedFallbackSessionCursor = $state<string | null>(null);
let loadingCheckpoints = $state(false);
let loadingMoreCheckpoints = $state(false);
let loadingLabels = $state(false);
let refreshingLabels = $state(false);
let loadingCheckpointsSpaceId = $state<string | null>(null);
let checkpointsPageInfo = $state<{
	hasMore: boolean;
	nextCursor: string | null;
}>({ hasMore: false, nextCursor: null });
let billingCredit = $state<BillingCreditStatus | null>(null);
let billingCreditLoading = $state(false);
let billingCreditError = $state<string | null>(null);
let refreshingSpaces = $state(false);
let billingCreditUserId = $state<string | null>(null);
let billingConfigured = $state<boolean | null>(null);
let billingSubscriptionName = $state<string | null>(null);
const modelsCatalog = $derived(modelsCatalogStore.items);

let checkpointsCollapsed = $state(false);
let chatsCollapsed = $state(false);
let labelsCollapsed = $state(false);
let labelDropTargetId = $state<string | null>(null);
let labelDropBusyId = $state<string | null>(null);
let labelDropSuccessId = $state<string | null>(null);
let labelDropErrorId = $state<string | null>(null);
let labelDropErrorMessage = $state<string | null>(null);
type LabelDragOrigin = {
	labelId: string;
	labelRef: string;
	labelName?: string;
};
let activeLabelDragOrigin: LabelDragOrigin | null = null;
let labelAutoExpandTimer: ReturnType<typeof setTimeout> | null = null;
let labelDropFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
let cronjobsCollapsed = $state(false);
let tasksCollapsed = $state(true);
let worksCollapsed = $state(false);
let creatingSession = $state(false);
let createSessionError = $state("");
const sidebarFlyoutPreviewLimit = 24;

// Session rename state
const SESSION_ROW_NAVIGATE_DELAY_MS = 120;
let renamingSessionId = $state<string | null>(null);
let renameTitleValue = $state("");
let renameSaving = $state(false);
let renameInputElement: HTMLInputElement | null = $state(null);
let sessionNavigateClickTimer: ReturnType<typeof setTimeout> | null = null;

// Label rename state
let renamingLabelId = $state<string | null>(null);
let renameLabelValue = $state("");
let renameLabelSaving = $state(false);
let renameLabelInputElement: HTMLInputElement | null = $state(null);
let deletingLabelId = $state<string | null>(null);

let cronjobs = $state<CronJobRecord[]>([]);
let tasks = $state<TaskRunRecord[]>([]);
let works = $state<WorkRecord[]>([]);
let loadingCronjobs = $state(false);
let refreshingCheckpoints = $state(false);
let loadingCronjobsSpaceId = $state<string | null>(null);
let loadingTasks = $state(false);
let refreshingCronjobs = $state(false);
let loadingTasksSpaceId = $state<string | null>(null);
let refreshingTasks = $state(false);
let loadingMoreTasks = $state(false);
let tasksPageInfo = $state<{ hasMore: boolean; nextCursor: string | null }>({
	hasMore: false,
	nextCursor: null,
});
let loadingWorks = $state(false);
let loadingWorksSpaceId = $state<string | null>(null);
let refreshingWorks = $state(false);

const currentPath = $derived(page.url.pathname);
const activeSession = $derived.by(() => {
	const match = currentPath.match(/^\/spaces\/[^/]+\/sessions\/([^/]+)/);
	const activeSessionId = match?.[1] ?? null;
	return sessions.find((s) => s.id === activeSessionId) ?? null;
});
const activeWorkId = $derived.by(() => {
	const match = currentPath.match(/^\/spaces\/[^/]+\/works\/([^/]+)/);
	return match?.[1] ?? null;
});
const activeWork = $derived(
	works.find((work) => work.id === activeWorkId) ?? null,
);

const activeCheckpointId = $derived.by(() => {
	const match = currentPath.match(/^\/spaces\/[^/]+\/checkpoints\/([^/]+)/);
	const id = match?.[1] ?? null;
	if (!id || id === "new") return null;
	return id;
});
const activeCheckpoint = $derived(
	checkpoints.find((checkpoint) => checkpoint.id === activeCheckpointId) ??
		null,
);
const sidebarSessionItems = $derived.by(() =>
	buildSidebarSessionItems(sessions),
);

const activeCronjobId = $derived.by(() => {
	const match = currentPath.match(/^\/spaces\/[^/]+\/cronjobs\/([^/]+)/);
	const id = match?.[1] ?? null;
	if (!id || id === "new") return null;
	return id;
});
const activeCronjob = $derived(
	cronjobs.find((job) => job.id === activeCronjobId) ?? null,
);

const activeTaskId = $derived.by(() => {
	const match = currentPath.match(/^\/spaces\/[^/]+\/tasks\/([^/]+)/);
	return match?.[1] ?? null;
});

const activeLabelResource = $derived.by<{
	type: LabelResourceType;
	ref: string;
} | null>(() => {
	const sessionMatch = currentPath.match(/^\/spaces\/[^/]+\/sessions\/([^/]+)/);
	if (sessionMatch?.[1]) {
		return { type: "session", ref: sessionMatch[1] };
	}

	const checkpointMatch = currentPath.match(
		/^\/spaces\/[^/]+\/checkpoints\/([^/]+)/,
	);
	if (checkpointMatch?.[1] && checkpointMatch[1] !== "new") {
		return { type: "checkpoint", ref: checkpointMatch[1] };
	}

	const fileMatch = currentPath.match(/^\/spaces\/[^/]+\/files\/(.+)$/);
	if (fileMatch?.[1]) {
		return { type: "file", ref: decodeRoutePath(fileMatch[1]) };
	}

	return null;
});

const currentSpaceId = $derived.by(() => {
	const match = currentPath.match(/^\/spaces\/([^/]+)/);
	const id = match?.[1] ?? null;
	if (id === "new") return null;
	return id;
});

const currentSpace = $derived(
	currentSpaceId ? (spaces.find((s) => s.id === currentSpaceId) ?? null) : null,
);
const canAssignLabels = $derived(
	Boolean(currentSpace?.access?.permissions?.includes("space.label.assign")),
);
const canManageLabels = $derived(
	Boolean(currentSpace?.access?.permissions?.includes("space.label.manage")),
);
const currentLabelSessionDetails = $derived(
	currentSpaceId ? (labelSessionDetailsBySpace[currentSpaceId] ?? {}) : {},
);
const sessionsById = $derived.by(
	() => new Map(sessions.map((session) => [session.id, session])),
);
const labelSessionsById = $derived.by(
	() =>
		new Map(
			[...sessions, ...Object.values(currentLabelSessionDetails)].map(
				(session) => [session.id, session],
			),
		),
);
const checkpointsById = $derived.by(
	() => new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint])),
);
const currentLabelItemsById = $derived.by(() =>
	currentSpaceId
		? hydrateLabelItemsById(
				currentSpaceId,
				labelItemsBySpace[currentSpaceId] ?? {},
				{
					sessions: [...sessions, ...Object.values(currentLabelSessionDetails)],
				},
			)
		: {},
);
const currentLabelItemsPageInfoById = $derived(
	currentSpaceId ? (labelItemsPageInfoBySpace[currentSpaceId] ?? {}) : {},
);
const currentExpandedLabelIds = $derived(
	currentSpaceId
		? (expandedLabelIdsBySpace[currentSpaceId] ?? new Set<string>())
		: new Set<string>(),
);
const currentLoadingLabelIds = $derived(
	currentSpaceId
		? (loadingLabelIdsBySpace[currentSpaceId] ?? new Set<string>())
		: new Set<string>(),
);
const sourceLabels = $derived(getSourceLabels(labels));
const systemUserLabels = $derived(getSystemUserLabels(labels));
const displayLabels = $derived(getDisplayLabels(labels));
const userDisplayName = $derived(
	authStore.profile?.displayName?.trim() || "User",
);

let billingCreditRequest: Promise<boolean> | null = null;
let billingPlanRequest: Promise<void> | null = null;
const showBillingBalanceEntry = $derived(
	billingConfigured !== false &&
		(billingCreditLoading ||
			Boolean(billingCredit) ||
			Boolean(billingCreditError)),
);
const currentSubscriptionName = $derived(billingSubscriptionName);

function clearBillingCredit() {
	billingCredit = null;
	billingCreditLoading = false;
	billingCreditError = null;
	billingCreditUserId = null;
	billingConfigured = null;
	billingSubscriptionName = null;
}

function markBillingUnavailable() {
	billingCredit = null;
	billingCreditLoading = false;
	billingCreditError = null;
	billingCreditUserId = authStore.userUuid;
	billingConfigured = false;
	billingSubscriptionName = null;
}

function formatUsdAmount(value: number | null | undefined) {
	const amount =
		typeof value === "number" && Number.isFinite(value) ? value : 0;
	const sign = amount < 0 ? "-" : "";
	return `${sign}$${Math.abs(amount).toFixed(8)}`;
}

async function refreshBillingCredit() {
	if (billingCreditRequest) return billingCreditRequest;
	billingCreditLoading = true;
	billingCreditError = null;
	billingCreditRequest = (async () => {
		try {
			billingCredit = await sdk.billing.getCredits();
			billingCreditUserId = authStore.userUuid;
			billingConfigured = true;
			return true;
		} catch (error) {
			if (await handleUnauthorizedError(error)) {
				clearBillingCredit();
				return false;
			}
			console.warn("[sidebar] Failed to load billing credit", error);
			billingCreditError = "Failed to refresh";
			return false;
		} finally {
			billingCreditLoading = false;
			billingCreditRequest = null;
		}
	})();
	return billingCreditRequest;
}

async function refreshBillingPlan() {
	if (billingPlanRequest) return billingPlanRequest;
	billingPlanRequest = (async () => {
		try {
			const catalog = await billingCatalogStore.load();
			const sub =
				catalog?.currentSubscriptions.find((s) => s.status === "active") ??
				catalog?.currentSubscriptions.find((s) => s.status === "trialing");
			billingSubscriptionName = sub?.productName ?? null;
		} catch (error) {
			if (await handleUnauthorizedError(error)) return;
			console.warn("[sidebar] Failed to load billing plan", error);
		} finally {
			billingPlanRequest = null;
		}
	})();
	return billingPlanRequest;
}

const baseSettingsTabs = [
	{ id: "profile", label: "Profile", icon: User, href: "/settings/profile" },
	{
		id: "billing",
		label: "Billing",
		icon: CreditCard,
		href: "/settings/billing",
	},
	{
		id: "rules",
		label: "User Rules",
		icon: NotebookPen,
		href: "/settings/rules",
	},
	{
		id: "channels",
		label: "Channels",
		icon: Network,
		href: "/settings/channels",
	},
];
const settingsTabs = $derived(
	baseSettingsTabs.filter(
		(tab) => tab.id !== "billing" || billingConfigured !== false,
	),
);

const settingsReturnTo = $derived.by(() => {
	const returnTo = page.url.searchParams.get("from");
	if (!returnTo) return "/";
	try {
		const decoded = decodeURIComponent(returnTo);
		if (!decoded.startsWith("/") || decoded.startsWith("//")) return "/";
		if (decoded.startsWith("/settings")) return "/";
		return decoded;
	} catch {
		return "/";
	}
});

const activeSettingsTab = $derived.by(() => {
	const tab = settingsTabs.find((tab) => currentPath.startsWith(tab.href));
	return tab?.id ?? null;
});

function sourceBadge(source: string | null): string {
	if (!source || source === "web") return "";
	const idx = source.indexOf(":");
	return idx > 0 ? source.slice(0, idx) : source;
}

function sourceTooltip(source: string | null): string {
	return source ?? "";
}

function getTaskRunBadge(status: TaskRunRecord["status"]) {
	if (status === "completed") {
		return { color: "text-status-running", dot: "bg-status-running" };
	}
	if (status === "failed") {
		return { color: "text-status-error", dot: "bg-status-error" };
	}
	if (status === "running") {
		return { color: "text-info", dot: "bg-info" };
	}
	return { color: "text-text-placeholder", dot: "bg-text-placeholder" };
}

function formatTaskRunTime(run: TaskRunRecord) {
	return formatCompactAbsoluteTime(run.createdAt ?? run.scheduledAt) || "—";
}

function asTaskRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function readTaskString(
	record: Record<string, unknown> | null,
	keys: string[],
) {
	if (!record) return null;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function compactTaskText(value: string, limit = 72) {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= limit) return compact;
	return `${compact.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function formatTaskTypeLabel(taskType: string | null | undefined) {
	const normalized = taskType?.trim() || "task";
	return normalized
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function getTaskRunPayloadData(run: Pick<TaskRunRecord, "payload">) {
	const payload = asTaskRecord(run.payload);
	return asTaskRecord(payload?.data) ?? payload;
}

function getTaskRunTitle(run: TaskRunRecord) {
	const payload = asTaskRecord(run.payload);
	const data = getTaskRunPayloadData(run);
	const explicitTitle = readTaskString(data, ["title", "name", "description"]);
	if (explicitTitle) return compactTaskText(explicitTitle);
	if (run.taskType === "generation") {
		const prompt = extractGenerationPromptPreview(run.payload);
		return prompt ? compactTaskText(prompt) : "Generation";
	}
	if (run.taskType === "send_message") {
		const content = data?.content;
		if (Array.isArray(content)) {
			const text = content
				.filter((block): block is Record<string, unknown> =>
					Boolean(asTaskRecord(block)),
				)
				.map((block) => readTaskString(block, ["text", "content", "value"]))
				.filter(Boolean)
				.join(" ");
			if (text.trim()) return compactTaskText(text);
		}
		return "Send message";
	}
	if (run.taskType === "run_command") {
		const command = readTaskString(data, ["command", "rawText"]);
		return command ? compactTaskText(command) : "Run command";
	}
	if (run.taskType === "save_checkpoint") {
		return compactTaskText(
			readTaskString(data, ["description"]) ?? "Save checkpoint",
		);
	}
	return formatTaskTypeLabel(
		(payload?.type as string | undefined) ?? run.taskType,
	);
}

function getTaskRunMeta(run: TaskRunRecord) {
	return `${formatTaskTypeLabel(run.taskType)} · ${run.status} · ${formatTaskRunTime(run)}`;
}

function getFallbackSessionCursor(sessionList: SessionRecord[]) {
	return sessionList.at(-1)?.lastMessageAt ?? null;
}

function mergeDefinedSpaceRecordFields(
	incoming: SpaceRecord,
	existing: SpaceRecord | null | undefined,
) {
	if (!existing) return incoming;
	const merged: SpaceRecord = { ...existing };
	for (const [key, value] of Object.entries(incoming) as Array<
		[keyof SpaceRecord, SpaceRecord[keyof SpaceRecord]]
	>) {
		if (value !== undefined) {
			merged[key] = value as never;
		}
	}
	return merged;
}

function mergeSpaceIntoSidebarList(space: SpaceRecord) {
	const existing = spaces.find((item) => item.id === space.id);
	const merged = mergeDefinedSpaceRecordFields(space, existing);
	spaces = [merged, ...spaces.filter((item) => item.id !== space.id)];
}

function mergeSpaceListWithCurrent(nextSpaces: SpaceRecord[]) {
	const current = currentSpaceId
		? spaces.find((space) => space.id === currentSpaceId)
		: null;
	const merged = nextSpaces.map((space) =>
		space.id === currentSpaceId
			? mergeDefinedSpaceRecordFields(space, current)
			: space,
	);
	if (!current || nextSpaces.some((space) => space.id === current.id))
		return merged;
	return [current, ...merged];
}

const currentSpaceRefreshes = new Map<string, Promise<void>>();

async function loadCurrentSpaceFromUrl(
	spaceId = currentSpaceId,
	options?: { refresh?: boolean },
) {
	if (!spaceId) return;
	const alreadyLoaded = spaces.some((space) => space.id === spaceId);

	if (!alreadyLoaded) {
		const cached = await getCachedSpaceRecord(spaceId).catch(() => null);
		if (spaceId !== currentSpaceId) return;
		if (cached?.space) mergeSpaceIntoSidebarList(cached.space);
	}

	if (!options?.refresh && currentSpaceRefreshes.has(spaceId)) return;

	let refresh!: Promise<void>;
	refresh = (async () => {
		try {
			const space = await sdk.space(spaceId).get();
			if (spaceId !== currentSpaceId) return;
			mergeSpaceIntoSidebarList(space);
			cacheSpaceRecordSoon(space);
		} catch (error) {
			if (spaceId !== currentSpaceId) return;
			console.warn("[sidebar] Failed to load current space", {
				spaceId,
				error,
			});
		} finally {
			if (currentSpaceRefreshes.get(spaceId) === refresh) {
				currentSpaceRefreshes.delete(spaceId);
			}
		}
	})();

	currentSpaceRefreshes.set(spaceId, refresh);
}

function shouldShowLoadMoreSessions() {
	if (sessionsPageInfo.hasMore && sessionsPageInfo.nextCursor) return true;
	const fallbackCursor = getFallbackSessionCursor(sessions);
	return Boolean(
		sessions.length >= SESSION_PAGE_SIZE &&
			fallbackCursor &&
			fallbackCursor !== exhaustedFallbackSessionCursor,
	);
}

function mergeSessionSnapshotForDisplay(
	currentSessions: SessionRecord[],
	nextSessions: SessionRecord[],
) {
	if (currentSessions.length === 0) return nextSessions;
	return sortSessionsByRecentActivity(
		mergeSessionRecords([...currentSessions, ...nextSessions]),
	);
}

async function loadSpaces(force = false) {
	await authStore.ensureLoaded();
	const requestedSpaceId = currentSpaceId;

	// The current URL is the source of truth for the selected space. Load it
	// directly first so guest-access spaces still render even if the broader
	// space list does not include them (or becomes paginated later).
	await loadCurrentSpaceFromUrl(requestedSpaceId);

	if (!authStore.isAuthenticated) {
		return;
	}

	if (!force) {
		const cached = getCachedSpaceList();
		if (cached && cached.length > 0) {
			spaces = mergeSpaceListWithCurrent(cached);
		}
	}

	const cacheMeta = getCachedSpaceListMeta();
	const shouldFetch = force || !cacheMeta || cacheMeta.isStale;
	if (!shouldFetch) return;

	refreshingSpaces = spaces.length > 0;
	try {
		const listedSpaces = await fetchSpaceListWithCache(
			async () => await sdk.spaces.list(),
			{ force },
		);
		spaces = mergeSpaceListWithCurrent(listedSpaces);
	} catch (error) {
		if (await handleUnauthorizedError(error)) {
			return;
		}
		console.warn("[sidebar] Failed to load spaces", error);
	} finally {
		refreshingSpaces = false;
	}

	await loadCurrentSpaceFromUrl(requestedSpaceId);
}

async function loadSessionsForSpace(spaceId: string, force = false) {
	if (!force && loadingSessions && loadingSessionsSpaceId === spaceId) return;

	if (!force) {
		const cached = await getCachedSessionListSnapshot(spaceId);
		if (spaceId !== currentSpaceId) return;
		if (cached && cached.sessions.length > 0) {
			sessions = cached.sessions;
			sessionForks = cached.forks ?? [];
			sessionsPageInfo = cached.pageInfo;
		}
	}

	const shouldShowLoading = sessions.length === 0;
	if (shouldShowLoading) {
		loadingSessions = true;
		loadingSessionsSpaceId = spaceId;
	} else {
		refreshingSessions = true;
	}

	const cachedSnapshot = await getCachedSessionListSnapshot(spaceId);
	if (spaceId !== currentSpaceId) {
		if (loadingSessionsSpaceId === spaceId) {
			loadingSessions = false;
			loadingSessionsSpaceId = null;
		}
		refreshingSessions = false;
		return;
	}
	const shouldFetch = force || !cachedSnapshot || cachedSnapshot.stale;
	if (!shouldFetch) {
		if (loadingSessionsSpaceId === spaceId) {
			loadingSessions = false;
			loadingSessionsSpaceId = null;
		}
		refreshingSessions = false;
		return;
	}

	try {
		const result = await sdk.space(spaceId).sessions.list({
			limit: SESSION_PAGE_SIZE,
			includeForks: true,
		});
		if (spaceId !== currentSpaceId) return;
		const nextSessions = result.sessions ?? [];
		const nextPageInfo = result.pageInfo ?? {
			hasMore: false,
			nextCursor: null,
		};
		const nextForks = result.forks ?? [];
		sessionForks = nextForks;
		sessions = nextSessions;
		void setCachedSessionList(
			spaceId,
			nextSessions,
			nextPageInfo,
			nextForks,
		).catch((error) =>
			console.warn("[sidebar] Failed to cache sessions", { spaceId, error }),
		);
		if (spaceId !== currentSpaceId) return;
		sessionsPageInfo = nextPageInfo;
	} catch (error) {
		console.warn("[sidebar] Failed to load sessions", { spaceId, error });
	} finally {
		if (loadingSessionsSpaceId === spaceId) {
			loadingSessions = false;
			loadingSessionsSpaceId = null;
		}
		refreshingSessions = false;
	}
}

async function loadMoreSessionsForSpace(spaceId: string) {
	if (loadingMoreSessions) return;
	const cursor =
		sessionsPageInfo.nextCursor ?? getFallbackSessionCursor(sessions);
	if (!cursor || cursor === exhaustedFallbackSessionCursor) return;
	loadingMoreSessions = true;
	try {
		const result = await sdk.space(spaceId).sessions.list({
			limit: SESSION_PAGE_SIZE,
			cursor,
			includeForks: true,
		});
		const moreSessions = result.sessions ?? [];
		const nextPageInfo = result.pageInfo ?? {
			hasMore: false,
			nextCursor: null,
		};
		const forkByChildId = new Map(
			sessionForks.map((fork) => [fork.childSessionId, fork]),
		);
		for (const fork of result.forks ?? [])
			forkByChildId.set(fork.childSessionId, fork);
		sessionForks = Array.from(forkByChildId.values());
		const mergedSessions = [...sessions, ...moreSessions];
		sessions = mergedSessions;
		void setCachedSessionList(
			spaceId,
			moreSessions,
			nextPageInfo,
			sessionForks,
			{ mode: "merge" },
		).catch((error) =>
			console.warn("[sidebar] Failed to cache loaded sessions", {
				spaceId,
				error,
			}),
		);
		sessionsPageInfo = nextPageInfo;
		exhaustedFallbackSessionCursor =
			!nextPageInfo.hasMore && moreSessions.length === 0 ? cursor : null;
	} catch (error) {
		console.warn("[sidebar] Failed to load more sessions", { spaceId, error });
	} finally {
		loadingMoreSessions = false;
	}
}

async function loadCheckpointsForSpace(spaceId: string, force = false) {
	if (!force && loadingCheckpoints && loadingCheckpointsSpaceId === spaceId)
		return;
	const shouldShowLoading = checkpoints.length === 0;
	if (shouldShowLoading) {
		loadingCheckpoints = true;
		loadingCheckpointsSpaceId = spaceId;
	} else {
		refreshingCheckpoints = true;
	}
	try {
		const result = await sdk.space(spaceId).checkpoints.list({
			limit: CHECKPOINT_PAGE_SIZE,
		});
		if (spaceId === currentSpaceId) {
			checkpoints = result.checkpoints ?? [];
			checkpointsPageInfo = result.pageInfo ?? {
				hasMore: false,
				nextCursor: null,
			};
		}
	} catch (error) {
		console.warn("[sidebar] Failed to load checkpoints", { spaceId, error });
	} finally {
		if (loadingCheckpointsSpaceId === spaceId) {
			loadingCheckpoints = false;
			loadingCheckpointsSpaceId = null;
		}
		refreshingCheckpoints = false;
	}
}

function getReactiveLabelDisplayName(label: LabelListItem) {
	userLabelProfileVersion;
	return getLabelDisplayName(label);
}

function getReactiveLabelDisplayTitle(label: LabelListItem) {
	userLabelProfileVersion;
	return getLabelDisplayTitle(label);
}

function getReactiveLabelUserProfile(label: LabelListItem) {
	userLabelProfileVersion;
	return getLabelUserProfile(label);
}

async function loadMoreCheckpointsForSpace(spaceId: string) {
	if (loadingMoreCheckpoints) return;
	const cursor = checkpointsPageInfo.nextCursor;
	if (!cursor) return;
	loadingMoreCheckpoints = true;
	try {
		const result = await sdk.space(spaceId).checkpoints.list({
			limit: CHECKPOINT_PAGE_SIZE,
			cursor,
		});
		if (spaceId !== currentSpaceId) return;
		const byId = new Map(
			checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]),
		);
		for (const checkpoint of result.checkpoints ?? []) {
			byId.set(checkpoint.id, checkpoint);
		}
		checkpoints = Array.from(byId.values()).sort(
			(a, b) =>
				(Date.parse(b.createdAt ?? "") || 0) -
				(Date.parse(a.createdAt ?? "") || 0),
		);
		checkpointsPageInfo = result.pageInfo ?? {
			hasMore: false,
			nextCursor: null,
		};
	} catch (error) {
		console.warn("[sidebar] Failed to load more checkpoints", {
			spaceId,
			error,
		});
	} finally {
		loadingMoreCheckpoints = false;
	}
}

async function loadLabelsForSpace(spaceId: string, force = false) {
	if (!force) {
		const cached = await getCachedSpaceLabelsSnapshot(spaceId);
		if (spaceId !== currentSpaceId) return;
		if (cached) {
			labels = cached.labels;
			pruneExpandedLabelIds(spaceId, cached.labels);
			applyDefaultExpandedLabelId(spaceId, cached.labels);
			void hydrateUserProfilesForLabels(cached.labels).catch(() => undefined);
		}
		if (cached && !cached.stale) return;
	}

	if (labels.length === 0) loadingLabels = true;
	else refreshingLabels = true;
	try {
		const next = await fetchSpaceLabelsFresh(spaceId);
		if (spaceId === currentSpaceId) {
			labels = next;
			pruneExpandedLabelIds(spaceId, next);
			applyDefaultExpandedLabelId(spaceId, next);
			void hydrateUserProfilesForLabels(next).catch(() => undefined);
		}
	} catch (error) {
		console.warn("[sidebar] Failed to load labels", { spaceId, error });
	} finally {
		if (spaceId === currentSpaceId) {
			loadingLabels = false;
			refreshingLabels = false;
		}
	}
}

function labelItemsEqual(
	left: LabelAssignmentListItem[],
	right: LabelAssignmentListItem[],
) {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		const a = left[index];
		const b = right[index];
		if (!a || !b) return false;
		if (a.id !== b.id || a.updatedAt !== b.updatedAt || a.rank !== b.rank)
			return false;
	}
	return true;
}

async function warmLabelSessionDetails(spaceId: string, sessionIds: string[]) {
	const uniqueIds = Array.from(new Set(sessionIds.filter(Boolean)));
	if (uniqueIds.length === 0) return;

	const localSessions = uniqueIds
		.map((sessionId) => sessionsById.get(sessionId))
		.filter((session): session is SessionRecord => Boolean(session));
	if (localSessions.length > 0) {
		void setCachedSessionDetails(spaceId, localSessions).catch(() => undefined);
	}

	const cached = (await getCachedSessionDetails(spaceId, uniqueIds).catch(
		() => ({}),
	)) as Awaited<ReturnType<typeof getCachedSessionDetails>>;
	const isCurrentSpace = () => spaceId === currentSpaceId;
	const cachedSessions = Object.values(cached)
		.map((snapshot) => snapshot.session)
		.filter((session): session is SessionRecord => Boolean(session));
	if (cachedSessions.length > 0 && isCurrentSpace()) {
		const currentDetails = labelSessionDetailsBySpace[spaceId] ?? {};
		labelSessionDetailsBySpace = {
			...labelSessionDetailsBySpace,
			[spaceId]: {
				...currentDetails,
				...Object.fromEntries(
					cachedSessions.map((session) => [session.id, session]),
				),
			},
		};
	}

	const loading =
		labelSessionDetailsLoadingBySpace[spaceId] ?? new Set<string>();
	const missingOrStale = uniqueIds.filter((sessionId) => {
		if (sessionsById.has(sessionId)) return false;
		if (loading.has(sessionId)) return false;
		const snapshot = cached[sessionId];
		return !snapshot || snapshot.stale;
	});
	if (missingOrStale.length === 0) return;

	labelSessionDetailsLoadingBySpace = {
		...labelSessionDetailsLoadingBySpace,
		[spaceId]: new Set([...loading, ...missingOrStale]),
	};

	try {
		const refreshed: SessionRecord[] = [];
		const concurrency = 4;
		let cursor = 0;
		async function worker() {
			while (cursor < missingOrStale.length) {
				const sessionId = missingOrStale[cursor++];
				if (!sessionId) continue;
				try {
					const session = await fetchSessionDetailWithCache(
						spaceId,
						sessionId,
						async () =>
							(await sdk.space(spaceId).session(sessionId).get()).session,
						{ force: Boolean(cached[sessionId]?.stale) },
					);
					refreshed.push(session);
				} catch (error) {
					console.warn("[labels] Failed to warm session detail", {
						spaceId,
						sessionId,
						error,
					});
				}
			}
		}
		await Promise.all(
			Array.from({ length: Math.min(concurrency, missingOrStale.length) }, () =>
				worker(),
			),
		);
		if (isCurrentSpace() && refreshed.length > 0) {
			const currentDetails = labelSessionDetailsBySpace[spaceId] ?? {};
			labelSessionDetailsBySpace = {
				...labelSessionDetailsBySpace,
				[spaceId]: {
					...currentDetails,
					...Object.fromEntries(
						refreshed.map((session) => [session.id, session]),
					),
				},
			};
		}
	} finally {
		const latestLoading =
			labelSessionDetailsLoadingBySpace[spaceId] ?? new Set<string>();
		labelSessionDetailsLoadingBySpace = {
			...labelSessionDetailsLoadingBySpace,
			[spaceId]: new Set(
				[...latestLoading].filter((id) => !missingOrStale.includes(id)),
			),
		};
	}
}

function patchLabelItems(
	spaceId: string,
	labelId: string,
	items: LabelAssignmentListItem[],
	pageInfo: { hasMore: boolean; nextCursor: string | null },
) {
	const sessionItems = items.filter((item) => item.resourceType === "session");
	if (sessionItems.length > 0)
		void warmLabelSessionDetails(
			spaceId,
			sessionItems.map((item) => item.resourceRef),
		);
	const currentSpaceItems = labelItemsBySpace[spaceId] ?? {};
	const currentItems = currentSpaceItems[labelId] ?? [];
	const currentPageInfo = labelItemsPageInfoBySpace[spaceId]?.[labelId];
	const samePageInfo =
		currentPageInfo?.hasMore === pageInfo.hasMore &&
		currentPageInfo?.nextCursor === pageInfo.nextCursor;
	if (labelItemsEqual(currentItems, items) && samePageInfo) return;

	labelItemsBySpace = {
		...labelItemsBySpace,
		[spaceId]: {
			...currentSpaceItems,
			[labelId]: items,
		},
	};
	labelItemsPageInfoBySpace = {
		...labelItemsPageInfoBySpace,
		[spaceId]: {
			...(labelItemsPageInfoBySpace[spaceId] ?? {}),
			[labelId]: pageInfo,
		},
	};
}

async function loadLabelItems(
	labelId: string,
	options?: { force?: boolean; append?: boolean },
) {
	const spaceId = currentSpaceId;
	if (!spaceId) return;
	const append = options?.append ?? false;
	const force = options?.force ?? false;
	const spacePageInfo = labelItemsPageInfoBySpace[spaceId] ?? {};

	if (!append && !force) {
		const cached = await getCachedLabelItemsSnapshot(spaceId, labelId);
		if (spaceId !== currentSpaceId) return;
		if (cached) {
			patchLabelItems(spaceId, labelId, cached.items, cached.pageInfo);
			if (!cached.stale) return;
		}
	}

	loadingLabelIdsBySpace = {
		...loadingLabelIdsBySpace,
		[spaceId]: new Set([
			...(loadingLabelIdsBySpace[spaceId] ?? new Set<string>()),
			labelId,
		]),
	};
	try {
		const labelRef = await getLabelRefById(spaceId, labelId);
		if (!labelRef) return;
		if (append) {
			const result = await sdk.space(spaceId).labels.listItems(labelRef, {
				limit: LABEL_ITEMS_PAGE_SIZE,
				cursor: spacePageInfo[labelId]?.nextCursor,
			});
			if (spaceId !== currentSpaceId) return;
			const latestItems = labelItemsBySpace[spaceId]?.[labelId] ?? [];
			const nextItems = [...latestItems, ...(result.items ?? [])];
			patchLabelItems(spaceId, labelId, nextItems, result.pageInfo);
			return;
		}

		const result = await fetchLabelItemsFirstPageFresh(
			spaceId,
			labelId,
			labelRef,
		);
		if (spaceId !== currentSpaceId) return;
		patchLabelItems(spaceId, labelId, result.items, result.pageInfo);
	} catch (error) {
		console.warn("[sidebar] Failed to load label items", { labelId, error });
	} finally {
		if (spaceId === currentSpaceId) {
			loadingLabelIdsBySpace = {
				...loadingLabelIdsBySpace,
				[spaceId]: new Set(
					[...(loadingLabelIdsBySpace[spaceId] ?? new Set<string>())].filter(
						(id) => id !== labelId,
					),
				),
			};
		}
	}
}

function toggleLabelExpanded(labelId: string) {
	if (!currentSpaceId) return;
	const spaceId = currentSpaceId;
	const next = new Set(expandedLabelIdsBySpace[spaceId] ?? new Set<string>());
	if (next.has(labelId)) next.delete(labelId);
	else {
		next.add(labelId);
		if (labelId !== ALL_CHATS_LABEL_ID) void loadLabelItems(labelId);
	}
	expandedLabelIdsBySpace = {
		...expandedLabelIdsBySpace,
		[spaceId]: next,
	};
	setCachedExpandedLabelIds(spaceId, next);
}

function isSessionActivityLabel(label: LabelListItem) {
	return (
		isSessionUserLabel(label) ||
		label.systemKey?.startsWith(SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX)
	);
}

function didSessionActivityChange(
	previous: SessionRecord | undefined,
	next: SessionRecord,
) {
	if (!previous) return true;
	return (
		previous.lastMessageAt !== next.lastMessageAt ||
		previous.updatedAt !== next.updatedAt ||
		previous.latestMessageText !== next.latestMessageText ||
		previous.status !== next.status ||
		previous.title !== next.title
	);
}

function refreshExpandedSessionActivityLabels(spaceId: string) {
	const expanded = expandedLabelIdsBySpace[spaceId];
	if (!expanded || spaceId !== currentSpaceId) return;
	for (const label of flattenLabels(labels)) {
		if (!expanded.has(label.id) || !isSessionActivityLabel(label)) continue;
		void loadLabelItems(label.id, { force: true });
	}
}

function optimisticPrependWebAppLabelSession(
	spaceId: string,
	session: SessionRecord,
) {
	if (!isWebSessionSource(session)) return;
	const labelId = findWebAppSourceLabel(labels)?.id ?? null;
	if (!labelId || !currentExpandedLabelIds.has(labelId)) return;
	const existingItems = labelItemsBySpace[spaceId]?.[labelId] ?? [];
	if (
		existingItems.some(
			(item) =>
				item.resourceType === "session" && item.resourceRef === session.id,
		)
	)
		return;
	patchLabelItems(
		spaceId,
		labelId,
		[
			buildOptimisticWebAppLabelSessionItem({ spaceId, labelId, session }),
			...existingItems,
		],
		currentLabelItemsPageInfoById[labelId] ?? {
			hasMore: false,
			nextCursor: null,
		},
	);
}

function restoreExpandedLabelIds(spaceId: string) {
	const expanded = getCachedExpandedLabelIdsSnapshot(spaceId);
	if (!expanded) return;
	expandedLabelIdsBySpace = {
		...expandedLabelIdsBySpace,
		[spaceId]: expanded,
	};
	for (const labelId of expanded) {
		if (labelId !== ALL_CHATS_LABEL_ID) void loadLabelItems(labelId);
	}
}

function applyDefaultExpandedLabelId(
	spaceId: string,
	nextLabels: LabelListItem[],
) {
	if (getCachedExpandedLabelIdsSnapshot(spaceId)) return;
	if (expandedLabelIdsBySpace[spaceId]?.size) return;
	const labelId = findDefaultExpandedLabelId(nextLabels);
	const expanded = new Set([labelId]);
	expandedLabelIdsBySpace = {
		...expandedLabelIdsBySpace,
		[spaceId]: expanded,
	};
	setCachedExpandedLabelIds(spaceId, expanded);
	if (labelId !== ALL_CHATS_LABEL_ID) void loadLabelItems(labelId);
}

function pruneExpandedLabelIds(spaceId: string, nextLabels: LabelListItem[]) {
	const expanded = expandedLabelIdsBySpace[spaceId];
	if (!expanded?.size) return;
	const validIds = new Set([
		...flattenLabels(nextLabels).map((label) => label.id),
		ALL_CHATS_LABEL_ID,
	]);
	const next = new Set(
		[...expanded].filter((labelId) => validIds.has(labelId)),
	);
	if (next.size === expanded.size) return;
	expandedLabelIdsBySpace = {
		...expandedLabelIdsBySpace,
		[spaceId]: next,
	};
	setCachedExpandedLabelIds(spaceId, next);
}

function refreshExpandedLabelItems(spaceId: string) {
	const expanded = expandedLabelIdsBySpace[spaceId];
	if (!expanded || spaceId !== currentSpaceId) return;
	for (const labelId of expanded) {
		if (labelId !== ALL_CHATS_LABEL_ID)
			void loadLabelItems(labelId, { force: true });
	}
}

function ensureLabelExpanded(labelId: string) {
	if (!currentSpaceId) return;
	const spaceId = currentSpaceId;
	const next = new Set(expandedLabelIdsBySpace[spaceId] ?? new Set<string>());
	if (next.has(labelId)) return;
	next.add(labelId);
	expandedLabelIdsBySpace = {
		...expandedLabelIdsBySpace,
		[spaceId]: next,
	};
	setCachedExpandedLabelIds(spaceId, next);
}

function clearLabelAutoExpandTimer() {
	if (!labelAutoExpandTimer) return;
	clearTimeout(labelAutoExpandTimer);
	labelAutoExpandTimer = null;
}

function scheduleLabelAutoExpand(labelId: string) {
	clearLabelAutoExpandTimer();
	if (currentExpandedLabelIds.has(labelId)) return;
	labelAutoExpandTimer = setTimeout(() => {
		ensureLabelExpanded(labelId);
		void loadLabelItems(labelId);
		labelAutoExpandTimer = null;
	}, 600);
}

function setLabelDropFeedback(
	kind: "success" | "error",
	labelId: string,
	message?: string,
) {
	if (labelDropFeedbackTimer) clearTimeout(labelDropFeedbackTimer);
	labelDropSuccessId = kind === "success" ? labelId : null;
	labelDropErrorId = kind === "error" ? labelId : null;
	labelDropErrorMessage =
		kind === "error" ? (message ?? "Failed to update label") : null;
	labelDropFeedbackTimer = setTimeout(
		() => {
			labelDropSuccessId = null;
			labelDropErrorId = null;
			labelDropErrorMessage = null;
			labelDropFeedbackTimer = null;
		},
		kind === "error" ? 2400 : 900,
	);
}

function refreshAffectedLabelItems(result: ResourceLabelMutationResult) {
	if (!currentSpaceId) return;
	for (const labelId of result.affectedLabelIds) {
		if (currentExpandedLabelIds.has(labelId)) {
			void loadLabelItems(labelId, { force: true });
		}
	}
}

function getDropResource(event: DragEvent): {
	payload: CohubResourceDragPayload;
	resource: LabelAssignableCohubResource;
} | null {
	const payload = getCohubResourceDragData(event.dataTransfer);
	if (!payload) return null;
	const resource = getFirstCohubResource(payload);
	if (!isLabelAssignableResource(resource)) return null;
	return { payload, resource };
}

function canAssignResourceToLabel(label: LabelListItem) {
	return canAssignLabels && label.source === "user";
}

function handleLabelDragOver(event: DragEvent, label: LabelListItem) {
	if (
		!canAssignResourceToLabel(label) ||
		!hasCohubResourceDragData(event.dataTransfer)
	)
		return;
	event.preventDefault();
	event.stopPropagation();
	labelDropTargetId = label.id;
	if (event.dataTransfer) {
		event.dataTransfer.dropEffect = activeLabelDragOrigin ? "move" : "copy";
	}
	scheduleLabelAutoExpand(label.id);
}

function labelRefForId(labelId: string) {
	return (
		flattenLabelsWithRefs(labels).find((label) => label.id === labelId)?.ref ??
		null
	);
}

function replaceLabelInTree(
	items: LabelListItem[],
	labelId: string,
	updater: (label: LabelListItem) => LabelListItem,
): LabelListItem[] {
	return items.map((item) => {
		const nextItem = item.id === labelId ? updater(item) : item;
		if (!nextItem.children?.length) return nextItem;
		return {
			...nextItem,
			children: replaceLabelInTree(nextItem.children, labelId, updater),
		};
	});
}

function handleLabelDragLeave(event: DragEvent, label: LabelListItem) {
	const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
	const { clientX: x, clientY: y } = event;
	if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
		return;
	if (labelDropTargetId === label.id) labelDropTargetId = null;
	clearLabelAutoExpandTimer();
}

async function handleLabelDrop(event: DragEvent, label: LabelListItem) {
	if (!canAssignResourceToLabel(label) || !currentSpaceId) return;
	const spaceId = currentSpaceId;
	const drop = getDropResource(event);
	if (!drop) return;
	event.preventDefault();
	event.stopPropagation();
	clearLabelAutoExpandTimer();
	labelDropTargetId = null;
	labelDropBusyId = label.id;
	try {
		const targetLabelRef = labelRefForId(label.id);
		if (!targetLabelRef) return;
		const result =
			drop.payload.origin?.kind === "label-items"
				? await moveResourceToLabel({
						spaceId,
						resource: drop.resource,
						sourceLabelRef: drop.payload.origin.labelRef,
						targetLabelRef,
					})
				: await addResourceToLabel({
						spaceId,
						resource: drop.resource,
						targetLabelRef,
					});
		if (currentSpaceId !== spaceId) return;
		ensureLabelExpanded(label.id);
		void loadLabelItems(label.id, { force: true });
		refreshAffectedLabelItems(result);
		setLabelDropFeedback("success", label.id);
	} catch (error) {
		console.warn("[labels] Failed to update resource labels", {
			labelId: label.id,
			resource: drop.resource,
			error,
		});
		if (currentSpaceId === spaceId) {
			setLabelDropFeedback("error", label.id, "Could not update label");
		}
	} finally {
		if (currentSpaceId === spaceId) labelDropBusyId = null;
	}
}

function handleSessionDragStart(
	event: DragEvent,
	session: SessionRecord,
	title: string,
) {
	const path = `/sessions/${session.id}.jsonl`;
	setCohubResourceDragData(
		event.dataTransfer,
		{
			version: 1,
			resources: [
				{
					type: "session",
					ref: session.id,
					title,
					href: currentSpaceId
						? buildSpaceSessionRoute(currentSpaceId, session.id)
						: undefined,
					path,
				},
			],
			origin: { kind: "sidebar-session-list" },
			createdAt: Date.now(),
		},
		{ cohubPath: path, plainText: path, effectAllowed: "copyMove" },
	);
}

function isDraggableLabelItem(
	item: LabelAssignmentListItem,
): item is LabelAssignmentListItem & {
	resourceType: "session" | "checkpoint" | "file";
} {
	return (
		item.resourceType === "session" ||
		item.resourceType === "checkpoint" ||
		item.resourceType === "file"
	);
}

function handleLabelItemDragStart(
	event: DragEvent,
	label: LabelListItem,
	item: LabelAssignmentListItem,
) {
	if (!isDraggableLabelItem(item)) {
		event.preventDefault();
		return;
	}
	const sourceLabelRef = canAssignResourceToLabel(label)
		? (labelRefForId(label.id) ?? label.name)
		: null;
	const resource: LabelAssignableCohubResource = {
		type: item.resourceType,
		ref: item.resourceRef,
		title: item.resource?.title ?? item.resourceRef,
		subtitle: item.resource?.subtitle,
		href: item.href,
		path: item.resourceType === "file" ? item.resourceRef : undefined,
	};
	setCohubResourceDragData(
		event.dataTransfer,
		{
			version: 1,
			resources: [resource],
			origin: sourceLabelRef
				? {
						kind: "label-items",
						labelRef: sourceLabelRef,
						labelName: getReactiveLabelDisplayName(label),
					}
				: undefined,
			createdAt: Date.now(),
		},
		{
			cohubPath:
				item.resourceType === "file"
					? item.resourceRef
					: item.resourceType === "session"
						? `/sessions/${item.resourceRef}.jsonl`
						: undefined,
			plainText: item.resourceRef,
			effectAllowed: "copyMove",
		},
	);
	activeLabelDragOrigin = sourceLabelRef
		? {
				labelId: label.id,
				labelRef: sourceLabelRef,
				labelName: getReactiveLabelDisplayName(label),
			}
		: null;
}

function handleResourceDragEnd() {
	activeLabelDragOrigin = null;
	labelDropTargetId = null;
	clearLabelAutoExpandTimer();
}

async function removeLabelAssignment(
	label: LabelListItem,
	item: LabelAssignmentListItem,
) {
	if (!canAssignResourceToLabel(label) || !currentSpaceId) return;
	if (!isDraggableLabelItem(item)) return;
	const spaceId = currentSpaceId;
	const sourceLabelRef = labelRefForId(label.id);
	if (!sourceLabelRef) return;
	labelDropBusyId = label.id;
	try {
		const result = await removeResourceFromLabel({
			spaceId,
			resource: {
				type: item.resourceType,
				ref: item.resourceRef,
				title: item.resource?.title ?? item.resourceRef,
				subtitle: item.resource?.subtitle,
				href: item.href,
				path: item.resourceType === "file" ? item.resourceRef : undefined,
			},
			sourceLabelRef,
		});
		if (currentSpaceId !== spaceId) return;
		refreshAffectedLabelItems(result);
		setLabelDropFeedback("success", label.id);
	} catch (error) {
		console.warn("[labels] Failed to remove resource label", {
			labelId: label.id,
			resourceType: item.resourceType,
			resourceRef: item.resourceRef,
			error,
		});
		if (currentSpaceId === spaceId) {
			setLabelDropFeedback("error", label.id, "Could not remove label");
		}
	} finally {
		if (currentSpaceId === spaceId) labelDropBusyId = null;
	}
}

function labelAssignmentHref(item: LabelAssignmentListItem) {
	return item.href;
}

function decodeRoutePath(path: string) {
	try {
		return path
			.split("/")
			.map((segment) => decodeURIComponent(segment))
			.join("/");
	} catch {
		return path;
	}
}

function normalizeFileRef(path: string) {
	return decodeRoutePath(path).replace(/^\/+/, "");
}

function isLabelAssignmentActive(item: LabelAssignmentListItem) {
	if (!activeLabelResource || item.resourceType !== activeLabelResource.type) {
		return false;
	}
	if (item.resourceType === "file") {
		return (
			normalizeFileRef(item.resourceRef) ===
			normalizeFileRef(activeLabelResource.ref)
		);
	}
	return item.resourceRef === activeLabelResource.ref;
}

async function loadCronjobsForSpace(spaceId: string, force = false) {
	if (!force && loadingCronjobs && loadingCronjobsSpaceId === spaceId) return;
	const shouldShowLoading = cronjobs.length === 0;
	if (shouldShowLoading) {
		loadingCronjobs = true;
		loadingCronjobsSpaceId = spaceId;
	} else {
		refreshingCronjobs = true;
	}
	try {
		const result = await sdk.cronJobs.list(spaceId);
		if (spaceId === currentSpaceId) cronjobs = result.jobs ?? [];
	} catch (error) {
		console.warn("[sidebar] Failed to load cronjobs", { spaceId, error });
	} finally {
		if (loadingCronjobsSpaceId === spaceId) {
			loadingCronjobs = false;
			loadingCronjobsSpaceId = null;
		}
		refreshingCronjobs = false;
	}
}

async function restoreTasksForSpace(spaceId: string) {
	const cachedRuns = getCachedTaskRuns(spaceId);
	if (cachedRuns.length > 0 && spaceId === currentSpaceId) {
		tasks = cachedRuns.slice(0, TASK_PAGE_SIZE);
	}
	try {
		const restoredRuns = await restoreCachedTaskRuns(spaceId);
		if (spaceId === currentSpaceId)
			tasks = restoredRuns.slice(0, TASK_PAGE_SIZE);
	} catch (error) {
		console.warn("[sidebar] Failed to restore cached tasks", {
			spaceId,
			error,
		});
	}
}

async function loadTasksForSpace(spaceId: string, force = false) {
	if (!force && loadingTasks && loadingTasksSpaceId === spaceId) return;
	const shouldShowLoading = tasks.length === 0;
	if (shouldShowLoading) {
		loadingTasks = true;
		loadingTasksSpaceId = spaceId;
	} else {
		refreshingTasks = true;
	}
	try {
		const result = await sdk.tasks.list({ spaceId, limit: TASK_PAGE_SIZE });
		if (spaceId === currentSpaceId) {
			tasks = result.runs ?? [];
			tasksPageInfo = result.pageInfo ?? { hasMore: false, nextCursor: null };
			setCachedTaskRuns(spaceId, tasks);
		}
	} catch (error) {
		console.warn("[sidebar] Failed to load tasks", { spaceId, error });
	} finally {
		if (loadingTasksSpaceId === spaceId) {
			loadingTasks = false;
			loadingTasksSpaceId = null;
		}
		refreshingTasks = false;
	}
}

async function loadMoreTasksForSpace(spaceId: string) {
	if (loadingMoreTasks) return;
	const cursor = tasksPageInfo.nextCursor;
	if (!cursor) return;
	loadingMoreTasks = true;
	try {
		const result = await sdk.tasks.list({
			spaceId,
			limit: TASK_PAGE_SIZE,
			cursor,
		});
		if (spaceId !== currentSpaceId) return;
		const moreRuns = result.runs ?? [];
		const runById = new Map(tasks.map((run) => [run.id, run]));
		for (const run of moreRuns) runById.set(run.id, run);
		tasks = Array.from(runById.values()).sort(
			(a, b) =>
				(Date.parse(b.createdAt ?? b.updatedAt ?? "") || 0) -
				(Date.parse(a.createdAt ?? a.updatedAt ?? "") || 0),
		);
		tasksPageInfo = result.pageInfo ?? { hasMore: false, nextCursor: null };
		setCachedTaskRuns(spaceId, tasks);
	} catch (error) {
		console.warn("[sidebar] Failed to load more tasks", { spaceId, error });
	} finally {
		loadingMoreTasks = false;
	}
}

async function loadWorksForSpace(spaceId: string, force = false) {
	if (!force && loadingWorks && loadingWorksSpaceId === spaceId) return;
	const shouldShowLoading = works.length === 0;
	if (shouldShowLoading) {
		loadingWorks = true;
		loadingWorksSpaceId = spaceId;
	} else {
		refreshingWorks = true;
	}
	try {
		const result = await sdk.works.listBySpace(spaceId);
		if (spaceId === currentSpaceId) works = result.works ?? [];
	} catch (error) {
		console.warn("[sidebar] Failed to load works", { spaceId, error });
	} finally {
		if (loadingWorksSpaceId === spaceId) {
			loadingWorks = false;
			loadingWorksSpaceId = null;
		}
		refreshingWorks = false;
	}
}

async function handleNavigate(
	href: string,
	options?: { keepSettingsReturn?: boolean },
) {
	onClose?.();
	if (options?.keepSettingsReturn && mode === "settings") {
		const target = new URL(href, page.url);
		const from = page.url.searchParams.get("from");
		if (from && !target.searchParams.has("from")) {
			target.searchParams.set("from", from);
		}
		await goto(target.pathname + target.search + target.hash);
		return;
	}
	await goto(href);
}

function openSettings() {
	const current = `${page.url.pathname}${page.url.search}${page.url.hash}`;
	const target = new URL("/settings/profile", page.url);
	if (!current.startsWith("/settings")) {
		target.searchParams.set("from", current);
	}
	showUserMenu = false;
	void handleNavigate(target.pathname + target.search + target.hash);
}

function openBillingSettings() {
	const current = `${page.url.pathname}${page.url.search}${page.url.hash}`;
	const target = new URL("/settings/billing", page.url);
	if (!current.startsWith("/settings")) {
		target.searchParams.set("from", current);
	} else {
		const from = page.url.searchParams.get("from");
		if (from) target.searchParams.set("from", from);
	}
	showUserMenu = false;
	void handleNavigate(target.pathname + target.search + target.hash);
}

function returnFromSettings() {
	void handleNavigate(settingsReturnTo);
}

function openHelpPanel() {
	showUserMenu = false;
	onClose?.();
	window.dispatchEvent(new CustomEvent("cohub:open-help-panel"));
}

function openCommandPalette() {
	onClose?.();
	window.dispatchEvent(new CustomEvent("cohub:open-command-palette"));
}

function openSpacePalette() {
	onClose?.();
	window.dispatchEvent(
		new CustomEvent("cohub:open-command-palette", {
			detail: {
				title: "Switch Space",
				query: "a: ",
				placeholder: "Search spaces…",
				refreshSpaces: true,
			},
		}),
	);
}

function buildPreferredSessionRoute(spaceId: string, sessionId: string) {
	return buildSpaceSessionRoute(spaceId, sessionId);
}

async function handleNavigateToSession(sessionId: string) {
	if (sessionNavigateClickTimer) {
		clearTimeout(sessionNavigateClickTimer);
		sessionNavigateClickTimer = null;
	}
	onClose?.();
	const session = sessions.find((s) => s.id === sessionId);
	unreadTracker.markViewed(sessionId, session?.lastMessageId ?? null);
	if (!currentSpaceId) return;
	await goto(buildPreferredSessionRoute(currentSpaceId, sessionId));
}

async function handleNavigateToCheckpoint(checkpointId: string) {
	onClose?.();
	if (!currentSpaceId) return;
	await goto(buildSpaceCheckpointRoute(currentSpaceId, checkpointId));
}

async function handleNavigateToNewCheckpoint() {
	onClose?.();
	if (!currentSpaceId) return;
	await goto(buildSpaceCheckpointNewRoute(currentSpaceId));
}

async function handleNavigateToCronjob(cronjobId: string) {
	onClose?.();
	if (!currentSpaceId) return;
	await goto(buildSpaceCronjobRoute(currentSpaceId, cronjobId));
}

async function handleNavigateToNewCronjob() {
	onClose?.();
	if (!currentSpaceId) return;
	await goto(buildSpaceCronjobNewRoute(currentSpaceId));
}

async function handleNavigateToTask(taskId: string) {
	onClose?.();
	if (!currentSpaceId) return;
	await goto(buildSpaceTaskRoute(currentSpaceId, taskId));
}

function getCurrentSpaceOwnerUsername() {
	return (
		currentSpace?.ownerProfile?.username ??
		(currentSpace?.userUuid === authStore.userUuid
			? authStore.profile?.username
			: null)
	);
}

async function handleNavigateToWork(workId: string) {
	onClose?.();
	if (!currentSpaceId) return;
	await goto(buildSpaceWorkRoute(currentSpaceId, workId));
}

function handleWorksChanged(event: Event) {
	const detail = (event as CustomEvent<{ spaceId?: string }>).detail;
	if (!currentSpaceId || detail?.spaceId !== currentSpaceId) return;
	void loadWorksForSpace(currentSpaceId, true);
}

async function handleCreateNewSession() {
	if (!currentSpaceId || creatingSession) return;
	createSessionError = "";
	try {
		await goto(buildSpaceNewSessionRoute(currentSpaceId), {
			keepFocus: true,
			noScroll: true,
		});
		onClose?.();
		requestAnimationFrame(() => {
			window.dispatchEvent(new CustomEvent("cohub:composer-focus"));
		});
	} catch (error) {
		createSessionError =
			error instanceof Error ? error.message : "Failed to open new chat";
	}
}

function insertPathReference(path: string) {
	insertComposerSnippet(` \`${path}\` `);
	onClose?.();
}

// ── Session rename ──────────────────────────────────────────────────────

function startRenameSession(session: SessionRecord) {
	renamingSessionId = session.id;
	renameTitleValue = session.title ?? getSessionTitle(session, 0);
	void tick().then(() => {
		renameInputElement?.focus();
		renameInputElement?.select();
	});
}

function scheduleSessionRowNavigate(sessionId: string) {
	if (sessionNavigateClickTimer) clearTimeout(sessionNavigateClickTimer);
	sessionNavigateClickTimer = setTimeout(() => {
		sessionNavigateClickTimer = null;
		void handleNavigateToSession(sessionId);
	}, SESSION_ROW_NAVIGATE_DELAY_MS);
}

function handleSessionRowDoubleClick(
	event: MouseEvent,
	session: SessionRecord,
) {
	event.preventDefault();
	event.stopPropagation();
	if (sessionNavigateClickTimer) {
		clearTimeout(sessionNavigateClickTimer);
		sessionNavigateClickTimer = null;
	}
	startRenameSession(session);
}

function cancelRenameSession() {
	renamingSessionId = null;
	renameTitleValue = "";
}

async function submitRenameSession(session: SessionRecord) {
	if (renameSaving || !currentSpaceId) return;
	const trimmed = renameTitleValue.trim();
	if (!trimmed) {
		cancelRenameSession();
		return;
	}
	if (trimmed === (session.title ?? getSessionTitle(session, 0))) {
		cancelRenameSession();
		return;
	}
	renameSaving = true;
	try {
		await sdk.space(currentSpaceId).session(session.id).rename(trimmed);
		const renamedSession = { ...session, title: trimmed };
		sessions = sessions.map((s) =>
			s.id === session.id ? { ...s, title: trimmed } : s,
		);
		if (labelSessionDetailsBySpace[currentSpaceId]?.[session.id]) {
			labelSessionDetailsBySpace = {
				...labelSessionDetailsBySpace,
				[currentSpaceId]: {
					...labelSessionDetailsBySpace[currentSpaceId],
					[session.id]: renamedSession,
				},
			};
		}
		void setCachedSessionDetails(currentSpaceId, [renamedSession]).catch(
			() => undefined,
		);
		void patchCachedSessionList(currentSpaceId, (current) =>
			current.map((s) => (s.id === session.id ? { ...s, title: trimmed } : s)),
		).catch(() => undefined);
	} catch {
		// Silently fail
	} finally {
		renameSaving = false;
		cancelRenameSession();
	}
}

function isUserLabel(label: LabelListItem) {
	return label.source === "user";
}

function canManageUserLabel(label: LabelListItem) {
	return canManageLabels && isUserLabel(label);
}

function canRenameLabel(label: LabelListItem) {
	return canManageUserLabel(label);
}

function canDeleteLabel(label: LabelListItem) {
	return canManageUserLabel(label);
}

function startRenameLabel(label: LabelListItem) {
	if (!canRenameLabel(label)) return;
	renamingLabelId = label.id;
	renameLabelValue = label.name;
	void tick().then(() => {
		renameLabelInputElement?.focus();
		renameLabelInputElement?.select();
	});
}

function cancelRenameLabel() {
	renamingLabelId = null;
	renameLabelValue = "";
}

async function deleteLabel(label: LabelListItem) {
	if (deletingLabelId || !currentSpaceId || !canDeleteLabel(label)) return;
	if (label.children?.length) {
		window.alert("Delete child labels first.");
		return;
	}
	const labelRef = labelRefForId(label.id);
	if (!labelRef) {
		window.alert("Label not found.");
		return;
	}
	const confirmed = window.confirm(
		`Delete “${label.name}”?\n\nThis removes the label and its item assignments. This cannot be undone.`,
	);
	if (!confirmed) return;

	deletingLabelId = label.id;
	try {
		if (renamingLabelId === label.id) cancelRenameLabel();
		await sdk.space(currentSpaceId).labels.delete(labelRef);
		labels = await fetchSpaceLabelsFresh(currentSpaceId);
		const nextExpanded = new Set(currentExpandedLabelIds);
		nextExpanded.delete(label.id);
		expandedLabelIdsBySpace = {
			...expandedLabelIdsBySpace,
			[currentSpaceId]: nextExpanded,
		};
		setCachedExpandedLabelIds(currentSpaceId, nextExpanded);
	} catch (error) {
		console.warn("[labels] Failed to delete label", {
			labelId: label.id,
			error,
		});
		window.alert(
			error instanceof Error ? error.message : "Failed to delete label.",
		);
	} finally {
		deletingLabelId = null;
	}
}

async function submitRenameLabel(label: LabelListItem) {
	if (renameLabelSaving || !currentSpaceId || !canRenameLabel(label)) return;
	const trimmed = renameLabelValue.trim();
	if (!trimmed || trimmed === label.name) {
		cancelRenameLabel();
		return;
	}
	const labelRef = labelRefForId(label.id);
	if (!labelRef) {
		cancelRenameLabel();
		return;
	}

	renameLabelSaving = true;
	try {
		await sdk.space(currentSpaceId).labels.update(labelRef, { name: trimmed });
		labels = replaceLabelInTree(labels, label.id, (item) => ({
			...item,
			name: trimmed,
		}));
		labels = await fetchSpaceLabelsFresh(currentSpaceId);
	} catch (error) {
		console.warn("[labels] Failed to rename label", {
			labelId: label.id,
			error,
		});
	} finally {
		renameLabelSaving = false;
		cancelRenameLabel();
	}
}

function handleLabelRowClick(label: LabelListItem) {
	if (renamingLabelId === label.id) return;
	toggleLabelExpanded(label.id);
}

function handleLabelRowKeydown(event: KeyboardEvent, label: LabelListItem) {
	if (renamingLabelId === label.id) return;
	if (event.key !== "Enter" && event.key !== " ") return;
	event.preventDefault();
	toggleLabelExpanded(label.id);
}

function handleLabelRenameKeydown(event: KeyboardEvent, label: LabelListItem) {
	if (
		event.key === "Enter" &&
		!renameLabelSaving &&
		!isComposingKeyboardEvent(event)
	) {
		event.preventDefault();
		void submitRenameLabel(label);
		return;
	}
	if (event.key === "Escape" && !renameLabelSaving) {
		event.preventDefault();
		cancelRenameLabel();
	}
}

function normalizeSessionDisplayText(value: string | null | undefined) {
	return formatSpaceMentionTextForDisplay(value ?? "")
		.replace(/\s+/g, " ")
		.replace(/^[:\-\s]+/, "")
		.trim();
}

function getSessionTitle(session: SessionRecord, _index: number) {
	const candidates = [session.title, session.latestMessageText];
	for (const candidate of candidates) {
		const normalized = normalizeSessionDisplayText(candidate);
		if (normalized) return normalized.slice(0, 36);
	}
	return "New chat";
}

function isLikelyDefaultForkTitle(
	session: SessionRecord,
	fork: SessionForkSidebarRecord | null,
) {
	if (!fork) return false;
	const childTitle = normalizeSessionDisplayText(session.title);
	if (!childTitle) return true;
	const parentTitle = normalizeSessionDisplayText(fork.parentTitle);
	return Boolean(parentTitle && childTitle === parentTitle);
}

function buildForkTitle(
	session: SessionRecord,
	fork: SessionForkSidebarRecord | null,
) {
	const forkText = normalizeSessionDisplayText(fork?.firstUserTextAfterFork);
	if (forkText && isLikelyDefaultForkTitle(session, fork))
		return forkText.slice(0, 48);
	return getSessionTitle(session, 0);
}

function getSessionRowStyle(item: SidebarSessionItem) {
	if (!item.isFork)
		return isMobile
			? "-webkit-touch-callout: none; user-select: none;"
			: undefined;
	const depth = isMobile ? Math.min(item.visualDepth, 1) : item.visualDepth;
	const indent = Math.min(depth, 3) * (isMobile ? 10 : 12);
	const base = `--fork-indent: ${indent}px;`;
	return isMobile
		? `${base} -webkit-touch-callout: none; user-select: none;`
		: base;
}

function getSessionActiveTime(session: SessionRecord) {
	return getSessionSortTime(session);
}

function buildSidebarSessionItems(
	sessionList: SessionRecord[],
): SidebarSessionItem[] {
	const sessionById = new Map(
		sessionList.map((session) => [session.id, session]),
	);
	const forkByChildId = new Map(
		sessionForks.map((fork) => [fork.childSessionId, fork]),
	);
	const childrenByParentId = new Map<string, SessionRecord[]>();
	const childIndexById = new Map<string, number>();
	const childCountByParentId = new Map<string, number>();

	for (const session of sessionList) {
		const fork = forkByChildId.get(session.id);
		if (!fork?.parentSessionId || !sessionById.has(fork.parentSessionId))
			continue;
		const siblings = childrenByParentId.get(fork.parentSessionId) ?? [];
		siblings.push(session);
		childrenByParentId.set(fork.parentSessionId, siblings);
	}

	const groupActiveTime = new Map<string, number>();
	const getGroupActiveTime = (
		session: SessionRecord,
		seen = new Set<string>(),
	) => {
		const cachedActiveTime = groupActiveTime.get(session.id);
		if (cachedActiveTime !== undefined) return cachedActiveTime;
		if (seen.has(session.id)) return getSessionActiveTime(session);
		seen.add(session.id);
		let activeTime = getSessionActiveTime(session);
		for (const child of childrenByParentId.get(session.id) ?? []) {
			activeTime = Math.max(activeTime, getGroupActiveTime(child, seen));
		}
		seen.delete(session.id);
		groupActiveTime.set(session.id, activeTime);
		return activeTime;
	};

	const compareSessions = (a: SessionRecord, b: SessionRecord) => {
		const activeDelta = getGroupActiveTime(b) - getGroupActiveTime(a);
		if (activeDelta !== 0) return activeDelta;
		return b.id.localeCompare(a.id);
	};

	for (const [parentId, children] of childrenByParentId) {
		const sortedChildren = children.sort(compareSessions);
		childCountByParentId.set(parentId, sortedChildren.length);
		sortedChildren.forEach((child, index) => {
			childIndexById.set(child.id, index);
		});
	}

	const roots = sessionList
		.filter((session) => {
			const fork = forkByChildId.get(session.id);
			return !fork?.parentSessionId || !sessionById.has(fork.parentSessionId);
		})
		.sort(compareSessions);

	const items: SidebarSessionItem[] = [];
	const appendSession = (
		session: SessionRecord,
		visualDepth: number,
		seen = new Set<string>(),
	) => {
		if (seen.has(session.id)) return;
		seen.add(session.id);
		const fork = forkByChildId.get(session.id) ?? null;
		const parentVisible = Boolean(
			fork?.parentSessionId && sessionById.has(fork.parentSessionId),
		);
		const connectedFork = parentVisible ? fork : null;
		const displayTitle = connectedFork
			? buildForkTitle(session, connectedFork)
			: getSessionTitle(session, 0);
		const source = connectedFork?.parentTitle
			? `Forked from “${normalizeSessionDisplayText(connectedFork.parentTitle)}”`
			: "Forked from another chat";
		const turn = connectedFork?.anchorSequence
			? ` at turn #${connectedFork.anchorSequence}`
			: "";
		const tooltip = connectedFork ? `${source}${turn}` : undefined;
		const childIndex = childIndexById.get(session.id);
		const childCount = fork?.parentSessionId
			? childCountByParentId.get(fork.parentSessionId)
			: undefined;
		const isLastVisibleChild = Boolean(
			connectedFork &&
				childIndex !== undefined &&
				childCount !== undefined &&
				childIndex === childCount - 1,
		);
		items.push({
			session,
			depth: connectedFork?.depth ?? 0,
			visualDepth: connectedFork ? visualDepth : 0,
			isFork: Boolean(connectedFork),
			parentVisible,
			isLastVisibleChild,
			fork: connectedFork,
			displayTitle,
			titleText: tooltip,
			ariaLabel: tooltip ? `${displayTitle}, ${tooltip}` : displayTitle,
		});

		const children = childrenByParentId.get(session.id) ?? [];
		for (const child of children) appendSession(child, visualDepth + 1, seen);
		seen.delete(session.id);
	};

	for (const root of roots) appendSession(root, 0);
	return items;
}

function buildLabelSessionItems(items: LabelAssignmentListItem[]) {
	const labelSessions = items
		.filter((item) => item.resourceType === "session")
		.map((item) => labelSessionsById.get(item.resourceRef))
		.filter((session): session is SessionRecord => Boolean(session));
	return buildSidebarSessionItems(labelSessions);
}

function orderLabelItemsBySessionTree(
	items: LabelAssignmentListItem[],
	sessionItems: SidebarSessionItem[],
) {
	const sessionItemByRef = new Map(
		items
			.filter((item) => item.resourceType === "session")
			.map((item) => [item.resourceRef, item]),
	);
	const orderedSessionItems = sessionItems
		.map((sessionItem) => sessionItemByRef.get(sessionItem.session.id))
		.filter((item): item is LabelAssignmentListItem => Boolean(item));
	const orderedSessionRefs = new Set(
		orderedSessionItems.map((item) => item.resourceRef),
	);
	const remainingSessionItems = items.filter(
		(item) =>
			item.resourceType === "session" &&
			!orderedSessionRefs.has(item.resourceRef),
	);
	const sessionQueue = [...orderedSessionItems, ...remainingSessionItems];
	return items.map((item) =>
		item.resourceType === "session" ? (sessionQueue.shift() ?? item) : item,
	);
}

async function handleLogout() {
	onClose?.();
	const commandPaletteRecentKey = `cohub:command-palette:recent:${encodeURIComponent(getCacheUserKey())}`;
	try {
		localStorage.removeItem(commandPaletteRecentKey);
	} catch {
		// Ignore storage cleanup failures during logout.
	}
	clearAllCachedSpaceLists();
	await clearAllIndexedDbCache().catch((error) => {
		console.warn("[sidebar] Failed to clear IndexedDB cache", error);
	});
	const userUuid = authStore.userUuid;
	if (userUuid) clearRecentSpace(userUuid);
	if (userUuid) clearGrantedWorkScopes(userUuid);
	try {
		await logtoClient.signOut(`${window.location.origin}/`);
	} catch (error) {
		console.error("[sidebar] Failed to sign out", error);
	}
}

function saveDebugLog() {
	showUserMenu = false;
	onClose?.();
	downloadCohubDebugBundle();
}

function handleGlobalNewChatKeydown(event: KeyboardEvent) {
	if (isComposingKeyboardEvent(event)) return;
	const key = event.key.toLowerCase();
	const isNewChatShortcut = (event.metaKey || event.ctrlKey) && key === "o";
	if (isNewChatShortcut) {
		event.preventDefault();
		void handleCreateNewSession();
	}
}

onMount(() => {
	void modelsCatalogStore.load().catch((error) => {
		console.error("Failed to load models catalog:", error);
	});
	let offSpaceListCacheUpdated = () => {};
	let offSessionListCacheUpdated = () => {};
	let offSpaceLabelsCacheUpdated = () => {};
	let offUserLabelProfilesUpdated = () => {};
	let offTaskRunsCacheUpdated = () => {};
	if (mode === "space") {
		offSpaceListCacheUpdated = onSpaceListCacheUpdated(
			({ spaces: nextSpaces }) => {
				if (!authStore.isAuthenticated) return;
				spaces = mergeSpaceListWithCurrent(nextSpaces);
			},
		);
		offSessionListCacheUpdated = onSessionListCacheUpdated(
			({ spaceId, sessions: nextSessions, forks, pageInfo }) => {
				if (spaceId !== currentSpaceId) return;
				const previousSessionsById = new Map(
					sessions.map((session) => [session.id, session]),
				);
				const shouldPreserveLoadedPageInfo =
					sessions.length > nextSessions.length;
				let shouldRefreshActivityLabels = false;
				sessions = mergeSessionSnapshotForDisplay(sessions, nextSessions);
				for (const session of nextSessions) {
					const previous = previousSessionsById.get(session.id);
					if (!previous) {
						optimisticPrependWebAppLabelSession(spaceId, session);
						continue;
					}
					if (didSessionActivityChange(previous, session)) {
						shouldRefreshActivityLabels = true;
					}
				}
				if (shouldRefreshActivityLabels)
					refreshExpandedSessionActivityLabels(spaceId);
				sessionForks = forks ?? [];
				if (pageInfo && !shouldPreserveLoadedPageInfo)
					sessionsPageInfo = pageInfo;
				exhaustedFallbackSessionCursor = null;
			},
		);
		offSpaceLabelsCacheUpdated = onSpaceLabelsCacheUpdated(
			({ spaceId, labels: nextLabels }) => {
				if (spaceId !== currentSpaceId) return;
				labels = nextLabels;
				pruneExpandedLabelIds(spaceId, nextLabels);
				void hydrateUserProfilesForLabels(nextLabels).catch(() => undefined);
			},
		);
		offUserLabelProfilesUpdated = onUserLabelProfilesUpdated(() => {
			userLabelProfileVersion += 1;
		});
		void hydrateUserProfilesForLabels(labels).catch(() => undefined);
		offTaskRunsCacheUpdated = onTaskRunsCacheUpdated(({ spaceId, runs }) => {
			if (spaceId !== currentSpaceId) return;
			tasks = runs;
		});
		window.addEventListener("keydown", handleGlobalNewChatKeydown);
		window.addEventListener(
			"cohub:works-changed",
			handleWorksChanged as EventListener,
		);
		void (async () => {
			await loadSpaces();
			void hydrateUserProfilesForLabels(labels).catch(() => undefined);

			window.addEventListener(
				"cohub:space-created",
				handleSpaceCreated as EventListener,
			);
			window.addEventListener(
				"cohub:checkpoints-updated",
				handleCheckpointsUpdated as EventListener,
			);
			window.addEventListener(
				"cohub:cronjobs-updated",
				handleCronjobsUpdated as EventListener,
			);
			window.addEventListener(
				"cohub:label-assignments-updated",
				handleLabelAssignmentsUpdated as EventListener,
			);
		})();
	}

	function handleSpaceCreated() {
		void loadSpaces(true);
	}

	function handleCheckpointsUpdated(e: Event) {
		const custom = e as CustomEvent;
		if (custom.detail?.spaceId === currentSpaceId && currentSpaceId) {
			void loadCheckpointsForSpace(currentSpaceId, true);
		}
	}

	function handleCronjobsUpdated(e: Event) {
		const custom = e as CustomEvent;
		if (custom.detail?.spaceId === currentSpaceId && currentSpaceId) {
			void loadCronjobsForSpace(currentSpaceId, true);
		}
	}

	function handleLabelAssignmentsUpdated(e: Event) {
		const custom = e as CustomEvent<{
			spaceId?: string;
			affectedLabelIds?: string[];
		}>;
		const spaceId = custom.detail?.spaceId;
		if (!spaceId || spaceId !== currentSpaceId) return;
		const expanded = expandedLabelIdsBySpace[spaceId];
		if (!expanded) return;
		for (const labelId of custom.detail?.affectedLabelIds ?? []) {
			if (expanded.has(labelId)) void loadLabelItems(labelId, { force: true });
			else void markLabelItemsStale(spaceId, labelId);
		}
	}

	function handleClickOutside(e: MouseEvent) {
		const target = e.target;
		if (!(target instanceof Element)) return;
		if (!target.closest("[data-user-menu]")) {
			showUserMenu = false;
		}
		if (
			renamingSessionId &&
			!renameSaving &&
			!target.closest("[data-session-rename]")
		) {
			cancelRenameSession();
		}
	}
	document.addEventListener("click", handleClickOutside);

	return () => {
		offSpaceListCacheUpdated();
		offSessionListCacheUpdated();
		offSpaceLabelsCacheUpdated();
		offUserLabelProfilesUpdated();
		offTaskRunsCacheUpdated();
		document.removeEventListener("click", handleClickOutside);
		if (mode === "space") {
			window.removeEventListener("keydown", handleGlobalNewChatKeydown);
			window.removeEventListener(
				"cohub:works-changed",
				handleWorksChanged as EventListener,
			);
			window.removeEventListener(
				"cohub:space-created",
				handleSpaceCreated as EventListener,
			);
			window.removeEventListener(
				"cohub:checkpoints-updated",
				handleCheckpointsUpdated as EventListener,
			);
			window.removeEventListener(
				"cohub:cronjobs-updated",
				handleCronjobsUpdated as EventListener,
			);
			window.removeEventListener(
				"cohub:label-assignments-updated",
				handleLabelAssignmentsUpdated as EventListener,
			);
		}
	};
});

// Always load the space addressed by the current URL directly. The global
// space list is only a switcher data source and may omit guest-access spaces.
$effect(() => {
	const userId = authStore.userUuid;
	if (!authStore.isAuthenticated || !userId) {
		clearBillingCredit();
		return;
	}
	if (billingCreditUserId && billingCreditUserId !== userId) {
		clearBillingCredit();
	}
	if (!showUserMenu) return;
	untrack(() => {
		void refreshBillingCredit();
		void refreshBillingPlan();
	});
});

$effect(() => {
	if (mode !== "space") return;
	const id = currentSpaceId;
	if (!id) return;

	untrack(() => {
		void loadCurrentSpaceFromUrl(id);
	});
});

$effect(() => {
	if (mode !== "space") return;
	const id = currentSpaceId;
	if (id) {
		sessions = [];
		sessionForks = [];
		labels = [];
		checkpoints = [];
		cronjobs = [];
		tasks = [];
		works = [];
		sessionsPageInfo = { hasMore: false, nextCursor: null };
		exhaustedFallbackSessionCursor = null;
		loadingSessions = false;
		loadingSessionsSpaceId = null;
		refreshingSessions = false;
		loadingLabels = false;
		refreshingLabels = false;
		loadingCheckpoints = false;
		loadingCheckpointsSpaceId = null;
		refreshingCheckpoints = false;
		loadingCronjobs = false;
		loadingCronjobsSpaceId = null;
		refreshingCronjobs = false;
		loadingTasks = false;
		loadingTasksSpaceId = null;
		refreshingTasks = false;
		loadingMoreTasks = false;
		tasksPageInfo = { hasMore: false, nextCursor: null };
		loadingWorks = false;
		loadingWorksSpaceId = null;
		refreshingWorks = false;
		labelDropTargetId = null;
		labelDropBusyId = null;
		labelDropErrorMessage = null;
		activeLabelDragOrigin = null;
		cancelRenameLabel();
		clearLabelAutoExpandTimer();
		untrack(() => {
			restoreExpandedLabelIds(id);
			void loadSessionsForSpace(id);
			void loadLabelsForSpace(id);
			void loadCheckpointsForSpace(id, true);
			void loadCronjobsForSpace(id, true);
			void loadWorksForSpace(id, true);
		});
	} else {
		sessions = [];
		sessionForks = [];
		labels = [];
		sessionsPageInfo = { hasMore: false, nextCursor: null };
		exhaustedFallbackSessionCursor = null;
		checkpoints = [];
		cronjobs = [];
		tasks = [];
		works = [];
		loadingSessions = false;
		loadingSessionsSpaceId = null;
		refreshingSessions = false;
		loadingLabels = false;
		refreshingLabels = false;
		loadingCheckpoints = false;
		loadingCheckpointsSpaceId = null;
		refreshingCheckpoints = false;
		loadingCronjobs = false;
		loadingCronjobsSpaceId = null;
		refreshingCronjobs = false;
		loadingTasks = false;
		loadingTasksSpaceId = null;
		refreshingTasks = false;
		loadingMoreTasks = false;
		tasksPageInfo = { hasMore: false, nextCursor: null };
		labelDropTargetId = null;
		labelDropBusyId = null;
		labelDropErrorMessage = null;
		activeLabelDragOrigin = null;
		cancelRenameLabel();
		clearLabelAutoExpandTimer();
	}
});

// Track the most recently visited space in localStorage
$effect(() => {
	if (mode !== "space") return;
	const userUuid = authStore.userUuid;
	if (!userUuid || !currentSpaceId) return;
	untrack(() => {
		const sessionId = activeSession?.id ?? null;
		setRecentSpace(userUuid, currentSpaceId, sessionId);
	});
});
</script>

{#snippet syncSpinner(active: boolean, className = "")}
	{#if active}
		<Loader2 class={`h-3 w-3 animate-spin text-text-placeholder ${className}`} aria-label="Syncing" />
	{/if}
{/snippet}

{#snippet sidebarEmptyState(message: string, loading = false)}
	<div class="flex min-h-8 items-center gap-2 rounded-[6px] px-2 py-2 text-[12px] text-text-placeholder">
		{#if loading}
			<Loader2 class="h-3 w-3 animate-spin text-text-tertiary" />
		{/if}
		<span>{message}</span>
	</div>
{/snippet}

{#snippet labelAssignmentRows(label: LabelListItem, depth: number)}
	{@const items = currentLabelItemsById[label.id] ?? []}
	{@const hasChildLabels = Boolean(label.children?.length)}
	{#if currentExpandedLabelIds.has(label.id)}
		{@const useSessionTreeOrder = isSessionActivityLabel(label)}
		{@const labelSessionItems = useSessionTreeOrder ? buildLabelSessionItems(items) : []}
		{@const labelSessionItemById = new Map(labelSessionItems.map((item) => [item.session.id, item]))}
		{@const orderedItems = useSessionTreeOrder ? orderLabelItemsBySessionTree(items, labelSessionItems) : items}
		{@const canEditLabelItems = canAssignResourceToLabel(label)}
		{#if items.length === 0 && !hasChildLabels}
			{#if currentLoadingLabelIds.has(label.id)}
				<div class="flex items-center gap-2 py-1 pr-1.5 pl-2 text-[12px] text-text-tertiary"><Loader2 class="h-3 w-3 animate-spin" /> Loading…</div>
			{:else}
				<div class="py-1 pr-1.5 pl-2 text-[12px] text-text-tertiary">No items</div>
			{/if}
		{:else if orderedItems.length > 0}
			<div class="space-y-[1px]">
				{#each orderedItems as item (item.id)}
					{@const isActive = isLabelAssignmentActive(item)}
					{@const itemDraggable = isDraggableLabelItem(item)}
					{@const labelRemoveTitle = `Remove from “${getReactiveLabelDisplayName(label)}”`}
					{#if item.resourceType === "session" && labelSessionsById.get(item.resourceRef)}
						{@const session = labelSessionsById.get(item.resourceRef)!}
						{@const sessionItem = labelSessionItemById.get(session.id)}
						<SidebarSessionRow
							{session}
							title={sessionItem?.displayTitle ?? getSessionTitle(session, 0)}
							href={buildPreferredSessionRoute(currentSpaceId!, session.id)}
							active={isActive}
							{isMobile}
							modelsCatalog={modelsCatalog ?? undefined}
							renaming={renamingSessionId === session.id}
							renameValue={renameTitleValue}
							renameSaving={renameSaving}
							rowState={sessionItem
								? {
										isFork: sessionItem.isFork,
										isLastVisibleChild: sessionItem.isLastVisibleChild,
										style: getSessionRowStyle(sessionItem),
										titleText: sessionItem.titleText || sourceTooltip(session.source) || undefined,
										ariaLabel: sessionItem.ariaLabel,
									}
								: { titleText: sourceTooltip(session.source) || undefined }}
							draggable={itemDraggable}
							removeLabelTitle={canEditLabelItems ? labelRemoveTitle : undefined}
							removeLabelDisabled={labelDropBusyId === label.id}
							onNavigate={(target) => void handleNavigateToSession(target.id)}
							onDoubleClick={handleSessionRowDoubleClick}
							onInsert={insertPathReference}
							onRename={startRenameSession}
							onRenameValueChange={(value) => { renameTitleValue = value; }}
							onSubmitRename={(target) => void submitRenameSession(target)}
							onCancelRename={cancelRenameSession}
							onRemoveLabel={canEditLabelItems ? () => void removeLabelAssignment(label, item) : undefined}
							onDragStart={(event) => handleLabelItemDragStart(event, label, item)}
							onDragEnd={handleResourceDragEnd}
						/>
					{:else if item.resourceType === "checkpoint" && checkpointsById.get(item.resourceRef)}
						{@const checkpoint = checkpointsById.get(item.resourceRef)!}
						<SidebarCheckpointRow
							{checkpoint}
							href={buildSpaceCheckpointRoute(currentSpaceId!, checkpoint.id)}
							active={isActive}
							removeLabelTitle={canEditLabelItems ? labelRemoveTitle : undefined}
							removeLabelDisabled={labelDropBusyId === label.id}
							onNavigate={(target) => void handleNavigateToCheckpoint(target.id)}
							onRemoveLabel={canEditLabelItems ? () => void removeLabelAssignment(label, item) : undefined}
						/>
					{:else if item.resourceType === "file"}
						<SidebarFileRow
							path={item.resourceRef}
							title={item.resource?.title ?? item.resourceRef.split("/").filter(Boolean).at(-1) ?? item.resourceRef}
							subtitle={item.resource?.subtitle ?? null}
							href={labelAssignmentHref(item)}
							active={isActive}
							{isMobile}
							removeLabelTitle={canEditLabelItems ? labelRemoveTitle : undefined}
							removeLabelDisabled={labelDropBusyId === label.id}
							onNavigate={() => void handleNavigate(labelAssignmentHref(item))}
							onInsert={insertPathReference}
							onRemoveLabel={canEditLabelItems ? () => void removeLabelAssignment(label, item) : undefined}
						/>
					{:else}
						<SidebarFallbackResourceRow
							{item}
							active={isActive}
							removeLabelTitle={canEditLabelItems ? labelRemoveTitle : undefined}
							removeLabelDisabled={labelDropBusyId === label.id}
							onNavigate={(href) => void handleNavigate(href)}
							onRemoveLabel={canEditLabelItems ? () => void removeLabelAssignment(label, item) : undefined}
						/>
					{/if}
				{/each}
			</div>
			{#if currentLabelItemsPageInfoById[label.id]?.hasMore}
				<button
					type="button"
					class="mt-0.5 rounded-[5px] px-2 py-1 text-[11px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
					disabled={currentLoadingLabelIds.has(label.id)}
					onclick={() => void loadLabelItems(label.id, { append: true })}
				>
					{#if currentLoadingLabelIds.has(label.id)}Loading…{:else}Load more{/if}
				</button>
			{/if}
		{/if}
	{/if}
{/snippet}

{#snippet labelTreeRows(labelItems: LabelListItem[])}
	{#each labelItems as label (label.id)}
		<div
			role="button"
			tabindex="0"
			class="label-tree-row group/label"
			class:drop-target={labelDropTargetId === label.id}
			class:drop-busy={labelDropBusyId === label.id}
			class:drop-success={labelDropSuccessId === label.id}
			class:drop-error={labelDropErrorId === label.id}
			class:renaming={renamingLabelId === label.id}
			onclick={() => handleLabelRowClick(label)}
			onkeydown={(event) => handleLabelRowKeydown(event, label)}
			ondragover={(event) => handleLabelDragOver(event, label)}
			ondragleave={(event) => handleLabelDragLeave(event, label)}
			ondrop={(event) => handleLabelDrop(event, label)}
		>
			<ChevronDown class="h-3 w-3 shrink-0 transition-transform {currentExpandedLabelIds.has(label.id) ? '' : '-rotate-90'}" />
			{#if renamingLabelId === label.id}
				<input
					bind:this={renameLabelInputElement}
					bind:value={renameLabelValue}
					class="label-rename-input"
					disabled={renameLabelSaving}
					onclick={(event) => event.stopPropagation()}
					onkeydown={(event) => handleLabelRenameKeydown(event, label)}
				/>
				<span class="ml-auto inline-flex shrink-0 items-center gap-0.5">
					<button type="button" class="rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover-strong hover:text-text-primary disabled:opacity-50" title="Save" disabled={renameLabelSaving} onclick={(event) => { event.preventDefault(); event.stopPropagation(); void submitRenameLabel(label); }}>
						{#if renameLabelSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Check class="h-3.5 w-3.5" />{/if}
					</button>
					<button type="button" class="rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover-strong hover:text-text-primary disabled:opacity-50" title="Cancel" disabled={renameLabelSaving} onclick={(event) => { event.preventDefault(); event.stopPropagation(); cancelRenameLabel(); }}>
						<X class="h-3.5 w-3.5" />
					</button>
				</span>
			{:else}
				{@const labelProfile = getReactiveLabelUserProfile(label)}
				{#if labelProfile || isSessionUserLabel(label)}
					<UserAvatar name={getReactiveLabelDisplayName(label)} avatarUrl={labelProfile?.avatarUrl} size="xxs" class="border-0 bg-bg-elevated" />
				{/if}
				<span class="min-w-0 flex-1 truncate" title={getReactiveLabelDisplayTitle(label)}>{getReactiveLabelDisplayName(label)}</span>
				{#if canManageUserLabel(label)}
					<span class="label-row-actions">
						<button type="button" class="rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover-strong hover:text-text-primary disabled:opacity-50" draggable="false" title="Rename" disabled={deletingLabelId === label.id} onclick={(event) => { event.preventDefault(); event.stopPropagation(); startRenameLabel(label); }}>
							<Pencil class="h-3.5 w-3.5" />
						</button>
						<button type="button" class="rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover-strong hover:text-status-error disabled:opacity-50" draggable="false" title="Delete" disabled={deletingLabelId === label.id} onclick={(event) => { event.preventDefault(); event.stopPropagation(); void deleteLabel(label); }}>
							{#if deletingLabelId === label.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 class="h-3.5 w-3.5" />{/if}
						</button>
					</span>
				{/if}
			{/if}
		</div>
		{@render labelAssignmentRows(label, 0)}
		{#if currentExpandedLabelIds.has(label.id)}
			{#each label.children ?? [] as child (child.id)}
				<div
					role="button"
					tabindex="0"
					class="label-tree-row child group/label"
					class:drop-target={labelDropTargetId === child.id}
					class:drop-busy={labelDropBusyId === child.id}
					class:drop-success={labelDropSuccessId === child.id}
					class:drop-error={labelDropErrorId === child.id}
					class:renaming={renamingLabelId === child.id}
					onclick={() => handleLabelRowClick(child)}
					onkeydown={(event) => handleLabelRowKeydown(event, child)}
					ondragover={(event) => handleLabelDragOver(event, child)}
					ondragleave={(event) => handleLabelDragLeave(event, child)}
					ondrop={(event) => handleLabelDrop(event, child)}
				>
					<ChevronDown class="h-3 w-3 shrink-0 transition-transform {currentExpandedLabelIds.has(child.id) ? '' : '-rotate-90'}" />
					{#if renamingLabelId === child.id}
						<input
							bind:this={renameLabelInputElement}
							bind:value={renameLabelValue}
							class="label-rename-input"
							disabled={renameLabelSaving}
							onclick={(event) => event.stopPropagation()}
							onkeydown={(event) => handleLabelRenameKeydown(event, child)}
						/>
						<span class="ml-auto inline-flex shrink-0 items-center gap-0.5">
							<button type="button" class="rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover-strong hover:text-text-primary disabled:opacity-50" title="Save" disabled={renameLabelSaving} onclick={(event) => { event.preventDefault(); event.stopPropagation(); void submitRenameLabel(child); }}>
								{#if renameLabelSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Check class="h-3.5 w-3.5" />{/if}
							</button>
							<button type="button" class="rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover-strong hover:text-text-primary disabled:opacity-50" title="Cancel" disabled={renameLabelSaving} onclick={(event) => { event.preventDefault(); event.stopPropagation(); cancelRenameLabel(); }}>
								<X class="h-3.5 w-3.5" />
							</button>
						</span>
					{:else}
						{@const childProfile = getReactiveLabelUserProfile(child)}
						{#if childProfile || isSessionUserLabel(child)}
							<UserAvatar name={getReactiveLabelDisplayName(child)} avatarUrl={childProfile?.avatarUrl} size="xxs" class="border-0 bg-bg-elevated" />
						{/if}
						<span class="min-w-0 flex-1 truncate" title={getReactiveLabelDisplayTitle(child)}>{getReactiveLabelDisplayName(child)}</span>
						{#if canManageUserLabel(child)}
							<span class="label-row-actions">
								<button type="button" class="rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover-strong hover:text-text-primary disabled:opacity-50" draggable="false" title="Rename" disabled={deletingLabelId === child.id} onclick={(event) => { event.preventDefault(); event.stopPropagation(); startRenameLabel(child); }}>
									<Pencil class="h-3.5 w-3.5" />
								</button>
								<button type="button" class="rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover-strong hover:text-status-error disabled:opacity-50" draggable="false" title="Delete" disabled={deletingLabelId === child.id} onclick={(event) => { event.preventDefault(); event.stopPropagation(); void deleteLabel(child); }}>
									{#if deletingLabelId === child.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 class="h-3.5 w-3.5" />{/if}
								</button>
							</span>
						{/if}
					{/if}
				</div>
				{@render labelAssignmentRows(child, 1)}
			{/each}
		{/if}
	{/each}
{/snippet}

{#snippet labelsSection(showHeader = true)}
	<div class={showHeader ? "mt-2" : "mt-0"}>
		{#if showHeader}
			<div
				class="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-1.5 py-1.5 text-left transition-colors duration-100 hover:bg-bg-hover"
				onclick={() => { labelsCollapsed = !labelsCollapsed; }}
				title={labelsCollapsed ? "Expand labels" : "Collapse labels"}
				role="button"
				tabindex="0"
				onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); labelsCollapsed = !labelsCollapsed; } }}
			>
				<ChevronDown class="h-3 w-3 shrink-0 text-text-tertiary transition-transform duration-150 {labelsCollapsed ? 'rotate-180' : ''}" />
				<Tags class="h-3.5 w-3.5 shrink-0 text-text-placeholder" />
				<span class="text-[11px] text-text-placeholder select-none">Labels</span>
				{@render syncSpinner(refreshingLabels, canManageLabels ? "ml-auto" : "ml-auto")}
				{#if canManageLabels}
					<span
						class="{refreshingLabels ? '' : 'ml-auto'} rounded p-0.5 text-text-placeholder transition-colors hover:bg-bg-hover hover:text-text-secondary"
						title="New label"
						onclick={(event) => { event.stopPropagation(); showNewLabelPopover = true; }}
						onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") { event.stopPropagation(); event.preventDefault(); showNewLabelPopover = true; } }}
						role="button"
						tabindex="0"
					>
						<Plus class="h-3 w-3" />
					</span>
				{/if}
			</div>
		{/if}
		{#if labelDropErrorMessage}
			<div class="label-drop-message" role="status">{labelDropErrorMessage}</div>
		{/if}
		{#if !showHeader || !labelsCollapsed}
			<div class="mt-1 space-y-[1px]">
				{#if loadingLabels && labels.length === 0}
					{@render sidebarEmptyState("Loading labels…", true)}
				{:else if displayLabels.length === 0}
					<div class="px-6 py-1.5 text-[12px] text-text-tertiary">No labels yet</div>
				{:else}
					{@render labelTreeRows(displayLabels)}
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet sourceLabelRows()}
	{#each sourceLabels as label (label.id)}
		<div
			role="button"
			tabindex="0"
			class="label-tree-row group/label"
			class:drop-target={labelDropTargetId === label.id}
			class:drop-busy={labelDropBusyId === label.id}
			class:drop-success={labelDropSuccessId === label.id}
			class:drop-error={labelDropErrorId === label.id}
			onclick={() => handleLabelRowClick(label)}
			onkeydown={(event) => handleLabelRowKeydown(event, label)}
			ondragover={(event) => handleLabelDragOver(event, label)}
			ondragleave={(event) => handleLabelDragLeave(event, label)}
			ondrop={(event) => handleLabelDrop(event, label)}
		>
			<ChevronDown class="h-3 w-3 shrink-0 transition-transform {currentExpandedLabelIds.has(label.id) ? '' : '-rotate-90'}" />
			<span class="min-w-0 flex-1 truncate" title={`Source / ${getReactiveLabelDisplayTitle(label)}`}>{getReactiveLabelDisplayName(label)}</span>
		</div>
		{@render labelAssignmentRows(label, 0)}
	{/each}
{/snippet}

{#snippet chatsSection(showHeader = true)}
	<div class={showHeader ? "mt-2" : "mt-0"}>
		{#if showHeader}
			<div
				class="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-1.5 py-1.5 text-left transition-colors duration-100 hover:bg-bg-hover"
				onclick={() => { chatsCollapsed = !chatsCollapsed; }}
				title={chatsCollapsed ? "Expand chats" : "Collapse chats"}
				role="button"
				tabindex="0"
				onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); chatsCollapsed = !chatsCollapsed; } }}
			>
				<ChevronDown class="h-3 w-3 shrink-0 text-text-tertiary transition-transform duration-150 {chatsCollapsed ? 'rotate-180' : ''}" />
				<MessageSquare class="h-3.5 w-3.5 shrink-0 text-text-placeholder" />
				<span class="text-[11px] text-text-placeholder select-none">Chats</span>
				{@render syncSpinner(refreshingSessions, "ml-auto")}
			</div>
		{/if}
		{#if !showHeader || !chatsCollapsed}
			<div class="mt-1 space-y-[1px]">
				{#if loadingLabels && labels.length === 0 && loadingSessions && sessions.length === 0}
					{@render sidebarEmptyState("Loading chats…", true)}
				{:else}
					{@render sourceLabelRows()}
					{@render labelTreeRows(systemUserLabels)}
					{@render allChatsLabelRow()}
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet allChatsLabelRow()}
	<div
		role="button"
		tabindex="0"
		class="label-tree-row group/label mt-1"
		onclick={() => toggleLabelExpanded(ALL_CHATS_LABEL_ID)}
		onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleLabelExpanded(ALL_CHATS_LABEL_ID); } }}
	>
		<ChevronDown class="h-3 w-3 shrink-0 transition-transform {currentExpandedLabelIds.has(ALL_CHATS_LABEL_ID) ? '' : '-rotate-90'}" />
		<span class="min-w-0 flex-1 truncate" title="All chats">All</span>
		{@render syncSpinner(refreshingSessions, "ml-auto")}
	</div>
	{#if currentExpandedLabelIds.has(ALL_CHATS_LABEL_ID)}
		<div class="mt-1">
			{@render allChatsList(false)}
		</div>
	{/if}
{/snippet}

{#snippet allChatsList(preview = true)}
	{#if loadingSessions && sessions.length === 0}
		{@render sidebarEmptyState("Loading chats…", true)}
	{:else if sessions.length === 0}
		{@render sidebarEmptyState("No chats")}
	{:else}
		{@const chatItems = preview ? sidebarSessionItems.slice(0, sidebarFlyoutPreviewLimit) : sidebarSessionItems}
		<div class="space-y-[2px]">
			{#each chatItems as item (item.session.id)}
				{@const session = item.session}
				{@const isActive = activeSession?.id === session.id}
				<SidebarSessionRow
					{session}
					title={item.displayTitle}
					href={buildPreferredSessionRoute(currentSpaceId!, session.id)}
					active={isActive}
					{isMobile}
					modelsCatalog={modelsCatalog ?? undefined}
					renaming={renamingSessionId === session.id}
					renameValue={renameTitleValue}
					renameSaving={renameSaving}
					rowState={{
						isFork: item.isFork,
						isLastVisibleChild: item.isLastVisibleChild,
						style: getSessionRowStyle(item),
						titleText: item.titleText || sourceTooltip(session.source) || undefined,
						ariaLabel: item.ariaLabel,
					}}
					draggable={!isMobile}
					onNavigate={(target) => scheduleSessionRowNavigate(target.id)}
					onDoubleClick={handleSessionRowDoubleClick}
					onInsert={insertPathReference}
					onRename={startRenameSession}
					onRenameValueChange={(value) => { renameTitleValue = value; }}
					onSubmitRename={(target) => void submitRenameSession(target)}
					onCancelRename={cancelRenameSession}
					onDragStart={(event, target, title) => handleSessionDragStart(event, target, title)}
					onDragEnd={handleResourceDragEnd}
				/>
			{/each}
			{#if shouldShowLoadMoreSessions()}
				<button type="button" class="mt-1 flex w-full items-center justify-center gap-2 rounded-[6px] px-2 py-1.5 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-60" disabled={loadingMoreSessions} onclick={() => currentSpaceId && void loadMoreSessionsForSpace(currentSpaceId)}>
					{#if loadingMoreSessions}<Loader2 class="h-3 w-3 animate-spin" /> Loading...{:else}Load more{/if}
				</button>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet checkpointsFlyoutList()}
	{#if loadingCheckpoints && checkpoints.length === 0}
		{@render sidebarEmptyState("Loading saves…", true)}
	{:else if checkpoints.length === 0}
		{@render sidebarEmptyState("No saves")}
	{:else}
		<div class="space-y-[2px]">
			{#each checkpoints.slice(0, sidebarFlyoutPreviewLimit) as checkpoint (checkpoint.id)}
				<SidebarCheckpointRow
					{checkpoint}
					href={buildSpaceCheckpointRoute(currentSpaceId!, checkpoint.id)}
					active={activeCheckpointId === checkpoint.id}
					onNavigate={(target) => void handleNavigateToCheckpoint(target.id)}
				/>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet cronjobsFlyoutList()}
	<div class="mb-1 flex justify-end">
		<button type="button" class="inline-flex items-center gap-1 rounded-[5px] px-2 py-1 text-[11px] font-medium text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35" onclick={handleNavigateToNewCronjob}>
			<Plus class="h-3 w-3" /> New scheduled
		</button>
	</div>
	{#if loadingCronjobs && cronjobs.length === 0}
		{@render sidebarEmptyState("Loading scheduled…", true)}
	{:else if cronjobs.length === 0}
		{@render sidebarEmptyState("No scheduled")}
	{:else}
		<div class="space-y-[2px]">
			{#each cronjobs.slice(0, sidebarFlyoutPreviewLimit) as job (job.id)}
				{@const isActive = activeCronjobId === job.id}
				<a href={buildSpaceCronjobRoute(currentSpaceId!, job.id)} class="sidebar-flyout-item flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] {isActive ? 'bg-bg-active font-medium text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}" onclick={(e) => { e.preventDefault(); handleNavigateToCronjob(job.id); }}>
					<div class="min-w-0 flex-1"><div class="truncate leading-tight">{job.title}</div></div>
					<span class="h-1.5 w-1.5 shrink-0 rounded-full {job.enabled ? 'bg-status-running' : 'bg-text-placeholder'}"></span>
				</a>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet worksFlyoutList()}
	{#if loadingWorks && works.length === 0}
		{@render sidebarEmptyState("Loading works…", true)}
	{:else if works.length === 0}
		{@render sidebarEmptyState("No works")}
	{:else}
		<div class="space-y-[2px]">
			{#each works.slice(0, sidebarFlyoutPreviewLimit) as work (work.id)}
				{@const manageHref = currentSpaceId ? buildSpaceWorkRoute(currentSpaceId, work.id) : "#"}
				{@const isActive = activeWork?.id === work.id}
				<a href={manageHref} class="sidebar-flyout-item flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] {isActive ? 'bg-bg-active font-medium text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}" onclick={(e) => { e.preventDefault(); void handleNavigateToWork(work.id); }}>
					<div class="min-w-0 flex-1"><div class="truncate font-mono leading-tight">{work.slug}</div></div>
				</a>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet tasksFlyoutList()}
	{#if loadingTasks && tasks.length === 0}
		{@render sidebarEmptyState("Loading tasks…", true)}
	{:else if tasks.length === 0}
		{@render sidebarEmptyState("No tasks")}
	{:else}
		<div class="space-y-[2px]">
			{#each tasks.slice(0, sidebarFlyoutPreviewLimit) as run (run.id)}
				{@const isActive = activeTaskId === run.id}
				{@const badge = getTaskRunBadge(run.status)}
				<a href={buildSpaceTaskRoute(currentSpaceId!, run.id)} class="sidebar-flyout-item flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] {isActive ? 'bg-bg-active font-medium text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}" onclick={(e) => { e.preventDefault(); handleNavigateToTask(run.id); }}>
					<div class="min-w-0 flex-1"><div class="truncate text-[12px] capitalize leading-tight {badge.color}">{run.status}</div><div class="mt-0.5 text-[10px] text-text-placeholder">{formatTaskRunTime(run)}</div></div>
					<span class="h-1.5 w-1.5 shrink-0 rounded-full {badge.dot}"></span>
				</a>
			{/each}
		</div>
	{/if}
{/snippet}

{#if collapsed && !isMobile}
  <aside class="h-screen w-[52px] shrink-0 bg-[var(--sidebar-bg)]">
    <div class="flex h-full flex-col items-center border-r border-border-subtle/70 px-2 py-2">
      <a
        href="/"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] bg-brand text-[11px] font-bold text-brand-contrast-fg transition-colors duration-100 hover:bg-brand-hover"
        aria-label="Cohub home"
        title="Home"
      >
        C
      </a>
      <button
        type="button"
        class="mt-1 flex h-8 w-8 items-center justify-center rounded-[6px] text-text-tertiary transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
        onclick={() => uiState.setLeftSidebarCollapsed(false)}
        aria-label="Expand sidebar"
        title="Expand sidebar"
      >
        <PanelLeftOpen class="h-4 w-4" />
      </button>
      <button
        type="button"
        class="mt-1 flex h-8 w-8 items-center justify-center rounded-[6px] text-text-tertiary transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
        onclick={openCommandPalette}
        aria-label="Search everywhere"
        title="Search everywhere (⌘K / Ctrl K)"
      >
        <Search class="h-4 w-4" />
      </button>

      <div class="mt-2 h-px w-6 bg-border-subtle/70"></div>

      {#if mode === "space"}
        <div class="mt-2 flex w-full flex-col items-center gap-1">
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center overflow-hidden rounded-[6px] text-text-tertiary transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
            onclick={openSpacePalette}
            aria-label={currentSpace ? `Switch space: ${currentSpace.name || currentSpace.title || currentSpace.id}` : "Select a space"}
            title={currentSpace ? currentSpace.name || currentSpace.title || currentSpace.id : "Select a space"}
          >
            {#if currentSpace}
              <SpaceAvatar name={currentSpace.name || currentSpace.title || currentSpace.id} profile={currentSpace.publicProfile} size="sm" />
            {:else}
              <FolderKanban class="h-4 w-4" />
            {/if}
          </button>
          {#if currentSpace}
            <button
              type="button"
              class="relative flex h-8 w-8 items-center justify-center rounded-[6px] text-brand transition-colors duration-100 hover:bg-brand-muted hover:text-brand"
              onclick={() => { void handleCreateNewSession(); }}
              disabled={creatingSession}
              aria-label="New chat"
              title="New chat (⌘O / Ctrl O)"
            >
              {#if creatingSession}
                <Loader2 class="h-4 w-4 animate-spin" />
              {:else}
                <Plus class="h-4 w-4" />
              {/if}
            </button>
            <button
              type="button"
              class="flex h-8 w-8 items-center justify-center rounded-[6px] transition-colors duration-100 {currentPath === buildSpaceSettingsRoute(currentSpaceId!) ? 'bg-bg-active text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}"
              onclick={() => { void handleNavigate(buildSpaceSettingsRoute(currentSpaceId!)); }}
              aria-label="Space settings"
              title="Space settings"
            >
              <Settings class="h-4 w-4" />
            </button>
            <button
              type="button"
              class="flex h-8 w-8 items-center justify-center rounded-[6px] text-text-tertiary transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
              onclick={handleNavigateToNewCheckpoint}
              aria-label="New save"
              title="New save"
            >
              <Save class="h-4 w-4" />
            </button>
          {/if}
        </div>

        {#if currentSpace}
          <div class="mt-2 h-px w-6 bg-border-subtle/70"></div>
          <nav class="mt-2 flex w-full flex-1 flex-col items-center gap-1 overflow-visible">
            <SidebarFlyout label="Labels" active={Boolean(activeLabelResource)} onTriggerClick={() => uiState.setLeftSidebarCollapsed(false)}>
              {#snippet trigger()}
                <Tags class="h-4 w-4" />
              {/snippet}
              {#if canManageLabels}
                {#snippet headerAction()}
                  <button
                    type="button"
                    class="inline-flex h-6 w-6 items-center justify-center rounded-[5px] text-text-placeholder transition-colors hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
                    title="New label"
                    aria-label="New label"
                    onclick={(event) => { event.stopPropagation(); showNewLabelPopover = true; }}
                  >
                    <Plus class="h-3.5 w-3.5" />
                  </button>
                {/snippet}
              {/if}
              {@render labelsSection(false)}
            </SidebarFlyout>
            <SidebarFlyout label="Chats" active={Boolean(activeSession)} onTriggerClick={() => uiState.setLeftSidebarCollapsed(false)}>
              {#snippet trigger()}
                <MessageSquare class="h-4 w-4" />
              {/snippet}
              {@render chatsSection(false)}
            </SidebarFlyout>
            <SidebarFlyout label="Works" active={Boolean(activeWork)} onTriggerClick={() => uiState.setLeftSidebarCollapsed(false)}>
              {#snippet trigger()}
                <Rocket class="h-4 w-4" />
              {/snippet}
              {@render worksFlyoutList()}
            </SidebarFlyout>
            <SidebarFlyout label="Saves" active={Boolean(activeCheckpointId)} onTriggerClick={() => uiState.setLeftSidebarCollapsed(false)}>
              {#snippet trigger()}
                <History class="h-4 w-4" />
              {/snippet}
              {@render checkpointsFlyoutList()}
            </SidebarFlyout>
            <SidebarFlyout label="Scheduled" active={Boolean(activeCronjobId)} onTriggerClick={() => uiState.setLeftSidebarCollapsed(false)}>
              {#snippet trigger()}
                <Clock class="h-4 w-4" />
              {/snippet}
              {@render cronjobsFlyoutList()}
            </SidebarFlyout>
            <SidebarFlyout label="Tasks" active={Boolean(activeTaskId)} onTriggerClick={() => uiState.setLeftSidebarCollapsed(false)}>
              {#snippet trigger()}
                <Activity class="h-4 w-4" />
              {/snippet}
              {@render tasksFlyoutList()}
            </SidebarFlyout>
          </nav>
        {:else}
          <div class="flex-1"></div>
        {/if}
      {:else}
        <nav class="mt-3 flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
          <button type="button" class="rail-button text-text-tertiary" onclick={returnFromSettings} aria-label="Back" title="Back">
            <ArrowLeft class="h-4 w-4" />
          </button>
          {#each settingsTabs as tab (tab.id)}
            {@const isActive = activeSettingsTab === tab.id}
            <a
              href={tab.href}
              class="rail-button {isActive ? 'bg-bg-active text-text-primary' : 'text-text-tertiary'}"
              title={tab.label}
              aria-label={tab.label}
              onclick={(e) => { e.preventDefault(); handleNavigate(tab.href, { keepSettingsReturn: true }); }}
            >
              <tab.icon class="h-4 w-4" />
            </a>
          {/each}
        </nav>
      {/if}

      <div class="relative mt-auto w-full pt-2">
        {#if showUserMenu}
          <div data-user-menu class="absolute bottom-full left-0 z-50 mb-1 w-56 overflow-hidden rounded-md border border-border-subtle bg-bg-primary py-1 shadow-lg">
            {#if billingConfigured !== false}
              <div class="border-b border-border-subtle">
                <a href={currentSubscriptionName ? "/settings/billing" : "/pricing"} class="rail-menu-item" title={currentSubscriptionName ? "Open billing details" : "View plans"} onclick={(e) => { e.preventDefault(); if (currentSubscriptionName) openBillingSettings(); else { showUserMenu = false; handleNavigate('/pricing'); } }}>
                  <CreditCard class="h-3.5 w-3.5" />
                  <span>{currentSubscriptionName ?? "Free Plan"}</span>
                  {#if showBillingBalanceEntry}
                    <span class="ml-auto font-mono text-[11px] {billingCredit && billingCredit.netUsd < 0 ? 'text-error-soft' : 'text-text-secondary'}">
                      {#if billingCreditLoading || (!billingCredit && !billingCreditError)}
                        <Loader2 class="h-3.5 w-3.5 animate-spin text-text-tertiary" />
                      {:else if billingCredit}
                        {formatUsdAmount(billingCredit.netUsd)}
                      {:else}
                        <span class="text-text-placeholder">—</span>
                      {/if}
                    </span>
                  {:else if !currentSubscriptionName}
                    <span class="ml-auto text-[10px] font-medium text-brand">Upgrade</span>
                  {/if}
                </a>
                {#if showBillingBalanceEntry && billingCreditError}
                  <div class="px-2.5 pb-1 text-[11px] text-text-placeholder">{billingCreditError}</div>
                {/if}
              </div>
            {/if}
            {#if mode === "space"}
              <a href="/settings" class="rail-menu-item" onclick={(e) => { e.preventDefault(); openSettings(); }}><Settings class="h-3.5 w-3.5" /><span>Settings</span></a>
            {:else}
              <a href="/" class="rail-menu-item" onclick={(e) => { e.preventDefault(); showUserMenu = false; handleNavigate('/'); }}><FolderKanban class="h-3.5 w-3.5" /><span>Spaces</span></a>
            {/if}
            <a href="/explore?view=wall" class="rail-menu-item" onclick={(e) => { e.preventDefault(); showUserMenu = false; handleNavigate('/explore?view=wall'); }}><Compass class="h-3.5 w-3.5" /><span>Explore</span></a>
            <a href="/trending" class="rail-menu-item" onclick={(e) => { e.preventDefault(); showUserMenu = false; handleNavigate('/trending'); }}><BarChart3 class="h-3.5 w-3.5" /><span>Trending</span></a>
            <button type="button" class="rail-menu-item w-full" onclick={openHelpPanel}><Keyboard class="h-3.5 w-3.5" /><span>Help</span></button>
            <button type="button" class="rail-menu-item w-full" onclick={saveDebugLog}><Download class="h-3.5 w-3.5" /><span>Save debug log</span></button>
            <button type="button" class="rail-menu-item w-full hover:text-error-soft" onclick={() => { showUserMenu = false; void handleLogout(); }}><LogOut class="h-3.5 w-3.5" /><span>Sign out</span></button>
          </div>
        {/if}
        <button
          type="button"
          data-user-menu
          class="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-bg-hover-strong transition-colors duration-100 hover:bg-bg-hover"
          onclick={() => { showUserMenu = !showUserMenu; }}
          aria-label={userDisplayName}
          title={userDisplayName}
        >
          <UserAvatar name={userDisplayName} avatarUrl={authStore.profile?.avatarUrl} size="md" class="h-full w-full border-0" />
        </button>
      </div>
    </div>
  </aside>
{:else}
<aside class="{isMobile ? 'h-full' : 'shrink-0 h-screen'} flex flex-col bg-[var(--sidebar-bg)]">
  <!-- Brand Header -->
  <div class="flex h-[48px] shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-3">
    <a href="/" class="flex min-w-0 items-center gap-2 group" aria-label="Cohub">
      <div class="w-7 h-7 bg-brand rounded-[6px] flex items-center justify-center font-bold text-[11px] text-brand-contrast-fg group-hover:bg-brand-hover transition-colors shrink-0">
        C
      </div>
      <span class="font-semibold text-[13px] text-text-primary tracking-tight truncate">Cohub</span>
    </a>
    <div class="flex shrink-0 items-center gap-1">
      <button
        type="button"
        class="group/search flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] bg-bg-surface px-2 text-[11px] text-text-tertiary transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
        onclick={openCommandPalette}
        title="Search everywhere (⌘K / Ctrl K)"
        aria-label="Search everywhere"
      >
        <Search class="h-3.5 w-3.5 text-text-placeholder transition-colors group-hover/search:text-brand" />
        <span class="hidden font-mono tracking-[0.02em] sm:inline">⌘K</span>
      </button>
      {#if !isMobile}
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
          onclick={() => uiState.setLeftSidebarCollapsed(true)}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          <PanelLeftClose class="h-4 w-4" />
        </button>
      {/if}
    </div>
  </div>

  {#if mode === "space"}
    <!-- Space Switcher -->
    <div class="px-1.5 py-1 shrink-0 border-b border-border-subtle">
      <button
        type="button"
        class="w-full flex items-center gap-1.5 px-1.5 py-1.5 rounded-[5px] hover:bg-bg-hover transition-colors duration-100 cursor-pointer group"
        onclick={openSpacePalette}
      >
        {#if currentSpace}
          <SpaceAvatar name={currentSpace.name || currentSpace.title || currentSpace.id} profile={currentSpace.publicProfile} size="sm" />
          <span class="flex-1 text-[13px] font-medium text-text-primary truncate text-left">{currentSpace.name || currentSpace.title || currentSpace.id.slice(0, 12)}</span>
          {@render syncSpinner(refreshingSpaces)}
        {:else}
          <span class="flex-1 text-[13px] text-text-placeholder truncate text-left">Select a space</span>
        {/if}
        <ChevronDown class="w-3.5 h-3.5 text-text-tertiary shrink-0 transition-transform duration-150 group-hover:text-text-secondary" />
      </button>
    </div>

    <!-- Action Buttons -->
    {#if currentSpace}
      <div class="px-1.5 py-1.5 shrink-0 space-y-[2px]">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-[var(--sidebar-primary-action-radius)] border border-[color:var(--sidebar-primary-action-border)] bg-[var(--sidebar-primary-action-bg)] px-1.5 py-1.5 text-[var(--sidebar-primary-action-fg)] transition-colors duration-100 hover:bg-[var(--sidebar-primary-action-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          onclick={() => { void handleCreateNewSession(); }}
          disabled={creatingSession}
          title="New chat (⌘O / Ctrl O)"
          aria-label="New chat (⌘O / Ctrl O)"
        >
          {#if creatingSession}
            <Loader2 class="w-3.5 h-3.5 animate-spin shrink-0" />
            <span class="text-[12px] font-medium">Creating…</span>
          {:else}
            <Plus class="w-3.5 h-3.5 shrink-0" />
            <span class="text-[12px] font-medium">New Chat</span>
            <span class="ml-auto hidden rounded-[4px] border border-brand/20 bg-bg-primary/70 px-1.5 py-px font-mono text-[10px] text-brand/80 xl:inline">⌘O</span>
          {/if}
        </button>
        <button
          type="button"
          class="flex items-center gap-2 w-full px-1.5 py-1.5 rounded-[5px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors duration-100 disabled:opacity-50"
          onclick={() => { void handleNavigate(buildSpaceSettingsRoute(currentSpaceId!)); }}
          title="Space settings"
        >
          <Settings class="w-3.5 h-3.5 shrink-0" />
          <span class="text-[12px] font-medium">Settings</span>
        </button>
        <button
          type="button"
          class="flex items-center gap-2 w-full px-1.5 py-1.5 rounded-[5px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors duration-100 disabled:opacity-50"
          onclick={handleNavigateToNewCheckpoint}
          title="New save"
        >
          <Save class="w-3.5 h-3.5 shrink-0" />
          <span class="text-[12px] font-medium">New Save</span>
        </button>
        {#if createSessionError}
          <div class="px-2 py-1 text-[11px] text-error-soft">{createSessionError}</div>
        {/if}
      </div>
    {/if}

    <!-- Sessions / Checkpoints -->
    {#if currentSpace}
      <div class="flex-1 overflow-y-auto px-1.5 pb-2 pt-1 min-h-0">
        {#if loadingSessions && sessions.length === 0 && loadingCheckpoints && checkpoints.length === 0}
          <div class="px-1 py-4 text-[12px] text-text-tertiary text-center flex items-center justify-center gap-2">
            <Loader2 class="w-3 h-3 animate-spin" />
            Loading...
          </div>
        {:else}
          {@render labelsSection()}
          {@render chatsSection()}

          <!-- Works -->
          <div class="mt-3">
            <button
              type="button"
              class="flex items-center gap-2 px-1.5 py-1.5 w-full text-left hover:bg-bg-hover transition-colors duration-100 rounded-[6px]"
              onclick={() => { worksCollapsed = !worksCollapsed; }}
              title={worksCollapsed ? "Expand works" : "Collapse works"}
            >
              <ChevronDown class="w-3 h-3 text-text-tertiary shrink-0 transition-transform duration-150 {worksCollapsed ? 'rotate-180' : ''}" />
              <Rocket class="w-3.5 h-3.5 shrink-0 text-text-placeholder" />
              <span class="text-[11px] text-text-placeholder select-none">Works</span>
              {@render syncSpinner(refreshingWorks, "ml-auto")}
            </button>

            {#if !worksCollapsed}
              {#if loadingWorks && works.length === 0}
                <div class="px-1.5 py-2 text-[12px] text-text-tertiary flex items-center gap-2">
                  <Loader2 class="w-3 h-3 animate-spin" />
                  Loading works...
                </div>
              {:else if works.length === 0}
                <div class="px-1.5 py-2 text-[12px] text-text-placeholder">No works</div>
              {:else}
                <div class="space-y-[2px] mt-1">
                  {#each works as work (work.id)}
                    {@const manageHref = currentSpaceId ? buildSpaceWorkRoute(currentSpaceId, work.id) : "#"}
                    {@const isActive = activeWork?.id === work.id}
                    <a
                      href={manageHref}
                      class="flex items-center gap-2 rounded-[6px] px-1.5 py-1.5 text-[13px] transition-colors duration-100 {isActive ? 'bg-bg-active font-medium text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}"
                      onclick={(e) => { e.preventDefault(); void handleNavigateToWork(work.id); }}
                    >
                      <div class="min-w-0 flex-1">
                        <div class="truncate font-mono leading-tight">{work.slug}</div>
                      </div>
                    </a>
                  {/each}
                </div>
              {/if}
            {:else if activeWork}
              {@const manageHref = currentSpaceId ? buildSpaceWorkRoute(currentSpaceId, activeWork.id) : "#"}
              <a
                href={manageHref}
                class="mt-1 flex items-center gap-2 rounded-[6px] bg-bg-active px-1.5 py-1.5 text-[13px] font-medium text-text-primary transition-colors duration-100"
                onclick={(e) => { e.preventDefault(); void handleNavigateToWork(activeWork.id); }}
              >
                <div class="min-w-0 flex-1">
                  <div class="truncate font-mono leading-tight">{activeWork.slug}</div>
                </div>
              </a>
            {/if}
          </div>

          <div class="mt-3">
            <button
              type="button"
              class="flex items-center gap-2 px-1.5 py-1.5 w-full text-left hover:bg-bg-hover transition-colors duration-100 rounded-[6px]"
              onclick={() => { checkpointsCollapsed = !checkpointsCollapsed; }}
              title={checkpointsCollapsed ? "Expand saves" : "Collapse saves"}
            >
              <ChevronDown class="w-3 h-3 text-text-tertiary shrink-0 transition-transform duration-150 {checkpointsCollapsed ? 'rotate-180' : ''}" />
              <History class="w-3.5 h-3.5 shrink-0 text-text-placeholder" />
              <span class="text-[11px] text-text-placeholder select-none">Saves</span>
              {@render syncSpinner(refreshingCheckpoints, "ml-auto")}
            </button>

            {#if !checkpointsCollapsed}
              {#if loadingCheckpoints && checkpoints.length === 0}
                <div class="px-1.5 py-2 text-[12px] text-text-tertiary flex items-center gap-2">
                  <Loader2 class="w-3 h-3 animate-spin" />
                  Loading saves...
                </div>
              {:else if checkpoints.length === 0}
                <div class="px-1.5 py-2 text-[12px] text-text-placeholder">No saves</div>
              {:else}
                <div class="space-y-[2px] mt-1">
                  {#each checkpoints as checkpoint (checkpoint.id)}
                    <SidebarCheckpointRow
                      {checkpoint}
                      href={buildSpaceCheckpointRoute(currentSpaceId!, checkpoint.id)}
                      active={activeCheckpointId === checkpoint.id}
                      onNavigate={(target) => void handleNavigateToCheckpoint(target.id)}
                    />
                  {/each}
                  {#if checkpointsPageInfo.hasMore && checkpointsPageInfo.nextCursor}
                    <button
                      type="button"
                      class="mt-1 flex w-full items-center justify-center gap-1.5 rounded-[6px] px-1.5 py-1.5 text-[11px] text-text-placeholder transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={loadingMoreCheckpoints}
                      onclick={() => currentSpaceId && void loadMoreCheckpointsForSpace(currentSpaceId)}
                    >
                      {#if loadingMoreCheckpoints}
                        <Loader2 class="h-3 w-3 animate-spin" />
                        Loading...
                      {:else}
                        Show more
                      {/if}
                    </button>
                  {/if}
                </div>
              {/if}
            {:else if activeCheckpoint}
              <div class="mt-1">
                <SidebarCheckpointRow
                  checkpoint={activeCheckpoint}
                  href={buildSpaceCheckpointRoute(currentSpaceId!, activeCheckpoint.id)}
                  active={true}
                  onNavigate={(target) => void handleNavigateToCheckpoint(target.id)}
                />
              </div>
            {/if}
          </div>


          <!-- Scheduled Jobs -->
          <div class="mt-3">
            <div
              class="flex items-center gap-2 px-1.5 py-1.5 w-full text-left hover:bg-bg-hover transition-colors duration-100 rounded-[6px] cursor-pointer"
              onclick={() => { cronjobsCollapsed = !cronjobsCollapsed; }}
              title={cronjobsCollapsed ? "Expand scheduled" : "Collapse scheduled"}
              role="button"
              tabindex="0"
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cronjobsCollapsed = !cronjobsCollapsed; } }}
            >
              <ChevronDown class="w-3 h-3 text-text-tertiary shrink-0 transition-transform duration-150 {cronjobsCollapsed ? 'rotate-180' : ''}" />
              <Clock class="w-3.5 h-3.5 shrink-0 text-text-placeholder" />
              <span class="text-[11px] text-text-placeholder select-none">Scheduled</span>
              {@render syncSpinner(refreshingCronjobs, "ml-auto")}
              <span
                class="{refreshingCronjobs ? '' : 'ml-auto'} p-0.5 rounded hover:bg-bg-hover text-text-placeholder hover:text-text-secondary transition-colors cursor-pointer"
                onclick={(e) => { e.stopPropagation(); handleNavigateToNewCronjob(); }}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); handleNavigateToNewCronjob(); } }}
                title="New scheduled"
                role="button"
                tabindex="0"
              >
                <Plus class="w-3 h-3" />
              </span>
            </div>

            {#if !cronjobsCollapsed}
              {#if loadingCronjobs && cronjobs.length === 0}
                <div class="px-1.5 py-2 text-[12px] text-text-tertiary flex items-center gap-2">
                  <Loader2 class="w-3 h-3 animate-spin" />
                  Loading scheduled...
                </div>
              {:else if cronjobs.length === 0}
                <div class="px-1.5 py-2 text-[12px] text-text-placeholder">No scheduled</div>
              {:else}
                <div class="space-y-[2px] mt-1">
                  {#each cronjobs as job (job.id)}
                    {@const isActive = activeCronjobId === job.id}
                    <a
                      href={buildSpaceCronjobRoute(currentSpaceId!, job.id)}
                      class="flex items-center gap-2 px-1.5 py-1.5 rounded-[6px] text-[13px] transition-colors duration-100 {isActive ? 'text-text-primary bg-bg-active font-medium' : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'}"
                      onclick={(e) => { e.preventDefault(); handleNavigateToCronjob(job.id); }}
                    >
                      <div class="min-w-0 flex-1">
                        <div class="truncate leading-tight">{job.title}</div>
                      </div>
                      <span class="w-[6px] h-[6px] rounded-full shrink-0 {job.enabled ? 'bg-status-running' : 'bg-text-placeholder'}"></span>
                    </a>
                  {/each}
                </div>
              {/if}
            {:else if activeCronjob}
              <a
                href={buildSpaceCronjobRoute(currentSpaceId!, activeCronjob.id)}
                class="flex items-center gap-2 px-1.5 py-1.5 mt-1 rounded-[6px] text-[13px] transition-colors duration-100 text-text-primary bg-bg-active font-medium"
                onclick={(e) => { e.preventDefault(); handleNavigateToCronjob(activeCronjob.id); }}
              >
                <div class="min-w-0 flex-1">
                  <div class="truncate leading-tight">{activeCronjob.title}</div>
                </div>
                <span class="w-[6px] h-[6px] rounded-full shrink-0 {activeCronjob.enabled ? 'bg-status-running' : 'bg-text-placeholder'}"></span>
              </a>
            {/if}
          </div>

          <!-- Tasks -->
          <div class="mt-3">
            <button
              type="button"
              class="flex items-center gap-2 px-1.5 py-1.5 w-full text-left hover:bg-bg-hover transition-colors duration-100 rounded-[6px]"
              onclick={() => {
                const nextCollapsed = !tasksCollapsed;
                tasksCollapsed = nextCollapsed;
                if (!nextCollapsed && currentSpaceId) {
                  void restoreTasksForSpace(currentSpaceId);
                  void loadTasksForSpace(currentSpaceId);
                }
              }}
              title={tasksCollapsed ? "Expand tasks" : "Collapse tasks"}
            >
              <ChevronDown class="w-3 h-3 text-text-tertiary shrink-0 transition-transform duration-150 {tasksCollapsed ? 'rotate-180' : ''}" />
              <Activity class="w-3.5 h-3.5 shrink-0 text-text-placeholder" />
              <span class="text-[11px] text-text-placeholder select-none">Tasks</span>
              {@render syncSpinner(refreshingTasks, "ml-auto")}
            </button>

            {#if !tasksCollapsed}
              {#if loadingTasks && tasks.length === 0}
                <div class="px-1.5 py-2 text-[12px] text-text-tertiary flex items-center gap-2">
                  <Loader2 class="w-3 h-3 animate-spin" />
                  Loading tasks...
                </div>
              {:else if tasks.length === 0}
                <div class="px-1.5 py-2 text-[12px] text-text-placeholder">No tasks</div>
              {:else}
                <div class="space-y-[2px] mt-1">
                  {#each tasks as run (run.id)}
                    {@const isActive = activeTaskId === run.id}
                    {@const badge = getTaskRunBadge(run.status)}
                    <a
                      href={buildSpaceTaskRoute(currentSpaceId!, run.id)}
                      class="flex items-center gap-2 px-1.5 py-1.5 rounded-[6px] text-[13px] transition-colors duration-100 {isActive ? 'text-text-primary bg-bg-active font-medium' : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'}"
                      onclick={(e) => { e.preventDefault(); handleNavigateToTask(run.id); }}
                      title={getTaskRunMeta(run)}
                    >
                      <div class="min-w-0 flex-1">
                        <div class="truncate leading-tight text-[12px] text-text-secondary">{getTaskRunTitle(run)}</div>
                        <div class="mt-0.5 truncate text-[10px] {badge.color}">{getTaskRunMeta(run)}</div>
                      </div>
                      <span class="w-[6px] h-[6px] rounded-full shrink-0 {badge.dot}"></span>
                    </a>
                  {/each}
                  {#if tasksPageInfo.hasMore && tasksPageInfo.nextCursor}
                    <button
                      type="button"
                      class="mt-1 flex w-full items-center justify-center gap-1.5 rounded-[6px] px-1.5 py-1.5 text-[11px] text-text-placeholder transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={loadingMoreTasks}
                      onclick={() => currentSpaceId && void loadMoreTasksForSpace(currentSpaceId)}
                    >
                      {#if loadingMoreTasks}
                        <Loader2 class="h-3 w-3 animate-spin" />
                        Loading...
                      {:else}
                        Show more
                      {/if}
                    </button>
                  {/if}
                </div>
              {/if}
            {:else if activeTaskId}
              <a
                href={buildSpaceTaskRoute(currentSpaceId!, activeTaskId)}
                class="flex items-center gap-2 px-1.5 py-1.5 mt-1 rounded-[6px] text-[13px] transition-colors duration-100 text-text-primary bg-bg-active font-medium"
                onclick={(e) => { e.preventDefault(); handleNavigateToTask(activeTaskId); }}
              >
                <div class="min-w-0 flex-1">
                  <div class="truncate leading-tight text-[12px]">Task run</div>
                </div>
              </a>
            {/if}
          </div>
        {/if}
      </div>
    {:else}
      <div class="flex-1 overflow-y-auto px-1.5 pb-2 pt-1 min-h-0">
        <div class="px-1 py-6 text-[12px] text-text-placeholder text-center">
          Select a space to view chats
        </div>
      </div>
    {/if}
  {:else}
    <div class="px-1.5 pt-2 pb-1">
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-[5px] px-1.5 py-2 text-[13px] text-text-tertiary transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
        onclick={returnFromSettings}
      >
        <ArrowLeft class="w-[15px] h-[15px] shrink-0" />
        <span class="truncate">Back</span>
      </button>
    </div>
    <nav class="flex-1 overflow-y-auto px-1.5 py-2 space-y-[2px]">
      {#each settingsTabs as tab (tab.id)}
        {@const isActive = activeSettingsTab === tab.id}
        <a
          href={tab.href}
          class="flex items-center gap-2.5 px-1.5 py-2 rounded-[5px] text-[13px] transition-colors duration-100 cursor-pointer {
            isActive
              ? 'bg-bg-active text-text-primary font-medium'
              : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
          }"
          onclick={(e) => { e.preventDefault(); handleNavigate(tab.href, { keepSettingsReturn: true }); }}
        >
          <tab.icon class="w-[15px] h-[15px] shrink-0" />
          <span>{tab.label}</span>
        </a>
      {/each}
    </nav>
  {/if}

  <!-- User Menu -->
  <div class="border-t border-border-subtle p-1.5 shrink-0 relative">
    {#if showUserMenu}
      <div
        data-user-menu
        class="absolute bottom-full left-1.5 right-1.5 mb-1 bg-bg-primary border border-border-subtle rounded-md shadow-lg overflow-hidden z-50"
      >
        {#if billingConfigured !== false}
          <div class="border-b border-border-subtle">
            <a
              href={currentSubscriptionName ? "/settings/billing" : "/pricing"}
              class="flex w-full items-center gap-2 px-2.5 py-[7px] text-[12px] text-text-tertiary transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
              title={currentSubscriptionName ? "Open billing details" : "View plans"}
              onclick={(e) => { e.preventDefault(); if (currentSubscriptionName) openBillingSettings(); else { showUserMenu = false; handleNavigate('/pricing'); } }}
            >
              <CreditCard class="w-3.5 h-3.5" />
              <span>{currentSubscriptionName ?? "Free Plan"}</span>
              {#if showBillingBalanceEntry}
                <span class="ml-auto font-mono text-[11px] {billingCredit && billingCredit.netUsd < 0 ? 'text-error-soft' : 'text-text-secondary'}">
                  {#if billingCreditLoading || (!billingCredit && !billingCreditError)}
                    <Loader2 class="h-3.5 w-3.5 animate-spin text-text-tertiary" />
                  {:else if billingCredit}
                    {formatUsdAmount(billingCredit.netUsd)}
                  {:else}
                    <span class="text-text-placeholder">—</span>
                  {/if}
                </span>
              {:else if !currentSubscriptionName}
                <span class="ml-auto text-[10px] font-medium text-brand">Upgrade</span>
              {/if}
            </a>
            {#if showBillingBalanceEntry && billingCreditError}
              <div class="px-2.5 pb-2 text-[11px] text-text-placeholder">{billingCreditError}</div>
            {/if}
          </div>
        {/if}
        {#if mode === "space"}
          <a
            href="/settings"
            class="flex items-center gap-2 px-2.5 py-[7px] text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
            onclick={(e) => { e.preventDefault(); openSettings(); }}
          >
            <Settings class="w-3.5 h-3.5" />
            <span>Settings</span>
          </a>
        {:else}
          <a
            href="/"
            class="flex items-center gap-2 px-2.5 py-[7px] text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
            onclick={(e) => { e.preventDefault(); showUserMenu = false; handleNavigate('/'); }}
          >
            <FolderKanban class="w-3.5 h-3.5" />
            <span>Spaces</span>
          </a>
        {/if}
        <a
          href="/explore?view=wall"
          class="flex items-center gap-2 px-2.5 py-[7px] text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
          onclick={(e) => { e.preventDefault(); showUserMenu = false; handleNavigate('/explore?view=wall'); }}
        >
          <Compass class="w-3.5 h-3.5" />
          <span>Explore</span>
        </a>
        <a
          href="/trending"
          class="flex items-center gap-2 px-2.5 py-[7px] text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
          onclick={(e) => { e.preventDefault(); showUserMenu = false; handleNavigate('/trending'); }}
        >
          <BarChart3 class="w-3.5 h-3.5" />
          <span>Trending</span>
        </a>
	        <button
	          type="button"
	          class="flex items-center gap-2 w-full px-2.5 py-[7px] text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
	          onclick={openHelpPanel}
        >
          <Keyboard class="w-3.5 h-3.5" />
	          <span>Help</span>
	          <span class="ml-auto rounded-[4px] border border-border-subtle bg-bg-surface px-1.5 py-px font-mono text-[10px] leading-4 text-text-placeholder">?</span>
	        </button>
	        <button
	          type="button"
	          class="flex items-center gap-2 w-full px-2.5 py-[7px] text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
	          onclick={saveDebugLog}
	        >
	          <Download class="w-3.5 h-3.5" />
	          <span>Save debug log</span>
	        </button>
	        <button
	          type="button"
	          class="flex items-center gap-2 w-full px-2.5 py-[7px] text-[12px] text-text-tertiary hover:text-error-soft hover:bg-bg-hover transition-colors duration-100"
	          onclick={() => { showUserMenu = false; void handleLogout(); }}
	        >
          <LogOut class="w-3.5 h-3.5" />
          <span>Sign out</span>
        </button>
      </div>
    {/if}

    <button
      type="button"
      data-user-menu
      class="flex items-center gap-2 w-full px-1.5 py-[6px] rounded-[5px] hover:bg-bg-hover transition-colors duration-100 cursor-pointer"
      onclick={() => { showUserMenu = !showUserMenu; }}
    >
      <UserAvatar name={userDisplayName} avatarUrl={authStore.profile?.avatarUrl} size="xs" class="h-[22px] w-[22px] border-0" />
      <div class="flex-1 min-w-0 text-left">
        <p class="text-[12px] text-text-secondary truncate">{userDisplayName}</p>
      </div>
      <ChevronDown class={'w-3 h-3 text-text-tertiary shrink-0 transition-transform duration-150 ' + (showUserMenu ? 'rotate-180' : '')} />
    </button>
  </div>
</aside>
{/if}

{#if showNewLabelPopover && currentSpaceId && canManageLabels}
	<NewLabelPopover
		spaceId={currentSpaceId}
		{labels}
		onCreated={() => { void loadLabelsForSpace(currentSpaceId, true); }}
		onClose={() => { showNewLabelPopover = false; }}
	/>
{/if}

<style>
	.label-tree-row {
		position: relative;
		display: flex;
		min-height: 28px;
		width: 100%;
		align-items: center;
		gap: 6px;
		border-radius: 6px;
		padding: 0 6px;
		color: var(--text-tertiary);
		font-size: 13px;
		text-align: left;
		transition: background-color 100ms ease, color 100ms ease;
	}

	.label-tree-row:hover,
	.label-tree-row.renaming {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.label-row-actions {
		margin-left: auto;
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 2px;
		opacity: 0;
		pointer-events: none;
		transition: opacity 100ms ease;
	}

	.label-tree-row:hover .label-row-actions,
	.label-tree-row:focus-within .label-row-actions {
		opacity: 1;
		pointer-events: auto;
	}

	.label-rename-input {
		min-width: 0;
		flex: 1 1 auto;
		border: 1px solid var(--border-subtle);
		border-radius: 5px;
		background: var(--bg-input);
		padding: 2px 6px;
		color: var(--text-primary);
		font: inherit;
		line-height: 1.25;
		outline: none;
	}

	.label-rename-input:focus {
		border-color: color-mix(in srgb, var(--brand) 45%, var(--border-subtle));
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand) 18%, transparent);
	}

	.label-tree-row.child {
		padding-left: 16px;
		font-size: 12px;
	}

	.label-tree-row.drop-target {
		background: var(--bg-active);
		color: var(--text-secondary);
	}

	.label-tree-row.drop-target::before,
	.label-tree-row.drop-success::before,
	.label-tree-row.drop-error::before {
		content: "";
		position: absolute;
		left: 0;
		top: 6px;
		bottom: 6px;
		width: 2px;
		border-radius: 999px;
		background: var(--brand);
	}

	.label-tree-row.drop-busy {
		color: var(--text-secondary);
		opacity: 0.75;
	}

	.label-tree-row.drop-error::before {
		background: var(--error-500, var(--brand));
	}

	.label-drop-message {
		margin: 4px 0 6px;
		border-radius: 6px;
		padding: 5px 8px;
		background: color-mix(in srgb, var(--error-500, var(--brand)) 8%, transparent);
		color: var(--text-secondary);
		font-size: 11px;
		line-height: 1.25;
	}

	.rail-button {
		position: relative;
		display: flex;
		height: 2rem;
		width: 2rem;
		align-items: center;
		justify-content: center;
		border-radius: 0.375rem;
		transition:
			background-color 100ms ease,
			color 100ms ease;
	}

	.rail-button:hover {
		background: var(--color-bg-hover);
		color: var(--color-text-secondary);
	}

	.rail-menu-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4375rem 0.625rem;
		font-size: 0.75rem;
		color: var(--color-text-tertiary);
		transition:
			background-color 100ms ease,
			color 100ms ease;
	}

	.rail-menu-item:hover {
		background: var(--color-bg-hover);
		color: var(--color-text-secondary);
	}

	.session-activity-caret {
		display: inline-block;
		margin-left: 0.0625rem;
		color: var(--color-brand);
		font-size: 0.82em;
		line-height: 1;
		animation: session-activity-caret 1.15s steps(2, jump-none) infinite;
	}

	@keyframes session-activity-caret {
		0%,
		45% {
			opacity: 1;
		}
		46%,
		100% {
			opacity: 0.28;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.session-activity-caret {
			animation: none;
			opacity: 0.85;
		}
	}

</style>
