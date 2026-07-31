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
