import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createCachedModelsConfig,
  getUserModelsRedisKey,
  mergeModelsConfigs,
  MODELS_CACHE_TTL_SEC,
  parseCachedModelsConfig,
  parseModelsConfig,
  PLATFORM_MODELS_REDIS_KEY,
  resolveModelRequestHeaders,
  type CachedModelsConfig,
  type ModelsConfig,
  type ModelDef,
  type ProviderConfig,
} from "@cohub/infra/config-runtime/models";
import type { Api, Model } from "@earendil-works/pi-ai";
import { config } from "../config.js";
import { redisCommandClient } from "../redis.js";

const PLATFORM_MODELS_PATH = join(config.platformConfigRoot, "platform", ".cohub", "models.json");
const getUserModelsPath = (userId: string) => join(config.platformConfigRoot, "users", userId, ".cohub", "models.json");

const inflightByKey = new Map<string, Promise<ModelsConfig | null>>();

export type RuntimeLlmModel = Model<Api> & {
  defaultThinkingLevel?: ModelDef["defaultThinkingLevel"];
};

function resolveApiKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const envValue = process.env[value];
  return envValue && envValue.trim().length > 0 ? envValue.trim() : value;
}

function finiteNumberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeModelCost(cost: ModelDef["cost"] | undefined): Model<Api>["cost"] {
  return {
    input: finiteNumberOrZero(cost?.input),
    output: finiteNumberOrZero(cost?.output),
    cacheRead: finiteNumberOrZero(cost?.cacheRead),
    cacheWrite: finiteNumberOrZero(cost?.cacheWrite),
  };
}

async function loadModelsFromFile(input: {
  modelsPath: string;
  redisKey: string;
  allowMissing: boolean;
}): Promise<CachedModelsConfig> {
  let rawText: string;
  try {
    rawText = await readFile(input.modelsPath, "utf-8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
    if (code === "ENOENT" && input.allowMissing) {
      const cached = createCachedModelsConfig({ content: null });
      await redisCommandClient.set(input.redisKey, JSON.stringify(cached), "EX", MODELS_CACHE_TTL_SEC);
      return cached;
    }
    if (code === "ENOENT") throw new Error("Models catalog file not found");
    throw error;
  }

  let content: ModelsConfig;
  try {
    content = parseModelsConfig(rawText);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Models catalog file is invalid JSON");
    throw error;
  }

  const cached = createCachedModelsConfig({ rawText, content });
  await redisCommandClient.set(input.redisKey, JSON.stringify(cached), "EX", MODELS_CACHE_TTL_SEC);
  return cached;
}

async function loadCachedModels(input: {
  redisKey: string;
  modelsPath: string;
  allowMissing: boolean;
}): Promise<ModelsConfig | null> {
  const inflight = inflightByKey.get(input.redisKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const cached = await redisCommandClient.get(input.redisKey);
    if (cached) {
      try {
        const parsed = parseCachedModelsConfig(cached);
        if (parsed) return parsed.content;
      } catch {
        // ignore cache parse errors and fall back to file
      }
    }
    return (await loadModelsFromFile(input)).content;
  })();

  inflightByKey.set(input.redisKey, promise);
  try {
    return await promise;
  } finally {
    inflightByKey.delete(input.redisKey);
  }
}

export async function loadRuntimeModelsConfigs(userId?: string | null): Promise<ModelsConfig[]> {
  const platform = await loadCachedModels({
    redisKey: PLATFORM_MODELS_REDIS_KEY,
    modelsPath: PLATFORM_MODELS_PATH,
    allowMissing: false,
  });
  const configs: ModelsConfig[] = [];
  if (platform) configs.push(platform);

  const trimmedUserId = userId?.trim();
  if (trimmedUserId) {
    const user = await loadCachedModels({
      redisKey: getUserModelsRedisKey(trimmedUserId),
      modelsPath: getUserModelsPath(trimmedUserId),
      allowMissing: true,
    });
    if (user) configs.push(user);
  }
  return configs;
}

export class CompletionModelRegistry {
  private models: RuntimeLlmModel[] = [];
  private providerApiKeys = new Map<string, string>();
  private providerHeaders = new Map<string, Record<string, string>>();

  constructor(configs: Array<ModelsConfig | null | undefined>) {
    const merged = mergeModelsConfigs(...configs.filter((item): item is ModelsConfig => Boolean(item)));
    const mergedModels = new Map<string, RuntimeLlmModel>();

    for (const [provider, providerConfig] of Object.entries(merged.providers ?? {})) {
      const apiKey = resolveApiKey((providerConfig as ProviderConfig).apiKey);
      if (apiKey) this.providerApiKeys.set(provider, apiKey);
      if (providerConfig.headers) this.providerHeaders.set(provider, providerConfig.headers);

      for (const modelDef of providerConfig.models ?? []) {
        const api = modelDef.api ?? providerConfig.api;
        const baseUrl = modelDef.baseUrl ?? providerConfig.baseUrl;
        if (!api || !baseUrl || !modelDef.id) continue;
        if (modelDef.hidden) continue;
        mergedModels.set(`${provider}:${modelDef.id}`, {
          id: modelDef.id,
          name: modelDef.name ?? modelDef.id,
          api: api as Api,
          provider,
          baseUrl,
          reasoning: modelDef.reasoning ?? false,
          defaultThinkingLevel: modelDef.defaultThinkingLevel,
          thinkingLevelMap: modelDef.thinkingLevelMap,
          input: modelDef.input ?? ["text"],
          cost: normalizeModelCost(modelDef.cost),
          contextWindow: modelDef.contextWindow ?? 128000,
          maxTokens: modelDef.maxTokens ?? 16384,
          headers: modelDef.headers,
          compat: (modelDef.compat ?? providerConfig.compat) as Model<Api>["compat"],
        } as RuntimeLlmModel);
      }
    }

    this.models = [...mergedModels.values()];
  }

  getAvailable() {
    return [...this.models];
  }

  find(provider: string, id: string) {
    return this.models.find((model) => model.provider === provider && model.id === id);
  }

  getDefault() {
    return this.models[0];
  }

  getApiKey(provider: string) {
    return this.providerApiKeys.get(provider);
  }

  getHeaders(provider: string, modelId?: string) {
    const model = modelId ? this.find(provider, modelId) : undefined;
    return resolveModelRequestHeaders(
      model,
      model?.headers ?? this.providerHeaders.get(provider),
    );
  }
}

export async function resolveCompletionModel(input: {
  userId: string;
  provider?: string | null;
  model?: string | null;
}) {
  const configs = await loadRuntimeModelsConfigs(input.userId);
  const registry = new CompletionModelRegistry(configs);
  const provider = input.provider?.trim() || null;
  const modelId = input.model?.trim() || null;

  if (provider && modelId) {
    const found = registry.find(provider, modelId);
    if (!found) {
      return { registry, model: null as RuntimeLlmModel | null, error: `Model not found: ${provider}/${modelId}` };
    }
    return { registry, model: found, error: null };
  }

  if (modelId && !provider) {
    const matches = registry.getAvailable().filter((item) => item.id === modelId);
    const only = matches[0];
    if (matches.length === 1 && only) return { registry, model: only, error: null };
    if (matches.length > 1) {
      return {
        registry,
        model: null,
        error: `Model id "${modelId}" is ambiguous; specify provider`,
      };
    }
    return { registry, model: null, error: `Model not found: ${modelId}` };
  }

  if (provider && !modelId) {
    const first = registry.getAvailable().find((item) => item.provider === provider);
    if (!first) return { registry, model: null, error: `No models available for provider: ${provider}` };
    return { registry, model: first, error: null };
  }

  const fallback = registry.getDefault();
  if (!fallback) return { registry, model: null, error: "No model available. Check platform models.json" };
  return { registry, model: fallback, error: null };
}
