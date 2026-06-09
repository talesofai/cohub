const STORAGE_KEY = "cohub:voice-input:lexicon:v1";
const MAX_TERMS = 120;
const MAX_TERM_LENGTH = 40;

export type VoiceInputLexiconEntry = {
	term: string;
	source: "manual" | "auto";
	updatedAt: number;
};

function isBrowser() {
	return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function normalizeTerm(value: string | null | undefined) {
	const term = value
		?.replace(/[`*_#[\]()>]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!term || term.length < 2 || term.length > MAX_TERM_LENGTH) return null;
	return term;
}

function normalizeEntry(value: unknown): VoiceInputLexiconEntry | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Partial<VoiceInputLexiconEntry>;
	const term = normalizeTerm(input.term);
	if (!term) return null;
	return {
		term,
		source: input.source === "manual" ? "manual" : "auto",
		updatedAt:
			typeof input.updatedAt === "number" ? input.updatedAt : Date.now(),
	};
}

function normalizeEntries(values: unknown): VoiceInputLexiconEntry[] {
	if (!Array.isArray(values)) return [];
	const byKey = new Map<string, VoiceInputLexiconEntry>();
	for (const value of values) {
		const entry = normalizeEntry(value);
		if (!entry) continue;
		const key = entry.term.toLowerCase();
		const previous = byKey.get(key);
		if (
			!previous ||
			previous.updatedAt < entry.updatedAt ||
			entry.source === "manual"
		)
			byKey.set(key, entry);
	}
	return Array.from(byKey.values())
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, MAX_TERMS);
}

export function getVoiceInputLexicon(): VoiceInputLexiconEntry[] {
	if (!isBrowser()) return [];
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? normalizeEntries(JSON.parse(raw)) : [];
	} catch {
		return [];
	}
}

function writeVoiceInputLexicon(entries: VoiceInputLexiconEntry[]) {
	if (!isBrowser()) return;
	try {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify(normalizeEntries(entries)),
		);
	} catch {
		// Ignore storage failures; dictation still works without a persistent lexicon.
	}
}

export function addVoiceInputLexiconTerm(
	term: string,
	source: VoiceInputLexiconEntry["source"] = "manual",
) {
	const normalized = normalizeTerm(term);
	if (!normalized) return getVoiceInputLexicon();
	const next = normalizeEntries([
		{ term: normalized, source, updatedAt: Date.now() },
		...getVoiceInputLexicon(),
	]);
	writeVoiceInputLexicon(next);
	return next;
}

export function removeVoiceInputLexiconTerm(term: string) {
	const key = normalizeTerm(term)?.toLowerCase();
	if (!key) return getVoiceInputLexicon();
	const next = getVoiceInputLexicon().filter(
		(entry) => entry.term.toLowerCase() !== key,
	);
	writeVoiceInputLexicon(next);
	return next;
}
