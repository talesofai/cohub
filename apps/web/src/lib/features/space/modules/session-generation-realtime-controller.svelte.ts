import type { GenerationStreamEvent } from "@neta-art/cohub";
import { tick } from "svelte";
import { sessionTurnsRepo } from "$lib/cache/repositories/session-turns-repo";
import { sdk } from "$lib/sdk";
import { sessionGenerationStore } from "$lib/stores/session-generation.svelte";
import { completeGeneration } from "$lib/stores/session-generation-controller";
import {
	applyGenerationStreamEvent,
	applyGenerationStreamSnapshot,
} from "$lib/stores/session-generation-realtime";
import { SessionRecoveryCoordinator } from "$lib/stores/session-recovery-coordinator";
import { areSessionTurnsEqual, preserveSessionTurnRefs } from "./session-utils";
import type { SessionViewState } from "./session-workspace-controller.svelte";

type SessionScrollAnchor = {
	sequence: number;
	offset: number;
	updatedAt: number;
};

type ConnectionState =
	| "idle"
	| "connecting"
	| "reconnecting"
	| "open"
	| "closed"
	| "error";

const FINALIZED_COMMIT_FALLBACK_MS = 250;
const FINALIZED_COMMIT_FALLBACK_MAX_ATTEMPTS = 6;
const POST_SEND_RECOVERY_GRACE_MS = 2500;
const STREAM_SNAPSHOT_RECOVERY_COOLDOWN_MS = 15000;
const TERMINAL_TURN_STATUSES = new Set([
	"completed",
	"failed",
	"interrupted",
	"merged",
	"cancelled",
]);

export function createSessionGenerationRealtimeController(options: {
	getSpaceId: () => string;
	getConnectionState: () => ConnectionState;
	getActiveSessionId: () => string | null;
	getSessionState: (id: string) => SessionViewState | undefined;
	updateSessionState: (id: string, state: SessionViewState) => void;
	refreshSessionsList: (force?: boolean) => Promise<void>;
	requestBottomFollow: (options?: { immediate?: boolean }) => void;
	shouldAutoFollow: () => boolean;
	getListEl: () => HTMLElement | null | undefined;
	captureCurrentScrollAnchor: (sessionId: string) => void;
	getSessionScrollAnchor: (
		sessionId: string,
	) => SessionScrollAnchor | null | undefined;
	areSessionScrollAnchorsEqual: (
		current: SessionScrollAnchor | null | undefined,
		snapshot: SessionScrollAnchor | null | undefined,
	) => boolean;
	restoreSessionScrollAnchorSoon: (sessionId: string) => void;
	isUserScrollActive: () => boolean;
	syncGenerationStateFromTail: (
		sessionId: string,
		turns: SessionViewState["turns"],
		requestStartedAt: number,
	) => Promise<void>;
	onRecovered: () => void;
	onExhausted: (sessionId: string) => void;
}) {
	let activeGenerationSubscriptionKey = "";
	let activeGenerationSubscriptionCleanup: (() => void) | null = null;
	const finalizedFallbackTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	const finalCommitSeenAtByKey = new Map<string, number>();
	const streamSnapshotRecoveryInFlight = new Map<string, Promise<boolean>>();
	const reconcileSessionTailInFlight = new Map<string, Promise<void>>();
	const postSendRecoveryTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	const lastStreamSnapshotRecoveryByTurn = new Map<string, number>();

	async function restoreSessionStreamSnapshot(
		sessionId: string,
		input?: { turnId?: string | null; force?: boolean },
	) {
		const turnId = input?.turnId ?? null;
		const cooldownKey = turnId ? `${sessionId}:${turnId}` : sessionId;
		const now = Date.now();
		const lastRecoveryAt =
			lastStreamSnapshotRecoveryByTurn.get(cooldownKey) ?? 0;
		if (
			!input?.force &&
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
					.space(options.getSpaceId())
					.session(sessionId)
					.turns.streamSnapshot();
				if (!snapshot) return false;
				if (turnId && snapshot.turnId && snapshot.turnId !== turnId) {
					return false;
				}
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
		const state = options.getSessionState(sessionId);
		if (!state?.session) return;
		const inFlight = reconcileSessionTailInFlight.get(sessionId);
		if (inFlight) return inFlight;
		const shouldRestoreAnchor =
			options.getActiveSessionId() === sessionId &&
			Boolean(options.getListEl()) &&
			!options.shouldAutoFollow();
		if (shouldRestoreAnchor) options.captureCurrentScrollAnchor(sessionId);
		const restoreAnchorSnapshot = shouldRestoreAnchor
			? options.getSessionScrollAnchor(sessionId)
			: null;
		const run = (async () => {
			try {
				const requestStartedAt = Date.now();
				const response = await sdk
					.space(options.getSpaceId())
					.session(sessionId)
					.turns.listPaginated({
						limit: 30,
					});
				await options.syncGenerationStateFromTail(
					sessionId,
					response.turns,
					requestStartedAt,
				);
				const snapshot = await sessionTurnsRepo.replaceTail(
					options.getSpaceId(),
					sessionId,
					{
						session: response.session,
						turns: response.turns,
						hasMore: response.hasMore,
					},
				);
				const currentState = options.getSessionState(sessionId);
				if (!currentState) return;
				const nextSession = snapshot.session ?? currentState.session;
				const nextTurns = preserveSessionTurnRefs(
					currentState.turns,
					snapshot.turns,
				);
				const nextOldestCursor = snapshot.oldestSequence ?? undefined;
				if (
					currentState.session === nextSession &&
					areSessionTurnsEqual(currentState.turns, nextTurns) &&
					currentState.hasMore === snapshot.hasMoreOlder &&
					currentState.hasMoreNewer === snapshot.hasMoreNewer &&
					currentState.loading === false &&
					currentState.loaded === true &&
					currentState.error === "" &&
					currentState.loadingOlder === false &&
					currentState.loadingNewer === false &&
					currentState.oldestCursor === nextOldestCursor
				) {
					return;
				}
				options.updateSessionState(sessionId, {
					...currentState,
					session: nextSession,
					turns: nextTurns,
					hasMore: snapshot.hasMoreOlder,
					hasMoreNewer: snapshot.hasMoreNewer,
					loading: false,
					loaded: true,
					error: "",
					loadingOlder: false,
					loadingNewer: false,
					oldestCursor: nextOldestCursor,
				});
				if (options.getActiveSessionId() === sessionId) {
					await tick();
					const currentAnchor = options.getSessionScrollAnchor(sessionId);
					const canRestoreAnchor =
						shouldRestoreAnchor &&
						options.areSessionScrollAnchorsEqual(
							currentAnchor,
							restoreAnchorSnapshot,
						) &&
						!options.isUserScrollActive();
					if (canRestoreAnchor) {
						options.restoreSessionScrollAnchorSoon(sessionId);
					} else if (!shouldRestoreAnchor && options.shouldAutoFollow()) {
						options.requestBottomFollow({ immediate: true });
					}
				}
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

	const recoveryCoordinator = new SessionRecoveryCoordinator({
		isTransportOpen: () => options.getConnectionState() === "open",
		reconcileSessionTail: (sessionId) => reconcileSessionTail(sessionId),
		refreshSessionsList: () => options.refreshSessionsList(true),
		onRecovered: () => {
			options.onRecovered();
			clearPostSendRecovery(options.getActiveSessionId());
		},
		onExhausted: options.onExhausted,
	});

	function schedulePostSendRecoveryCheck(sessionId: string) {
		clearPostSendRecovery(sessionId);
		if (options.getConnectionState() === "open") return;
		const timer = setTimeout(() => {
			postSendRecoveryTimers.delete(sessionId);
			if (
				options.getConnectionState() === "open" ||
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

	function getFinalizedFallbackKey(sessionId: string, turnId: string | null) {
		return `${sessionId}:${turnId ?? "unknown"}`;
	}

	function clearFinalizedFallback(sessionId: string, turnId: string | null) {
		const key = getFinalizedFallbackKey(sessionId, turnId);
		const timer = finalizedFallbackTimers.get(key);
		if (!timer) return;
		clearTimeout(timer);
		finalizedFallbackTimers.delete(key);
	}

	function clearAllFinalizedFallbacks() {
		for (const timer of finalizedFallbackTimers.values()) clearTimeout(timer);
		finalizedFallbackTimers.clear();
		finalCommitSeenAtByKey.clear();
	}

	function rememberFinalCommit(sessionId: string, turnId: string | null) {
		const now = Date.now();
		finalCommitSeenAtByKey.set(getFinalizedFallbackKey(sessionId, null), now);
		if (turnId) {
			finalCommitSeenAtByKey.set(
				getFinalizedFallbackKey(sessionId, turnId),
				now,
			);
		}
	}

	function hasRecentFinalCommit(sessionId: string, turnId: string | null) {
		const keys = [
			getFinalizedFallbackKey(sessionId, turnId),
			getFinalizedFallbackKey(sessionId, null),
		];
		return keys.some((key) => {
			const seenAt = finalCommitSeenAtByKey.get(key) ?? 0;
			const isRecent = Date.now() - seenAt < FINALIZED_COMMIT_FALLBACK_MS * 4;
			if (!isRecent) finalCommitSeenAtByKey.delete(key);
			return isRecent;
		});
	}

	function getMessageTurnId(message: {
		meta?: Record<string, unknown> | null;
	}) {
		const turnId = message.meta?.turnId;
		return typeof turnId === "string" && turnId.trim() ? turnId.trim() : null;
	}

	function getRawEventTurnId(event: GenerationStreamEvent) {
		const turn = event.rawEvent?.payload?.turn;
		if (turn && typeof turn === "object" && !Array.isArray(turn)) {
			const turnId = (turn as { id?: unknown }).id;
			if (typeof turnId === "string" && turnId.trim()) return turnId.trim();
		}
		const message = event.rawEvent?.payload?.message;
		if (message && typeof message === "object" && !Array.isArray(message)) {
			const meta = (message as { meta?: unknown }).meta;
			if (meta && typeof meta === "object" && !Array.isArray(meta)) {
				const turnId = (meta as { turnId?: unknown }).turnId;
				if (typeof turnId === "string" && turnId.trim()) return turnId.trim();
			}
		}
		return null;
	}

	function getEventTurnId(sessionId: string, event: GenerationStreamEvent) {
		if (event.type === "state" || event.type === "out_of_sync") {
			return event.state.turnId ?? null;
		}
		if (event.type === "finalized") return event.turn.id ?? null;
		if (event.type === "turn_updated") {
			return typeof event.turn.id === "string" ? event.turn.id : null;
		}
		if (event.type === "lifecycle") return event.turnId ?? null;
		return (
			(event.type === "commit"
				? getMessageTurnId(event.commit.message)
				: null) ??
			getRawEventTurnId(event) ??
			sessionGenerationStore.get(sessionId)?.turnId ??
			null
		);
	}

	function hasConfirmedFinalTurn(sessionId: string, turnId: string | null) {
		if (!turnId) return false;
		const turn = options
			.getSessionState(sessionId)
			?.turns.find((item) => item.id === turnId);
		return Boolean(turn && TERMINAL_TURN_STATUSES.has(turn.status));
	}

	function scheduleFinalizedFallback(
		sessionId: string,
		turnId: string | null,
		attempt = 0,
	) {
		if (hasRecentFinalCommit(sessionId, turnId)) return;
		const key = getFinalizedFallbackKey(sessionId, turnId);
		clearFinalizedFallback(sessionId, turnId);
		const timer = setTimeout(() => {
			finalizedFallbackTimers.delete(key);
			void finalizeAfterMissingCommit(sessionId, turnId, attempt);
		}, FINALIZED_COMMIT_FALLBACK_MS);
		finalizedFallbackTimers.set(key, timer);
	}

	async function finalizeAfterMissingCommit(
		sessionId: string,
		turnId: string | null,
		attempt: number,
	) {
		const current = sessionGenerationStore.get(sessionId);
		if (!sessionGenerationStore.isGenerating(sessionId)) return;
		if (turnId && current?.turnId && current.turnId !== turnId) return;
		await restoreSessionStreamSnapshot(sessionId, { turnId, force: true });
		await reconcileSessionTail(sessionId);
		const latest = sessionGenerationStore.get(sessionId);
		if (!sessionGenerationStore.isGenerating(sessionId)) return;
		if (turnId && latest?.turnId && latest.turnId !== turnId) return;
		if (!hasConfirmedFinalTurn(sessionId, turnId)) {
			if (attempt + 1 < FINALIZED_COMMIT_FALLBACK_MAX_ATTEMPTS) {
				scheduleFinalizedFallback(sessionId, turnId, attempt + 1);
			}
			return;
		}
		completeGeneration(sessionId);
		if (
			sessionId === options.getActiveSessionId() &&
			options.shouldAutoFollow()
		) {
			await tick();
			options.requestBottomFollow();
		}
	}

	async function handleGenerationStreamEvent(
		sessionId: string,
		event: GenerationStreamEvent,
	) {
		try {
			const turnId = getEventTurnId(sessionId, event);
			if (
				event.type === "commit" &&
				(event.commit.kind === "final" || event.commit.kind === "error")
			) {
				rememberFinalCommit(sessionId, turnId);
				clearFinalizedFallback(sessionId, turnId);
			}
			const generationEffect = applyGenerationStreamEvent(sessionId, event);
			if (!generationEffect.handled) return;
			clearPostSendRecovery(sessionId);
			if (event.type === "finalized") {
				scheduleFinalizedFallback(sessionId, turnId);
			}
			if (generationEffect.shouldRestoreSnapshot) {
				void restoreSessionStreamSnapshot(sessionId, { turnId });
			}
			if (
				generationEffect.shouldReconcile &&
				sessionId === options.getActiveSessionId()
			) {
				void reconcileSessionTail(sessionId);
			}
			if (generationEffect.shouldRefreshSessions) {
				void options.refreshSessionsList(true);
			}
			if (
				generationEffect.shouldScroll &&
				sessionId === options.getActiveSessionId() &&
				options.shouldAutoFollow()
			) {
				await tick();
				options.requestBottomFollow();
			}
		} catch (error) {
			console.error("[WS] handleGenerationStreamEvent error:", error);
		}
	}

	function clearActiveGenerationSubscription() {
		activeGenerationSubscriptionCleanup?.();
		activeGenerationSubscriptionCleanup = null;
		activeGenerationSubscriptionKey = "";
	}

	function syncActiveSubscription(enabled: boolean) {
		const spaceId = options.getSpaceId();
		const sessionId = options.getActiveSessionId();
		if (!enabled || !spaceId || !sessionId) {
			clearActiveGenerationSubscription();
			return;
		}
		const key = `${spaceId}:${sessionId}`;
		if (activeGenerationSubscriptionKey === key) return;
		clearActiveGenerationSubscription();
		activeGenerationSubscriptionKey = key;
		try {
			activeGenerationSubscriptionCleanup = sdk
				.space(spaceId)
				.session(sessionId)
				.subscribeGeneration(
					{
						event: (event) => {
							if (activeGenerationSubscriptionKey !== key) return;
							void handleGenerationStreamEvent(sessionId, event);
						},
					},
					{ recover: true },
				);
		} catch (error) {
			clearActiveGenerationSubscription();
			console.warn("[GenerationRealtime] subscribeGeneration failed:", error);
		}
	}

	function clearStreamSnapshotRecoveryCooldowns() {
		lastStreamSnapshotRecoveryByTurn.clear();
	}

	function dispose() {
		clearActiveGenerationSubscription();
		clearAllFinalizedFallbacks();
		clearAllPostSendRecovery();
		recoveryCoordinator.dispose();
		lastStreamSnapshotRecoveryByTurn.clear();
	}

	return {
		restoreSessionStreamSnapshot,
		reconcileSessionTail,
		clearPostSendRecovery,
		clearAllPostSendRecovery,
		schedulePostSendRecoveryCheck,
		syncActiveSubscription,
		clearStreamSnapshotRecoveryCooldowns,
		reconcileAfterReconnect: (sessionId: string | null) =>
			recoveryCoordinator.reconcileAfterReconnect(sessionId),
		onTransportOpen: () => recoveryCoordinator.onTransportOpen(),
		dispose,
	};
}
