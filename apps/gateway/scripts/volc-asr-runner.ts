import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { VolcAsrProvider } from "../src/asr/volc-asr-provider.js";
import type { VolcAsrCorpusConfig } from "../src/asr/volc-asr-protocol.js";

export type VolcAsrExperimentVariant = {
  name: string;
  endWindowSizeMs: number;
  forceToSpeechTimeMs: number;
  enableNonstream: boolean;
  enablePunctuation: boolean;
  enableItn: boolean;
  enableDdc: boolean;
};

export type VolcAsrRunnerConfig = {
  apiKey: string;
  resourceId: string;
  url: string;
  uid: string;
  frameMs: number;
  realtime: boolean;
  closeTimeoutMs: number;
};

export type VolcAsrTrialInput = {
  audio: Buffer;
  variant: VolcAsrExperimentVariant;
  round: number;
  warmup: boolean;
  language?: string | null;
  corpus?: VolcAsrCorpusConfig | null;
};

export type VolcAsrTrialResult = {
  variant: string;
  requestId: string;
  round: number;
  warmup: boolean;
  endWindowSizeMs: number;
  forceToSpeechTimeMs: number;
  enableNonstream: boolean;
  enablePunctuation: boolean;
  enableItn: boolean;
  enableDdc: boolean;
  audioBytes: number;
  frameMs: number;
  realtime: boolean;
  durationMs: number;
  providerConnectMs: number | null;
  firstPartialMs: number | null;
  firstFinalMs: number | null;
  partialMessages: number;
  finalMessages: number;
  textChars: number;
  textPreview: string;
  finalText: string;
  latestPartialText: string;
  closeReason: "closed" | "timeout";
  providerErrors: string[];
};

export const defaultVolcAsrExperimentVariants: VolcAsrExperimentVariant[] = [
  {
    name: "fast-600",
    endWindowSizeMs: 600,
    forceToSpeechTimeMs: 1000,
    enableNonstream: true,
    enablePunctuation: true,
    enableItn: true,
    enableDdc: false,
  },
  {
    name: "balanced-800",
    endWindowSizeMs: 800,
    forceToSpeechTimeMs: 1000,
    enableNonstream: true,
    enablePunctuation: true,
    enableItn: true,
    enableDdc: false,
  },
  {
    name: "patient-1200",
    endWindowSizeMs: 1200,
    forceToSpeechTimeMs: 1200,
    enableNonstream: true,
    enablePunctuation: true,
    enableItn: true,
    enableDdc: false,
  },
];

export const readPcm16Audio = async (audioPath: string) => {
  const audio = await readFile(audioPath);
  if (audio.length % 2 !== 0) {
    throw new Error(`${audioPath} must be 16k mono PCM raw with 16-bit samples`);
  }
  return audio;
};

export const resolveFrameMs = (value: string | undefined) =>
  Math.min(1000, Math.max(20, Math.trunc(Number(value ?? 200))));

export const resolveRunnerConfig = (input: {
  apiKey: string;
  resourceId?: string;
  url?: string;
  uid?: string;
  frameMs?: string;
  realtime?: string;
  closeTimeoutMs?: string;
}): VolcAsrRunnerConfig => ({
  apiKey: input.apiKey,
  resourceId: input.resourceId ?? "volc.seedasr.sauc.duration",
  url:
    input.url ??
    "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
  uid: input.uid ?? "cohub-local-experiment",
  frameMs: resolveFrameMs(input.frameMs),
  realtime: input.realtime !== "false",
  closeTimeoutMs: Math.max(
    1000,
    Math.trunc(Number(input.closeTimeoutMs ?? 30_000)),
  ),
});

export const parseVolcAsrVariants = (raw: string | undefined) => {
  if (!raw?.trim()) return defaultVolcAsrExperimentVariants;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("ASR experiment variants must be a JSON array");
  }
  return parsed.map((value, index): VolcAsrExperimentVariant => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`invalid variant at index ${index}`);
    }
    const input = value as Partial<VolcAsrExperimentVariant> & {
      options?: Partial<VolcAsrExperimentVariant>;
    };
    const options =
      input.options &&
      typeof input.options === "object" &&
      !Array.isArray(input.options)
        ? input.options
        : input;
    if (!input.name) throw new Error(`variant ${index} is missing name`);

    const numberOption = (
      key: "endWindowSizeMs" | "forceToSpeechTimeMs",
      fallback: number,
    ) => {
      const number = Number(options[key] ?? fallback);
      if (!Number.isFinite(number)) {
        throw new Error(`variant ${input.name} has invalid ${key}`);
      }
      return Math.trunc(number);
    };

    return {
      name: input.name,
      endWindowSizeMs: numberOption("endWindowSizeMs", 800),
      forceToSpeechTimeMs: numberOption("forceToSpeechTimeMs", 1000),
      enableNonstream: options.enableNonstream ?? true,
      enablePunctuation: options.enablePunctuation ?? true,
      enableItn: options.enableItn ?? true,
      enableDdc: options.enableDdc ?? false,
    };
  });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const streamPcm = async (
  provider: VolcAsrProvider,
  audio: Buffer,
  config: VolcAsrRunnerConfig,
) => {
  const pcmBytesPerMs = (16_000 * 2) / 1000;
  const frameBytes = Math.max(
    2,
    Math.trunc((pcmBytesPerMs * config.frameMs) / 2) * 2,
  );
  for (let offset = 0; offset < audio.length; offset += frameBytes) {
    provider.sendAudio(
      audio.subarray(offset, Math.min(offset + frameBytes, audio.length)),
    );
    if (config.realtime) await sleep(config.frameMs);
  }
};

const waitForClose = async (
  provider: VolcAsrProvider,
  closeTimeoutMs: number,
): Promise<"closed" | "timeout"> =>
  new Promise((resolve) => {
    const timeout = setTimeout(() => {
      provider.close();
      resolve("timeout");
    }, closeTimeoutMs);
    provider.once("close", () => {
      clearTimeout(timeout);
      resolve("closed");
    });
  });

export const runVolcAsrTrial = async (
  config: VolcAsrRunnerConfig,
  input: VolcAsrTrialInput,
): Promise<VolcAsrTrialResult> => {
  const startedAt = Date.now();
  let providerReadyAt: number | null = null;
  let firstPartialAt: number | null = null;
  let firstFinalAt: number | null = null;
  let partialMessages = 0;
  let finalMessages = 0;
  let finalText = "";
  let latestPartialText = "";
  const providerErrors: string[] = [];
  const requestId = randomUUID();
  const { variant } = input;
  const provider = new VolcAsrProvider({
    apiKey: config.apiKey,
    resourceId: config.resourceId,
    url: config.url,
    requestId,
    uid: config.uid,
    requestConfig: {
      language: variant.enableNonstream ? null : input.language,
      endWindowSizeMs: variant.endWindowSizeMs,
      forceToSpeechTimeMs: variant.forceToSpeechTimeMs,
      enableNonstream: variant.enableNonstream,
      enablePunctuation: variant.enablePunctuation,
      enableItn: variant.enableItn,
      enableDdc: variant.enableDdc,
      corpus: input.corpus,
    },
  });

  provider.on("result", (result) => {
    const now = Date.now();
    if (result.definite) {
      firstFinalAt ??= now;
      finalMessages += 1;
      finalText += result.text;
      latestPartialText = "";
      return;
    }
    firstPartialAt ??= now;
    partialMessages += 1;
    latestPartialText = result.text;
  });
  provider.on("error", (error) => {
    providerErrors.push(error.message);
  });

  await provider.start();
  providerReadyAt = Date.now();
  const close = waitForClose(provider, config.closeTimeoutMs);
  await streamPcm(provider, input.audio, config);
  provider.stop();
  const closeReason = await close;
  return {
    variant: variant.name,
    requestId,
    round: input.round,
    warmup: input.warmup,
    endWindowSizeMs: variant.endWindowSizeMs,
    forceToSpeechTimeMs: variant.forceToSpeechTimeMs,
    enableNonstream: variant.enableNonstream,
    enablePunctuation: variant.enablePunctuation,
    enableItn: variant.enableItn,
    enableDdc: variant.enableDdc,
    audioBytes: input.audio.length,
    frameMs: config.frameMs,
    realtime: config.realtime,
    durationMs: Date.now() - startedAt,
    providerConnectMs: providerReadyAt ? providerReadyAt - startedAt : null,
    firstPartialMs: firstPartialAt ? firstPartialAt - startedAt : null,
    firstFinalMs: firstFinalAt ? firstFinalAt - startedAt : null,
    partialMessages,
    finalMessages,
    textChars: finalText.length,
    textPreview: finalText.slice(0, 80),
    finalText,
    latestPartialText,
    closeReason,
    providerErrors,
  };
};
