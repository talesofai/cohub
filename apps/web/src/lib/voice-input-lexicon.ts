import type {
	VoiceLexiconEntry as ServerVoiceLexiconEntry,
	VoiceLexiconScope,
	VoiceLexiconSource,
} from "@neta-art/cohub";

const LOCAL_STORAGE_KEY = "cohub:voice-input:lexicon:v1";
const USER_CACHE_KEY = "cohub:voice-input:user-lexicon:v1";
const SPACE_CACHE_PREFIX = "cohub:voice-input:space-lexicon:v1:";
const MAX_TERMS = 240;
const MAX_TERM_LENGTH = 80;

export type VoiceInputLexiconEntry = {
	id: string;
	scope: VoiceLexiconScope | "local";
	term: string;
	source: VoiceLexiconSource;
	originalText: string | null;
	usageCount: number;
	createdAt: string | null;
	updatedAt: string | null;
	updatedAtMs: number;
};

type StoredLocalVoiceLexiconEntry = {
	term: string;
	source: VoiceLexiconSource;
	originalText?: string | null;
	usageCount?: number;
	updatedAt: number;
};

function isBrowser() {
	return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

export function normalizeVoiceLexiconTerm(value: string | null | undefined) {
	const term = value
		?.replace(/[`*_#[\]()>]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!term || term.length < 2 || term.length > MAX_TERM_LENGTH) return null;
	return term;
}

export function getVoiceLexiconTermKey(term: string) {
	return term.toLowerCase();
}

function parseTime(value: string | number | null | undefined) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSource(value: unknown): VoiceLexiconSource {
	if (value === "manual" || value === "correction") return value;
	return "auto";
}

function normalizeServerEntry(
	entry: ServerVoiceLexiconEntry,
): VoiceInputLexiconEntry | null {
	const term = normalizeVoiceLexiconTerm(entry.term);
	if (!term) return null;
	return {
		id: entry.id,
		scope: entry.scope,
		term,
		source: normalizeSource(entry.source),
		originalText: entry.originalText ?? null,
		usageCount: entry.usageCount,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
		updatedAtMs: parseTime(entry.updatedAt ?? entry.createdAt),
	};
}

function normalizeLocalEntry(value: unknown): VoiceInputLexiconEntry | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Partial<StoredLocalVoiceLexiconEntry>;
	const term = normalizeVoiceLexiconTerm(input.term);
	if (!term) return null;
	const updatedAt =
		typeof input.updatedAt === "number" ? input.updatedAt : Date.now();
	return {
		id: `local:${getVoiceLexiconTermKey(term)}`,
		scope: "local",
		term,
		source: normalizeSource(input.source),
		originalText:
			typeof input.originalText === "string" && input.originalText.trim()
				? input.originalText.trim()
				: null,
		usageCount:
			typeof input.usageCount === "number" && Number.isFinite(input.usageCount)
				? Math.max(0, Math.trunc(input.usageCount))
				: 0,
		createdAt: null,
		updatedAt: new Date(updatedAt).toISOString(),
		updatedAtMs: updatedAt,
	};
}

function readJsonArray(key: string) {
	if (!isBrowser()) return [];
	try {
		const raw = localStorage.getItem(key);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function writeJsonArray(key: string, entries: unknown[]) {
	if (!isBrowser()) return;
	try {
		localStorage.setItem(key, JSON.stringify(entries));
	} catch {
		// Dictation still works without persistent local cache.
	}
}

function spaceCacheKey(spaceId: string) {
	return `${SPACE_CACHE_PREFIX}${spaceId}`;
}

export function mergeVoiceInputLexiconEntries(
	...entryGroups: Array<Array<VoiceInputLexiconEntry | null | undefined>>
) {
	const byKey = new Map<string, VoiceInputLexiconEntry>();
	for (const entry of entryGroups.flat()) {
		if (!entry) continue;
		const term = normalizeVoiceLexiconTerm(entry.term);
		if (!term) continue;
		const normalized = { ...entry, term };
		const key = getVoiceLexiconTermKey(term);
		const previous = byKey.get(key);
		if (!previous) {
			byKey.set(key, normalized);
			continue;
		}
		if (previous.scope === "local" && normalized.scope !== "local") {
			byKey.set(key, normalized);
			continue;
		}
		if (
			previous.scope === normalized.scope &&
			normalized.updatedAtMs >= previous.updatedAtMs
		) {
			byKey.set(key, normalized);
		}
	}
	return Array.from(byKey.values())
		.sort((a, b) => b.updatedAtMs - a.updatedAtMs)
		.slice(0, MAX_TERMS);
}

export function getVoiceInputLexicon(): VoiceInputLexiconEntry[] {
	return mergeVoiceInputLexiconEntries(
		readJsonArray(LOCAL_STORAGE_KEY).map(normalizeLocalEntry),
		getCachedUserVoiceInputLexicon(),
	);
}

function writeLocalVoiceInputLexicon(entries: VoiceInputLexiconEntry[]) {
	const stored: StoredLocalVoiceLexiconEntry[] = entries
		.filter((entry) => entry.scope === "local")
		.map((entry) => ({
			term: entry.term,
			source: entry.source,
			originalText: entry.originalText,
			usageCount: entry.usageCount,
			updatedAt: entry.updatedAtMs || Date.now(),
		}));
	writeJsonArray(LOCAL_STORAGE_KEY, stored);
}

export function addVoiceInputLexiconTerm(
	term: string,
	source: VoiceLexiconSource = "manual",
	originalText?: string | null,
) {
	const normalized = normalizeVoiceLexiconTerm(term);
	if (!normalized) return getVoiceInputLexicon();
	const now = Date.now();
	const next = mergeVoiceInputLexiconEntries([
		{
			id: `local:${getVoiceLexiconTermKey(normalized)}`,
			scope: "local",
			term: normalized,
			source,
			originalText: originalText?.trim() || null,
			usageCount: source === "manual" ? 0 : 1,
			createdAt: null,
			updatedAt: new Date(now).toISOString(),
			updatedAtMs: now,
		},
		...getVoiceInputLexicon(),
	]);
	writeLocalVoiceInputLexicon(next);
	return next;
}

export function removeVoiceInputLexiconTerm(term: string) {
	const key = normalizeVoiceLexiconTerm(term);
	if (!key) return getVoiceInputLexicon();
	const normalizedKey = getVoiceLexiconTermKey(key);
	const next = getVoiceInputLexicon().filter(
		(entry) =>
			entry.scope !== "local" ||
			getVoiceLexiconTermKey(entry.term) !== normalizedKey,
	);
	writeLocalVoiceInputLexicon(next);
	return next;
}

export function getCachedUserVoiceInputLexicon() {
	return readJsonArray(USER_CACHE_KEY)
		.map((entry) => normalizeServerEntry(entry as ServerVoiceLexiconEntry))
		.filter((entry): entry is VoiceInputLexiconEntry => Boolean(entry));
}

export function setCachedUserVoiceInputLexicon(
	entries: ServerVoiceLexiconEntry[],
) {
	writeJsonArray(USER_CACHE_KEY, entries);
}

export function getCachedSpaceVoiceInputLexicon(
	spaceId: string | null | undefined,
) {
	if (!spaceId) return [];
	return readJsonArray(spaceCacheKey(spaceId))
		.map((entry) => normalizeServerEntry(entry as ServerVoiceLexiconEntry))
		.filter((entry): entry is VoiceInputLexiconEntry => Boolean(entry));
}

export function setCachedSpaceVoiceInputLexicon(
	spaceId: string,
	entries: ServerVoiceLexiconEntry[],
) {
	writeJsonArray(spaceCacheKey(spaceId), entries);
}

export function mergeVoiceLexiconForComposer(
	spaceId: string | null | undefined,
) {
	return mergeVoiceInputLexiconEntries(
		getVoiceInputLexicon(),
		getCachedSpaceVoiceInputLexicon(spaceId),
	);
}
