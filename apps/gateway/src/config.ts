import { resolveLogtoEndpoint } from "@cohub/identity";
import { parseAsrExperimentVariants } from "./asr/experiments.js";

const normalizeBaseUrl = (value: string) => value.replace(/\/+$/, "");

const env = process.env.ENV === "prod" ? "prod" : "dev";

const intFromEnv = (name: string, fallback: number) => {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};

const boolFromEnv = (name: string, fallback: boolean) => {
  const value = process.env[name];
  if (!value) return fallback;
  return value === "1" || value.toLowerCase() === "true";
};

export const gatewayConfig = {
  apiBaseUrl: normalizeBaseUrl(
    process.env.API_BASE_URL ?? "http://localhost:8787",
  ),
  workerSecret: process.env.WORKER_SECRET ?? "",
  logtoEndpoint: resolveLogtoEndpoint({
    endpoint: process.env.LOGTO_ENDPOINT,
    env,
  }),
  port: Number(process.env.PORT ?? 8788),
  volcAsr: {
    apiKey: process.env.VOLC_ASR_API_KEY ?? "",
    resourceId: "volc.seedasr.sauc.duration",
    url: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
    endWindowSizeMs: intFromEnv("VOLC_ASR_END_WINDOW_SIZE_MS", 600),
    forceToSpeechTimeMs: intFromEnv("VOLC_ASR_FORCE_TO_SPEECH_TIME_MS", 1000),
    enableNonstream: boolFromEnv("VOLC_ASR_ENABLE_NONSTREAM", true),
    enablePunctuation: boolFromEnv("VOLC_ASR_ENABLE_PUNCTUATION", true),
    enableItn: boolFromEnv("VOLC_ASR_ENABLE_ITN", true),
    enableDdc: boolFromEnv("VOLC_ASR_ENABLE_DDC", false),
    boostingTableName: process.env.VOLC_ASR_BOOSTING_TABLE_NAME ?? "",
    boostingTableId: process.env.VOLC_ASR_BOOSTING_TABLE_ID ?? "",
    correctTableName: process.env.VOLC_ASR_CORRECT_TABLE_NAME ?? "",
    correctTableId: process.env.VOLC_ASR_CORRECT_TABLE_ID ?? "",
    experimentName: process.env.VOLC_ASR_EXPERIMENT_NAME?.trim() || "",
    experimentVariants: parseAsrExperimentVariants(
      process.env.VOLC_ASR_EXPERIMENT_VARIANTS,
    ),
  },
  asrRewrite: {
    enabled:
      boolFromEnv("ASR_REWRITE_ENABLED", false) &&
      Boolean(process.env.ASR_REWRITE_API_KEY),
    baseUrl: normalizeBaseUrl(
      process.env.ASR_REWRITE_BASE_URL ?? "https://api.openai.com/v1",
    ),
    apiKey: process.env.ASR_REWRITE_API_KEY ?? "",
    model: process.env.ASR_REWRITE_MODEL ?? "gpt-4.1-mini",
    timeoutMs: intFromEnv("ASR_REWRITE_TIMEOUT_MS", 1800),
  },
};

export type GatewayAuthUser = {
  uuid: string;
  nick_name?: string;
  avatar_url?: string;
  [key: string]: unknown;
};
