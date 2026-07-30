const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type ComposerDraftRecord = {
	text: string;
	systemInstructions: string;
	updatedAt: number;
};

export type SessionComposerDraft = Pick<
	ComposerDraftRecord,
	"text" | "systemInstructions"
>;

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
		if (!draft.text.trim() && !draft.systemInstructions.trim()) {
			safeRemoveItem(key);
			return;
		}
		const record: ComposerDraftRecord = {
			text: draft.text,
			systemInstructions: draft.systemInstructions,
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
