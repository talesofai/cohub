import type { SkillCatalogEntry } from "@neta-art/cohub";

const CACHE_VERSION = 2;

function getCacheKey(spaceId: string) {
	return `cohub:space-skills:${spaceId}:v${CACHE_VERSION}`;
}

function isModSkillSource(value: unknown) {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		record.type === "mod" &&
		typeof record.modSpaceId === "string" &&
		typeof record.mountSlug === "string"
	);
}

function isSkillCatalogEntry(value: unknown): value is SkillCatalogEntry {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	const validScope =
		record.scope === "platform" ||
		record.scope === "mod" ||
		record.scope === "user" ||
		record.scope === "project";
	return (
		typeof record.name === "string" &&
		typeof record.description === "string" &&
		validScope &&
		(record.scope === "mod"
			? isModSkillSource(record.source)
			: record.source === undefined)
	);
}

export function readCachedSkills(spaceId: string) {
	if (typeof localStorage === "undefined") return null;
	try {
		const raw = localStorage.getItem(getCacheKey(spaceId));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const record = parsed as Record<string, unknown>;
		if (record.version !== CACHE_VERSION || !Array.isArray(record.skills)) {
			return null;
		}
		if (!record.skills.every(isSkillCatalogEntry)) return null;
		return record.skills;
	} catch {
		return null;
	}
}

export function writeCachedSkills(
	spaceId: string,
	skills: SkillCatalogEntry[],
) {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(
			getCacheKey(spaceId),
			JSON.stringify({ version: CACHE_VERSION, skills }),
		);
	} catch {
		// Cache writes are best-effort and should never block workspace boot.
	}
}
