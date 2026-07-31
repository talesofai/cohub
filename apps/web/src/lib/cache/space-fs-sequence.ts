import type { SpaceFsChangedPayload } from "@cohub/protocol/fs";

export type SpaceFsSequenceResult = {
	payload: SpaceFsChangedPayload | null;
	lastSeq: number | null;
};

export function reconcileSpaceFsSequence(
	payload: SpaceFsChangedPayload,
	lastSeq: number | null,
): SpaceFsSequenceResult {
	if (payload.source === "sandbox-watch-started" && payload.resync) {
		return { payload, lastSeq: payload.seq ?? null };
	}
	if (payload.source !== "sandbox-inotify" || payload.seq == null) {
		return { payload, lastSeq };
	}
	if (lastSeq != null && payload.seq <= lastSeq) {
		return { payload: null, lastSeq };
	}
	const hasGap = lastSeq != null && payload.seq > lastSeq + 1;
	return {
		payload: hasGap ? { ...payload, resync: true, changes: [] } : payload,
		lastSeq: payload.seq,
	};
}
