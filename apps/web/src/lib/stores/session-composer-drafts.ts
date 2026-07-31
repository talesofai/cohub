const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type ComposerDraftRecord = {
	text: string;
	systemInstructions: string;
	retryClientMessageId: string | null;
	retryRequestFingerprint: string | null;
	updatedAt: number;
};

export type SessionComposerDraft = Omit<ComposerDraftRecord, "updatedAt">;

function canUseLocalStorage() {
	return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function safeRemoveItem(key: string) {
	try {
		localStorage.removeItem(key);
	} catch {
		// ignore
	}
}

function isExpired(updatedAt: unknown) {
	return (
		typeof updatedAt !== "number" ||
		!Number.isFinite(updatedAt) ||
		Date.now() - updatedAt > DRAFT_TTL_MS
	);
}

const emptyDraft = (): SessionComposerDraft => ({
	text: "",
	systemInstructions: "",
	retryClientMessageId: null,
	retryRequestFingerprint: null,
});

export function readSessionComposerDraft(key: string): SessionComposerDraft {
	if (!canUseLocalStorage()) return emptyDraft();
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return emptyDraft();
		const record = JSON.parse(raw) as Partial<ComposerDraftRecord>;
		if (isExpired(record.updatedAt)) {
			safeRemoveItem(key);
			return emptyDraft();
		}
		return {
			text: typeof record.text === "string" ? record.text : "",
			systemInstructions:
				typeof record.systemInstructions === "string"
					? record.systemInstructions
					: "",
			retryClientMessageId:
				typeof record.retryClientMessageId === "string" &&
				record.retryClientMessageId.trim()
					? record.retryClientMessageId.trim()
					: null,
			retryRequestFingerprint:
				typeof record.retryRequestFingerprint === "string" &&
				record.retryRequestFingerprint.trim()
					? record.retryRequestFingerprint.trim()
					: null,
		};
	} catch {
		safeRemoveItem(key);
		return emptyDraft();
	}
}

export function writeSessionComposerDraft(
	key: string,
	draft: SessionComposerDraft,
) {
	if (!canUseLocalStorage()) return;
	try {
		if (
			!draft.text.trim() &&
			!draft.systemInstructions.trim() &&
			!draft.retryClientMessageId
		) {
			safeRemoveItem(key);
			return;
		}
		const record: ComposerDraftRecord = {
			text: draft.text,
			systemInstructions: draft.systemInstructions,
			retryClientMessageId: draft.retryClientMessageId,
			retryRequestFingerprint: draft.retryRequestFingerprint,
			updatedAt: Date.now(),
		};
		localStorage.setItem(key, JSON.stringify(record));
	} catch {
		// localStorage may be unavailable or full; runtime state remains authoritative.
	}
}

export function removeSessionComposerDraft(key: string | null) {
	if (!key || !canUseLocalStorage()) return;
	safeRemoveItem(key);
}
