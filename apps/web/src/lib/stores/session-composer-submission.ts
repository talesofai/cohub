import type {
	ComposerPendingSubmission,
	SessionComposerDraft,
} from "./session-composer-drafts";

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, nested]) => nested !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(
				([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export async function createComposerSubmissionFingerprint(value: unknown) {
	const bytes = new TextEncoder().encode(stableStringify(value));
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export function resolveComposerClientMessageId(input: {
	retryClientMessageId: string | null;
	retryRequestFingerprint: string | null;
	requestFingerprint: string;
	randomUUID: () => string;
}) {
	return input.retryClientMessageId &&
		input.retryRequestFingerprint === input.requestFingerprint
		? input.retryClientMessageId
		: input.randomUUID();
}

export function resolvePendingComposerSubmission(input: {
	draft: SessionComposerDraft | null;
	text: string;
	systemInstructions: string;
	spaceId: string;
	sessionId: string | null;
	model: string | null;
	provider: string | null;
	thinkingLevel: string | null;
	generationPolicy: unknown;
}): ComposerPendingSubmission | null {
	const pending = input.draft?.pendingSubmission;
	if (
		!pending ||
		input.draft?.text !== input.text ||
		input.draft.systemInstructions !== input.systemInstructions ||
		pending.spaceId !== input.spaceId ||
		pending.sessionId !== input.sessionId ||
		pending.model !== input.model ||
		pending.provider !== input.provider ||
		pending.thinkingLevel !== input.thinkingLevel ||
		pending.systemInstructions !== (input.systemInstructions || null) ||
		stableStringify(pending.generationPolicy) !==
			stableStringify(input.generationPolicy)
	) {
		return null;
	}
	return pending;
}
