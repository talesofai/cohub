/**
 * Full-capability session chat host.
 * Shell uses a small Handle surface; Panel uses the host as view-model.
 */
import {
	buildFileReferencesText,
	buildImageReferencesText,
	buildViewportContentBlock,
} from "@cohub/protocol";
import type { ContentBlock } from "@cohub/protocol/core";
import type {
	SessionTurnIndexItem,
	SessionTurnRecord,
	StoredIntermediateMessage,
} from "@cohub/protocol/model";
import type { ChannelEnvelope } from "@cohub/protocol/realtime";
import {
	extractBillingPayload,
	HttpError,
	type SessionRecord,
	type TaskRunRecord,
} from "@neta-art/cohub";
import { tick, untrack } from "svelte";
import { classifyAccessError } from "$lib/access/access-state";
import type { SessionListForkRecord } from "$lib/cache/db";
import { sessionTurnsRepo } from "$lib/cache/repositories/session-turns-repo";
import { writeTaskRunDetail } from "$lib/cache/repositories/task-runs-repo";
import { mediaLightbox } from "$lib/components/media-lightbox";
import type {
	GenerationTaskNotice,
	SessionTaskNotice,
} from "$lib/components/SessionTaskTray.svelte";
import {
	buildComposerTextContentBlock,
	type ComposerFileAttachment,
	type ComposerImageAttachment,
} from "$lib/composer-attachments";
import { createPromptTemplateController } from "$lib/features/space/modules/prompt-template-controller.svelte";
import { createKeyedRouteRequestGuard } from "$lib/features/space/modules/route-request-guard";
import { createSkillController } from "$lib/features/space/modules/skill-controller.svelte";
import { mergeTaskRunRecord } from "$lib/features/space/modules/task-run-utils";
import { asRecord } from "$lib/features/space/space-utils";
import { formatGenerationPolicyLabel } from "$lib/generation-policy-label";
import {
	extractGenerationMediaItems,
	extractGenerationPromptPreview,
	isInlineMediaUrl,
} from "$lib/generation-task-media";
import { extractSpaceMentionsFromText } from "$lib/mentions/space";
import {
	formatThinkingLevelShort,
	getRequestedThinkingLevel,
	type ModelThinkingLevel,
} from "$lib/model-catalog";
import {
	uploadChatAttachmentFile,
	uploadChatAttachmentImage,
} from "$lib/public-asset-images";
import { sdk } from "$lib/sdk";
import { sortSessionsByRecentActivity } from "$lib/session-sort";
import type { TimelineItem } from "$lib/session-tree";
import { buildTurnTimelineItems } from "$lib/session-turn-render";
import type { NewChatComposerApplyPayload } from "$lib/space-config";
import type { SpaceRouteIdentity } from "$lib/space-routes";
import { materializeSpaceEntries } from "$lib/space-upload";
import { authStore } from "$lib/stores/auth.svelte";
import {
	billingConversion,
	isBillingAccessBlockedCode,
} from "$lib/stores/billing-conversion.svelte";
import {
	readDraftSessionModel,
	saveDraftSessionModel,
} from "$lib/stores/draft-session-model";
import { modelsCatalogStore } from "$lib/stores/models-catalog.svelte";
import {
	readSessionComposerDraftText,
	removeSessionComposerDraftText,
	sessionComposerDraftKey,
	writeSessionComposerDraftText,
} from "$lib/stores/session-composer-drafts";
import { sessionGenerationStore } from "$lib/stores/session-generation.svelte";
import {
	buildStreamingStoredIntermediateMessages,
	clearCompletedIntermediateHandoff,
	clearGenerationError,
	completeGeneration,
	failGeneration,
	interruptGeneration,
	replaceGenerationTurnId,
	resetGeneration,
	startGenerationRequest,
} from "$lib/stores/session-generation-controller";
import {
	fetchSessionListWithCache,
	getCachedSessionListSnapshot,
	patchCachedSessionList,
} from "$lib/stores/session-list-cache";
import { unreadTracker } from "$lib/stores/session-state.svelte";
import {
	mergeCachedTaskRun,
	restoreCachedTaskRuns,
} from "$lib/stores/task-runs-cache";
import { mergeTurnsById } from "$lib/stores/turn-cache";
import {
	loadMessageToolCalls,
	loadTurnIntermediate,
} from "$lib/stores/turn-intermediate-cache";
import { turnRecordToIndexItem } from "$lib/turn-nav-preview";
import type { LocalUploadEntry } from "$lib/upload-entries";
import type { WorkspaceFileLinkTarget } from "$lib/workspace-file-links";
import {
	shouldClearActiveSessionForNewDraft,
	shouldClearResolvedNewSessionOnRoute,
} from "./new-chat-draft-isolation";
import {
	createSessionComposerController,
	revokeComposerAttachmentPreview,
} from "./session-composer-controller.svelte";
import { createSessionGenerationPolicyController } from "./session-generation-policy-controller.svelte";
import { createSessionGenerationRealtimeController } from "./session-generation-realtime-controller.svelte";
import {
	createSessionScrollController,
	isSessionScrollAnchorInTurns,
	resolveSessionScrollRestore,
} from "./session-scroll-controller.svelte";
import { createSessionShareController } from "./session-share-controller.svelte";
import {
	createSessionTaskController,
	isBackgroundBashTaskRun,
	isGenerationTaskRun,
	SESSION_TASK_TYPES,
	type SessionTaskType,
} from "./session-task-controller.svelte";
import { createSessionTurnLoadingController } from "./session-turn-loading-controller.svelte";
import {
	extractBackgroundBashResultPreview,
	formatBackgroundBashSubtitle,
	getTurnClientMessageId,
	isOptimisticTurn,
	isSameClientMessageTurn,
	normalizeTurnDuplicates,
	preserveSessionTurnRefs,
	reconcileOptimisticTurn,
} from "./session-utils";
import {
	createSessionWorkspaceController,
	type SessionViewState,
} from "./session-workspace-controller.svelte";
import {
	acquireSpaceGeneration,
	releaseSpaceGeneration,
	setSpaceGenerationLastReleaseHandler,
} from "./space-generation-lease";
import type {
	SelectedModel,
	SessionChatAccess,
	SessionChatContext,
	SessionChatEnvironment,
	SessionChatRoute,
} from "./types";
import {
	type ActiveViewportSource,
	type BoardViewportObservation,
	createViewportContextController,
} from "./viewport-context-controller.svelte";

const PRELOAD_THRESHOLD = 10;
const TURN_SCROLL_ANCHOR_OFFSET = 16;
const SESSION_INITIAL_LOADING_DELAY_MS = 160;
const SESSION_SCROLL_ANCHOR_STORAGE_KEY = "cohub:session_scroll_anchor";
const SESSION_TASK_PAGE_LIMIT = 8;
const TERMINAL_GENERATION_STATUSES = new Set([
	"idle",
	"completed",
	"failed",
	"interrupted",
]);

export type SessionChatHostOptions = SessionChatEnvironment & {
	getSpaceRouteIdentity?: () => SpaceRouteIdentity;
	getConnectionState: () =>
		| "idle"
		| "connecting"
		| "reconnecting"
		| "open"
		| "closed"
		| "error";
	canManageSessionAccess?: () => boolean;
	hasSpace?: () => boolean;
};

type SessionScrollAnchor = {
	sequence: number;
	offset: number;
	updatedAt: number;
};

function taskRunSortTime(notice: SessionTaskNotice) {
	const rec = notice as { updatedAt?: string; createdAt?: string };
	const raw = rec.updatedAt ?? rec.createdAt ?? "";
	const t = Date.parse(raw);
	return Number.isFinite(t) ? t : 0;
}

// Wire generation store reset once for process-wide leases.
setSpaceGenerationLastReleaseHandler((spaceId) => {
	sessionGenerationStore.resetSpace(spaceId);
});

export function createSessionChatHost(options: SessionChatHostOptions) {
	let spaceId = $state("");
	let route = $state<SessionChatRoute>({ kind: "none" });
	let access = $state<SessionChatAccess>({
		spaceLoadError: "",
		spaceHasMinimalAccess: false,
		canCreateSession: false,
		bootstrapping: false,
	});
	let disposed = false;
	/** Space id this host currently holds a generation lease for (null if none). */
	let leasedSpaceId: string | null = null;

	function acquireGenerationLease(nextSpaceId: string) {
		if (!nextSpaceId || leasedSpaceId === nextSpaceId) return;
		if (leasedSpaceId) releaseSpaceGeneration(leasedSpaceId);
		acquireSpaceGeneration(nextSpaceId);
		leasedSpaceId = nextSpaceId;
	}

	function releaseGenerationLease() {
		if (!leasedSpaceId) return;
		releaseSpaceGeneration(leasedSpaceId);
		leasedSpaceId = null;
	}

	const isNewSessionRoute = $derived(route.kind === "new");
	const workspace = createSessionWorkspaceController();
	const composer = createSessionComposerController();
	const viewport = createViewportContextController();
	const scroll = createSessionScrollController();
	const turnLoading = createSessionTurnLoadingController({
		getSpaceId: () => spaceId,
	});
	const tasks = createSessionTaskController();
	const generationPolicy = createSessionGenerationPolicyController({
		getActiveSessionId: () => workspace.activeSessionId,
	});
	const promptTemplatesCtrl = createPromptTemplateController({
		getSpaceId: () => spaceId,
	});
	const skillsCtrl = createSkillController({
		getSpaceId: () => spaceId,
	});
	const share = createSessionShareController({
		getSpaceIdentity: () =>
			options.getSpaceRouteIdentity?.() ?? { id: spaceId },
		canManageAccess: () => options.canManageSessionAccess?.() ?? false,
	});

	const spaceSessions = $derived(workspace.spaceSessions);
	const sessionStateById = $derived(workspace.sessionStateById);
	const activeSessionId = $derived(workspace.activeSessionId);
	const loadingSessionIds = $derived(workspace.loadingSessionIds);
	const visibleInitialLoadingSessionIds = $derived(
		workspace.visibleInitialLoadingSessionIds,
	);

	let resolvedNewSessionId = $state<string | null>(null);
	const isDraftNewSessionRoute = $derived(
		isNewSessionRoute && !resolvedNewSessionId,
	);
	let createSessionError = $state("");
	let forkingTurnId = $state<string | null>(null);

	// Stable empty refs — fresh `{}` / `[]` each derived run re-triggers effects.
	const EMPTY_DRAFT_SESSION_STATE: SessionViewState = {
		session: undefined,
		turns: [],
		loading: false,
		loaded: true,
		error: null,
		hasMore: false,
		hasMoreNewer: false,
		loadingOlder: false,
		loadingNewer: false,
		oldestCursor: undefined,
	};
	const EMPTY_TIMELINE: TimelineItem[] = [];

	const draftSessionState = $derived<SessionViewState | null>(
		isDraftNewSessionRoute ? EMPTY_DRAFT_SESSION_STATE : null,
	);
	const activeSessionState = $derived(
		isDraftNewSessionRoute
			? draftSessionState
			: activeSessionId
				? (sessionStateById[activeSessionId] ?? null)
				: null,
	);
	const activeSessionInitialLoadingVisible = $derived.by(() =>
		Boolean(
			activeSessionId && visibleInitialLoadingSessionIds[activeSessionId],
		),
	);

	let activeComposerDraftKey = $state<string | null>(null);
	let composerDraftSaveTimer: ReturnType<typeof setTimeout> | null = null;
	let preserveComposerInputOnNextDraftKeyChange = false;
	const input = $derived(composer.input);
	const attachments = $derived(composer.attachments);
	const sending = $derived(composer.sending);
	const aborting = $derived(composer.aborting);
	const composerError = $derived(composer.error);
	const composerErrorCode = $derived(composer.errorCode);
	const nextComposerDraftKey = $derived.by(() => {
		if (sending && activeComposerDraftKey) return activeComposerDraftKey;
		if (isNewSessionRoute)
			return sessionComposerDraftKey(spaceId, { kind: "new" });
		if (activeSessionId) {
			return sessionComposerDraftKey(spaceId, {
				kind: "session",
				sessionId: activeSessionId,
			});
		}
		return null;
	});

	const modelsCatalog = $derived(modelsCatalogStore.items);
	const visibleModelsCatalog = $derived(modelsCatalogStore.visibleItems);
	const generationModelsCatalog = $derived(generationPolicy.modelsCatalog);
	const generationPolicyMode = $derived(generationPolicy.mode);
	const selectedGenerationModels = $derived(generationPolicy.selectedModels);
	const generationPolicyLabel = $derived(
		formatGenerationPolicyLabel({
			mode: generationPolicyMode,
			selectedModels: selectedGenerationModels,
			catalog: generationModelsCatalog,
		}),
	);
	const generationEnumSelections = $derived(generationPolicy.enumSelections);
	const generationNumericConstraints = $derived(
		generationPolicy.numericConstraints,
	);
	const generationBooleanConstraints = $derived(
		generationPolicy.booleanConstraints,
	);
	const promptTemplates = $derived(promptTemplatesCtrl.items);
	const promptTemplatesLoaded = $derived(promptTemplatesCtrl.loaded);
	const skills = $derived(skillsCtrl.items);
	const skillsLoaded = $derived(skillsCtrl.loaded);
	let showModelSelector = $state(false);
	let sessionModelById = $state<Record<string, SelectedModel | null>>({});
	let sessionThinkingLevelById = $state<
		Record<string, ModelThinkingLevel | null>
	>({});
	let draftSessionModel = $state<SelectedModel | null>(null);
	let draftSessionModelManuallySelected = $state(false);
	let draftThinkingLevel = $state<ModelThinkingLevel | null>(null);

	let composerHostEl = $state<HTMLDivElement | null>(null);
	let chatChromeEl = $state<HTMLDivElement | null>(null);
	const shouldAutoFollow = $derived(scroll.shouldAutoFollow);
	const composerHeight = $derived(scroll.composerHeight);
	const chatChromeHeight = $derived(scroll.chatChromeHeight);
	const listEl = $derived(scroll.listEl);
	const chatTimelineRef = $derived(scroll.chatTimelineRef);
	const turnIndexBySessionId = $derived(turnLoading.turnIndexBySessionId);
	const loadingTurnSequence = $derived(turnLoading.loadingTurnSequence);
	let currentTurnSequence = $state<number | null>(null);
	let highlightedTurnSequence = $state<number | null>(null);
	const turnMarkerPositions = $derived(scroll.turnMarkerPositions);
	const turnMarkerHeights = $derived(scroll.turnMarkerHeights);
	const timelineScrollTop = $derived(scroll.timelineScrollTop);
	const timelineScrollHeight = $derived(scroll.timelineScrollHeight);
	const timelineClientHeight = $derived(scroll.timelineClientHeight);
	let showTurnBottomSheet = $state(false);
	let appliedRouteTurnKey = $state<string | null>(null);
	let turnMarkerMeasureFrame: number | null = null;
	let lastTurnIndexRefreshKey = "";
	let restoringBottomSessionId = $state<string | null>(null);
	let programmaticScrollActive = false;
	let programmaticScrollTarget: number | null = null;
	let userScrollActive = false;
	const pendingRestoreSessionId = $derived(scroll.pendingRestoreSessionId);
	const activeAnchorRestore = $derived(scroll.activeAnchorRestore);
	const pendingTimelineMarkdownRenders = $derived(
		scroll.pendingTimelineMarkdownRenders,
	);
	const anchorRestoreWaitingForLayout = $derived(
		scroll.anchorRestoreWaitingForLayout,
	);

	const generationTaskRunById = $derived(tasks.generationTaskRunById);
	const backgroundBashTaskRunById = $derived(tasks.backgroundBashTaskRunById);
	const backgroundBashHydrateKey = $derived(tasks.backgroundBashHydrateKey);
	const sessionTaskRecentHydrateKey = $derived(tasks.recentHydrateKey);
	const sessionTaskRecentLoading = $derived(tasks.recentLoading);
	const sessionTaskRecentCursors = $derived(tasks.recentCursors);
	const sessionTaskRecentHasMoreByType = $derived(tasks.recentHasMoreByType);
	const pendingFollowupActionIds = $derived(tasks.pendingFollowupActionIds);
	const taskHydrateRetryCounts = new Map<string, number>();
	const taskHydrateRetryTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();

	let refreshSessionsListInFlight: Promise<void> | null = null;
	let refreshSessionsListQueued = false;
	let refreshSessionsListQueuedForce = false;
	const turnHydrationInFlight = new Map<string, Promise<void>>();
	let reconnectSyncInFlight: Promise<void> | null = null;

	const viewportContexts = $derived(viewport.contexts);

	const firstCatalogModel = $derived(
		visibleModelsCatalog && visibleModelsCatalog.length > 0
			? {
					provider: visibleModelsCatalog[0].provider,
					id: visibleModelsCatalog[0].id,
					name: visibleModelsCatalog[0].model.name as string | undefined,
				}
			: null,
	);
	const EMPTY_TURN_INDEX: SessionTurnIndexItem[] = [];
	const activeTurnIndex = $derived.by(() =>
		activeSessionId
			? (turnIndexBySessionId[activeSessionId] ?? EMPTY_TURN_INDEX)
			: EMPTY_TURN_INDEX,
	);
	const activeSessionLastTurnModel = $derived.by(() => {
		const turns = [...(activeSessionState?.turns ?? []), ...activeTurnIndex]
			.filter((turn) => typeof turn.model === "string" && turn.model.trim())
			.sort((a, b) => a.sequence - b.sequence);
		const lastTurn = turns.at(-1);
		if (!lastTurn?.model) return null;
		const provider = lastTurn.provider ?? "cohub";
		const catalogItem = visibleModelsCatalog?.find(
			(item) => item.id === lastTurn.model && item.provider === provider,
		);
		return {
			provider,
			id: lastTurn.model,
			name: catalogItem?.model.name as string | undefined,
		} satisfies SelectedModel;
	});
	const activeSessionLastRequestedThinkingLevel =
		$derived.by<ModelThinkingLevel | null>(() => {
			const lastPersistedTurn = [...(activeSessionState?.turns ?? [])]
				.filter((turn) => asRecord(turn.meta)?.optimistic !== true)
				.sort((a, b) => a.sequence - b.sequence)
				.at(-1);
			return getRequestedThinkingLevel(lastPersistedTurn?.meta);
		});
	const activeSessionModel = $derived.by(() => {
		if (!activeSessionId) return draftSessionModel ?? firstCatalogModel;
		return (
			sessionModelById[activeSessionId] ??
			activeSessionLastTurnModel ??
			firstCatalogModel
		);
	});
	// Explicit choices remain sticky across turns. Effective model defaults are
	// never promoted into a request, and a pending null explicitly resets to default.
	const activeSessionThinkingLevel = $derived.by<ModelThinkingLevel | null>(
		() => {
			if (!activeSessionId) return draftThinkingLevel;
			return Object.hasOwn(sessionThinkingLevelById, activeSessionId)
				? (sessionThinkingLevelById[activeSessionId] ?? null)
				: activeSessionLastRequestedThinkingLevel;
		},
	);
	const activeGenerationState = $derived.by(() =>
		sessionGenerationStore.get(activeSessionId),
	);
	const activeTurnRailItems = $derived.by<SessionTurnIndexItem[]>(() => {
		const bySequence = new Map<number, SessionTurnIndexItem>();
		for (const item of activeTurnIndex) bySequence.set(item.sequence, item);
		for (const turn of activeSessionState?.turns ?? []) {
			const item = turnRecordToIndexItem(turn);
			const existing = bySequence.get(turn.sequence);
			bySequence.set(turn.sequence, {
				...existing,
				...item,
				authorProfile: item.authorProfile ?? existing?.authorProfile ?? null,
				userUuid: item.userUuid ?? existing?.userUuid ?? null,
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
		return activeTurnIndex.filter((t) => t.sequence < loadedMinTurnSequence)
			.length;
	});
	const unloadedNewerTurnCount = $derived.by(() => {
		if (loadedMaxTurnSequence == null) return 0;
		return activeTurnIndex.filter((t) => t.sequence > loadedMaxTurnSequence)
			.length;
	});
	const EMPTY_INTERMEDIATE_MESSAGES: ReturnType<
		typeof buildStreamingStoredIntermediateMessages
	> = [];
	const activeStreamingIntermediateMessages = $derived.by(() => {
		if (!activeGenerationState || !activeSessionId)
			return EMPTY_INTERMEDIATE_MESSAGES;
		return buildStreamingStoredIntermediateMessages({
			spaceId,
			sessionId: activeSessionId,
			turnId: activeGenerationState.turnId,
			intermediateMessages: activeGenerationState.intermediateMessages,
		});
	});
	const activeGenerationClientMessageId = $derived.by(() => {
		const turnId = activeGenerationState?.turnId;
		if (!turnId) return null;
		return getTurnClientMessageId(
			activeSessionState?.turns.find((turn) => turn.id === turnId) ??
				activeSessionState?.turns.find(
					(turn) => getTurnClientMessageId(turn) === turnId,
				) ?? { meta: null },
		);
	});
	const activeStreamError = $derived.by(
		() => activeGenerationState?.error ?? "",
	);
	const activeStreamErrorCode = $derived.by(
		() => activeGenerationState?.errorCode ?? null,
	);
	const composerNotice = $derived.by(() => activeStreamError || composerError);
	const composerShowsBillingAction = $derived(
		isBillingAccessBlockedCode(activeStreamErrorCode) ||
			isBillingAccessBlockedCode(composerErrorCode),
	);
	const activeSessionIsRunning = $derived.by(() =>
		Boolean(
			activeGenerationState &&
				!TERMINAL_GENERATION_STATUSES.has(activeGenerationState.status),
		),
	);
	const timeline = $derived.by<TimelineItem[]>(() => {
		const state = activeSessionState;
		if (!state) return EMPTY_TIMELINE;
		const streaming =
			activeGenerationState &&
			(activeGenerationState.status === "streaming" ||
				activeGenerationState.status === "pending" ||
				(activeGenerationState.status === "completed" &&
					activeStreamingIntermediateMessages.length > 0) ||
				!TERMINAL_GENERATION_STATUSES.has(activeGenerationState.status))
				? {
						sessionId: activeSessionId ?? "active",
						turnId: activeGenerationState.turnId ?? null,
						anchorUserMessageId:
							activeGenerationState.anchorUserMessageId ?? null,
						clientMessageId: activeGenerationClientMessageId,
						intermediateMessages: activeStreamingIntermediateMessages,
						contentBlocks: activeGenerationState.contentBlocks,
						finalizedPreview: activeGenerationState.finalizedPreview,
						status: activeGenerationState.status,
						runtimePhase: activeGenerationState.runtimePhase,
						runtimeProvider: activeGenerationState.runtimeProvider,
						runtimeModel: activeGenerationState.runtimeModel,
						lastPatchAt: activeGenerationState.lastPatchAt ?? null,
						startedAt: activeGenerationState.startedAt ?? null,
					}
				: null;
		if (state.turns.length === 0 && !streaming) return EMPTY_TIMELINE;
		return buildTurnTimelineItems({
			sessionId: activeSessionId,
			turns: state.turns,
			streaming,
		});
	});
	const hasUnread = $derived.by(() => {
		const session = activeSessionState?.session;
		if (
			!session ||
			!activeSessionState?.loaded ||
			activeSessionState.turns.length === 0
		)
			return false;
		return unreadTracker.isUnread(session, session.lastMessageId);
	});

	const generationRealtime = createSessionGenerationRealtimeController({
		getSpaceId: () => spaceId,
		getConnectionState: () => options.getConnectionState(),
		getActiveSessionId: () => activeSessionId,
		getSessionState: (id) => sessionStateById[id],
		updateSessionState: (id, state) => {
			workspace.sessionStateById = { ...sessionStateById, [id]: state };
		},
		refreshSessionsList: (force) => refreshSessionsList(force ?? true),
		requestBottomFollow: (opts) => requestBottomFollow(opts),
		shouldAutoFollow: () => scroll.shouldAutoFollow,
		getListEl: () => scroll.listEl,
		captureCurrentScrollAnchor: (id) => captureCurrentScrollAnchor(id),
		getSessionScrollAnchor: (id) => getSessionScrollAnchor(id),
		areSessionScrollAnchorsEqual: (a, b) => areSessionScrollAnchorsEqual(a, b),
		restoreSessionScrollAnchorSoon: (id) => restoreSessionScrollAnchorSoon(id),
		isUserScrollActive: () => userScrollActive,
		syncGenerationStateFromTail: (id, turns, at) =>
			syncGenerationStateFromTail(id, turns, at),
		onRecovered: () => undefined,
		onExhausted: (sessionId) => {
			console.warn("[session-chat] recovery exhausted", {
				sessionId,
				spaceId,
			});
		},
	});

	function preferFollowupQueueTurn(
		current: SessionTurnRecord,
		incoming: SessionTurnRecord,
	) {
		if (isOptimisticTurn(current) && !isOptimisticTurn(incoming))
			return incoming;
		if (!isOptimisticTurn(current) && isOptimisticTurn(incoming))
			return current;
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
			(a, b) =>
				a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt),
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

	// task notice mappers are defined among extracted methods; derived uses them.
	// Place derived after methods via lazy $derived.by that calls functions hoisted as function decls.

	$effect(() => {
		const key = nextComposerDraftKey;
		if (key === activeComposerDraftKey) return;
		untrack(() => {
			const previousKey = activeComposerDraftKey;
			const preserveInput = preserveComposerInputOnNextDraftKeyChange;
			preserveComposerInputOnNextDraftKeyChange = false;
			flushActiveComposerDraft();
			activeComposerDraftKey = key;
			if (preserveInput) {
				if (key) writeSessionComposerDraftText(key, composer.input);
				if (previousKey !== key) removeSessionComposerDraftText(previousKey);
				return;
			}
			composer.input = key ? readSessionComposerDraftText(key) : "";
		});
	});
	$effect(() => {
		const key = activeComposerDraftKey;
		const text = input;
		if (!key) return;
		clearComposerDraftSaveTimer();
		composerDraftSaveTimer = setTimeout(() => {
			writeSessionComposerDraftText(key, text);
			composerDraftSaveTimer = null;
		}, 400);
		return clearComposerDraftSaveTimer;
	});
	$effect(() => {
		if (isDraftNewSessionRoute) draftSessionModelManuallySelected = false;
	});
	$effect(() => {
		if (!isDraftNewSessionRoute) return;
		const catalog = visibleModelsCatalog;
		if (!catalog || catalog.length === 0) return;
		if (draftSessionModel) return;
		const stored = readDraftSessionModel();
		if (!stored) return;
		const catalogItem = catalog.find(
			(item) => item.provider === stored.provider && item.id === stored.id,
		);
		if (!catalogItem) return;
		draftSessionModel = {
			provider: catalogItem.provider,
			id: catalogItem.id,
			name: catalogItem.model.name as string | undefined,
		};
	});

	// ── Timeline lifecycle (scroll, restore, markers, generation) ──
	$effect(() => {
		const sessionId = activeSessionId;
		if (!sessionId) return;
		untrack(() => {
			void sessionGenerationStore
				.restore(spaceId, sessionId)
				.catch(() => undefined);
			void loadTurnIndex(sessionId);
		});
	});

	$effect(() => {
		if (!listEl || timeline.length === 0) {
			scroll.clearTurnMarkers();
			return;
		}
		void tick().then(() => {
			updateCurrentTurnSequence();
			scheduleTurnMarkerMeasure();
		});
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
		container.addEventListener("touchstart", beginUserScroll, {
			passive: true,
		});
		container.addEventListener("touchmove", beginUserScroll, { passive: true });
		container.addEventListener("pointerdown", beginUserScroll, {
			passive: true,
		});
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
		// Must accept assistant sequences (turn*10+2), not only user (turn*10).
		const hasCachedAnchor = anchor
			? isSessionScrollAnchorInTurns(anchor.sequence, state.turns)
			: false;
		const isRestoreTargetCurrent = () =>
			activeSessionId === targetId &&
			(scroll.pendingRestoreSessionId === targetId ||
				scroll.activeAnchorRestore?.sessionId === targetId);
		const finishRestore = () => {
			// Only clear state owned by this target — a stale rAF from a previous
			// session must not wipe the next session's pending restore.
			if (scroll.pendingRestoreSessionId === targetId) {
				scroll.pendingRestoreSessionId = null;
			}
			if (restoringBottomSessionId === targetId) {
				restoringBottomSessionId = null;
			}
			if (scroll.activeAnchorRestore?.sessionId === targetId) {
				scroll.activeAnchorRestore = null;
				scroll.anchorRestoreWaitingForLayout = false;
			}
			if (activeSessionId === targetId) updateAutoFollow();
		};
		/** Apply leave position now; keep ownership while content is still laying out. */
		const finishAnchorRestore = (options?: { waitForLayout?: boolean }) => {
			if (scroll.pendingRestoreSessionId === targetId) {
				scroll.pendingRestoreSessionId = null;
			}
			if (restoringBottomSessionId === targetId) {
				restoringBottomSessionId = null;
			}
			if (activeSessionId !== targetId) return;
			const waitForLayout = Boolean(options?.waitForLayout);
			if (waitForLayout) {
				scroll.anchorRestoreWaitingForLayout = true;
				updateAutoFollow();
				return;
			}
			if (scroll.activeAnchorRestore?.sessionId === targetId) {
				scroll.activeAnchorRestore = null;
			}
			scroll.anchorRestoreWaitingForLayout = false;
			updateAutoFollow();
			scheduleTurnMarkerMeasure();
		};
		const restoreToBottom = () => {
			if (activeSessionId !== targetId) {
				finishRestore();
				return;
			}
			if (scroll.activeAnchorRestore?.sessionId === targetId) {
				scroll.activeAnchorRestore = null;
			}
			scroll.anchorRestoreWaitingForLayout = false;
			restoringBottomSessionId = targetId;
			scroll.shouldAutoFollow = true;
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
		const restoreByAnchor = (retries = 6) => {
			requestAnimationFrame(() => {
				// Session switched away — drop this attempt without touching the
				// new session's pending restore flags.
				if (activeSessionId !== targetId) return;
				if (scroll.pendingRestoreSessionId !== targetId) return;
				// `{#key}` remount briefly clears listEl. Keep pending restore so
				// the effect can re-run once the new timeline binds.
				if (!listEl) {
					if (retries > 0) restoreByAnchor(retries - 1);
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
					// Only clear this session's anchor when we still own restore.
					if (isRestoreTargetCurrent()) {
						clearSessionScrollAnchor(targetId);
						restoreToBottom();
					}
					return;
				}
				const restore = {
					sessionId: targetId,
					sequence: anchor.sequence,
					offset: anchor.offset,
					updatedAt: anchor.updatedAt,
				};
				scroll.activeAnchorRestore = restore;
				// Apply immediately, but keep the anchor until the target is actually
				// reachable. Early session layout can otherwise clamp it to scrollTop 0.
				const restoreResult = applyActiveAnchorRestore(restore);
				if (restoreResult === "missing") {
					if (isRestoreTargetCurrent()) {
						clearSessionScrollAnchor(targetId);
						restoreToBottom();
					}
					return;
				}
				const waitForLayout =
					pendingTimelineMarkdownRenders > 0 || restoreResult === "pending";
				finishAnchorRestore({ waitForLayout });
				if (waitForLayout && isRestoreTargetCurrent()) {
					requestAnimationFrame(() => {
						maybeCompleteAnchorRestore();
					});
				}
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
		const chromeEl = chatChromeEl;
		const composerEl = composerHostEl;
		if (!chromeEl && !composerEl) {
			if (scroll.chatChromeHeight !== 0) scroll.chatChromeHeight = 0;
			if (scroll.composerHeight !== 0) scroll.composerHeight = 0;
			return;
		}
		const updateChromeHeights = () => {
			const nextChrome =
				chromeEl?.offsetHeight ?? composerEl?.offsetHeight ?? 0;
			const nextComposer = composerEl?.offsetHeight ?? 0;
			const chromeChanged = scroll.chatChromeHeight !== nextChrome;
			const composerChanged = scroll.composerHeight !== nextComposer;
			if (chromeChanged) scroll.chatChromeHeight = nextChrome;
			if (composerChanged) scroll.composerHeight = nextComposer;
			// Rail bottomOffset changes the track geometry; remeasure after layout.
			if (chromeChanged || composerChanged) scheduleTurnMarkerMeasure();
		};
		updateChromeHeights();
		const ro = new ResizeObserver(() => updateChromeHeights());
		if (chromeEl) ro.observe(chromeEl);
		if (composerEl && composerEl !== chromeEl) ro.observe(composerEl);
		return () => ro.disconnect();
	});

	$effect(() => {
		if (!listEl || !activeSessionId) return;
		updateTimelineScrollMetrics();
		updateAutoFollow();
	});

	// Keep pinned to bottom when content grows (markdown/images) while following.
	$effect(() => {
		const el = listEl;
		if (!el) return;
		let prevHeight = el.scrollHeight;
		const ro = new ResizeObserver(() => {
			if (listEl !== el) return;
			const currentHeight = el.scrollHeight;
			const restoringBottom = restoringBottomSessionId === activeSessionId;
			const restoringPosition = isRestoringSessionScroll(activeSessionId);
			if (restoringPosition) maybeCompleteAnchorRestore();
			if (
				currentHeight > prevHeight &&
				!restoringPosition &&
				(shouldAutoFollow || restoringBottom)
			) {
				requestBottomFollow({ immediate: restoringBottom });
			}
			prevHeight = currentHeight;
			updateTimelineScrollMetrics();
			scheduleTurnMarkerMeasure();
		});
		ro.observe(el);
		for (const child of Array.from(el.children)) ro.observe(child);
		scheduleTurnMarkerMeasure();
		return () => ro.disconnect();
	});

	// Active session turns cache subscription
	$effect(() => {
		const currentSpaceId = spaceId;
		const sessionId = activeSessionId;
		if (!currentSpaceId || !sessionId) return;
		return sessionTurnsRepo.subscribe(currentSpaceId, sessionId, (snapshot) => {
			const current = sessionStateById[sessionId];
			if (!current) return;
			const nextTurns = preserveSessionTurnRefs(
				current.turns,
				normalizeTurnDuplicates(
					mergeTurnsById(current.turns, snapshot.turns, {
						preferIncoming: true,
					}),
				),
			);
			workspace.sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					...current,
					session: snapshot.session ?? current.session,
					turns: nextTurns,
					hasMore: snapshot.hasMoreOlder,
					hasMoreNewer: snapshot.hasMoreNewer,
					oldestCursor: snapshot.oldestSequence ?? undefined,
				},
			};
		});
	});

	$effect(() => {
		const sessionId = activeSessionId;
		generationRealtime.syncActiveSubscription(Boolean(spaceId && sessionId));
	});

	// Session task tray: restore cache + hydrate active runs for the open session only.
	$effect(() => {
		const sessionId = activeSessionId;
		if (!sessionId) {
			if (backgroundBashHydrateKey !== "") {
				tasks.backgroundBashHydrateKey = "";
				resetRecentSessionTaskPagination();
			}
			return;
		}
		const hydrateKey = `${spaceId}:${sessionId}`;
		if (backgroundBashHydrateKey !== hydrateKey) {
			tasks.backgroundBashHydrateKey = hydrateKey;
			resetRecentSessionTaskPagination();
			void restoreCachedTaskRuns(spaceId, sessionId)
				.then((runs) => {
					for (const run of runs) ingestSessionTaskRun(run);
				})
				.catch(() => undefined);
			void hydrateActiveSessionTasks(sessionId);
		}
	});

	// ── Chat methods (extracted from SpaceWorkspacePage) ──
	function clearComposerError() {
		composer.clearError();
	}

	function setComposerError(message: string, code: string | null = null) {
		composer.setError(message, code);
	}

	function clearComposerDraftSaveTimer() {
		if (composerDraftSaveTimer == null) return;
		clearTimeout(composerDraftSaveTimer);
		composerDraftSaveTimer = null;
	}

	function flushActiveComposerDraft() {
		clearComposerDraftSaveTimer();
		if (!activeComposerDraftKey) return;
		writeSessionComposerDraftText(activeComposerDraftKey, composer.input);
	}

	function clearActiveComposerDraft() {
		clearComposerDraftSaveTimer();
		removeSessionComposerDraftText(activeComposerDraftKey);
	}

	function getHttpErrorCode(error: unknown): string | null {
		if (!(error instanceof HttpError)) return null;
		const body = error.body;
		if (!body || typeof body !== "object" || Array.isArray(body)) return null;
		const record = body as Record<string, unknown>;
		const directError = record.error;
		if (
			directError &&
			typeof directError === "object" &&
			!Array.isArray(directError)
		) {
			const code = (directError as Record<string, unknown>).code;
			if (typeof code === "string") return code;
		}
		const code = record.code;
		return typeof code === "string" ? code : null;
	}

	// ─── Task detail ───

	function getTaskPayloadData(run: Pick<TaskRunRecord, "payload">) {
		return asRecord(asRecord(run.payload)?.data);
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
			mediaItems: extractGenerationMediaItems(run.result, {
				deferBase64: true,
			}),
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
		tasks.upsertGenerationTaskRun(run);
	}

	function upsertBackgroundBashTaskRun(run: TaskRunRecord) {
		tasks.upsertBackgroundBashTaskRun(run);
	}

	async function hydrateTaskRun(taskId: string) {
		try {
			const detail = await sdk.tasks.get(taskId);
			taskHydrateRetryCounts.delete(taskId);
			const retryTimer = taskHydrateRetryTimers.get(taskId);
			if (retryTimer) clearTimeout(retryTimer);
			taskHydrateRetryTimers.delete(taskId);
			if (detail.run.spaceId)
				mergeCachedTaskRun(detail.run.spaceId, detail.run);
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

	function ingestSessionTaskRun(run: TaskRunRecord) {
		mergeCachedTaskRun(spaceId, run);
		if (isGenerationTaskRun(run)) upsertGenerationTaskRun(run);
		if (isBackgroundBashTaskRun(run)) upsertBackgroundBashTaskRun(run);
	}

	async function fetchSessionTasksByType(
		sessionId: string,
		taskType: SessionTaskType,
		options: {
			status?: "active";
			cursor?: string | null;
		},
	) {
		const { runs, pageInfo } = await sdk.tasks.list({
			spaceId,
			sessionId,
			taskType,
			status: options.status,
			limit: SESSION_TASK_PAGE_LIMIT,
			cursor: options.cursor ?? undefined,
		});
		return {
			runs,
			pageInfo: pageInfo ?? { hasMore: false, nextCursor: null },
		};
	}

	async function hydrateActiveSessionTasks(sessionId: string) {
		const requestSpaceId = spaceId;
		try {
			const results = await Promise.all(
				SESSION_TASK_TYPES.map((taskType) =>
					fetchSessionTasksByType(sessionId, taskType, { status: "active" }),
				),
			);
			if (spaceId !== requestSpaceId || activeSessionId !== sessionId) return;
			for (const result of results) {
				for (const run of result.runs) ingestSessionTaskRun(run);
			}
		} catch (error) {
			console.warn("Failed to load active session tasks:", error);
		}
	}

	function resetRecentSessionTaskPagination() {
		tasks.resetRecentPagination();
	}

	async function loadRecentSessionTaskPage(sessionId: string) {
		if (sessionTaskRecentLoading) return;
		const requestSpaceId = spaceId;
		const hydrateKey = `${requestSpaceId}:${sessionId}`;
		const isCurrentRequest = () =>
			spaceId === requestSpaceId && workspace.activeSessionId === sessionId;
		tasks.recentLoading = true;
		try {
			const results = await Promise.all(
				SESSION_TASK_TYPES.map(async (taskType) => {
					if (
						sessionTaskRecentHydrateKey === hydrateKey &&
						sessionTaskRecentHasMoreByType[taskType] === false
					) {
						return { taskType, runs: [], pageInfo: null };
					}
					const { runs, pageInfo } = await fetchSessionTasksByType(
						sessionId,
						taskType,
						{
							cursor:
								sessionTaskRecentHydrateKey === hydrateKey
									? sessionTaskRecentCursors[taskType]
									: undefined,
						},
					);
					return { taskType, runs, pageInfo };
				}),
			);
			if (!isCurrentRequest()) return;
			for (const result of results) {
				for (const run of result.runs) ingestSessionTaskRun(run);
			}
			const nextCursors: Partial<Record<SessionTaskType, string | null>> = {
				...(sessionTaskRecentHydrateKey === hydrateKey
					? sessionTaskRecentCursors
					: {}),
			};
			const nextHasMore: Partial<Record<SessionTaskType, boolean>> = {
				...(sessionTaskRecentHydrateKey === hydrateKey
					? sessionTaskRecentHasMoreByType
					: {}),
			};
			for (const result of results) {
				if (!result.pageInfo) continue;
				nextCursors[result.taskType] = result.pageInfo.nextCursor;
				nextHasMore[result.taskType] = result.pageInfo.hasMore;
			}
			tasks.setRecentPagination(hydrateKey, nextCursors, nextHasMore);
		} catch (error) {
			if (isCurrentRequest())
				console.warn("Failed to load recent session tasks:", error);
		} finally {
			if (isCurrentRequest()) tasks.recentLoading = false;
		}
	}

	function handleSessionTaskTrayExpand() {
		if (!activeSessionId) return;
		void loadRecentSessionTaskPage(activeSessionId);
	}

	function handleSessionTaskTrayLoadMore() {
		if (!activeSessionId) return;
		void loadRecentSessionTaskPage(activeSessionId);
	}

	async function handleOpenGenerationTaskMedia(notice: GenerationTaskNotice) {
		const hasDeferredMedia = notice.mediaItems.some(
			(item) =>
				item.deferred ||
				isInlineMediaUrl(item.src) ||
				isInlineMediaUrl(item.poster),
		);
		if (!hasDeferredMedia) {
			mediaLightbox.show(notice.mediaItems);
			return;
		}
		try {
			const detail = await sdk.tasks.get(notice.id);
			const mediaItems = extractGenerationMediaItems(detail.run.result);
			if (mediaItems.length > 0) mediaLightbox.show(mediaItems);
		} catch (error) {
			console.warn("Failed to load generation media:", error);
		}
	}

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
		clearComposerError();
		await syncSessionNewer(sessionId, null).catch(() => undefined);
	}

	async function handleSteerFollowup(turnId: string) {
		if (
			!activeSessionId ||
			!(options.hasSpace?.() ?? Boolean(spaceId)) ||
			pendingFollowupActionIds.has(turnId)
		)
			return;
		const sessionId = activeSessionId;
		tasks.addPendingFollowupAction(turnId);
		clearComposerError();
		try {
			const result = await sdk
				.space(spaceId)
				.session(sessionId)
				.steerTurn(turnId);
			const current = sessionStateById[sessionId];
			if (current) {
				workspace.sessionStateById = {
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
			setComposerError(
				error instanceof Error ? error.message : "Failed to steer follow-up",
			);
		} finally {
			tasks.removePendingFollowupAction(turnId);
		}
	}

	async function handleCancelFollowup(turnId: string) {
		if (
			!activeSessionId ||
			!(options.hasSpace?.() ?? Boolean(spaceId)) ||
			pendingFollowupActionIds.has(turnId)
		)
			return;
		const sessionId = activeSessionId;
		tasks.addPendingFollowupAction(turnId);
		clearComposerError();
		try {
			const result = await sdk
				.space(spaceId)
				.session(sessionId)
				.cancelTurn(turnId);
			const current = sessionStateById[sessionId];
			if (current) {
				workspace.sessionStateById = {
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
			setComposerError(
				error instanceof Error ? error.message : "Failed to cancel follow-up",
			);
		} finally {
			tasks.removePendingFollowupAction(turnId);
		}
	}

	function applySessionGenerationPolicy(sessionId: string) {
		generationPolicy.apply(generationPolicy.load(sessionId));
	}

	function ensureSessionModelLoaded(sessionId: string) {
		if (Object.hasOwn(sessionModelById, sessionId)) return;
		sessionModelById = {
			...sessionModelById,
			[sessionId]: null,
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
		await generationPolicy.loadModelsCatalog();
	}

	function buildTurnGenerationPolicy() {
		return generationPolicy.buildTurnPolicy();
	}

	function setGenerationPolicyMode(mode: "auto" | "limited") {
		generationPolicy.setPolicyMode(mode);
	}

	function setGenerationModelSelected(modelId: string, selected: boolean) {
		generationPolicy.setModelSelected(modelId, selected);
	}

	function setGenerationEnumValueSelected(
		modelId: string,
		parameter: string,
		value: string,
		selected: boolean,
	) {
		generationPolicy.setEnumValueSelected(modelId, parameter, value, selected);
	}

	function setGenerationNumericConstraint(
		modelId: string,
		parameter: string,
		constraint: { min?: number; max?: number },
	) {
		generationPolicy.setNumericConstraint(modelId, parameter, constraint);
	}

	function setGenerationBooleanConstraint(
		modelId: string,
		parameter: string,
		constraint: { value?: boolean },
	) {
		generationPolicy.setBooleanConstraint(modelId, parameter, constraint);
	}

	async function loadPromptTemplates() {
		await promptTemplatesCtrl.load();
		await skillsCtrl.load();
	}

	function handleModelSelect(model: {
		provider: string;
		id: string;
		thinkingLevel?: ModelThinkingLevel;
	}) {
		const catalogItem = modelsCatalog?.find(
			(item) => item.provider === model.provider && item.id === model.id,
		);
		const selected = {
			provider: model.provider,
			id: model.id,
			name: catalogItem?.model.name as string | undefined,
		} satisfies SelectedModel;
		const thinkingLevel = model.thinkingLevel ?? null;
		if (!activeSessionId) {
			draftSessionModel = selected;
			draftSessionModelManuallySelected = true;
			draftThinkingLevel = thinkingLevel;
			showModelSelector = false;
			focusComposerSoon();
			return;
		}
		sessionModelById = {
			...sessionModelById,
			[activeSessionId]: selected,
		};
		sessionThinkingLevelById = {
			...sessionThinkingLevelById,
			[activeSessionId]: thinkingLevel,
		};
		showModelSelector = false;
		focusComposerSoon();
	}

	function loadSessionScrollAnchors() {
		scroll.loadSessionScrollAnchors(SESSION_SCROLL_ANCHOR_STORAGE_KEY);
	}

	function persistSessionScrollAnchorsNow() {
		scroll.persistSessionScrollAnchorsNow(SESSION_SCROLL_ANCHOR_STORAGE_KEY);
	}

	function setSessionScrollAnchor(
		sessionId: string,
		anchor: SessionScrollAnchor,
	) {
		scroll.setSessionScrollAnchor(
			SESSION_SCROLL_ANCHOR_STORAGE_KEY,
			sessionId,
			anchor,
		);
	}

	function getSessionScrollAnchor(sessionId: string) {
		return scroll.getSessionScrollAnchor(sessionId);
	}

	function clearSessionScrollAnchor(sessionId: string) {
		scroll.clearSessionScrollAnchor(
			SESSION_SCROLL_ANCHOR_STORAGE_KEY,
			sessionId,
		);
	}

	function getMessageElementAbsoluteTop(node: HTMLElement) {
		return scroll.getMessageElementAbsoluteTop(node);
	}

	function updateTimelineScrollMetrics() {
		scroll.updateTimelineScrollMetrics();
	}

	function measureTurnMarkerPositions() {
		scroll.measureTurnMarkerPositions(TURN_SCROLL_ANCHOR_OFFSET);
	}

	function scheduleTurnMarkerMeasure() {
		if (turnMarkerMeasureFrame != null) return;
		turnMarkerMeasureFrame = requestAnimationFrame(() => {
			turnMarkerMeasureFrame = null;
			measureTurnMarkerPositions();
		});
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
				(turn) =>
					turn.status !== "running" && turn.status !== "abort_requested",
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
		// Re-entry restore owns the saved leave position until it finishes.
		if (isRestoringSessionScroll(sessionId)) return;
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
		const offset = listEl.scrollTop - absoluteTop;
		setSessionScrollAnchor(sessionId, {
			sequence,
			offset,
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
		const offset = listEl.scrollTop - absoluteTop;
		setSessionScrollAnchor(sessionId, {
			sequence,
			offset,
			updatedAt: Date.now(),
		});
		const state = sessionStateById[sessionId];
		unreadTracker.markViewed(sessionId, state?.session?.lastMessageId ?? null);
	}

	function upsertSessionRecord(
		session: SessionRecord,
		options?: { cache?: boolean },
	) {
		const nextSessions = workspace.upsertSessionRecord(session);
		if (options?.cache !== false) {
			void patchCachedSessionList(spaceId, () => nextSessions).catch(
				() => undefined,
			);
		}
	}

	function applySessionRealtimeRecord(session: SessionRecord) {
		upsertSessionRecord(session);
	}

	function applySessionsSnapshot(sessions: SessionRecord[]) {
		workspace.applySessionsSnapshot(sessions);
	}

	function seedSessions(sessions: SessionRecord[]) {
		workspace.seedSessions(sessions);
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
			} catch (error) {
				console.warn("[space] Failed to refresh sessions:", error);
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
		const previousSessionId = activeSessionId;
		// `loaded` means bootstrap finished (cache paint and/or network). While
		// loading, loadSessionState owns the fetch — do not double-hit /turns.
		const alreadyLoaded = Boolean(sessionStateById[sessionId]?.loaded);
		const sessionChanged = previousSessionId !== sessionId;
		workspace.prepareRouteSession(sessionId);
		scroll.pendingRestoreSessionId = sessionId;
		scroll.activeAnchorRestore = null;
		scroll.anchorRestoreWaitingForLayout = false;
		// Session switch remounts the timeline via `{#key}`. MarkdownViews that
		// started rendering on the previous tree may never fire onRendered, so
		// drop any leaked pending count — otherwise restore waits forever and
		// the new list stays at scrollTop 0.
		if (sessionChanged) {
			scroll.pendingTimelineMarkdownRenders = 0;
		}
		userScrollActive = false;
		programmaticScrollActive = false;
		programmaticScrollTarget = null;
		currentTurnSequence = null;
		showTurnBottomSheet = false;
		ensureSessionModelLoaded(sessionId);
		applySessionGenerationPolicy(sessionId);
		// Keep mid-session position: only default to bottom when no cached anchor.
		scroll.shouldAutoFollow = !getSessionScrollAnchor(sessionId);
		// Always restore local generation UI. Re-fetch tail only when switching
		// back into a fully loaded session (mid-send leave / dual-host return).
		void sessionGenerationStore
			.restore(spaceId, sessionId)
			.catch(() => undefined)
			.then(() => {
				if (disposed || activeSessionId !== sessionId) return;
				if (!alreadyLoaded || !sessionChanged) return;
				return reconcileSessionTail(sessionId);
			})
			.catch(() => undefined);
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
				current &&
				TERMINAL_GENERATION_STATUSES.has(current.status) &&
				isSameTurn;
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
		if (existing?.loaded && !force) return;
		const load = async () => {
			const guard = createKeyedRouteRequestGuard({
				captureKey: () => `${spaceId}:${sessionId}`,
			});
			let cached: Awaited<
				ReturnType<typeof sessionTurnsRepo.getCached>
			> | null = null;
			if (!force) {
				try {
					cached = await sessionTurnsRepo.getCached(spaceId, sessionId);
				} catch (error) {
					console.warn(
						"[loadSessionState] Failed to read session cache:",
						error,
					);
				}
			}
			if (!guard.isCurrent()) return;
			if (cached && (cached.turns.length > 0 || cached.session)) {
				workspace.sessionStateById = {
					...sessionStateById,
					[sessionId]: {
						session:
							cached.session ??
							existing?.session ??
							spaceSessions.find((s) => s.id === sessionId),
						turns: cached.turns,
						loading: true,
						loaded: true,
						error: null,
						hasMore: cached.hasMoreOlder,
						hasMoreNewer: cached.hasMoreNewer,
						loadingOlder: false,
						loadingNewer: false,
						oldestCursor: cached.oldestSequence ?? undefined,
					},
				};
			}
			workspace.loadingSessionIds = {
				...loadingSessionIds,
				[sessionId]: true,
			};
			workspace.visibleInitialLoadingSessionIds = {
				...visibleInitialLoadingSessionIds,
				[sessionId]: false,
			};
			const loadSpaceId = spaceId;
			const loadingTimer = setTimeout(() => {
				if (spaceId !== loadSpaceId) return;
				if (sessionStateById[sessionId]?.loaded) return;
				workspace.visibleInitialLoadingSessionIds = {
					...visibleInitialLoadingSessionIds,
					[sessionId]: true,
				};
			}, SESSION_INITIAL_LOADING_DELAY_MS);
			const currentSeed = sessionStateById[sessionId];
			workspace.sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					session:
						currentSeed?.session ??
						existing?.session ??
						spaceSessions.find((s) => s.id === sessionId),
					turns: currentSeed?.turns ?? existing?.turns ?? [],
					loading: true,
					loaded: currentSeed?.loaded ?? existing?.loaded ?? false,
					error: currentSeed?.error ?? existing?.error ?? null,
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
				if (!guard.isCurrent()) return;
				await syncGenerationStateFromTail(
					sessionId,
					response.turns,
					requestStartedAt,
				);
				const snapshot = await sessionTurnsRepo.replaceTail(
					spaceId,
					sessionId,
					{
						session: response.session,
						turns: response.turns,
						hasMore: response.hasMore,
					},
				);
				if (!guard.isCurrent()) return;
				upsertSessionRecord(response.session);
				const currentAfterSnapshot = sessionStateById[sessionId];
				const nextTurns = currentAfterSnapshot
					? preserveSessionTurnRefs(currentAfterSnapshot.turns, snapshot.turns)
					: snapshot.turns;
				workspace.sessionStateById = {
					...sessionStateById,
					[sessionId]: {
						session: snapshot.session ?? response.session,
						turns: nextTurns,
						loading: false,
						loaded: true,
						error: null,
						hasMore: snapshot.hasMoreOlder,
						hasMoreNewer: snapshot.hasMoreNewer,
						loadingOlder: false,
						loadingNewer: false,
						oldestCursor: snapshot.oldestSequence ?? undefined,
					},
				};
			} catch (error) {
				if (!guard.isCurrent()) return;
				const fallback = sessionStateById[sessionId];
				workspace.sessionStateById = {
					...sessionStateById,
					[sessionId]: {
						session:
							fallback?.session ??
							existing?.session ??
							spaceSessions.find((s) => s.id === sessionId),
						turns: fallback?.turns ?? existing?.turns ?? [],
						loading: false,
						loaded: Boolean(fallback?.loaded ?? existing?.loaded),
						error: classifyAccessError(error, {
							isAuthenticated: authStore.isAuthenticated,
							resource: "session",
						}),
						hasMore: fallback?.hasMore ?? existing?.hasMore ?? true,
						hasMoreNewer:
							fallback?.hasMoreNewer ?? existing?.hasMoreNewer ?? false,
						loadingOlder: false,
						loadingNewer: false,
						oldestCursor: fallback?.oldestCursor ?? existing?.oldestCursor,
					},
				};
			} finally {
				clearTimeout(loadingTimer);
				if (guard.isCurrent()) {
					const nextVisibleLoading = { ...visibleInitialLoadingSessionIds };
					delete nextVisibleLoading[sessionId];
					workspace.visibleInitialLoadingSessionIds = nextVisibleLoading;
					workspace.loadingSessionIds = {
						...loadingSessionIds,
						[sessionId]: false,
					};
				}
			}
		};
		if (force) return load();
		return workspace.runSessionLoad(sessionId, load);
	}

	async function loadTurnIndex(sessionId: string, force = false) {
		await turnLoading.loadTurnIndex(sessionId, force);
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
			Math.max(
				0,
				getMessageElementAbsoluteTop(node) - TURN_SCROLL_ANCHOR_OFFSET,
			),
		);
		scroll.shouldAutoFollow = false;
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
		return turnLoading.runTurnWindowLoad(key, async () => {
			const guard = createKeyedRouteRequestGuard({
				captureKey: () => `${spaceId}:${sessionId}`,
			});
			const state = sessionStateById[sessionId];
			if (state?.turns.some((turn) => turn.sequence === sequence)) return;
			if (state?.loaded && !state.loading && state.turns.length === 0) return;
			turnLoading.loadingTurnSequence = sequence;
			try {
				const response = await sdk
					.space(spaceId)
					.session(sessionId)
					.turns.window({
						sequence,
						before: 10,
						after: 20,
					});
				if (!guard.isCurrent()) return;
				const current = sessionStateById[sessionId] ?? state;
				const mergedTurns = current
					? normalizeTurnDuplicates(
							mergeTurnsById(current.turns, response.turns, {
								preferIncoming: true,
							}),
						)
					: response.turns;
				void sessionTurnsRepo
					.mergeTurns(spaceId, sessionId, response.turns, {
						session: response.session,
						hasMoreOlder: response.hasMoreOlder,
						hasMoreNewer:
							"hasMoreNewer" in response ? response.hasMoreNewer : undefined,
						source: "network",
						trimAnchorSequence: sequence,
					})
					.catch(() => undefined);
				if (current) {
					workspace.sessionStateById = {
						...sessionStateById,
						[sessionId]: {
							...current,
							session: response.session ?? current.session,
							turns: mergedTurns,
							hasMore: response.hasMoreOlder,
							hasMoreNewer:
								"hasMoreNewer" in response
									? response.hasMoreNewer
									: current.hasMoreNewer,
							oldestCursor: mergedTurns[0]?.sequence ?? undefined,
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
				if (guard.isCurrent()) turnLoading.loadingTurnSequence = null;
			}
		});
	}

	async function jumpToTurn(sequence: number) {
		if (!activeSessionId) return;
		try {
			clearComposerError();
			if (scrollToTurnAnchor(sequence)) return;
			await ensureTurnWindowLoaded(activeSessionId, sequence);
			await tick();
			requestAnimationFrame(() => scrollToTurnAnchor(sequence));
		} catch (error) {
			console.warn("[jumpToTurn] Failed to jump to turn:", error);
			setComposerError(
				error instanceof Error ? error.message : "Failed to jump to turn",
			);
		}
	}

	async function jumpToTurnAndUpdateUrl(sequence: number) {
		if (!activeSessionId) return;
		try {
			appliedRouteTurnKey = `${activeSessionId}:${sequence}`;
			await options.router.toTurn(activeSessionId, sequence);
			await jumpToTurn(sequence);
		} catch (error) {
			console.warn("[jumpToTurnAndUpdateUrl] Failed to jump to turn:", error);
			setComposerError(
				error instanceof Error ? error.message : "Failed to jump to turn",
			);
		}
	}

	async function syncSessionNewer(sessionId: string, _cached: unknown) {
		const sync = async () => {
			const state = sessionStateById[sessionId];
			if (!state || state.turns.length === 0) return;
			const newestSeq = state.turns.at(-1)?.sequence;
			if (newestSeq == null) return;
			workspace.sessionStateById = {
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
					void sessionTurnsRepo
						.mergeTurns(spaceId, sessionId, response.turns, {
							session: response.session,
							source: "network",
						})
						.catch(() => undefined);
					const current = sessionStateById[sessionId];
					if (current) {
						const mergedTurns = normalizeTurnDuplicates(
							mergeTurnsById(current.turns, response.turns, {
								preferIncoming: true,
							}),
						);
						workspace.sessionStateById = {
							...sessionStateById,
							[sessionId]: {
								...current,
								session: response.session ?? current.session,
								turns: mergedTurns,
							},
						};
					}
				}
			} catch (error) {
				console.warn("[syncSessionNewer] Failed to sync newer turns:", error);
			} finally {
				const current = sessionStateById[sessionId];
				if (current) {
					workspace.sessionStateById = {
						...sessionStateById,
						[sessionId]: {
							...current,
							loadingNewer: false,
						},
					};
				}
			}
		};
		return workspace.runSyncSessionNewer(sessionId, sync);
	}

	async function loadOlderTurns(sessionId: string) {
		const state = sessionStateById[sessionId];
		if (!state?.hasMore || state.loadingOlder) return;
		chatTimelineRef?.preparePrepend();
		workspace.sessionStateById = {
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
			void sessionTurnsRepo
				.loadOlder(spaceId, sessionId, {
					session: response.session,
					turns: response.turns,
					hasMore: response.hasMore,
				})
				.catch(() => undefined);
			const current = sessionStateById[sessionId] ?? state;
			const mergedTurns = normalizeTurnDuplicates(
				mergeTurnsById(current.turns, response.turns, {
					preferIncoming: false,
				}),
			);
			workspace.sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					...current,
					session: response.session ?? current.session,
					turns: mergedTurns,
					hasMore: response.hasMore,
					hasMoreNewer: current.hasMoreNewer,
					loadingOlder: false,
					loadingNewer: false,
					oldestCursor: mergedTurns[0]?.sequence ?? undefined,
				},
			};
			if (response.turns.length > 0) {
				await tick();
				chatTimelineRef?.finalizePrepend();
			}
		} catch (error) {
			workspace.sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					...state,
					loadingOlder: false,
					error: {
						kind: "error",
						message:
							error instanceof Error
								? error.message
								: "Failed to load older turns",
					},
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
			!workspace.isPreloadingSession(activeSessionId)
		) {
			const sessionId = activeSessionId;
			workspace.beginPreloadingSession(sessionId);
			void loadOlderTurns(sessionId).finally(() =>
				workspace.endPreloadingSession(sessionId),
			);
		}
	}

	function restoreSessionStreamSnapshot(
		sessionId: string,
		options?: { turnId?: string | null; force?: boolean },
	) {
		return generationRealtime.restoreSessionStreamSnapshot(sessionId, options);
	}

	function reconcileSessionTail(sessionId: string) {
		return generationRealtime.reconcileSessionTail(sessionId);
	}

	function clearPostSendRecovery(sessionId: string | null | undefined) {
		generationRealtime.clearPostSendRecovery(sessionId);
	}

	function clearAllPostSendRecovery() {
		generationRealtime.clearAllPostSendRecovery();
	}

	function schedulePostSendRecoveryCheck(sessionId: string) {
		generationRealtime.schedulePostSendRecoveryCheck(sessionId);
	}

	async function reconnectSync() {
		if (reconnectSyncInFlight) return reconnectSyncInFlight;
		const run = (async () => {
			await generationRealtime.reconcileAfterReconnect(
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
		})();
		reconnectSyncInFlight = run.finally(() => {
			reconnectSyncInFlight = null;
		});
		return reconnectSyncInFlight;
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
						provider: input.confirmedTurn?.provider ?? turn.provider,
						model: input.confirmedTurn?.model ?? turn.model,
						meta,
					};
				});
				workspace.sessionStateById = {
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
				workspace.sessionStateById = {
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
		mergeCachedTaskRun(
			spaceId,
			task as Parameters<typeof mergeCachedTaskRun>[1],
		);
		const existingGenerationTaskRun = generationTaskRunById[task.id] ?? null;
		const mergedTaskRun = mergeTaskRunRecord(
			existingGenerationTaskRun,
			{
				...(task as Partial<TaskRunRecord>),
				id: task.id,
				type: task.type,
				userId: task.userId,
			},
			spaceId,
		);
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
		// Shell may also observe task envelopes for route-detail views.
	}

	async function requestIntermediateSyncForTurn(
		sessionId: string,
		turnId: string | null,
	) {
		const current = sessionGenerationStore.get(sessionId);
		if (turnId && current?.turnId && current.turnId !== turnId) return false;
		return restoreSessionStreamSnapshot(sessionId, {
			turnId,
			force: true,
		});
	}

	function clearIntermediateHandoffIfPersisted(
		sessionId: string,
		turnId: string | null,
	) {
		if (!turnId) return;
		const state = sessionStateById[sessionId];
		const turn = state?.turns.find((item) => item.id === turnId) ?? null;
		if (!turn?.intermediateIndex?.messagesObjectKey) return;
		clearCompletedIntermediateHandoff(sessionId, { turnId });
	}

	function completeGenerationForTurn(sessionId: string, turnId: string | null) {
		const current = sessionGenerationStore.get(sessionId);
		if (turnId && current?.turnId && current.turnId !== turnId) return;
		completeGeneration(sessionId);
	}

	async function handleForkTurn(turn: SessionTurnRecord) {
		if (!activeSessionId || forkingTurnId) return;
		const opSpaceId = spaceId;
		const opSessionId = activeSessionId;
		const parentSession = activeSessionState?.session ?? null;
		forkingTurnId = turn.id;
		clearComposerError();
		try {
			const response = await sdk
				.space(opSpaceId)
				.session(opSessionId)
				.turn(turn.sourceTurnId ?? turn.id)
				.fork();
			if (disposed || spaceId !== opSpaceId) return;
			await sessionTurnsRepo
				.clearSession(opSpaceId, response.session.id)
				.catch(() => undefined);
			if (disposed || spaceId !== opSpaceId) return;
			await syncForkResponseToSessionListCache(
				response.session,
				response.fork as SessionListForkRecord,
				parentSession,
			).catch(() => undefined);
			if (disposed || spaceId !== opSpaceId) return;
			await options.router.toSession(response.session.id);
		} catch (error) {
			if (disposed || spaceId !== opSpaceId) return;
			setComposerError(
				error instanceof Error ? error.message : "Failed to fork session",
			);
		} finally {
			if (spaceId === opSpaceId) forkingTurnId = null;
		}
	}

	async function handleAbort() {
		if (
			!activeSessionId ||
			!activeSessionState?.session ||
			!(options.hasSpace?.() ?? Boolean(spaceId)) ||
			aborting
		)
			return;
		const opSpaceId = spaceId;
		const opSessionId = activeSessionId;
		const opTurnId = activeGenerationState?.turnId ?? null;
		composer.aborting = true;
		clearComposerError();
		try {
			await sdk.space(opSpaceId).session(opSessionId).abort({
				turnId: opTurnId,
			});
			if (disposed || spaceId !== opSpaceId) return;
			interruptGeneration(opSessionId);
		} catch (error) {
			if (disposed || spaceId !== opSpaceId) return;
			setComposerError(
				error instanceof Error ? error.message : "Failed to stop generation",
			);
		} finally {
			if (spaceId === opSpaceId) composer.aborting = false;
		}
	}

	function uniqueComposerRelativePaths(
		entries: Array<{ file: File; relativePath: string }>,
	) {
		const used = new Set<string>();
		return entries.map((entry) => {
			const base = entry.relativePath.trim() || entry.file.name || "file";
			if (!used.has(base)) {
				used.add(base);
				return { ...entry, relativePath: base };
			}
			const dot = base.lastIndexOf(".");
			const stem = dot > 0 ? base.slice(0, dot) : base;
			const ext = dot > 0 ? base.slice(dot) : "";
			let index = 2;
			let candidate = `${stem}-${index}${ext}`;
			while (used.has(candidate)) {
				index += 1;
				candidate = `${stem}-${index}${ext}`;
			}
			used.add(candidate);
			return { ...entry, relativePath: candidate };
		});
	}

	async function materializeDurableUrlsToSandbox(
		opSpaceId: string,
		sessionId: string | null,
		entries: Array<{
			name: string;
			relativePath: string;
			size: number;
			mimeType?: string | null;
			downloadUrl: string;
		}>,
	) {
		if (entries.length === 0) return [] as string[];
		// Deduplicate relative paths while keeping each entry's durable metadata.
		const uniquePaths = uniqueComposerRelativePaths(
			entries.map((entry) => ({
				file: new File([], entry.name),
				relativePath: entry.relativePath,
			})),
		);
		const payload = uniquePaths.map((pathEntry, index) => ({
			name: entries[index].name,
			relativePath: pathEntry.relativePath,
			size: entries[index].size,
			mimeType: entries[index].mimeType ?? null,
			downloadUrl: entries[index].downloadUrl,
		}));
		const uploaded = await materializeSpaceEntries({
			spaceId: opSpaceId,
			destination: {
				kind: "sandbox_tmp",
				...(sessionId ? { sessionId } : {}),
			},
			entries: payload,
		});
		return uploaded.map((file) => file.path);
	}

	async function uploadComposerFileDurables(
		opSpaceId: string,
		sessionId: string | null,
		fileAttachments: ComposerFileAttachment[],
	) {
		if (fileAttachments.length === 0) return new Map<string, string>();
		composer.setUploading("file");
		const urls = new Map<string, string>();
		await Promise.all(
			fileAttachments.map(async (attachment) => {
				const asset = await uploadChatAttachmentFile({
					spaceId: opSpaceId,
					sessionId: sessionId ?? undefined,
					file: attachment.file,
					filename: attachment.name,
				});
				urls.set(attachment.id, asset.publicUrl);
			}),
		);
		return urls;
	}

	async function uploadComposerImageDurables(
		opSpaceId: string,
		sessionId: string | null,
		imageAttachments: ComposerImageAttachment[],
	) {
		if (imageAttachments.length === 0) {
			return {
				urls: new Map<string, string>(),
				fileUrls: new Map<string, string>(),
				demotedIds: new Set<string>(),
			};
		}
		composer.setUploading("image");
		const urls = new Map<string, string>();
		const fileUrls = new Map<string, string>();
		const demotedIds = new Set<string>();
		await Promise.all(
			imageAttachments.map(async (attachment) => {
				if (attachment.uploadedUrl) {
					urls.set(attachment.id, attachment.uploadedUrl);
					return;
				}
				try {
					const asset = await uploadChatAttachmentImage({
						spaceId: opSpaceId,
						sessionId: sessionId ?? undefined,
						file: attachment.file,
						mediaType: attachment.mediaType,
						filename: attachment.name,
					});
					urls.set(attachment.id, asset.publicUrl);
				} catch (error) {
					// Image specialization failed — still upload as a normal durable file.
					demotedIds.add(attachment.id);
					console.warn(
						"[composer] image specialization demoted to file durable",
						{
							name: attachment.name,
							size: attachment.size,
							error,
						},
					);
					try {
						const asset = await uploadChatAttachmentFile({
							spaceId: opSpaceId,
							sessionId: sessionId ?? undefined,
							file: attachment.file,
							filename: attachment.name,
						});
						fileUrls.set(attachment.id, asset.publicUrl);
					} catch (fileError) {
						console.warn("[composer] demoted image file durable failed", {
							name: attachment.name,
							error: fileError,
						});
					}
				}
			}),
		);
		if (urls.size > 0) composer.setUploadedImageUrls(urls);
		return { urls, fileUrls, demotedIds };
	}

	function adoptPromptSession(input: {
		session: SessionRecord;
		model: SelectedModel | null;
	}) {
		const { session, model } = input;
		const nextSessions = sortSessionsByRecentActivity([
			session,
			...spaceSessions.filter((item) => item.id !== session.id),
		]);
		void patchCachedSessionList(spaceId, (current) => [
			session,
			...current.filter((item) => item.id !== session.id),
		]).catch(() => undefined);
		seedSessions(nextSessions);
		// Merge with any state already populated by realtime while prompt was in flight.
		// Never clobber turns with [] if WS already delivered session.turn.* events.
		const existing = sessionStateById[session.id];
		const targetSessionState: SessionViewState = existing
			? {
					...existing,
					session,
					error: null,
				}
			: {
					session,
					turns: [],
					loading: false,
					loaded: true,
					error: null,
					hasMore: false,
					hasMoreNewer: false,
					loadingOlder: false,
					loadingNewer: false,
					oldestCursor: undefined,
				};
		workspace.sessionStateById = {
			...sessionStateById,
			[session.id]: targetSessionState,
		};
		resolvedNewSessionId = session.id;
		if (model) {
			sessionModelById = {
				...sessionModelById,
				[session.id]: model,
			};
			if (draftSessionModelManuallySelected) {
				saveDraftSessionModel(model);
			}
		}
		workspace.activeSessionId = session.id;
		ensureSessionModelLoaded(session.id);
		applySessionGenerationPolicy(session.id);
		void options.router.toSession(session.id).catch((error) => {
			console.warn("[NewChat] failed to update URL after prompt", error);
		});
		return targetSessionState;
	}

	async function handleSend() {
		if (
			(!activeSessionState?.session && !isNewSessionRoute) ||
			(!input.trim() && attachments.length === 0) ||
			sending ||
			!(options.hasSpace?.() ?? Boolean(spaceId))
		)
			return;
		composer.sending = true;
		const model = activeSessionModel;
		clearComposerError();
		// Snapshot identity for the whole send pipeline (multi-space host safe).
		const opSpaceId = spaceId;
		const opSessionIdAtStart = activeSessionId;
		clearGenerationError(opSessionIdAtStart);
		// Existing session only — new chat lets prompt create the session server-side.
		let sessionId = activeSessionState?.session?.id ?? null;
		let targetSessionState = activeSessionState;
		const isNewChat = !sessionId;
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
		let hadImageUpload = false;
		let uploadCompleted = false;
		let uploadedReferenceText = "";
		let uploadedImageUrls = new Map<string, string>();
		let optimisticTurn: SessionTurnRecord | null = null;
		let hasActiveTurn = false;
		try {
			const fileAttachments = attachments.filter(
				(attachment): attachment is ComposerFileAttachment =>
					attachment.kind === "file",
			);
			const imageAttachments = attachments.filter(
				(attachment): attachment is ComposerImageAttachment =>
					attachment.kind === "image",
			);
			hadFileUpload = fileAttachments.length > 0;
			hadImageUpload = imageAttachments.length > 0;
			if (fileAttachments.length > 0) composer.setUploading("file");
			if (imageAttachments.length > 0) composer.setUploading("image");

			// Client uploads once to durable public storage.
			// With space, server materializes from those URLs into sandbox (no second client upload).
			const [fileDurableUrls, imageUpload] = await Promise.all([
				uploadComposerFileDurables(opSpaceId, sessionId, fileAttachments),
				uploadComposerImageDurables(opSpaceId, sessionId, imageAttachments),
			]);
			const imageUrls = imageUpload.urls;
			const demotedImageIds = imageUpload.demotedIds;
			const demotedImageFileUrls = imageUpload.fileUrls;
			const durableFileUrls = [
				...fileDurableUrls.values(),
				...demotedImageFileUrls.values(),
			];

			const materializeSource = [
				...fileAttachments.flatMap((attachment) => {
					const url = fileDurableUrls.get(attachment.id);
					if (!url) return [];
					return [
						{
							name: attachment.name,
							relativePath: attachment.relativePath,
							size: attachment.size,
							mimeType: attachment.mediaType,
							downloadUrl: url,
						},
					];
				}),
				...imageAttachments.flatMap((attachment) => {
					const url =
						imageUrls.get(attachment.id) ??
						demotedImageFileUrls.get(attachment.id);
					if (!url) return [];
					return [
						{
							name: attachment.name,
							relativePath: attachment.name,
							size: attachment.size,
							mimeType: attachment.mediaType,
							downloadUrl: url,
						},
					];
				}),
			];
			const sandboxPaths =
				materializeSource.length > 0
					? await materializeDurableUrlsToSandbox(
							opSpaceId,
							sessionId,
							materializeSource,
						).catch((error) => {
							// Durable URL is enough without sandbox.
							console.warn("[composer] sandbox materialize skipped", error);
							return [] as string[];
						})
					: [];

			// Per-attachment delivery: each binary must have durable URL (image or file).
			// Sandbox is additive; durable is the always-on channel without space.
			const undelivered = [
				...fileAttachments.filter(
					(attachment) => !fileDurableUrls.has(attachment.id),
				),
				...imageAttachments.filter(
					(attachment) =>
						!imageUrls.has(attachment.id) &&
						!demotedImageFileUrls.has(attachment.id),
				),
			];
			if (undelivered.length > 0) {
				const names = undelivered
					.map((attachment) => attachment.name)
					.slice(0, 3)
					.join(", ");
				const more =
					undelivered.length > 3 ? ` +${undelivered.length - 3} more` : "";
				throw new Error(
					`Failed to upload ${undelivered.length} attachment${undelivered.length === 1 ? "" : "s"}: ${names}${more}`,
				);
			}
			uploadedImageUrls = imageUrls;
			uploadCompleted = true;
			const userText = input.trim();
			if (disposed || spaceId !== opSpaceId) {
				// Host left this space while upload was in flight — drop results.
				return;
			}
			const pendingViewportContexts = viewport.takeSendSnapshot();
			// Prefer sandbox paths when available; otherwise durable public URLs.
			const referenceText = sandboxPaths.length
				? buildFileReferencesText(sandboxPaths)
				: [
						buildFileReferencesText(durableFileUrls),
						buildImageReferencesText([...imageUrls.values()]),
					]
						.filter(Boolean)
						.join("\n\n");
			uploadedReferenceText = referenceText;
			text = [userText, referenceText].filter(Boolean).join("\n\n");
			const attachmentBlocks: ContentBlock[] = attachments.flatMap(
				(attachment) => {
					if (attachment.kind === "file") return [];
					if (attachment.kind === "text")
						return [buildComposerTextContentBlock(attachment)];
					// Image specialization only: durable URL → image content block.
					// Demoted images keep durable file URL in text refs, no image block.
					if (demotedImageIds.has(attachment.id)) return [];
					const url = imageUrls.get(attachment.id);
					if (!url) return [];
					return [
						{
							type: "image",
							source: {
								type: "url",
								url,
							},
							_meta: {
								filename: attachment.name,
								mediaType: attachment.mediaType,
								size: attachment.size,
							},
						} satisfies ContentBlock,
					];
				},
			);
			const viewportBlock = buildViewportContentBlock(pendingViewportContexts);
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
				...(viewportBlock ? [viewportBlock] : []),
				...attachmentBlocks,
			];

			// Clear input immediately so it disappears from the composer at the same
			// time the optimistic turn appears in the list — avoids the awkward "stuck"
			// feeling where the message shows in the list but lingers in the input.
			composer.clearDraft();
			clearActiveComposerDraft();

			// Existing chat: optimistic turn before prompt.
			// New chat: wait for prompt (server creates session); keep sending state.
			if (!isNewChat && sessionId && targetSessionState?.session) {
				const now = new Date().toISOString();
				const sequenceHint =
					(targetSessionState.turns.at(-1)?.sequence ?? 0) + 1;
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
				workspace.sessionStateById = {
					...sessionStateById,
					[sessionId]: {
						...targetSessionState,
						turns: mergeTurnsById(targetSessionState.turns, [optimisticTurn], {
							preferIncoming: true,
						}),
					},
				};
				// Sending a message is an explicit intent to jump back to the live edge.
				scroll.shouldAutoFollow = true;
				await tick();
				requestBottomFollow({ immediate: true });
				if (!hasActiveTurn)
					startGenerationRequest(sessionId, {
						spaceId: opSpaceId,
						turnId: optimisticTurnId,
					});
			}

			const sendResult = await sdk.space(opSpaceId).prompt({
				// Omit sessionId for new chat — server creates it.
				...(sessionId ? { sessionId } : {}),
				content,
				model: model?.id,
				provider: model?.provider,
				...(activeSessionThinkingLevel
					? { thinkingLevel: activeSessionThinkingLevel }
					: {}),
				clientMessageId,
				generationPolicy: buildTurnGenerationPolicy(),
				accessMode: "full_access",
				intent: "followup",
				schedule: { mode: "immediate" },
			});
			if (sendResult.mode !== "immediate") {
				throw new Error("Expected immediate prompt response");
			}
			// Prompt already accepted server-side. If we left the space, skip local
			// adopt; other hosts / re-enter will load via WS or session fetch.
			if (disposed || spaceId !== opSpaceId) {
				return;
			}
			const acceptedTurn = sendResult.turn;
			const acceptedSession = sendResult.session;
			if (!acceptedSession) throw new Error("Prompt response missing session");

			if (isNewChat) {
				targetSessionState = adoptPromptSession({
					session: acceptedSession,
					model,
				});
				sessionId = acceptedSession.id;
				startGenerationRequest(sessionId, {
					spaceId: opSpaceId,
					turnId: acceptedTurn.id,
				});
				scroll.shouldAutoFollow = true;
			} else if (sessionId) {
				applyAcceptedTurnId({
					sessionId,
					previousTurnId: optimisticTurnId,
					nextTurnId: acceptedTurn.id,
					confirmedTurn: acceptedTurn,
				});
				upsertSessionRecord(acceptedSession);
			}

			const current = sessionId ? sessionStateById[sessionId] : null;
			if (sessionId && current) {
				const acceptedTurnWithProfile = {
					...acceptedTurn,
					userUuid: acceptedTurn.userUuid ?? currentUser.uuid,
					authorProfile:
						acceptedTurn.authorProfile ?? currentUser.profile ?? null,
				};
				workspace.sessionStateById = {
					...sessionStateById,
					[sessionId]: {
						...current,
						session: acceptedSession,
						turns: normalizeTurnDuplicates(
							mergeTurnsById(current.turns, [acceptedTurnWithProfile], {
								preferIncoming: true,
							}),
						),
					},
				};
			}
			// The accepted turn now owns the explicit request state. Clear the local
			// override only after merging it to avoid briefly showing the older level.
			if (sessionId) {
				const nextThinkingLevels = { ...sessionThinkingLevelById };
				delete nextThinkingLevels[sessionId];
				sessionThinkingLevelById = nextThinkingLevels;
			}
			draftThinkingLevel = null;
			if (sessionId && options.getConnectionState() !== "open") {
				schedulePostSendRecoveryCheck(sessionId);
			}
			for (const attachment of pendingAttachments)
				revokeComposerAttachmentPreview(attachment);
			viewport.markSendSucceeded();
			if (isNewChat) {
				await tick();
				requestBottomFollow({ immediate: true });
			}
		} catch (error) {
			// Always persist failed draft against the originating space/session key so
			// a mid-send space switch cannot permanently lose the message.
			const failedDraftText =
				(hadFileUpload || hadImageUpload) && uploadCompleted
					? [pendingInput.trim(), uploadedReferenceText]
							.filter(Boolean)
							.join("\n\n")
					: pendingInput;
			const failedDraftScope =
				sessionId != null
					? { kind: "session" as const, sessionId }
					: { kind: "new" as const };
			const failedDraftKey = sessionComposerDraftKey(
				opSpaceId,
				failedDraftScope,
			);
			if (failedDraftText.trim()) {
				writeSessionComposerDraftText(failedDraftKey, failedDraftText);
			}
			// Restore UI only if we still own the originating space/session context.
			if (disposed || spaceId !== opSpaceId) {
				return;
			}
			// Restore input and attachments on failure so user doesn't lose their message
			viewport.restoreAfterFailedSend();
			if ((hadFileUpload || hadImageUpload) && uploadCompleted) {
				composer.restoreDraft(
					[pendingInput.trim(), uploadedReferenceText]
						.filter(Boolean)
						.join("\n\n"),
					pendingAttachments
						.filter((attachment) => attachment.kind !== "file")
						.map((attachment) =>
							attachment.kind === "image"
								? {
										...attachment,
										status: "ready" as const,
										uploadedUrl:
											uploadedImageUrls.get(attachment.id) ??
											attachment.uploadedUrl,
									}
								: attachment,
						),
				);
			} else {
				composer.restoreDraft(pendingInput, pendingAttachments);
			}
			preserveComposerInputOnNextDraftKeyChange = true;
			if ((hadFileUpload || hadImageUpload) && !uploadCompleted) {
				composer.markAttachmentUploadsFailed();
			}
			const rawSendError =
				error instanceof Error ? error.message : "Failed to send message";
			// Safari often surfaces Headers/URL/FormData failures as this opaque TypeError.
			const sendError =
				rawSendError === "The string did not match the expected pattern."
					? "Could not send request. Your session may be invalid — try refreshing or signing in again."
					: rawSendError;
			const sendErrorCode = getHttpErrorCode(error);
			const displayError =
				hadFileUpload || hadImageUpload
					? uploadCompleted
						? "Message failed. Attachments were uploaded."
						: "Upload failed. Please try again."
					: sendError;
			setComposerError(displayError, sendErrorCode);
			if (sessionId)
				failGeneration(sessionId, sendError, { errorCode: sendErrorCode });
			const current = sessionId ? sessionStateById[sessionId] : null;
			const failedSessionId = sessionId;
			if (current && optimisticTurn && failedSessionId) {
				const failedAt = new Date().toISOString();
				const failedTurn = {
					id: optimisticTurnId,
					sessionId: failedSessionId,
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
				workspace.sessionStateById = {
					...sessionStateById,
					[failedSessionId]: {
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
			composer.sending = false;
		}
	}

	function isRestoringSessionScroll(sessionId = activeSessionId) {
		if (!sessionId) return false;
		return (
			scroll.pendingRestoreSessionId === sessionId ||
			scroll.activeAnchorRestore?.sessionId === sessionId
		);
	}

	function scrollToBottomNow() {
		if (!listEl) return;
		setProgrammaticScrollTop(scroll.getTimelineBottomScrollTop());
		if (activeSessionId) {
			writeBottomScrollAnchor(activeSessionId);
		}
	}

	function requestBottomFollow(options?: { immediate?: boolean }) {
		// Never overwrite a mid-session restore with bottom follow / bottom anchor.
		if (isRestoringSessionScroll()) return;
		if (!scroll.shouldPinToBottom(options)) return;
		scrollToBottomNow();
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
		scroll.updateAutoFollow();
	}

	function updateCurrentTurnSequence() {
		if (!listEl) return;
		const nodes = Array.from(
			listEl.querySelectorAll<HTMLElement>('[data-turn-anchor="user"]'),
		);
		if (nodes.length === 0) {
			if (currentTurnSequence !== null) currentTurnSequence = null;
			return;
		}
		const containerRect = listEl.getBoundingClientRect();
		const probeY =
			containerRect.top + Math.min(160, containerRect.height * 0.35);
		let best: { sequence: number; distance: number } | null = null;
		for (const node of nodes) {
			const sequence = Number(node.dataset.turnSequence);
			if (!Number.isFinite(sequence)) continue;
			const rect = node.getBoundingClientRect();
			const distance =
				rect.top <= probeY ? probeY - rect.top : rect.top - probeY + 1000;
			if (!best || distance < best.distance) best = { sequence, distance };
		}
		const next = best?.sequence ?? null;
		if (currentTurnSequence !== next) currentTurnSequence = next;
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
			scroll.activeAnchorRestore = null;
			scroll.anchorRestoreWaitingForLayout = false;
		}
		if (pendingRestoreSessionId === activeSessionId) {
			scroll.pendingRestoreSessionId = null;
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
		if (!activeAnchorRestore || !anchorRestoreWaitingForLayout) return;
		if (pendingTimelineMarkdownRenders > 0) return;
		const restore = activeAnchorRestore;
		if (activeSessionId !== restore.sessionId) return;
		if (applyActiveAnchorRestore(restore) !== "complete") return;
		if (scroll.activeAnchorRestore?.sessionId !== restore.sessionId) return;
		scroll.activeAnchorRestore = null;
		scroll.anchorRestoreWaitingForLayout = false;
		scheduleTurnMarkerMeasure();
		updateAutoFollow();
	}

	function applyActiveAnchorRestore(restore = activeAnchorRestore) {
		if (!restore || !listEl || activeSessionId !== restore.sessionId)
			return "missing" as const;
		const node = listEl.querySelector<HTMLElement>(
			`[data-sequence="${restore.sequence}"]`,
		);
		if (!node) return "missing" as const;
		const target = resolveSessionScrollRestore({
			anchorTop: getMessageElementAbsoluteTop(node),
			anchorOffset: restore.offset,
			scrollHeight: listEl.scrollHeight,
			clientHeight: listEl.clientHeight,
		});
		setProgrammaticScrollTop(target.scrollTop);
		scroll.shouldAutoFollow = false;
		return target.reached ? ("complete" as const) : ("pending" as const);
	}

	function areSessionScrollAnchorsEqual(
		current: SessionScrollAnchor | null | undefined,
		next: SessionScrollAnchor | null | undefined,
	) {
		return Boolean(
			current &&
				next &&
				current.sequence === next.sequence &&
				current.offset === next.offset &&
				current.updatedAt === next.updatedAt,
		);
	}

	function restoreSessionScrollAnchorSoon(sessionId: string) {
		const anchor = getSessionScrollAnchor(sessionId);
		if (!anchor) return;
		const restore = { ...anchor, sessionId };
		scroll.activeAnchorRestore = restore;
		requestAnimationFrame(() => {
			if (activeSessionId !== sessionId) return;
			const result = applyActiveAnchorRestore(restore);
			const waitForLayout =
				pendingTimelineMarkdownRenders > 0 || result === "pending";
			scroll.anchorRestoreWaitingForLayout = waitForLayout;
			if (result !== "missing") scheduleTurnMarkerMeasure();
			if (!waitForLayout && activeAnchorRestore?.sessionId === sessionId) {
				scroll.activeAnchorRestore = null;
				scroll.anchorRestoreWaitingForLayout = false;
			}
			updateAutoFollow();
		});
	}

	function handleTimelineMarkdownRenderStart() {
		scroll.pendingTimelineMarkdownRenders += 1;
	}

	function handleTimelineMarkdownRendered() {
		if (pendingTimelineMarkdownRenders > 0)
			scroll.pendingTimelineMarkdownRenders -= 1;
		scheduleTurnMarkerMeasure();
		const restore = activeAnchorRestore;
		if (restore?.sessionId === activeSessionId) {
			// Keep the leave position pinned while content height settles.
			requestAnimationFrame(() => {
				if (activeSessionId !== restore.sessionId) return;
				applyActiveAnchorRestore(restore);
				maybeCompleteAnchorRestore();
			});
			return;
		}
		if (
			activeSessionId &&
			!isRestoringSessionScroll(activeSessionId) &&
			(restoringBottomSessionId === activeSessionId || shouldAutoFollow)
		) {
			requestBottomFollow();
		}
		maybeCompleteAnchorRestore();
	}

	async function handlePickAttachments(
		files: FileList | File[] | LocalUploadEntry[] | null,
	) {
		await composer.handlePickAttachments(files);
	}

	async function applyBackgroundComposerPayload(
		payload: NewChatComposerApplyPayload,
	) {
		if (typeof payload.prompt === "string") {
			composer.input = payload.prompt;
		}
		if (payload.model && modelsCatalog) {
			const catalogItem = modelsCatalog.find(
				(item) =>
					item.provider === payload.model?.provider &&
					item.id === payload.model?.id,
			);
			if (catalogItem) {
				const selected = {
					provider: catalogItem.provider,
					id: catalogItem.id,
					name: catalogItem.model.name as string | undefined,
				} satisfies SelectedModel;
				draftSessionModel = selected;
				if (activeSessionId) {
					sessionModelById = {
						...sessionModelById,
						[activeSessionId]: selected,
					};
				}
			}
		}
		const imageEntries = (payload.images ?? []).filter(
			(image): image is { url: string; name?: string } =>
				typeof image.url === "string" && image.url.startsWith("https://"),
		);
		if (imageEntries.length > 0) {
			try {
				const files = await Promise.all(
					imageEntries.map(async (image) => {
						const response = await fetch(image.url);
						if (!response.ok) {
							throw new Error(`Failed to load image: ${image.url}`);
						}
						const blob = await response.blob();
						if (!blob.type.startsWith("image/")) {
							throw new Error(`Unsupported image type: ${image.url}`);
						}
						return new File([blob], image.name ?? "image", { type: blob.type });
					}),
				);
				await handlePickAttachments(files);
			} catch (error) {
				console.warn(
					"[NewChat] failed to apply background payload images",
					error,
				);
			}
		}
	}

	function handleRemoveAttachment(id: string) {
		composer.handleRemoveAttachment(id);
	}

	function focusComposerSoon() {
		requestAnimationFrame(() => {
			window.dispatchEvent(new CustomEvent("cohub:composer-focus"));
		});
	}

	async function ingestRealtimeEnvelope(payload: ChannelEnvelope) {
		if (disposed) return;
		try {
			// Shell owns FS / ports / labels; chat only consumes session/task events.
			if (
				payload.type === "space.fs.changed" ||
				payload.type === "space.ports.changed" ||
				payload.type === "label.assignments.updated"
			) {
				return;
			}
			if (payload.type === "task.created" || payload.type === "task.updated") {
				handleTaskRealtimeEvent(payload);
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
					code?: string;
					message?: string;
					clientMessageId?: string | null;
					billing?: { conversion?: unknown } | null;
				};
				const message =
					requestError.message?.trim() || "Message request failed";
				const code =
					typeof requestError.code === "string" ? requestError.code : null;
				const conversion =
					extractBillingPayload(requestError)?.conversion ?? null;
				if (conversion) {
					billingConversion.openFromIntent(conversion);
				} else if (isBillingAccessBlockedCode(code)) {
					billingConversion.openFallbackHard();
				}
				failGeneration(targetSessionId, message, { errorCode: code });
				if (isActiveSession) setComposerError(message, code);
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
						typeof (payload.payload.turn as { id?: unknown } | undefined)
							?.id === "string"
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
					workspace.sessionStateById = {
						...sessionStateById,
						[targetSessionId]: {
							...current,
							turns: normalizeTurnDuplicates(reconciled.turns),
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
					const patchedTurn = {
						...existingTurn,
						...normalizedTurnPatch,
					} as SessionTurnRecord;
					workspace.sessionStateById = {
						...sessionStateById,
						[targetSessionId]: {
							...state,
							turns: normalizeTurnDuplicates(
								mergeTurnsById(state.turns, [patchedTurn], {
									preferIncoming: true,
								}),
							),
						},
					};
					clearIntermediateHandoffIfPersisted(targetSessionId, turnId);
				}
				if (!existingTurn || payload.type === "session.turn.finalized") {
					void hydrateTurnOnce({
						sessionId: targetSessionId,
						turnId,
						reason: "turn.event",
						onHydrated:
							payload.type === "session.turn.finalized"
								? () => {
										completeGenerationForTurn(targetSessionId, turnId);
										clearIntermediateHandoffIfPersisted(
											targetSessionId,
											turnId,
										);
									}
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
	const sessionTaskHasMore = $derived.by(() =>
		SESSION_TASK_TYPES.some(
			(taskType) => sessionTaskRecentHasMoreByType[taskType],
		),
	);

	function handleRemoveViewportContext(id: string) {
		viewport.dismiss(id);
	}

	function handleCreateNewSession() {
		if (!access.canCreateSession) return;
		createSessionError = "";
		void options.router
			.toNewSession()
			.then(() => {
				// Defense in depth: route sync also clears these when entering /new.
				resolvedNewSessionId = null;
				workspace.activeSessionId = null;
				scroll.pendingRestoreSessionId = null;
				scroll.activeAnchorRestore = null;
				scroll.anchorRestoreWaitingForLayout = false;
				currentTurnSequence = null;
				showTurnBottomSheet = false;
				scroll.shouldAutoFollow = true;
				focusComposerSoon();
			})
			.catch((error) => {
				createSessionError =
					error instanceof Error ? error.message : "Failed to open new chat";
			});
	}

	function enterSpace(nextSpaceId: string) {
		if (disposed) return;
		// Soft clear: no space selected (e.g. Sessions empty state).
		if (!nextSpaceId) {
			if (activeSessionId) captureCurrentScrollAnchor(activeSessionId);
			if (spaceId) flushActiveComposerDraft();
			spaceId = "";
			resolvedNewSessionId = null;
			createSessionError = "";
			forkingTurnId = null;
			workspace.reset();
			turnLoading.reset();
			turnHydrationInFlight.clear();
			clearAllPostSendRecovery();
			generationPolicy.apply(null);
			generationRealtime.resetForSpaceChange();
			currentTurnSequence = null;
			highlightedTurnSequence = null;
			scroll.clearTurnMarkers();
			lastTurnIndexRefreshKey = "";
			showTurnBottomSheet = false;
			appliedRouteTurnKey = null;
			share.reset();
			tasks.reset();
			sessionModelById = {};
			draftSessionModel = null;
			draftSessionModelManuallySelected = false;
			route = { kind: "none" };
			composer.sending = false;
			composer.aborting = false;
			releaseGenerationLease();
			return;
		}
		if (spaceId === nextSpaceId) return;
		const previous = spaceId;
		if (previous && activeSessionId)
			captureCurrentScrollAnchor(activeSessionId);
		if (previous) flushActiveComposerDraft();
		// Multi-host safe: host-local lease tracking; only last leaver resets store.
		acquireGenerationLease(nextSpaceId);
		spaceId = nextSpaceId;
		resolvedNewSessionId = null;
		createSessionError = "";
		forkingTurnId = null;
		composer.sending = false;
		composer.aborting = false;
		workspace.reset();
		turnLoading.reset();
		turnHydrationInFlight.clear();
		clearAllPostSendRecovery();
		generationPolicy.apply(null);
		generationRealtime.resetForSpaceChange();
		currentTurnSequence = null;
		highlightedTurnSequence = null;
		scroll.clearTurnMarkers();
		lastTurnIndexRefreshKey = "";
		showTurnBottomSheet = false;
		appliedRouteTurnKey = null;
		share.reset();
		tasks.reset();
		sessionModelById = {};
		draftSessionModel = null;
		draftSessionModelManuallySelected = false;
		promptTemplatesCtrl.restore(nextSpaceId);
		skillsCtrl.restore(nextSpaceId);
		void loadPromptTemplates();
		loadSessionScrollAnchors();
		route = { kind: "none" };
	}

	function isSameAccess(current: SessionChatAccess, next: SessionChatAccess) {
		return (
			current.spaceLoadError === next.spaceLoadError &&
			current.spaceHasMinimalAccess === next.spaceHasMinimalAccess &&
			current.canCreateSession === next.canCreateSession &&
			current.bootstrapping === next.bootstrapping
		);
	}

	function isSameRoute(current: SessionChatRoute, next: SessionChatRoute) {
		if (current.kind !== next.kind) return false;
		if (current.kind === "session" && next.kind === "session") {
			return (
				current.sessionId === next.sessionId &&
				current.turnSequence === next.turnSequence
			);
		}
		return true;
	}

	function syncContext(input: SessionChatContext) {
		if (disposed) return;
		if (input.spaceId !== spaceId) enterSpace(input.spaceId);
		if (!isSameAccess(access, input.access)) {
			access = { ...input.access };
		}
		const prev = route;
		if (!isSameRoute(route, input.route)) {
			route = input.route;
		}

		if (route.kind === "session") {
			if (
				shouldClearResolvedNewSessionOnRoute({
					nextKind: "session",
					prevKind: prev.kind,
				})
			) {
				resolvedNewSessionId = null;
			}
			if (activeSessionId !== route.sessionId) {
				if (activeSessionId) captureCurrentScrollAnchor(activeSessionId);
				prepareRouteSession(route.sessionId);
				const state = sessionStateById[route.sessionId];
				unreadTracker.markViewed(
					route.sessionId,
					state?.session?.lastMessageId ?? null,
				);
				void loadSessionState(route.sessionId);
				void loadTurnIndex(route.sessionId);
			} else {
				const state = sessionStateById[route.sessionId];
				if (state && !state.loaded && !state.loading) {
					void loadSessionState(route.sessionId);
				}
			}
			if (route.turnSequence) {
				const key = `${route.sessionId}:${route.turnSequence}`;
				if (appliedRouteTurnKey !== key) {
					appliedRouteTurnKey = key;
					void jumpToTurn(route.turnSequence);
				}
			}
			return;
		}

		if (route.kind === "new") {
			// Fresh draft entry (from another route): always clear the previous
			// session so a still-streaming chat cannot paint into the empty draft.
			// Keep resolvedNewSessionId only while we stay on /new after adopt
			// (prompt created a session, URL has not switched to /:id yet).
			if (
				shouldClearResolvedNewSessionOnRoute({
					nextKind: "new",
					prevKind: prev.kind,
				})
			) {
				resolvedNewSessionId = null;
			}
			const draftActiveSessionId = activeSessionId;
			if (
				shouldClearActiveSessionForNewDraft({
					resolvedNewSessionId,
					activeSessionId: draftActiveSessionId,
				}) &&
				draftActiveSessionId
			) {
				captureCurrentScrollAnchor(draftActiveSessionId);
				workspace.activeSessionId = null;
				scroll.pendingRestoreSessionId = null;
				scroll.activeAnchorRestore = null;
				scroll.anchorRestoreWaitingForLayout = false;
				userScrollActive = false;
				programmaticScrollActive = false;
				programmaticScrollTarget = null;
				currentTurnSequence = null;
				showTurnBottomSheet = false;
			}
			appliedRouteTurnKey = null;
			return;
		}

		if (
			shouldClearResolvedNewSessionOnRoute({
				nextKind: "none",
				prevKind: prev.kind,
			})
		) {
			resolvedNewSessionId = null;
		}
		if (activeSessionId) {
			captureCurrentScrollAnchor(activeSessionId);
			workspace.activeSessionId = null;
			scroll.pendingRestoreSessionId = null;
			scroll.activeAnchorRestore = null;
			scroll.anchorRestoreWaitingForLayout = false;
			userScrollActive = false;
			programmaticScrollActive = false;
			programmaticScrollTarget = null;
			currentTurnSequence = null;
			showTurnBottomSheet = false;
		}
		appliedRouteTurnKey = null;
	}

	function onTransportOpen() {
		generationRealtime.onTransportOpen();
	}
	function onConnectionRecovered() {
		void reconnectSync();
	}
	function onVisibilityChanged(visible: boolean) {
		if (!visible) {
			if (activeSessionId) captureCurrentScrollAnchor(activeSessionId);
			return;
		}
		void refreshSessionsList(false);
		if (activeSessionId && sessionStateById[activeSessionId]?.loaded) {
			void reconcileSessionTail(activeSessionId);
		}
	}

	function reportActiveSource(source: ActiveViewportSource) {
		viewport.setActiveSource(source);
	}
	function reportFileVisibleLines(
		path: string,
		range: { start: number; end: number } | null,
	) {
		if (!path) return;
		viewport.setFileVisibleLines(path, range);
	}
	function reportBoardView(state: BoardViewportObservation) {
		viewport.setBoardViewState(state.path, {
			visibleRect: state.visibleRect,
			selectedNodes: state.selectedNodes,
		});
	}

	async function renameActiveSession(title: string) {
		if (!activeSessionId) return null;
		const trimmed = title.trim();
		if (!trimmed) return null;
		const result = await sdk
			.space(spaceId)
			.session(activeSessionId)
			.rename(trimmed);
		workspace.spaceSessions = spaceSessions.map((s) =>
			s.id === activeSessionId ? result.session : s,
		);
		void patchCachedSessionList(spaceId, (current) =>
			current.map((s) => (s.id === activeSessionId ? result.session : s)),
		).catch(() => undefined);
		if (sessionStateById[activeSessionId]) {
			workspace.sessionStateById = {
				...sessionStateById,
				[activeSessionId]: {
					...sessionStateById[activeSessionId],
					session: result.session,
				},
			};
		}
		return result.session;
	}

	function dispose() {
		if (disposed) return;
		disposed = true;
		if (activeSessionId) captureCurrentScrollAnchor(activeSessionId);
		flushActiveComposerDraft();
		generationRealtime.dispose();
		share.dispose();
		composer.dispose();
		viewport.dispose();
		scroll.stopVimScroll();
		scroll.clearPendingVimG();
		if (turnMarkerMeasureFrame != null) {
			cancelAnimationFrame(turnMarkerMeasureFrame);
			turnMarkerMeasureFrame = null;
		}
		for (const timer of taskHydrateRetryTimers.values()) clearTimeout(timer);
		taskHydrateRetryTimers.clear();
		clearAllPostSendRecovery();
		composer.sending = false;
		composer.aborting = false;
		// Release generation lease only if this host still holds it.
		releaseGenerationLease();
	}

	function onLoadToolCalls(input: {
		turn: SessionTurnRecord;
		message: StoredIntermediateMessage;
	}) {
		return loadMessageToolCalls({
			spaceId,
			sessionId: input.turn.sessionId,
			turnId: input.turn.sourceTurnId ?? input.turn.id,
			message: input.message,
		});
	}
	function onLoadIntermediate(turn: SessionTurnRecord) {
		return loadTurnIntermediate({
			spaceId,
			sessionId: turn.sessionId,
			turnId: turn.sourceTurnId ?? turn.id,
			messagesObjectKey: turn.intermediateIndex?.messagesObjectKey ?? null,
		});
	}
	function onRequestIntermediateSync(turn: SessionTurnRecord) {
		return requestIntermediateSyncForTurn(turn.sessionId, turn.id);
	}

	return {
		get spaceId() {
			return spaceId;
		},
		get access() {
			return access;
		},
		get isNewSessionRoute() {
			return isNewSessionRoute;
		},
		get activeSessionId() {
			return activeSessionId;
		},
		get activeSession() {
			return activeSessionState?.session;
		},
		get activeSessionState() {
			return activeSessionState;
		},
		get activeSessionInitialLoadingVisible() {
			return activeSessionInitialLoadingVisible;
		},
		get createSessionError() {
			return createSessionError;
		},
		set createSessionError(v: string) {
			createSessionError = v;
		},
		get timeline() {
			return timeline;
		},
		get activeSessionIsRunning() {
			return activeSessionIsRunning;
		},
		get forkingTurnId() {
			return forkingTurnId;
		},
		get modelsCatalog() {
			return modelsCatalog;
		},
		get activeSessionModel() {
			return activeSessionModel;
		},
		/** Model recorded on the session from server turns (no draft/override). */
		get activeSessionTurnModel() {
			return activeSessionLastTurnModel;
		},
		get activeSessionThinkingLevel() {
			return activeSessionThinkingLevel;
		},
		get activeSessionThinkingLevelLabel() {
			if (!activeSessionThinkingLevel) return null;
			return formatThinkingLevelShort(activeSessionThinkingLevel);
		},
		get generationPolicyLabel() {
			return generationPolicyLabel;
		},
		get generationModelsCatalog() {
			return generationModelsCatalog;
		},
		get generationPolicyMode() {
			return generationPolicyMode;
		},
		get selectedGenerationModels() {
			return selectedGenerationModels;
		},
		get generationEnumSelections() {
			return generationEnumSelections;
		},
		get generationNumericConstraints() {
			return generationNumericConstraints;
		},
		get generationBooleanConstraints() {
			return generationBooleanConstraints;
		},
		get promptTemplates() {
			return promptTemplates;
		},
		get promptTemplatesLoaded() {
			return promptTemplatesLoaded;
		},
		get skills() {
			return skills;
		},
		get skillsLoaded() {
			return skillsLoaded;
		},
		get input() {
			return composer.input;
		},
		set input(v: string) {
			composer.input = v;
		},
		get attachments() {
			return attachments;
		},
		get sending() {
			return sending;
		},
		get aborting() {
			return aborting;
		},
		get composerNotice() {
			return composerNotice;
		},
		get composerShowsBillingAction() {
			return composerShowsBillingAction;
		},
		get showModelSelector() {
			return showModelSelector;
		},
		set showModelSelector(v: boolean) {
			showModelSelector = v;
		},
		get composerHostEl() {
			return composerHostEl;
		},
		set composerHostEl(v: HTMLDivElement | null) {
			composerHostEl = v;
		},
		get chatChromeEl() {
			return chatChromeEl;
		},
		set chatChromeEl(v: HTMLDivElement | null) {
			chatChromeEl = v;
		},
		get viewportContexts() {
			return viewportContexts;
		},
		get listEl() {
			return scroll.listEl;
		},
		set listEl(v: HTMLDivElement | null) {
			scroll.listEl = v;
		},
		get chatTimelineRef() {
			return scroll.chatTimelineRef;
		},
		set chatTimelineRef(v: unknown) {
			scroll.chatTimelineRef = v as typeof scroll.chatTimelineRef;
		},
		get shouldAutoFollow() {
			return scroll.shouldAutoFollow;
		},
		set shouldAutoFollow(v: boolean) {
			scroll.shouldAutoFollow = v;
		},
		get hasUnread() {
			return hasUnread;
		},
		get composerHeight() {
			return composerHeight;
		},
		set composerHeight(v: number) {
			scroll.composerHeight = v;
		},
		get chatChromeHeight() {
			return chatChromeHeight;
		},
		set chatChromeHeight(v: number) {
			scroll.chatChromeHeight = v;
		},
		get turnMarkerPositions() {
			return turnMarkerPositions;
		},
		get turnMarkerHeights() {
			return turnMarkerHeights;
		},
		get timelineScrollTop() {
			return timelineScrollTop;
		},
		get timelineScrollHeight() {
			return timelineScrollHeight;
		},
		get timelineClientHeight() {
			return timelineClientHeight;
		},
		get activeTurnRailItems() {
			return activeTurnRailItems;
		},
		get unloadedOlderTurnCount() {
			return unloadedOlderTurnCount;
		},
		get unloadedNewerTurnCount() {
			return unloadedNewerTurnCount;
		},
		get currentTurnSequence() {
			return currentTurnSequence;
		},
		get loadingTurnSequence() {
			return loadingTurnSequence;
		},
		get highlightedTurnSequence() {
			return highlightedTurnSequence;
		},
		get showTurnBottomSheet() {
			return showTurnBottomSheet;
		},
		set showTurnBottomSheet(v: boolean) {
			showTurnBottomSheet = v;
		},
		get sessionTaskNotices() {
			return sessionTaskNotices;
		},
		get sessionTaskHasMore() {
			return sessionTaskHasMore;
		},
		get sessionTaskRecentLoading() {
			return sessionTaskRecentLoading;
		},
		get followupQueue() {
			return followupQueue;
		},
		get pendingFollowupActionIds() {
			return pendingFollowupActionIds;
		},
		// Shell still needs share dialog + vim scroll controllers.
		share,
		scroll,
		enterSpace,
		syncContext,
		ingestRealtimeEnvelope,
		onTransportOpen,
		onConnectionRecovered,
		onVisibilityChanged,
		reportActiveSource,
		reportFileVisibleLines,
		reportBoardView,
		flushComposerDraft: flushActiveComposerDraft,
		refreshSessions: refreshSessionsList,
		renameActiveSession,
		dispose,
		handleSend,
		handleAbort,
		handleForkTurn,
		handleSteerFollowup,
		handleCancelFollowup,
		handlePickAttachments,
		handleRemoveAttachment,
		handleRemoveViewportContext,
		handleFirstVisible,
		handleTimelineMarkdownRenderStart,
		handleTimelineMarkdownRendered,
		jumpToTurn,
		beginUserScroll,
		scrollToBottomNow,
		updateCurrentTurnSequence,
		loadSessionScrollAnchors,
		persistSessionScrollAnchorsNow,
		jumpToTurnAndUpdateUrl,
		setProgrammaticScrollTop,
		snapScrollToNearestTurn,
		forceScrollToBottom,
		loadOlderTurns,
		syncSessionNewer,
		loadTurnIndex,
		loadSessionState,
		prepareRouteSession,
		seedSessions,
		applySessionsSnapshot,
		upsertSessionRecord,
		handleSessionTaskTrayExpand,
		handleSessionTaskTrayLoadMore,
		handleOpenGenerationTaskMedia,
		handleCreateNewSession,
		loadModelsCatalog,
		loadGenerationModelsCatalog,
		loadPromptTemplates,
		handleModelSelect,
		setGenerationPolicyMode,
		setGenerationModelSelected,
		setGenerationEnumValueSelected,
		setGenerationNumericConstraint,
		setGenerationBooleanConstraint,
		turnPreviewText,
		onLoadToolCalls,
		onLoadIntermediate,
		onRequestIntermediateSync,
		applyBackgroundComposerPayload,
		openShareModal: (sessionId: string) => share.openFor(sessionId),
		openPath: (target: string | WorkspaceFileLinkTarget) =>
			options.openPath(target),
		captureCurrentScrollAnchor,
	};
}

export type SessionChatHost = ReturnType<typeof createSessionChatHost>;
