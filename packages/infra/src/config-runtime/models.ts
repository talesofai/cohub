export const MODELS_REDIS_KEY_VERSION = "v2";
export const PLATFORM_MODELS_REDIS_KEY = `configs:models:${MODELS_REDIS_KEY_VERSION}:platform`;
export const USER_MODELS_REDIS_KEY_PREFIX = `configs:models:${MODELS_REDIS_KEY_VERSION}:user`;
export const MODELS_CACHE_TTL_SEC = 24 * 60 * 60;
export const CODEX_ORIGINATOR = "codex_cli_rs";
export const GPT_RESPONSES_USER_AGENT = "codex_cli_rs/0.144.0";

const SAFE_REDIS_KEY_SEGMENT_REGEX = /^[0-9a-zA-Z_-]+$/;

export type ModelCost = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

export type ModelDef = {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  defaultThinkingLevel?: ModelThinkingLevel;
  thinkingLevelMap?: ThinkingLevelMap;
  /** Hide this model from UI pickers while keeping it available for runtime use. */
  hidden?: boolean;
  input?: Array<"text" | "image">;
  cost?: ModelCost;
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: unknown;
  [key: string]: unknown;
};

export type ProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  compat?: unknown;
  models?: ModelDef[];
  [key: string]: unknown;
};

export type ModelsConfig = {
  providers: Record<string, ProviderConfig>;
};

export type CachedModelsConfig = {
  rev: string;
  updatedAt: string;
  sourceCheckpointId?: string | null;
  content: ModelsConfig | null;
};

export function isGptResponsesModel(
  model: Pick<ModelDef, "api" | "id"> | undefined,
): boolean {
  return model?.api === "openai-responses" && model.id.toLowerCase().startsWith("gpt-");
}

function hasConfiguredHeader(
  headers: Record<string, string> | undefined,
  expectedName: string,
): boolean {
  const expected = expectedName.toLowerCase();
  return Object.keys(headers ?? {}).some((name) => name.toLowerCase() === expected);
}

export function resolveModelRequestHeaders(
  model: Pick<ModelDef, "api" | "id"> | undefined,
  configuredHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!isGptResponsesModel(model)) {
    return configuredHeaders;
  }

  let headers = configuredHeaders;
  if (!hasConfiguredHeader(headers, "User-Agent")) {
    headers = { ...(headers ?? {}), "User-Agent": GPT_RESPONSES_USER_AGENT };
  }
  if (!hasConfiguredHeader(headers, "Originator")) {
    headers = { ...(headers ?? {}), Originator: CODEX_ORIGINATOR };
  }

  return headers;
}

export type ModelCatalogEntry = {
  provider: string;
  id: string;
  model: Record<string, unknown>;
};

export function assertSafeRedisKeySegment(value: string, label = "value"): string {
  const trimmed = value.trim();
  if (!SAFE_REDIS_KEY_SEGMENT_REGEX.test(trimmed)) {
    throw new Error(`Invalid ${label} for Redis key`);
  }
  return trimmed;
}

export function getUserModelsRedisKey(userId: string): string {
  return `${USER_MODELS_REDIS_KEY_PREFIX}:${assertSafeRedisKeySegment(userId, "userId")}`;
}

export function isModelsConfig(value: unknown): value is ModelsConfig {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return !!record.providers && typeof record.providers === "object";
}

export function parseModelsConfig(rawText: string): ModelsConfig {
  const parsed = JSON.parse(rawText) as unknown;
  if (!isModelsConfig(parsed)) {
    throw new Error("Models catalog file has invalid schema: missing providers object");
  }
  return parsed;
}

function createFastContentHash(rawText: string): string {
  let hash = 2166136261;
  for (let i = 0; i < rawText.length; i++) {
    hash ^= rawText.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16)}:${rawText.length}`;
}

export function createCachedModelsConfig(input: {
  rawText?: string;
  content: ModelsConfig | null;
  sourceCheckpointId?: string | null;
  rev?: string;
  updatedAt?: string;
}): CachedModelsConfig {
  return {
    rev: input.rev ?? (input.rawText ? createFastContentHash(input.rawText) : `missing:${input.sourceCheckpointId ?? "unknown"}`),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    sourceCheckpointId: input.sourceCheckpointId ?? null,
    content: input.content,
  };
}

export function parseCachedModelsConfig(rawText: string): CachedModelsConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const content = record.content;
  if (content !== null && !isModelsConfig(content)) return null;
  return {
    rev: typeof record.rev === "string" ? record.rev : "unknown",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
    sourceCheckpointId: typeof record.sourceCheckpointId === "string" ? record.sourceCheckpointId : null,
    content,
  };
}

export function mergeModelsConfigs(...configs: Array<ModelsConfig | null | undefined>): ModelsConfig {
  const providers: Record<string, ProviderConfig> = {};

  for (const config of configs) {
    if (!config) continue;
    for (const [provider, providerConfig] of Object.entries(config.providers ?? {})) {
      const existing = providers[provider] ?? {};
      const mergedModels = new Map<string, ModelDef>();

      for (const model of existing.models ?? []) {
        if (model.id) mergedModels.set(model.id, model);
      }
      for (const model of providerConfig.models ?? []) {
        if (model.id) mergedModels.set(model.id, model);
      }

      providers[provider] = {
        ...existing,
        ...providerConfig,
        headers: {
          ...(existing.headers ?? {}),
          ...(providerConfig.headers ?? {}),
        },
        models: [...mergedModels.values()],
      };
    }
  }

  return { providers };
}

export function flattenModelsCatalog(config: ModelsConfig | null | undefined): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  for (const [provider, providerConfig] of Object.entries(config?.providers ?? {})) {
    for (const model of providerConfig.models ?? []) {
      entries.push({ provider, id: String(model.id), model: model as Record<string, unknown> });
    }
  }
  return entries;
}
