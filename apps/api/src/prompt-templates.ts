import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createCachedPromptTemplatesConfig,
  getModPromptsRedisKey,
  getSpaceModPromptsRedisKey,
  getUserPromptsRedisKey,
  mergePromptTemplatesConfigs,
  parseCachedPromptTemplatesConfig,
  PLATFORM_PROMPTS_REDIS_KEY,
  PROMPTS_CACHE_TTL_SEC,
  type CachedPromptTemplatesConfig,
  type PromptTemplate,
  type PromptTemplateCatalogEntry,
  type PromptTemplatesConfig,
  type PromptTemplateScope,
} from "@cohub/infra/config-runtime/prompts";
import { getSpaceModMountSignature, listEnabledSpaceMods } from "@cohub/core/space-mods";
import { config } from "./config.js";
import { db } from "./db/index.js";
import { redisCommandClient } from "./redis.js";
import { resolveStoredPrincipalReadKeys } from "./identity-bridge.js";

export type { PromptTemplateCatalogEntry } from "@cohub/infra/config-runtime/prompts";

export type ExpandedPromptTemplate = {
  renderedText: string;
  template: PromptTemplateCatalogEntry;
  args: string[];
  rawInput: string;
};

export type LoadPromptTemplatesOptions = {
  userId?: string | null;
  spaceId?: string | null;
};

const PROMPTS_DIR = ".agents/prompts";
const CHECKPOINT_META_PATH = ".cohub/system/checkpoint-meta.v1.json";
const PROJECT_PROMPTS_CACHE_KEY_PREFIX = "configs:prompts:v1:project";

const inflightByCacheKey = new Map<string, Promise<PromptTemplatesConfig | null>>();

function getPlatformPromptsDir() {
  return join(config.platformConfigRoot, "platform", PROMPTS_DIR);
}

function getUserPromptsDir(userId: string) {
  return join(config.platformConfigRoot, "users", userId, PROMPTS_DIR);
}

function getProjectPromptsDir(spaceId: string) {
  return resolve(config.spaceStorageRoot, spaceId, "workspace", PROMPTS_DIR);
}

function getModLatestDir(modSpaceId: string) {
  return resolve(config.checkpointCacheRoot, modSpaceId, "latest");
}

function getModPromptsDir(modSpaceId: string) {
  return resolve(getModLatestDir(modSpaceId), PROMPTS_DIR);
}

function getProjectPromptsRedisKey(spaceId: string) {
  return `${PROJECT_PROMPTS_CACHE_KEY_PREFIX}:${spaceId}`;
}

async function getDirectoryRevision(dir: string): Promise<string> {
  for (const path of [join(dir, CHECKPOINT_META_PATH), dir]) {
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

function parseFrontmatter(markdown: string): {
  attributes: Record<string, string>;
  body: string;
} {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { attributes: {}, body: markdown };

  const attributes: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) attributes[key] = value;
  }

  return {
    attributes,
    body: markdown.slice(match[0].length),
  };
}

function parseTemplateFromText(raw: string, filePath: string, scope: PromptTemplateScope): PromptTemplate {
  const { attributes, body } = parseFrontmatter(raw);
  const fileName = filePath.split(/[/\\]/).at(-1) ?? "";
  const name = fileName.replace(/\.md$/i, "");

  let description = attributes.description?.trim() ?? "";
  if (!description) {
    const firstLine = body.split("\n").find((line) => line.trim());
    description = firstLine?.trim().slice(0, 80) ?? name;
  }

  return {
    name,
    description,
    argumentHint: attributes["argument-hint"]?.trim() || undefined,
    category: attributes.category?.trim() || undefined,
    content: body,
    filePath,
    scope,
  };
}

async function readPromptsConfigFromDir(dir: string, scope: PromptTemplateScope): Promise<{ rawText: string; content: PromptTemplatesConfig }> {
  const entries = await readdir(dir);
  const templates: PromptTemplate[] = [];
  const rawParts: string[] = [];

  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    const rawText = await readFile(path, "utf-8");
    rawParts.push(`${entry}\n${rawText}`);
    templates.push(parseTemplateFromText(rawText, path, scope));
  }

  templates.sort((a, b) => a.name.localeCompare(b.name));
  return { rawText: rawParts.join("\n---\n"), content: { templates } };
}

async function loadPromptsFromDir(input: {
  dir: string;
  redisKey: string;
  scope: PromptTemplateScope;
  allowMissing: boolean;
}): Promise<CachedPromptTemplatesConfig> {
  try {
    const { rawText, content } = await readPromptsConfigFromDir(input.dir, input.scope);
    const cached = createCachedPromptTemplatesConfig({ rawText, content });
    await redisCommandClient.set(input.redisKey, JSON.stringify(cached), "EX", PROMPTS_CACHE_TTL_SEC).catch(() => undefined);
    return cached;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
    if (code !== "ENOENT" || !input.allowMissing) throw error;
    const cached = createCachedPromptTemplatesConfig({ rawText: "", content: { templates: [] } });
    await redisCommandClient.set(input.redisKey, JSON.stringify(cached), "EX", PROMPTS_CACHE_TTL_SEC).catch(() => undefined);
    return cached;
  }
}

async function loadCachedPrompts(input: {
  redisKey: string;
  dir: string;
  scope: PromptTemplateScope;
  allowMissing: boolean;
}): Promise<PromptTemplatesConfig | null> {
  const inflight = inflightByCacheKey.get(input.redisKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const cached = await redisCommandClient.get(input.redisKey).catch(() => null);
    if (cached) {
      const parsed = parseCachedPromptTemplatesConfig(cached);
      if (parsed) return parsed.content;
    }
    return (await loadPromptsFromDir(input)).content;
  })();

  inflightByCacheKey.set(input.redisKey, promise);
  try {
    return await promise;
  } finally {
    inflightByCacheKey.delete(input.redisKey);
  }
}

async function loadSpaceModPrompts(spaceId: string): Promise<PromptTemplatesConfig | null> {
  const mods = await listEnabledSpaceMods(db, spaceId);
  if (mods.length === 0) return null;

  const signature = getSpaceModMountSignature(mods);
  const sources = await Promise.all(mods.map(async (mod) => ({
    mod,
    promptsDir: getModPromptsDir(mod.modSpaceId),
    revision: await getDirectoryRevision(getModLatestDir(mod.modSpaceId)),
  })));
  const aggregateKey = getSpaceModPromptsRedisKey(
    spaceId,
    JSON.stringify({ signature, revisions: sources.map((source) => [source.mod.modSpaceId, source.revision]) }),
  );

  const cached = await redisCommandClient.get(aggregateKey).catch(() => null);
  if (cached) {
    const parsed = parseCachedPromptTemplatesConfig(cached);
    if (parsed) return parsed.content;
  }

  const configs = await Promise.all(sources.map((source) => loadCachedPrompts({
    redisKey: getModPromptsRedisKey(source.mod.modSpaceId, source.revision),
    dir: source.promptsDir,
    scope: "mod",
    allowMissing: true,
  })));
  const content = mergePromptTemplatesConfigs(...configs);
  const aggregate = createCachedPromptTemplatesConfig({ rawText: aggregateKey, content });
  await redisCommandClient.set(aggregateKey, JSON.stringify(aggregate), "EX", PROMPTS_CACHE_TTL_SEC).catch(() => undefined);
  return content;
}

async function fetchPromptTemplates(options: LoadPromptTemplatesOptions): Promise<PromptTemplate[]> {
  const platformPrompts = await loadCachedPrompts({
    redisKey: PLATFORM_PROMPTS_REDIS_KEY,
    dir: getPlatformPromptsDir(),
    scope: "platform",
    allowMissing: true,
  });

  const configs: Array<PromptTemplatesConfig | null> = [platformPrompts];

  if (options.spaceId) {
    configs.push(await loadSpaceModPrompts(options.spaceId));
  }

  if (options.userId) {
    const userId = options.userId.trim();
    const userIds = await resolveStoredPrincipalReadKeys(userId);
    configs.push(...await Promise.all(userIds.map((userId) => loadCachedPrompts({
      redisKey: getUserPromptsRedisKey(userId),
      dir: getUserPromptsDir(userId),
      scope: "user",
      allowMissing: true,
    }))));
  }

  if (options.spaceId && config.spaceStorageRoot) {
    configs.push(await loadCachedPrompts({
      redisKey: getProjectPromptsRedisKey(options.spaceId),
      dir: getProjectPromptsDir(options.spaceId),
      scope: "project",
      allowMissing: true,
    }));
  }

  return mergePromptTemplatesConfigs(...configs).templates;
}

function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;

  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i];

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inQuote = char;
      continue;
    }

    if (char === " " || char === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) args.push(current);
  return args;
}

function substituteArgs(content: string, args: string[]): string {
  let result = content;

  result = result.replace(/\$(\d+)/g, (_, num) => {
    const index = Number.parseInt(num, 10) - 1;
    return args[index] ?? "";
  });

  result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
    let start = Number.parseInt(startStr, 10) - 1;
    if (start < 0) start = 0;
    if (lengthStr) {
      const length = Number.parseInt(lengthStr, 10);
      return args.slice(start, start + length).join(" ");
    }
    return args.slice(start).join(" ");
  });

  const allArgs = args.join(" ");
  result = result.replace(/\$ARGUMENTS/g, allArgs);
  result = result.replace(/\$@/g, allArgs);
  return result;
}

export async function listPromptTemplates(options: LoadPromptTemplatesOptions = {}): Promise<PromptTemplateCatalogEntry[]> {
  const templates = await fetchPromptTemplates(options);
  return templates.map((template) => ({
    name: template.name,
    description: template.description,
    argumentHint: template.argumentHint,
    category: template.category,
    scope: template.scope,
  }));
}

export async function expandPromptTemplate(text: string, options: LoadPromptTemplatesOptions = {}): Promise<ExpandedPromptTemplate | null> {
  if (!text.startsWith("/") || text.startsWith("/skill:")) return null;

  const spaceIndex = text.indexOf(" ");
  const templateName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);
  const template = (await fetchPromptTemplates(options)).find((item) => item.name === templateName);
  if (!template) return null;

  const args = parseCommandArgs(argsString);
  return {
    renderedText: substituteArgs(template.content, args),
    template: {
      name: template.name,
      description: template.description,
      argumentHint: template.argumentHint,
      category: template.category,
      scope: template.scope,
    },
    args,
    rawInput: text,
  };
}
