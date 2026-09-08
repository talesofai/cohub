/** Web-only contract. Deliberately not a new public SDK namespace. */
export const EMBED_PROTOCOL = "cohub.app.embed";
export const EMBED_VERSION = 1;
export const EMBED_PATH = "/app-embed";
export const EMBED_LIMIT = 8;
export const EMBED_TIMEOUT = 15_000;
export const EMBED_MAX_BYTES = 128 * 1024;
export type EmbedEnvelope = {
	protocol: typeof EMBED_PROTOCOL;
	version: 1;
	type: string;
	requestId?: string;
	instanceId?: string;
	[key: string]: unknown;
};
export function envelope(
	type: string,
	fields: Record<string, unknown> = {},
): EmbedEnvelope {
	return { ...fields, protocol: EMBED_PROTOCOL, version: EMBED_VERSION, type };
}
export function textField(value: unknown, max = 128): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}
export function parseEmbed(value: unknown): EmbedEnvelope | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const m = value as EmbedEnvelope;
	if (
		m.protocol !== EMBED_PROTOCOL ||
		m.version !== EMBED_VERSION ||
		!textField(m.type, 40)
	)
		return null;
	if (m.requestId !== undefined && !textField(m.requestId)) return null;
	if (m.instanceId !== undefined && !textField(m.instanceId)) return null;
	try {
		if (new TextEncoder().encode(JSON.stringify(m)).length > EMBED_MAX_BYTES)
			return null;
	} catch {
		return null;
	}
	return m;
}
const RUNTIME_TYPES = new Set([
	"context",
	"token",
	"authorize",
	"purchase",
	"checkout-state",
]);
export function isRuntimeRequest(
	data: unknown,
): data is Record<string, unknown> {
	if (!data || typeof data !== "object") return false;
	const m = data as Record<string, unknown>;
	if (!textField(m.requestId)) return false;
	const match =
		typeof m.type === "string" && /^cohub\.(?:app|work)\.(.+)$/.exec(m.type);
	return Boolean(match && RUNTIME_TYPES.has(match[1]));
}
