import {
  bindModSkillsConfig,
  bindSpaceModSkillsConfig,
  createCachedSkillsConfig,
  formatSkillExpansion,
  getDirectoryRevision,
  getModSkillsRedisKey,
  getProjectSkillsRedisKey,
  getSpaceModSkillsRedisKey,
  getUserSkillsRedisKey,
  isValidSkillName,
  loadSkillsFromDirectory,
  mergeSkillsConfigs,
  parseCachedSkillsConfig,
  PLATFORM_SKILLS_REDIS_KEY,
  SKILLS_CACHE_TTL_SEC,
  type CachedSkillsConfig,
  type Skill,
  type SkillCatalogEntry,
  type ModSkillBinding,
  type SkillsConfig,
  type SkillScope,
} from "@cohub/infra/config-runtime/skills";
import { getSpaceModMountSignature, listEnabledSpaceMods } from "@cohub/core/space-mods";
import { createLogger } from "@cohub/infra/logging";
import { join, resolve } from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";
import { redisCommandClient } from "./redis.js";

const logger = createLogger({ serviceName: "cohub-worker" });

export type { SkillCatalogEntry } from "@cohub/infra/config-runtime/skills";

export type ExpandedSkill = {
  renderedText: string;
  skill: SkillCatalogEntry & {
    sandboxFilePath: string;
    sandboxBaseDir: string;
  };
  argsText: string;
  rawInput: string;
};

export type LoadSkillsOptions = {
  userId?: string | null;
  spaceId?: string | null;
};

const SKILLS_DIR = ".agents/skills";
const CHECKPOINT_META_PATH = ".cohub/system/checkpoint-meta.v1.json";
const SANDBOX_PLATFORM_SKILLS_PATH = "/configs/platform/.agents/skills";
const SANDBOX_USER_SKILLS_PATH = "/configs/user/.agents/skills";
const SANDBOX_WORKSPACE_SKILLS_PATH = "/workspace/.agents/skills";

const inflightByCacheKey = new Map<string, Promise<SkillsConfig | null>>();

function getPlatformSkillsDir() {
  return join(config.platformConfigRoot, "platform", SKILLS_DIR);
}

function getUserSkillsDir(userId: string) {
  return join(config.platformConfigRoot, "users", userId, SKILLS_DIR);
}

function getProjectSkillsDir(spaceId: string) {
  return resolve(config.spaceStorageRoot, spaceId, "workspace", SKILLS_DIR);
}

function getModLatestDir(modSpaceId: string) {
  return resolve(config.checkpointCacheRoot, modSpaceId, "latest");
}

function getModSkillsDir(modSpaceId: string) {
  return resolve(getModLatestDir(modSpaceId), SKILLS_DIR);
}

async function loadSkillsFromDir(input: {
  dir: string;
  sandboxDir: string;
  redisKey: string;
  scope: SkillScope;
  allowMissing: boolean;
}): Promise<CachedSkillsConfig> {
  try {
    const { rawText, content } = await loadSkillsFromDirectory(input);
    const cached = createCachedSkillsConfig({ rawText, content });
    await redisCommandClient.set(input.redisKey, JSON.stringify(cached), "EX", SKILLS_CACHE_TTL_SEC).catch(() => undefined);
    return cached;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
    if (code !== "ENOENT" || !input.allowMissing) throw error;
    const cached = createCachedSkillsConfig({ rawText: "", content: { skills: [] } });
    await redisCommandClient.set(input.redisKey, JSON.stringify(cached), "EX", SKILLS_CACHE_TTL_SEC).catch(() => undefined);
    return cached;
  }
}

async function loadCachedSkills(input: {
  redisKey: string;
  dir: string;
  sandboxDir: string;
  scope: SkillScope;
  allowMissing: boolean;
}): Promise<SkillsConfig | null> {
  const inflight = inflightByCacheKey.get(input.redisKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const cached = await redisCommandClient.get(input.redisKey).catch(() => null);
    if (cached) {
      const parsed = parseCachedSkillsConfig(cached);
      if (parsed) return parsed.content;
    }
    return (await loadSkillsFromDir(input)).content;
  })();

  inflightByCacheKey.set(input.redisKey, promise);
  try {
    return await promise;
  } finally {
    inflightByCacheKey.delete(input.redisKey);
  }
}

type SpaceModSkillSource = ModSkillBinding & {
  revision: string;
};

function getModSkillsLoadInput(source: SpaceModSkillSource) {
  return {
    redisKey: getModSkillsRedisKey(source.modSpaceId, source.revision),
    dir: source.skillsDir,
    sandboxDir: source.sandboxDir,
    scope: "mod" as const,
    allowMissing: true,
  };
}

async function loadBoundModSkills(spaceId: string, source: SpaceModSkillSource): Promise<{
  config: SkillsConfig | null;
  cacheable: boolean;
}> {
  const loadInput = getModSkillsLoadInput(source);
  try {
    const cached = await loadCachedSkills(loadInput);
    if (!cached) return { config: null, cacheable: true };
    try {
      return { config: bindModSkillsConfig(cached, source), cacheable: true };
    } catch (error) {
      logger.warn("[skills] invalid Mod skill cache; reloading from disk", {
        spaceId,
        modSpaceId: source.modSpaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      await redisCommandClient.del(loadInput.redisKey).catch(() => undefined);
      const refreshed = (await loadSkillsFromDir(loadInput)).content;
      return { config: refreshed ? bindModSkillsConfig(refreshed, source) : null, cacheable: true };
    }
  } catch (error) {
    await redisCommandClient.del(loadInput.redisKey).catch(() => undefined);
    logger.warn("[skills] failed to load Mod skills; skipping source", {
      spaceId,
      modSpaceId: source.modSpaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { config: null, cacheable: false };
  }
}

async function loadSpaceModSkills(spaceId: string): Promise<SkillsConfig | null> {
  const mods = await listEnabledSpaceMods(db, spaceId);
  if (mods.length === 0) return null;

  const signature = getSpaceModMountSignature(mods);
  const sources: SpaceModSkillSource[] = await Promise.all(mods.map(async (mod) => {
    const latestDir = getModLatestDir(mod.modSpaceId);
    return {
      skillsDir: getModSkillsDir(mod.modSpaceId),
      sandboxDir: `${mod.mountPath}/.agents/skills`,
      modSpaceId: mod.modSpaceId,
      mountSlug: mod.mountSlug,
      revision: await getDirectoryRevision(latestDir, join(latestDir, CHECKPOINT_META_PATH)),
    };
  }));
  const aggregateKey = getSpaceModSkillsRedisKey(
    spaceId,
    JSON.stringify({ signature, revisions: sources.map((source) => [source.modSpaceId, source.revision]) }),
  );

  const cached = await redisCommandClient.get(aggregateKey).catch(() => null);
  if (cached) {
    const parsed = parseCachedSkillsConfig(cached);
    if (parsed?.content) {
      try {
        return bindSpaceModSkillsConfig(parsed.content, sources);
      } catch (error) {
        logger.warn("[skills] invalid aggregate Mod skill cache; rebuilding", {
          spaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await redisCommandClient.del(aggregateKey).catch(() => undefined);
  }

  const results = await Promise.all(sources.map((source) => loadBoundModSkills(spaceId, source)));
  const content = mergeSkillsConfigs(...results.map((result) => result.config));
  if (results.every((result) => result.cacheable)) {
    const aggregate = createCachedSkillsConfig({ rawText: aggregateKey, content });
    await redisCommandClient.set(aggregateKey, JSON.stringify(aggregate), "EX", SKILLS_CACHE_TTL_SEC).catch(() => undefined);
  }
  return content;
}

async function fetchSkills(options: LoadSkillsOptions): Promise<Skill[]> {
  const platformSkills = await loadCachedSkills({
    redisKey: PLATFORM_SKILLS_REDIS_KEY,
    dir: getPlatformSkillsDir(),
    sandboxDir: SANDBOX_PLATFORM_SKILLS_PATH,
    scope: "platform",
    allowMissing: true,
  });

  const configs: Array<SkillsConfig | null> = [platformSkills];

  if (options.spaceId) {
    configs.push(await loadSpaceModSkills(options.spaceId));
  }

  if (options.userId) {
    configs.push(await loadCachedSkills({
      redisKey: getUserSkillsRedisKey(options.userId),
      dir: getUserSkillsDir(options.userId),
      sandboxDir: SANDBOX_USER_SKILLS_PATH,
      scope: "user",
      allowMissing: true,
    }));
  }

  if (options.spaceId && config.spaceStorageRoot) {
    const projectDir = getProjectSkillsDir(options.spaceId);
    const revision = await getDirectoryRevision(projectDir, join(projectDir, CHECKPOINT_META_PATH));
    configs.push(await loadCachedSkills({
      redisKey: getProjectSkillsRedisKey(options.spaceId, revision),
      dir: projectDir,
      sandboxDir: SANDBOX_WORKSPACE_SKILLS_PATH,
      scope: "project",
      allowMissing: true,
    }));
  }

  return mergeSkillsConfigs(...configs).skills;
}

export async function expandSkillCommand(text: string, options: LoadSkillsOptions = {}): Promise<ExpandedSkill | null> {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/skill:")) return null;

  const rest = trimmed.slice("/skill:".length);
  const spaceIndex = rest.search(/\s/);
  const skillName = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex);
  const argsText = spaceIndex === -1 ? "" : rest.slice(spaceIndex + 1).trim();
  if (!skillName) return null;
  if (!isValidSkillName(skillName)) {
    throw new Error(`Unknown skill: ${skillName}`);
  }

  const skill = (await fetchSkills(options)).find((item) => item.name === skillName);
  if (!skill) {
    throw new Error(`Unknown skill: ${skillName}`);
  }

  return {
    renderedText: formatSkillExpansion({
      name: skill.name,
      sandboxFilePath: skill.sandboxFilePath,
      sandboxBaseDir: skill.sandboxBaseDir,
      content: skill.content,
      argsText,
    }),
    skill: {
      name: skill.name,
      description: skill.description,
      scope: skill.scope,
      source: skill.source,
      sandboxFilePath: skill.sandboxFilePath,
      sandboxBaseDir: skill.sandboxBaseDir,
    },
    argsText,
    rawInput: text,
  };
}

export type SkillService = {
  expand: typeof expandSkillCommand;
};

let service: SkillService | null = null;
export function getSkillService(): SkillService {
  service ??= { expand: expandSkillCommand };
  return service;
}
