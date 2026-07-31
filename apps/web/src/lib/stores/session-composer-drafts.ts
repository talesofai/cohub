import type { ContentBlock } from "@cohub/protocol/core";
import type { GenerationPolicy } from "@cohub/protocol/generation";

const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type ComposerPendingSubmission = {
	spaceId: string;
	sessionId: string | null;
	content: ContentBlock[];
	text: string;
	model: string | null;
	provider: string | null;
	thinkingLevel: string | null;
	systemInstructions: string | null;
	generationPolicy: GenerationPolicy | null;
	clientMessageId: string;
	requestFingerprint: string;
};

type ComposerDraftRecord = {
	text: string;
	systemInstructions: string;
	retryClientMessageId: string | null;
	retryRequestFingerprint: string | null;
	pendingSubmission: ComposerPendingSubmission | null;
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
	pendingSubmission: null,
});

function optionalString(value: unknown) {
	return typeof value === "string" ? value : value === null ? null : undefined;
}

function parsePendingSubmission(
	value: unknown,
): ComposerPendingSubmission | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const sessionId = optionalString(record.sessionId);
	const model = optionalString(record.model);
	const provider = optionalString(record.provider);
	const thinkingLevel = optionalString(record.thinkingLevel);
	const systemInstructions = optionalString(record.systemInstructions);
	if (
		typeof record.spaceId !== "string" ||
		sessionId === undefined ||
		!Array.isArray(record.content) ||
		typeof record.text !== "string" ||
		model === undefined ||
		provider === undefined ||
		thinkingLevel === undefined ||
		systemInstructions === undefined ||
		typeof record.clientMessageId !== "string" ||
		!record.clientMessageId.trim() ||
		typeof record.requestFingerprint !== "string" ||
		!record.requestFingerprint.trim()
	) {
		return null;
	}
	return {
		spaceId: record.spaceId,
		sessionId,
		content: record.content as ContentBlock[],
		text: record.text,
		model,
		provider,
		thinkingLevel,
		systemInstructions,
		generationPolicy: (record.generationPolicy ??
			null) as GenerationPolicy | null,
		clientMessageId: record.clientMessageId.trim(),
		requestFingerprint: record.requestFingerprint.trim(),
	};
}

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
			pendingSubmission: parsePendingSubmission(record.pendingSubmission),
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
			!draft.retryClientMessageId &&
			!draft.pendingSubmission
		) {
			safeRemoveItem(key);
			return;
		}
		const record: ComposerDraftRecord = {
			text: draft.text,
			systemInstructions: draft.systemInstructions,
			retryClientMessageId: draft.retryClientMessageId,
			retryRequestFingerprint: draft.retryRequestFingerprint,
			pendingSubmission: draft.pendingSubmission,
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
