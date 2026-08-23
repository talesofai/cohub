import { getCacheUserKey } from "$lib/cache/keys";

const VERSION = 1;
const PREFIX = "cohub:space-group-collapse";

function isBrowser() {
	return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function storageKey() {
	return `${PREFIX}:${encodeURIComponent(getCacheUserKey())}:v${VERSION}`;
}

export function getCollapsedSpaceGroupIds(): Set<string> {
	if (!isBrowser()) return new Set();
	try {
		const raw = localStorage.getItem(storageKey());
		if (!raw) return new Set();
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.filter((id): id is string => typeof id === "string"));
	} catch {
		return new Set();
	}
}

export function setCollapsedSpaceGroupIds(ids: Set<string>) {
	if (!isBrowser()) return;
	try {
		localStorage.setItem(storageKey(), JSON.stringify([...ids]));
	} catch {
		// localStorage may be unavailable or full; runtime state remains authoritative.
	}
}
