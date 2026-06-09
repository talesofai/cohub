import type { Job } from "bullmq";
import {
  createGenerationClient,
  GenerationConfigError,
  GenerationProviderError,
  GenerationUnsupportedAdapterError,
  GenerationValidationError,
} from "@neta-art/generation";
import { createGenerationDeclarationLoader } from "@cohub/infra/config-runtime/generation-declarations";
import { GENERATION_TASK_TYPE, type GenerationTaskData, type GenerationTaskResult } from "@cohub/protocol/generation";
import type { TaskPayload } from "@cohub/protocol/task";
import { config } from "../config.js";
import { klingVideoGenerationsAdapter } from "../generations/kling-video-adapter.js";
import { redisCommandClient } from "../redis.js";
import { registerTask } from "./registry.js";

const loader = createGenerationDeclarationLoader({
  platformConfigRoot: config.platformConfigRoot,
  redis: redisCommandClient,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseGenerationTaskData(data: unknown): GenerationTaskData {
  if (!isRecord(data)) throw new Error("Invalid generation task payload: data is required");
  if (typeof data.model !== "string" || !data.model.trim()) {
    throw new Error("Invalid generation task payload: model is required");
  }
  if (!Array.isArray(data.content) || data.content.length === 0) {
    throw new Error("Invalid generation task payload: content is required");
  }
  if (data.parameters !== undefined && !isRecord(data.parameters)) {
    throw new Error("Invalid generation task payload: parameters must be an object");
  }
  if (data.meta !== undefined && !isRecord(data.meta)) {
    throw new Error("Invalid generation task payload: meta must be an object");
  }
  return {
    model: data.model,
    content: data.content as GenerationTaskData["content"],
    parameters: data.parameters,
    meta: data.meta,
  };
}

function getNetaRouterApiKey(): string {
  if (!config.netaRouterApiKey) throw new GenerationConfigError("Missing required env: NETA_ROUTER_API_KEY");
  return config.netaRouterApiKey;
}

function summarizeProviderBody(body: string | undefined): string | null {
  if (!body) return null;
  return body.replace(/\s+/g, " ").trim().slice(0, 500) || null;
}

function truncateProviderDetail(value: string, maxLength = 1_000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function summarizeProviderDetails(details: Record<string, unknown> | undefined): string | null {
  if (!details) return null;
  try {
    const serialized = JSON.stringify(details);
    if (!serialized) return null;
    return `details ${truncateProviderDetail(serialized.replace(/\s+/g, " "))}`;
  } catch {
    return "details [unserializable]";
  }
}

function providerStatusMessage(status: number | undefined): string | null {
  if (status === undefined) return null;
  if (status === 401 || status === 403) return "Generation provider rejected the configured credentials";
  if (status === 429) return "Generation provider rate limit exceeded";
  if (status >= 500) return "Generation provider is temporarily unavailable";
  return "Generation provider request failed";
}

function mergeCohubMeta(
  meta: Record<string, unknown> | undefined,
  cohub: Record<string, unknown>,
): Record<string, unknown> {
  const existingCohub = meta?.cohub;
  return {
    ...(meta ?? {}),
    cohub: {
      ...(existingCohub && typeof existingCohub === "object" && !Array.isArray(existingCohub) ? existingCohub : {}),
      ...cohub,
    },
  };
}

function normalizeGenerationError(error: unknown): Error {
  if (error instanceof GenerationValidationError) {
    return new Error(`Invalid generation input: ${error.message}`);
  }
  if (error instanceof GenerationProviderError) {
    const parts = [providerStatusMessage(error.status) ?? error.message];
    if (error.status !== undefined) parts.push(`HTTP ${error.status}`);
    const details = summarizeProviderDetails(error.details);
    if (details) parts.push(details);
    const body = summarizeProviderBody(error.body);
    if (body) parts.push(body);
    return new Error(parts.join(" — "));
  }
  if (error instanceof GenerationConfigError || error instanceof GenerationUnsupportedAdapterError) {
    return new Error(error.message);
  }
  if (error instanceof Error) return error;
  return new Error(String(error));
}

registerTask(GENERATION_TASK_TYPE, async (job: Job, context) => {
  const payload = job.data as TaskPayload;
  const spaceId = payload.spaceId;
  const sessionId = payload.sessionId;
  const turnId = payload.turnId;
  const userId = payload.userId;
  if (!spaceId) throw new Error("Invalid generation task payload: spaceId is required");
  if (!userId) throw new Error("Invalid generation task payload: userId is required");
  const data = parseGenerationTaskData(payload.data);
  const taskRunId = context?.taskRunId ?? String(job.id ?? "");
  const meta = mergeCohubMeta(data.meta, {
    taskRunId,
    spaceId,
    sessionId: sessionId ?? null,
    turnId: turnId ?? null,
  });

  try {
    const declaration = await loader.loadGenerationDeclaration(userId, data.model);
    if (!declaration) throw new Error(`Generation model is unavailable: ${data.model}`);

    const output = await createGenerationClient({
      models: [declaration],
      includeBuiltinModels: false,
      apiKey: getNetaRouterApiKey(),
      adapters: {
        "kling.videoGenerations": klingVideoGenerationsAdapter,
      },
    }).generate({
      model: data.model,
      content: data.content,
      parameters: data.parameters,
      meta,
    });

    return {
      model: data.model,
      output,
      meta,
    } satisfies GenerationTaskResult;
  } catch (error) {
    throw normalizeGenerationError(error);
  }
});
