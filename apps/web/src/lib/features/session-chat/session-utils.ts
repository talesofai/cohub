import type { SessionTurnRecord } from "@cohub/protocol/model";
import type { SessionRecord, TaskRunRecord } from "@neta-art/cohub";
import { mergeTurnsById } from "$lib/stores/turn-cache";

export {
	areSessionTurnRecordsEqual,
	areSessionTurnsEqual,
	preserveSessionTurnRefs,
} from "$lib/session-turn-equality";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function tailText(value: unknown, limit = 420) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
}

export function getSessionTitle(
	session: Pick<SessionRecord, "title"> & { latestMessageText?: string | null },
): string {
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

export function extractBackgroundBashResultPreview(result: unknown) {
	const content = asRecord(result)?.content;
	if (!Array.isArray(content)) return null;
	for (const block of content) {
		const record = asRecord(block);
		if (record?.type === "tool_result") return tailText(record.content);
	}
	return null;
}

export function formatBackgroundBashSubtitle(run: TaskRunRecord) {
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

export function getTurnClientMessageId(turn: Pick<SessionTurnRecord, "meta">) {
	const value = turn.meta?.clientMessageId;
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isOptimisticTurn(turn: Pick<SessionTurnRecord, "meta">) {
	return turn.meta?.optimistic === true;
}

export function withOptimisticMetaCleared(turn: SessionTurnRecord) {
	if (!isOptimisticTurn(turn)) return turn;
	const meta = turn.meta ? { ...turn.meta } : null;
	if (meta && "optimistic" in meta) delete meta.optimistic;
	return { ...turn, meta };
}

export function isSameClientMessageTurn(
	turn: Pick<SessionTurnRecord, "meta">,
	clientMessageId: string | null,
) {
	return Boolean(
		clientMessageId && getTurnClientMessageId(turn) === clientMessageId,
	);
}

export function reconcileOptimisticTurn(
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

export function normalizeTurnDuplicates(turns: SessionTurnRecord[]) {
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
