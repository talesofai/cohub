import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { createLogger } from "../logging/index.js";

const logger = createLogger({ serviceName: "cohub-skills" });

export const SKILLS_REDIS_KEY_VERSION = "v3";
export const PLATFORM_SKILLS_REDIS_KEY = `configs:skills:${SKILLS_REDIS_KEY_VERSION}:platform`;
export const USER_SKILLS_REDIS_KEY_PREFIX = `configs:skills:${SKILLS_REDIS_KEY_VERSION}:user`;
export const PROJECT_SKILLS_REDIS_KEY_PREFIX = `configs:skills:${SKILLS_REDIS_KEY_VERSION}:project`;
export const MOD_SKILLS_REDIS_KEY_PREFIX = `configs:skills:${SKILLS_REDIS_KEY_VERSION}:mod`;
export const SPACE_MOD_SKILLS_REDIS_KEY_PREFIX = `configs:skills:${SKILLS_REDIS_KEY_VERSION}:space-mods`;
export const SKILLS_CACHE_TTL_SEC = 24 * 60 * 60;
export const MAX_SKILL_CONTENT_CHARS = 100_000;
export const SKILL_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const SAFE_REDIS_KEY_SEGMENT_REGEX = /^[0-9a-zA-Z_-]+$/;

export type SkillScope = "platform" | "mod" | "user" | "project";

export type SkillCatalogSource = {
  type: "mod";
  modSpaceId: string;
  mountSlug: string;
};

export type ModSkillBinding = {
  skillsDir: string;
  sandboxDir: string;
  modSpaceId: string;
  mountSlug: string;
};

export type Skill = {
  name: string;
  description: string;
  content: string;
  filePath: string;
  sandboxFilePath: string;
  baseDir: string;
  sandboxBaseDir: string;
  scope: SkillScope;
  source?: SkillCatalogSource;
  /** When true, the skill is hidden from the model's system prompt and can only be invoked explicitly via `/skill:name`. */
  disableModelInvocation: boolean;
};

export type SkillCatalogEntry = {
  name: string;
  description: string;
  scope: SkillScope;
  source?: SkillCatalogSource;
};

export type SkillsConfig = {
  skills: Skill[];
};

export type CachedSkillsConfig = {
  rev: string;
  updatedAt: string;
  sourceCheckpointId?: string | null;
  content: SkillsConfig | null;
};

export function assertSafeRedisKeySegment(value: string, label = "value"): string {
  const trimmed = value.trim();
  if (!SAFE_REDIS_KEY_SEGMENT_REGEX.test(trimmed)) {
    throw new Error(`Invalid ${label} for Redis key`);
  }
  return trimmed;
}

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_REGEX.test(name);
}

function createFastContentHash(rawText: string): string {
  let hash = 2166136261;
  for (let i = 0; i < rawText.length; i++) {
    hash ^= rawText.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16)}:${rawText.length}`;
}

export function getUserSkillsRedisKey(userId: string): string {
  return `${USER_SKILLS_REDIS_KEY_PREFIX}:${assertSafeRedisKeySegment(userId, "userId")}`;
}

export function getProjectSkillsRedisKey(spaceId: string, revision: string): string {
  return `${PROJECT_SKILLS_REDIS_KEY_PREFIX}:${assertSafeRedisKeySegment(spaceId, "spaceId")}:${createFastContentHash(revision)}`;
}

export function getModSkillsRedisKey(modSpaceId: string, revision: string): string {
  return `${MOD_SKILLS_REDIS_KEY_PREFIX}:${assertSafeRedisKeySegment(modSpaceId, "modSpaceId")}:${createFastContentHash(revision)}`;
}

export function getSpaceModSkillsRedisKey(spaceId: string, fingerprint: string): string {
  return `${SPACE_MOD_SKILLS_REDIS_KEY_PREFIX}:${assertSafeRedisKeySegment(spaceId, "spaceId")}:${createFastContentHash(fingerprint)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isSkillCatalogSource(value: unknown): value is SkillCatalogSource {
  return isRecord(value)
    && value.type === "mod"
    && typeof value.modSpaceId === "string"
    && typeof value.mountSlug === "string";
}

export function isSkill(value: unknown): value is Skill {
  if (!isRecord(value)) return false;
  if (value.scope !== "platform" && value.scope !== "mod" && value.scope !== "user" && value.scope !== "project") return false;
  return typeof value.name === "string"
    && typeof value.description === "string"
    && typeof value.content === "string"
    && typeof value.filePath === "string"
    && typeof value.sandboxFilePath === "string"
    && typeof value.baseDir === "string"
    && typeof value.sandboxBaseDir === "string"
    && (value.source === undefined || isSkillCatalogSource(value.source))
    && typeof value.disableModelInvocation === "boolean";
}

export function isSkillsConfig(value: unknown): value is SkillsConfig {
  if (!isRecord(value) || !Array.isArray(value.skills)) return false;
  return value.skills.every(isSkill);
}

export function createCachedSkillsConfig(input: {
  rawText?: string;
  content: SkillsConfig | null;
  sourceCheckpointId?: string | null;
  rev?: string;
  updatedAt?: string;
}): CachedSkillsConfig {
  return {
    rev: input.rev ?? (input.rawText !== undefined ? createFastContentHash(input.rawText) : `missing:${input.sourceCheckpointId ?? "unknown"}`),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    sourceCheckpointId: input.sourceCheckpointId ?? null,
    content: input.content,
  };
}

export function parseCachedSkillsConfig(rawText: string): CachedSkillsConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const content = parsed.content;
  if (content !== null && !isSkillsConfig(content)) return null;
  return {
    rev: typeof parsed.rev === "string" ? parsed.rev : "unknown",
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    sourceCheckpointId: typeof parsed.sourceCheckpointId === "string" ? parsed.sourceCheckpointId : null,
    content,
  };
}

export function mergeSkillsConfigs(...configs: Array<SkillsConfig | null | undefined>): SkillsConfig {
  const skills = new Map<string, Skill>();
  for (const config of configs) {
    for (const skill of config?.skills ?? []) {
      skills.set(skill.name, skill);
    }
  }
  return { skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

function isSafeSkillChildPath(value: string): boolean {
  if (!value || value.startsWith("/")) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function getSandboxChildPath(rootDir: string, targetPath: string, sandboxDir: string): string {
  const relativePath = relative(rootDir, targetPath).replaceAll("\\", "/");
  if (isSafeSkillChildPath(relativePath)) return `${sandboxDir}/${relativePath}`;

  const normalizedPath = targetPath.replaceAll("\\", "/");
  const skillsMarker = "/.agents/skills/";
  const markerIndex = normalizedPath.lastIndexOf(skillsMarker);
  const cachedRelativePath = markerIndex === -1
    ? ""
    : normalizedPath.slice(markerIndex + skillsMarker.length);
  if (!isSafeSkillChildPath(cachedRelativePath)) {
    throw new Error(`Skill path is outside its source directory: ${targetPath}`);
  }
  return `${sandboxDir}/${cachedRelativePath}`;
}

export function bindModSkillsConfig(
  config: SkillsConfig,
  input: ModSkillBinding,
): SkillsConfig {
  const source: SkillCatalogSource = {
    type: "mod",
    modSpaceId: input.modSpaceId,
    mountSlug: input.mountSlug,
  };
  return {
    skills: config.skills.map((skill) => ({
      ...skill,
      sandboxFilePath: getSandboxChildPath(input.skillsDir, skill.filePath, input.sandboxDir),
      sandboxBaseDir: getSandboxChildPath(input.skillsDir, skill.baseDir, input.sandboxDir),
      scope: "mod",
      source,
    })),
  };
}

function getModSkillBindingKey(source: Pick<SkillCatalogSource, "modSpaceId" | "mountSlug">): string {
  return `${source.modSpaceId}\0${source.mountSlug}`;
}

export function bindSpaceModSkillsConfig(config: SkillsConfig, bindings: ModSkillBinding[]): SkillsConfig {
  const bindingsBySource = new Map(bindings.map((binding) => [getModSkillBindingKey(binding), binding]));
  return {
    skills: config.skills.map((skill) => {
      if (skill.scope !== "mod" || !skill.source) {
        throw new Error(`Cached Mod skill is missing source metadata: ${skill.name}`);
      }
      const binding = bindingsBySource.get(getModSkillBindingKey(skill.source));
      if (!binding) {
        throw new Error(`Cached Mod skill has an unknown source: ${skill.name}`);
      }
      const [bound] = bindModSkillsConfig({ skills: [skill] }, binding).skills;
      if (!bound) throw new Error(`Failed to bind cached Mod skill: ${skill.name}`);
      return bound;
    }),
  };
}

export function toSkillCatalog(skills: Skill[]): SkillCatalogEntry[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    ...(skill.source ? { source: skill.source } : {}),
  }));
}

export function stripSkillFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? markdown.slice(match[0].length) : markdown;
}

export function escapeXmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ");
}

export function formatSkillExpansion(input: {
  name: string;
  sandboxFilePath: string;
  sandboxBaseDir: string;
  content: string;
  argsText?: string;
}): string {
  if (!isValidSkillName(input.name)) {
    throw new Error(`Invalid skill name: ${input.name}`);
  }
  const body = stripSkillFrontmatter(input.content).trim().slice(0, MAX_SKILL_CONTENT_CHARS);
  const block = [
    `<skill name="${escapeXmlAttr(input.name)}" location="${escapeXmlAttr(input.sandboxFilePath)}">`,
    `References are relative to ${input.sandboxBaseDir}.`,
    "",
    body,
    "</skill>",
  ].join("\n");
  const argsText = input.argsText?.trim() ?? "";
  return argsText ? `${block}\n\n${argsText}` : block;
}

export function parseSkillFrontmatter(markdown: string): {
  attributes: Record<string, string>;
  body: string;
} {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { attributes: {}, body: markdown };

  const attributes: Record<string, string> = {};
  const lines = (match[1] ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (key && (value === ">" || value === "|")) {
      const blockType = value as ">" | "|";
      const parts: string[] = [];
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        if (nextLine === undefined) break;
        if (nextLine.length === 0 || nextLine[0] !== " ") break;
        i++;
        parts.push(nextLine.trim());
      }
      if (parts.length > 0) {
        value = blockType === ">" ? parts.join(" ") : parts.join("\n");
      }
    }
    if (key) attributes[key] = value;
  }

  return {
    attributes,
    body: markdown.slice(match[0].length),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a frontmatter value as a YAML 1.2 core-schema boolean.
 * Accepts `true`/`True`/`TRUE` (case-insensitive), tolerates trailing inline
 * comments (`true # note`) and surrounding quotes. Anything else is false.
 */
function parseFrontmatterBoolean(value: string | undefined): boolean {
  if (value === undefined) return false;
  const withoutComment = value.replace(/\s+#.*$/, "").trim();
  const unquoted = withoutComment.replace(/^["']|["']$/g, "").trim();
  return unquoted.toLowerCase() === "true";
}

export async function loadSkillsFromDirectory(input: {
  dir: string;
  sandboxDir: string;
  scope: SkillScope;
  maxContentChars?: number;
}): Promise<{ rawText: string; content: SkillsConfig }> {
  if (!(await pathExists(input.dir))) {
    return { rawText: "", content: { skills: [] } };
  }

  const maxContentChars = input.maxContentChars ?? MAX_SKILL_CONTENT_CHARS;
  const skills: Skill[] = [];
  const rawParts: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    for (const name of entries.sort()) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      let stats: Awaited<ReturnType<typeof stat>>;
      try {
        stats = await stat(full);
      } catch {
        continue;
      }
      if (!stats.isDirectory()) continue;

      const skillFile = join(full, "SKILL.md");
      try {
        const rawText = (await readFile(skillFile, "utf-8")).slice(0, maxContentChars);
        const { attributes, body } = parseSkillFrontmatter(rawText);
        const relativePath = skillFile.slice(input.dir.length + 1).replaceAll("\\", "/");
        const relativeDir = full.slice(input.dir.length + 1).replaceAll("\\", "/");
        const skillName = attributes.name?.trim() || basename(full);
        if (!isValidSkillName(skillName)) continue;
        const description = attributes.description?.trim()
          || body.split("\n").find((line) => line.trim())?.trim().slice(0, 80)
          || skillName;
        rawParts.push(`${relativePath}\n${rawText}`);
        skills.push({
          name: skillName,
          description,
          content: rawText,
          filePath: skillFile,
          sandboxFilePath: `${input.sandboxDir}/${relativePath}`,
          baseDir: full,
          sandboxBaseDir: `${input.sandboxDir}/${relativeDir}`,
          scope: input.scope,
          disableModelInvocation: parseFrontmatterBoolean(attributes["disable-model-invocation"]),
        });
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined;
        // Missing SKILL.md means this is not a skill root; recurse into subdirectories.
        if (code === "ENOENT") {
          await walk(full);
          continue;
        }
        // Any other failure (permissions, I/O, parse) isolates to this skill: log and skip
        // so one broken optional skill never aborts the whole prompt build.
        logger.warn("failed to load skill", { skillFile, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  await walk(input.dir);
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { rawText: rawParts.join("\n---\n"), content: { skills } };
}

export async function getDirectoryRevision(dir: string, checkpointMetaPath?: string): Promise<string> {
  const candidates = checkpointMetaPath ? [checkpointMetaPath, dir] : [dir];
  for (const path of candidates) {
    try {
      const stats = await stat(path);
      return `${path}:${Math.trunc(stats.mtimeMs)}:${stats.size}`;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
      if (code !== "ENOENT") throw error;
    }
  }
  return `${dir}:missing`;
}
