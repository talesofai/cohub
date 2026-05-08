import {
	createSessionPatchReducer,
	type SessionPatchApplyInput,
} from "@neta-art/cohub";
import type { ContentBlock } from "@neta-art/cohub-protocol/core";
import type { StoredIntermediateMessage } from "@neta-art/cohub-protocol/model";
import { mergeStreamingDeltaBlocks } from "$lib/session-streaming";
import { createStreamingIntermediateMessage } from "$lib/session-streaming-message";
import { sessionGenerationStore } from "./session-generation.svelte";

type PatchApplyResult =
	| { applied: true }
	| { applied: false; reason: "duplicate" | "version_mismatch" };

const realtimePatchReducer = createSessionPatchReducer();

function resolveStreamMessageId(input: {
	sessionId: string;
	turnId?: string | null;
	anchorUserMessageId?: string | null;
	messageId?: string | null;
	messageOrdinal?: number | null;
}) {
	if (input.messageId?.trim()) return input.messageId.trim();
	if (input.messageOrdinal == null) return null;
	if (input.turnId?.trim()) {
		return `turn:${input.turnId.trim()}:assistant:${input.messageOrdinal}`;
	}
	return `session:${input.sessionId}:assistant:${input.messageOrdinal}:${input.anchorUserMessageId ?? "unknown"}`;
}

function appendCurrentMessageToIntermediate(input: {
	contentBlocks: ContentBlock[];
	intermediateMessages?: ContentBlock[][];
}) {
	if (input.contentBlocks.length === 0) return input.intermediateMessages ?? [];
	return [...(input.intermediateMessages ?? []), input.contentBlocks];
}

export function buildStreamingStoredIntermediateMessages(input: {
	spaceId?: string | null;
	sessionId: string;
	turnId?: string | null;
	intermediateMessages?: ContentBlock[][];
}): StoredIntermediateMessage[] {
	return (input.intermediateMessages ?? [])
		.map((contentBlocks, index) =>
			createStreamingIntermediateMessage({
				spaceId: input.spaceId,
				sessionId: input.sessionId,
				turnId: input.turnId,
				streamMessageId: `stream:${input.sessionId}:${input.turnId ?? "turn"}:intermediate:${index}`,
				messageOrdinal: index,
				contentBlocks,
			}),
		)
		.filter((message): message is StoredIntermediateMessage =>
			Boolean(message),
		);
}

export function clearGenerationError(sessionId: string | null | undefined) {
	sessionGenerationStore.clearError(sessionId);
}

export function startGenerationRequest(
	sessionId: string,
	input?: {
		requestId?: string | null;
		spaceId?: string | null;
		turnId?: string | null;
	},
) {
	clearGenerationError(sessionId);
	const current = sessionGenerationStore.get(sessionId);
	const isDifferentTurn = Boolean(
		input?.turnId && current?.turnId && input.turnId !== current.turnId,
	);
	if (current?.status === "streaming" && !isDifferentTurn) return;
	realtimePatchReducer.start({
		sessionId,
		spaceId: input?.spaceId ?? current?.spaceId ?? null,
		turnId: input?.turnId ?? null,
	});
	sessionGenerationStore.startPending(sessionId, input);
}

export function applyRealtimeGenerationProgress(
	sessionId: string,
	input: {
		spaceId?: string | null;
		turnId?: string | null;
		content: ContentBlock[];
		anchorUserMessageId?: string | null;
		messageId?: string | null;
		messageOrdinal?: number | null;
	},
) {
	const current = sessionGenerationStore.get(sessionId);
	const currentContentBlocks = current?.contentBlocks ?? [];
	const currentIntermediateMessages = current?.intermediateMessages ?? [];
	const currentStreamMessageId = current?.streamMessageId ?? null;
	const currentMessageOrdinal = current?.messageOrdinal ?? null;
	const currentAnchorUserMessageId = current?.anchorUserMessageId ?? null;
	const incomingTurnId = input.turnId ?? null;
	const isDifferentTurn = Boolean(
		incomingTurnId && current?.turnId && incomingTurnId !== current.turnId,
	);
	const baseContentBlocks = isDifferentTurn ? [] : currentContentBlocks;
	const baseIntermediateMessages = isDifferentTurn
		? []
		: currentIntermediateMessages;
	const baseStreamMessageId = isDifferentTurn ? null : currentStreamMessageId;
	const baseMessageOrdinal = isDifferentTurn ? null : currentMessageOrdinal;
	const baseAnchorUserMessageId = isDifferentTurn
		? null
		: currentAnchorUserMessageId;
	const resolvedSpaceId = input.spaceId ?? current?.spaceId ?? null;
	const resolvedTurnId =
		incomingTurnId ?? (isDifferentTurn ? null : current?.turnId) ?? null;
	const nextStreamMessageId = resolveStreamMessageId({
		sessionId,
		turnId: resolvedTurnId,
		anchorUserMessageId: input.anchorUserMessageId ?? baseAnchorUserMessageId,
		messageId: input.messageId,
		messageOrdinal: input.messageOrdinal,
	});

	if (input.content.length === 0) {
		if (!input.anchorUserMessageId && !nextStreamMessageId) return;
		sessionGenerationStore.applyProgress(sessionId, {
			spaceId: resolvedSpaceId,
			contentBlocks: baseContentBlocks,
			intermediateMessages: baseIntermediateMessages,
			streamMessageId: nextStreamMessageId ?? baseStreamMessageId,
			messageOrdinal: input.messageOrdinal ?? baseMessageOrdinal,
			anchorUserMessageId: input.anchorUserMessageId ?? baseAnchorUserMessageId,
			truncatedStart: isDifferentTurn
				? false
				: (current?.truncatedStart ?? false),
			turnId: resolvedTurnId,
		});
		return;
	}

	const messageChanged = Boolean(
		nextStreamMessageId &&
			currentContentBlocks.length > 0 &&
			((currentStreamMessageId &&
				nextStreamMessageId !== currentStreamMessageId) ||
				(!currentStreamMessageId && current?.status === "streaming")),
	);
	const shouldStartFreshPreview =
		baseContentBlocks.length > 0 && current?.status !== "streaming";
	const previewBase = messageChanged
		? []
		: shouldStartFreshPreview
			? []
			: baseContentBlocks;
	const mergedContent = mergeStreamingDeltaBlocks(previewBase, input.content);
	const intermediateMessages = messageChanged
		? appendCurrentMessageToIntermediate({
				contentBlocks: currentContentBlocks,
				intermediateMessages: currentIntermediateMessages,
			})
		: baseIntermediateMessages;
	sessionGenerationStore.applyProgress(sessionId, {
		spaceId: resolvedSpaceId,
		contentBlocks: mergedContent,
		intermediateMessages,
		streamMessageId: nextStreamMessageId ?? baseStreamMessageId,
		messageOrdinal: input.messageOrdinal ?? baseMessageOrdinal,
		anchorUserMessageId: input.anchorUserMessageId ?? baseAnchorUserMessageId,
		truncatedStart:
			!isDifferentTurn &&
			baseContentBlocks.length === 0 &&
			current?.status === "pending"
				? true
				: shouldStartFreshPreview
					? false
					: (current?.truncatedStart ?? false),
		turnId: resolvedTurnId,
	});
}

type RealtimeGenerationSnapshotResult =
	| { applied: true }
	| { applied: false; reason: "stale_snapshot" };

export function applyRealtimeGenerationSnapshot(
	sessionId: string,
	input: {
		spaceId?: string | null;
		turnId?: string | null;
		seq: number;
		anchorUserMessageId?: string | null;
		current: {
			messageId?: string | null;
			messageOrdinal?: number | null;
			content: ContentBlock[];
			appendPath?: string | null;
		};
		intermediateMessages?: Array<{
			messageId?: string | null;
			messageOrdinal?: number | null;
			content: ContentBlock[];
		}>;
	},
): RealtimeGenerationSnapshotResult {
	const current = sessionGenerationStore.get(sessionId);
	const resolvedTurnId = input.turnId ?? current?.turnId ?? null;
	if (
		current?.turnId &&
		resolvedTurnId &&
		current.turnId === resolvedTurnId &&
		current.patchSeq > input.seq
	) {
		return { applied: false, reason: "stale_snapshot" };
	}
	const streamMessageId = resolveStreamMessageId({
		sessionId,
		turnId: resolvedTurnId,
		anchorUserMessageId:
			input.anchorUserMessageId ?? current?.anchorUserMessageId,
		messageId: input.current.messageId,
		messageOrdinal: input.current.messageOrdinal,
	});
	const snapshotResult = realtimePatchReducer.applySnapshot({
		sessionId,
		spaceId: input.spaceId ?? current?.spaceId ?? null,
		turnId: resolvedTurnId,
		seq: input.seq,
		contentBlocks: input.current.content,
		anchorUserMessageId:
			input.anchorUserMessageId ?? current?.anchorUserMessageId ?? null,
		appendPath:
			"appendPath" in input.current ? (input.current.appendPath ?? null) : null,
	});
	if (!snapshotResult.applied) {
		return { applied: false, reason: "stale_snapshot" };
	}
	sessionGenerationStore.applyProgress(sessionId, {
		spaceId: input.spaceId ?? current?.spaceId ?? null,
		contentBlocks: input.current.content,
		intermediateMessages: (input.intermediateMessages ?? []).map(
			(message) => message.content,
		),
		streamMessageId,
		messageOrdinal: input.current.messageOrdinal ?? null,
		anchorUserMessageId:
			input.anchorUserMessageId ?? current?.anchorUserMessageId ?? null,
		truncatedStart: false,
		patchSeq: input.seq,
		turnId: resolvedTurnId,
	});
	return { applied: true };
}

export function applyRealtimeGenerationPatch(
	sessionId: string,
	input: {
		spaceId?: string | null;
		turnId?: string | null;
		messageId?: string | null;
		messageOrdinal?: number | null;
		seq: number;
		baseSeq: number;
		ops: SessionPatchApplyInput["ops"];
		anchorUserMessageId?: string | null;
	},
): PatchApplyResult {
	const current = sessionGenerationStore.get(sessionId);
	const currentContentBlocks = current?.contentBlocks ?? [];
	const currentIntermediateMessages = current?.intermediateMessages ?? [];
	const currentStreamMessageId = current?.streamMessageId ?? null;
	const currentMessageOrdinal = current?.messageOrdinal ?? null;
	const incomingTurnId = input.turnId ?? null;
	const isDifferentTurn = Boolean(
		incomingTurnId && current?.turnId && incomingTurnId !== current.turnId,
	);
	const baseIntermediateMessages = isDifferentTurn
		? []
		: currentIntermediateMessages;
	const baseStreamMessageId = isDifferentTurn ? null : currentStreamMessageId;
	const baseMessageOrdinal = isDifferentTurn ? null : currentMessageOrdinal;
	const resolvedSpaceId = input.spaceId ?? current?.spaceId ?? null;
	const resolvedTurnId =
		incomingTurnId ?? (isDifferentTurn ? null : current?.turnId) ?? null;
	const nextStreamMessageId = resolveStreamMessageId({
		sessionId,
		turnId: resolvedTurnId,
		anchorUserMessageId: input.anchorUserMessageId,
		messageId: input.messageId,
		messageOrdinal: input.messageOrdinal,
	});
	const messageChanged = Boolean(
		nextStreamMessageId &&
			currentContentBlocks.length > 0 &&
			((currentStreamMessageId &&
				nextStreamMessageId !== currentStreamMessageId) ||
				(!currentStreamMessageId && current?.status === "streaming")),
	);
	if (isDifferentTurn || messageChanged) {
		realtimePatchReducer.start({
			sessionId,
			spaceId: resolvedSpaceId,
			turnId: resolvedTurnId,
		});
	}
	const result = realtimePatchReducer.applyPatch({
		sessionId,
		...input,
		spaceId: resolvedSpaceId,
		turnId: resolvedTurnId,
	});
	if (import.meta.env.DEV) {
		console.log("[cohub][web:applyRealtimeGenerationPatch] patchState parity", {
			sessionId,
			spaceId: resolvedSpaceId,
			turnId: resolvedTurnId,
			incomingSeq: input.seq,
			incomingBaseSeq: input.baseSeq,
			didCallReducerStart: isDifferentTurn || messageChanged,
			result,
		});
	}
	if (!result.applied) {
		return {
			applied: false,
			reason: result.reason === "duplicate" ? "duplicate" : "version_mismatch",
		};
	}
	const intermediateMessages = messageChanged
		? appendCurrentMessageToIntermediate({
				contentBlocks: currentContentBlocks,
				intermediateMessages: currentIntermediateMessages,
			})
		: baseIntermediateMessages;
	sessionGenerationStore.applyProgress(sessionId, {
		spaceId: resolvedSpaceId ?? result.state.spaceId ?? null,
		contentBlocks: result.state.contentBlocks,
		intermediateMessages,
		streamMessageId: nextStreamMessageId ?? baseStreamMessageId,
		messageOrdinal: input.messageOrdinal ?? baseMessageOrdinal,
		anchorUserMessageId: result.state.anchorUserMessageId,
		truncatedStart:
			!isDifferentTurn && input.baseSeq !== 0 && current?.status === "pending"
				? true
				: messageChanged || isDifferentTurn
					? false
					: (current?.truncatedStart ?? false),
		patchSeq: result.state.patchSeq,
		turnId: result.state.turnId,
	});
	return { applied: true };
}

export function failGeneration(sessionId: string, error?: string | null) {
	realtimePatchReducer.fail({ sessionId });
	sessionGenerationStore.fail(sessionId, error ?? "Generation failed");
}

export function replaceGenerationTurnId(
	sessionId: string,
	input: { previousTurnId?: string | null; nextTurnId: string | null },
) {
	realtimePatchReducer.replaceTurnId({
		sessionId,
		turnId: input.previousTurnId ?? null,
		nextTurnId: input.nextTurnId,
	});
	sessionGenerationStore.replaceTurnId(sessionId, input);
}

export function completeGeneration(sessionId: string) {
	realtimePatchReducer.complete({ sessionId });
	sessionGenerationStore.complete(sessionId);
}

export function resetGeneration(sessionId: string | null | undefined) {
	if (sessionId) realtimePatchReducer.reset({ sessionId });
	sessionGenerationStore.reset(sessionId);
}
