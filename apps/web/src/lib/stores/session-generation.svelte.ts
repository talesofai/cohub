import type { ContentBlock, Usage } from "@cohub/protocol/core";
import { sessionGenerationSnapshotsRepo } from "$lib/cache/repositories/session-generation-snapshots-repo";

export type SessionGenerationStatus =
	| "idle"
	| "pending"
	| "streaming"
	| "completed"
	| "failed"
	| "interrupted";

export type SessionGenerationRuntimePhase = "llm_call_started";

export type StreamingIntermediateMessage = {
	messageId?: string | null;
	messageOrdinal?: number | null;
	content: ContentBlock[];
	id?: string;
	sessionId?: string;
	role?: "user" | "assistant" | "system";
	text?: string | null;
	provider?: string | null;
	model?: string | null;
	stopReason?: string | null;
	errorMessage?: string | null;
	usage?: Usage | null;
	durationMs?: number | null;
	toolCallsObjectKey?: string | null;
	meta?: Record<string, unknown> | null;
	createdAt?: string;
};

export type SessionGenerationState = {
	spaceId?: string | null;
	sessionId: string;
	status: SessionGenerationStatus | string;
	requestId?: string | null;
	error?: string | null;
	errorCode?: string | null;
	startedAt?: number;
	lastEventAt?: number;
	contentBlocks: ContentBlock[];
	intermediateMessages: StreamingIntermediateMessage[];
	streamMessageId: string | null;
	messageOrdinal: number | null;
	anchorUserMessageId: string | null;
	truncatedStart: boolean;
	patchSeq: number;
	turnId: string | null;
	runtimePhase: SessionGenerationRuntimePhase | null;
	runtimePhaseAt: number | null;
	llmRound: number | null;
	runtimeProvider: string | null;
	runtimeModel: string | null;
	finalizedPreview: boolean;
};

const PERSIST_WRITE_DEBOUNCE_MS = 250;
const MAX_PERSISTED_ERROR_LENGTH = 1000;
const TERMINAL_STATUSES = new Set([
	"idle",
	"completed",
	"failed",
	"interrupted",
]);

const createIdleState = (sessionId: string): SessionGenerationState => ({
	sessionId,
	spaceId: null,
	status: "idle",
	requestId: null,
	error: null,
	errorCode: null,
	startedAt: undefined,
	lastEventAt: undefined,
	contentBlocks: [],
	intermediateMessages: [],
	streamMessageId: null,
	messageOrdinal: null,
	anchorUserMessageId: null,
	truncatedStart: false,
	patchSeq: 0,
	turnId: null,
	runtimePhase: null,
	runtimePhaseAt: null,
	llmRound: null,
	runtimeProvider: null,
	runtimeModel: null,
	finalizedPreview: false,
});

function sanitizeError(error: string | null | undefined) {
	const trimmed = error?.trim();
	return trimmed ? trimmed.slice(0, MAX_PERSISTED_ERROR_LENGTH) : null;
}

function parseIntermediateMessage(
	value: unknown,
): StreamingIntermediateMessage | null {
	if (Array.isArray(value)) return { content: value as ContentBlock[] };
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.content)) return null;
	return {
		...record,
		content: record.content as ContentBlock[],
		messageId: typeof record.messageId === "string" ? record.messageId : null,
		messageOrdinal:
			typeof record.messageOrdinal === "number" ? record.messageOrdinal : null,
		id: typeof record.id === "string" ? record.id : undefined,
		sessionId:
			typeof record.sessionId === "string" ? record.sessionId : undefined,
		role:
			record.role === "user" ||
			record.role === "assistant" ||
			record.role === "system"
				? record.role
				: undefined,
		text: typeof record.text === "string" ? record.text : null,
		provider: typeof record.provider === "string" ? record.provider : null,
		model: typeof record.model === "string" ? record.model : null,
		stopReason:
			typeof record.stopReason === "string" ? record.stopReason : null,
		errorMessage:
			typeof record.errorMessage === "string" ? record.errorMessage : null,
		usage:
			record.usage && typeof record.usage === "object"
				? (record.usage as Usage)
				: null,
		durationMs:
			typeof record.durationMs === "number" ? record.durationMs : null,
		toolCallsObjectKey:
			typeof record.toolCallsObjectKey === "string"
				? record.toolCallsObjectKey
				: null,
		meta:
			record.meta &&
			typeof record.meta === "object" &&
			!Array.isArray(record.meta)
				? (record.meta as Record<string, unknown>)
				: null,
		createdAt:
			typeof record.createdAt === "string" ? record.createdAt : undefined,
	};
}

function isPersistable(state: SessionGenerationState) {
	return !TERMINAL_STATUSES.has(state.status);
}

function parseSnapshotState(
	record: Awaited<ReturnType<typeof sessionGenerationSnapshotsRepo.get>>,
): SessionGenerationState | null {
	if (!record?.sessionId || !record.status) return null;
	if (TERMINAL_STATUSES.has(record.status)) return null;
	if (!record.spaceId) return null;
	const contentBlocks = Array.isArray(record.contentBlocks)
		? (record.contentBlocks as ContentBlock[])
		: null;
	const intermediateMessages = Array.isArray(record.intermediateMessages)
		? record.intermediateMessages
				.map(parseIntermediateMessage)
				.filter((message): message is StreamingIntermediateMessage =>
					Boolean(message),
				)
		: null;
	if (!contentBlocks || !intermediateMessages) return null;
	return {
		spaceId: record.spaceId,
		sessionId: record.sessionId,
		status: record.status,
		requestId: null,
		error: null,
		errorCode: null,
		startedAt: record.startedAt ?? undefined,
		lastEventAt: record.lastEventAt ?? undefined,
		contentBlocks,
		intermediateMessages,
		streamMessageId: record.streamMessageId,
		messageOrdinal: record.messageOrdinal,
		anchorUserMessageId: record.anchorUserMessageId,
		truncatedStart: record.truncatedStart,
		patchSeq: record.patchSeq,
		turnId: record.turnId,
		runtimePhase:
			record.runtimePhase === "llm_call_started" ? "llm_call_started" : null,
		runtimePhaseAt: record.runtimePhaseAt,
		llmRound: record.llmRound,
		runtimeProvider: record.runtimeProvider,
		runtimeModel: record.runtimeModel,
		finalizedPreview: record.finalizedPreview,
	};
}

function toSnapshotInput(state: SessionGenerationState) {
	const now = Date.now();
	return {
		spaceId: state.spaceId ?? "",
		sessionId: state.sessionId,
		turnId: state.turnId,
		anchorUserMessageId: state.anchorUserMessageId,
		clientMessageId: null,
		status: state.status,
		contentBlocks: state.contentBlocks,
		intermediateMessages: state.intermediateMessages,
		streamMessageId: state.streamMessageId,
		messageOrdinal: state.messageOrdinal,
		truncatedStart: state.truncatedStart,
		patchSeq: state.patchSeq,
		finalizedPreview: state.finalizedPreview,
		runtimePhase: state.runtimePhase,
		runtimePhaseAt: state.runtimePhaseAt,
		llmRound: state.llmRound,
		runtimeProvider: state.runtimeProvider,
		runtimeModel: state.runtimeModel,
		startedAt: state.startedAt ?? null,
		lastEventAt: state.lastEventAt ?? null,
		updatedAt: now,
	};
}

class SessionGenerationStore {
	bySessionId = $state<Record<string, SessionGenerationState>>({});
	private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor() {
		void sessionGenerationSnapshotsRepo.deleteExpired().catch(() => undefined);
	}

	async restore(spaceId: string, sessionId: string) {
		const current = this.get(sessionId);
		if (current && isPersistable(current)) return current;
		const requestStartedAt = Date.now();
		const record = await sessionGenerationSnapshotsRepo.get(spaceId, sessionId);
		const latest = this.get(sessionId);
		if (
			latest &&
			isPersistable(latest) &&
			(latest.lastEventAt ?? latest.startedAt ?? 0) >= requestStartedAt
		) {
			return latest;
		}
		const state = parseSnapshotState(record);
		if (!state) {
			if (record) {
				void sessionGenerationSnapshotsRepo
					.delete(spaceId, sessionId)
					.catch(() => undefined);
			}
			return null;
		}
		if (
			latest &&
			isPersistable(latest) &&
			(latest.lastEventAt ?? latest.startedAt ?? 0) >
				(state.lastEventAt ?? state.startedAt ?? 0)
		) {
			return latest;
		}
		this.bySessionId = {
			...this.bySessionId,
			[sessionId]: state,
		};
		return state;
	}

	private clearPersistTimer(sessionId: string) {
		const timer = this.persistTimers.get(sessionId);
		if (!timer) return;
		clearTimeout(timer);
		this.persistTimers.delete(sessionId);
	}

	private clearPersisted(sessionId: string, spaceId?: string | null) {
		this.clearPersistTimer(sessionId);
		const resolvedSpaceId =
			spaceId ?? this.bySessionId[sessionId]?.spaceId ?? null;
		if (!resolvedSpaceId) return;
		void sessionGenerationSnapshotsRepo
			.delete(resolvedSpaceId, sessionId)
			.catch(() => undefined);
	}

	private schedulePersist(state: SessionGenerationState) {
		if (!isPersistable(state) || !state.spaceId) {
			this.clearPersisted(state.sessionId, state.spaceId);
			return;
		}
		this.clearPersistTimer(state.sessionId);
		const timer = setTimeout(() => {
			this.persistTimers.delete(state.sessionId);
			void sessionGenerationSnapshotsRepo
				.put(toSnapshotInput(state))
				.catch(() => undefined);
		}, PERSIST_WRITE_DEBOUNCE_MS);
		this.persistTimers.set(state.sessionId, timer);
	}

	private setState(sessionId: string, state: SessionGenerationState) {
		this.bySessionId = {
			...this.bySessionId,
			[sessionId]: state,
		};
		this.schedulePersist(state);
	}

	get(sessionId: string | null | undefined): SessionGenerationState | null {
		if (!sessionId) return null;
		return this.bySessionId[sessionId] ?? null;
	}

	isStreaming(sessionId: string | null | undefined): boolean {
		if (!sessionId) return false;
		const state = this.bySessionId[sessionId];
		return state?.status === "streaming";
	}

	isGenerating(sessionId: string | null | undefined): boolean {
		if (!sessionId) return false;
		const state = this.bySessionId[sessionId];
		return Boolean(state && !TERMINAL_STATUSES.has(state.status));
	}

	startPending(
		sessionId: string,
		input?: {
			requestId?: string | null;
			spaceId?: string | null;
			turnId?: string | null;
			finalizedPreview?: boolean;
		},
	) {
		const current = this.get(sessionId) ?? createIdleState(sessionId);
		const isDifferentTurn = Boolean(
			input?.turnId && current.turnId && input.turnId !== current.turnId,
		);
		if (current.status === "streaming" && !isDifferentTurn) return;
		this.setState(sessionId, {
			...current,
			sessionId,
			spaceId: input?.spaceId ?? current.spaceId ?? null,
			status: "pending",
			requestId: input?.requestId ?? current.requestId ?? null,
			error: null,
			errorCode: null,
			startedAt: current.startedAt ?? Date.now(),
			lastEventAt: Date.now(),
			contentBlocks: [],
			intermediateMessages: [],
			streamMessageId: null,
			messageOrdinal: null,
			anchorUserMessageId: null,
			truncatedStart: false,
			patchSeq: 0,
			turnId: input?.turnId ?? null,
			runtimePhase: null,
			runtimePhaseAt: null,
			llmRound: null,
			runtimeProvider: null,
			runtimeModel: null,
			finalizedPreview: false,
		});
	}

	resumePending(
		sessionId: string,
		input?: {
			spaceId?: string | null;
			turnId?: string | null;
			anchorUserMessageId?: string | null;
			finalizedPreview?: boolean;
		},
	) {
		const current = this.get(sessionId) ?? createIdleState(sessionId);
		if (current.status === "streaming") return;
		if (isPersistable(current)) return;
		this.setState(sessionId, {
			...current,
			sessionId,
			spaceId: input?.spaceId ?? current.spaceId ?? null,
			status: "pending",
			error: null,
			errorCode: null,
			startedAt: current.startedAt ?? Date.now(),
			lastEventAt: Date.now(),
			anchorUserMessageId:
				input?.anchorUserMessageId ?? current.anchorUserMessageId ?? null,
			turnId: input?.turnId ?? current.turnId ?? null,
			runtimePhase: current.runtimePhase ?? null,
			runtimePhaseAt: current.runtimePhaseAt ?? null,
			llmRound: current.llmRound ?? null,
			runtimeProvider: current.runtimeProvider ?? null,
			runtimeModel: current.runtimeModel ?? null,
			finalizedPreview:
				input?.finalizedPreview ?? current.finalizedPreview ?? false,
		});
	}

	applyProgress(
		sessionId: string,
		input: {
			spaceId?: string | null;
			contentBlocks: ContentBlock[];
			intermediateMessages?: StreamingIntermediateMessage[];
			streamMessageId?: string | null;
			messageOrdinal?: number | null;
			anchorUserMessageId?: string | null;
			truncatedStart?: boolean;
			patchSeq?: number;
			turnId?: string | null;
			finalizedPreview?: boolean;
		},
	) {
		const current = this.get(sessionId) ?? createIdleState(sessionId);
		this.setState(sessionId, {
			...current,
			spaceId: input.spaceId ?? current.spaceId ?? null,
			status: "streaming",
			error: null,
			errorCode: null,
			startedAt: current.startedAt ?? Date.now(),
			lastEventAt: Date.now(),
			contentBlocks: input.contentBlocks,
			intermediateMessages:
				input.intermediateMessages !== undefined
					? input.intermediateMessages
					: (current.intermediateMessages ?? []),
			streamMessageId:
				input.streamMessageId !== undefined
					? input.streamMessageId
					: current.streamMessageId,
			messageOrdinal:
				input.messageOrdinal !== undefined
					? input.messageOrdinal
					: current.messageOrdinal,
			anchorUserMessageId:
				input.anchorUserMessageId ?? current.anchorUserMessageId ?? null,
			truncatedStart: input.truncatedStart ?? current.truncatedStart,
			patchSeq: input.patchSeq ?? current.patchSeq,
			turnId: input.turnId ?? current.turnId ?? null,
			runtimePhase: null,
			runtimePhaseAt: null,
			llmRound: null,
			runtimeProvider: null,
			runtimeModel: null,
			finalizedPreview: input.finalizedPreview ?? false,
		});
	}

	markRuntimePhase(
		sessionId: string,
		input: {
			phase: SessionGenerationRuntimePhase;
			at?: string | number | null;
			llmRound?: number | null;
			provider?: string | null;
			model?: string | null;
			spaceId?: string | null;
			turnId?: string | null;
			anchorUserMessageId?: string | null;
		},
	) {
		const current = this.get(sessionId) ?? createIdleState(sessionId);
		const atMs =
			typeof input.at === "number"
				? input.at
				: typeof input.at === "string"
					? Date.parse(input.at)
					: Date.now();
		this.setState(sessionId, {
			...current,
			sessionId,
			spaceId: input.spaceId ?? current.spaceId ?? null,
			status: current.status === "idle" ? "pending" : current.status,
			error: null,
			errorCode: null,
			startedAt: current.startedAt ?? Date.now(),
			lastEventAt: Date.now(),
			turnId: input.turnId ?? current.turnId ?? null,
			anchorUserMessageId:
				input.anchorUserMessageId ?? current.anchorUserMessageId ?? null,
			runtimePhase: input.phase,
			runtimePhaseAt: Number.isFinite(atMs) ? atMs : Date.now(),
			llmRound: input.llmRound ?? current.llmRound ?? null,
			runtimeProvider: input.provider ?? current.runtimeProvider ?? null,
			runtimeModel: input.model ?? current.runtimeModel ?? null,
		});
	}

	replaceTurnId(
		sessionId: string,
		input: { previousTurnId?: string | null; nextTurnId: string | null },
	) {
		const current = this.get(sessionId);
		if (!current) return;
		if (
			input.previousTurnId &&
			current.turnId &&
			current.turnId !== input.previousTurnId
		) {
			return;
		}
		this.setState(sessionId, {
			...current,
			turnId: input.nextTurnId,
			streamMessageId:
				current.streamMessageId && current.turnId && input.nextTurnId
					? current.streamMessageId.replace(
							`turn:${current.turnId}:`,
							`turn:${input.nextTurnId}:`,
						)
					: current.streamMessageId,
		});
	}

	complete(sessionId: string) {
		const current = this.get(sessionId) ?? createIdleState(sessionId);
		this.setState(sessionId, {
			...current,
			status: "completed",
			error: null,
			errorCode: null,
			lastEventAt: Date.now(),
			contentBlocks: [],
			intermediateMessages: [],
			streamMessageId: null,
			messageOrdinal: null,
			anchorUserMessageId: null,
			truncatedStart: false,
			patchSeq: current.patchSeq,
			turnId: current.turnId,
			runtimePhase: null,
			runtimePhaseAt: null,
			llmRound: null,
			runtimeProvider: null,
			runtimeModel: null,
			finalizedPreview: false,
		});
	}

	fail(
		sessionId: string,
		error?: string | null,
		input?: { errorCode?: string | null },
	) {
		const current = this.get(sessionId) ?? createIdleState(sessionId);
		this.setState(sessionId, {
			...current,
			status: "failed",
			error: sanitizeError(error ?? current.error),
			errorCode: input?.errorCode ?? current.errorCode ?? null,
			lastEventAt: Date.now(),
			contentBlocks: [],
			intermediateMessages: [],
			streamMessageId: null,
			messageOrdinal: null,
			anchorUserMessageId: null,
			truncatedStart: false,
			patchSeq: current.patchSeq,
			turnId: current.turnId,
			runtimePhase: null,
			runtimePhaseAt: null,
			llmRound: null,
			runtimeProvider: null,
			runtimeModel: null,
			finalizedPreview: false,
		});
	}

	interrupt(sessionId: string) {
		const current = this.get(sessionId) ?? createIdleState(sessionId);
		this.setState(sessionId, {
			...current,
			status: "interrupted",
			error: null,
			errorCode: null,
			lastEventAt: Date.now(),
			contentBlocks: [],
			intermediateMessages: [],
			streamMessageId: null,
			messageOrdinal: null,
			anchorUserMessageId: null,
			truncatedStart: false,
			patchSeq: current.patchSeq,
			turnId: current.turnId,
			runtimePhase: null,
			runtimePhaseAt: null,
			llmRound: null,
			runtimeProvider: null,
			runtimeModel: null,
			finalizedPreview: false,
		});
	}

	clearError(sessionId: string | null | undefined) {
		if (!sessionId) return;
		const current = this.get(sessionId);
		if (!current?.error) return;
		this.setState(sessionId, {
			...current,
			error: null,
			errorCode: null,
		});
	}

	reset(sessionId: string | null | undefined) {
		if (!sessionId) return;
		const currentSpaceId = this.bySessionId[sessionId]?.spaceId ?? null;
		this.bySessionId = {
			...this.bySessionId,
			[sessionId]: createIdleState(sessionId),
		};
		this.clearPersisted(sessionId, currentSpaceId);
	}

	resetAll() {
		for (const sessionId of Object.keys(this.bySessionId)) {
			this.clearPersisted(sessionId);
		}
		for (const timer of this.persistTimers.values()) clearTimeout(timer);
		this.persistTimers.clear();
		this.bySessionId = {};
	}
}

export const sessionGenerationStore = new SessionGenerationStore();
