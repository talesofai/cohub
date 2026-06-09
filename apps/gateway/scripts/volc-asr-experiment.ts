import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { VolcAsrProvider } from "../src/asr/volc-asr-provider.js";

type Variant = {
  name: string;
  endWindowSizeMs: number;
  forceToSpeechTimeMs: number;
  enableNonstream: boolean;
  enablePunctuation: boolean;
  enableItn: boolean;
  enableDdc: boolean;
};

const variants: Variant[] = [
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

const apiKey = process.env.VOLC_ASR_API_KEY;
const audioPath = process.env.VOLC_ASR_EXPERIMENT_AUDIO;

if (!apiKey || !audioPath) {
  console.error(
    "Set VOLC_ASR_API_KEY and VOLC_ASR_EXPERIMENT_AUDIO to run a real Volc ASR experiment.",
  );
  process.exit(2);
}

const resolvedApiKey = apiKey;
const resolvedAudioPath = audioPath;
const resourceId =
  process.env.VOLC_ASR_RESOURCE_ID ?? "volc.seedasr.sauc.duration";
const url =
  process.env.VOLC_ASR_URL ??
  "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
const uid = process.env.VOLC_ASR_EXPERIMENT_UID ?? "cohub-local-experiment";
const rounds = Math.max(
  1,
  Math.trunc(Number(process.env.VOLC_ASR_EXPERIMENT_ROUNDS ?? 1)),
);
const warmupRounds = Math.max(
  0,
  Math.trunc(Number(process.env.VOLC_ASR_EXPERIMENT_WARMUP_ROUNDS ?? 0)),
);
const realtime = process.env.VOLC_ASR_EXPERIMENT_REALTIME !== "false";
const frameMs = Math.min(
  1000,
  Math.max(
    20,
    Math.trunc(Number(process.env.VOLC_ASR_EXPERIMENT_FRAME_MS ?? 200)),
  ),
);
const pcmBytesPerMs = (16_000 * 2) / 1000;
const frameBytes = Math.max(2, Math.trunc((pcmBytesPerMs * frameMs) / 2) * 2);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parseVariants = () => {
  const raw = process.env.VOLC_ASR_EXPERIMENT_VARIANTS;
  if (!raw?.trim()) return variants;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed))
    throw new Error("VOLC_ASR_EXPERIMENT_VARIANTS must be a JSON array");
  return parsed.map((value, index): Variant => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`invalid variant at index ${index}`);
    const input = value as Partial<Variant> & { options?: Partial<Variant> };
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
      if (!Number.isFinite(number))
        throw new Error(`variant ${input.name} has invalid ${key}`);
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

const streamPcm = async (provider: VolcAsrProvider, audio: Buffer) => {
  for (let offset = 0; offset < audio.length; offset += frameBytes) {
    provider.sendAudio(
      audio.subarray(offset, Math.min(offset + frameBytes, audio.length)),
    );
    if (realtime) await sleep(frameMs);
  }
};

const runVariant = async (
  variant: Variant,
  audio: Buffer,
  round: number,
  warmup: boolean,
) => {
  const startedAt = Date.now();
  let providerReadyAt: number | null = null;
  let firstPartialAt: number | null = null;
  let firstFinalAt: number | null = null;
  let partialMessages = 0;
  let finalMessages = 0;
  let finalText = "";
  const provider = new VolcAsrProvider({
    apiKey: resolvedApiKey,
    resourceId,
    url,
    requestId: randomUUID(),
    uid,
    requestConfig: {
      endWindowSizeMs: variant.endWindowSizeMs,
      forceToSpeechTimeMs: variant.forceToSpeechTimeMs,
      enableNonstream: variant.enableNonstream,
      enablePunctuation: variant.enablePunctuation,
      enableItn: variant.enableItn,
      enableDdc: variant.enableDdc,
    },
  });
  provider.on("result", (result) => {
    const now = Date.now();
    if (result.definite) {
      firstFinalAt ??= now;
      finalMessages += 1;
      finalText += result.text;
    } else {
      firstPartialAt ??= now;
      partialMessages += 1;
    }
  });
  provider.on("error", (error) => {
    console.error(
      JSON.stringify({
        event: "error",
        variant: variant.name,
        error: error.message,
      }),
    );
  });
  const closed = new Promise<void>((resolve) => provider.on("close", resolve));
  await provider.start();
  providerReadyAt = Date.now();
  await streamPcm(provider, audio);
  provider.stop();
  await closed;
  return {
    variant: variant.name,
    round,
    warmup,
    endWindowSizeMs: variant.endWindowSizeMs,
    forceToSpeechTimeMs: variant.forceToSpeechTimeMs,
    enableNonstream: variant.enableNonstream,
    enablePunctuation: variant.enablePunctuation,
    enableItn: variant.enableItn,
    enableDdc: variant.enableDdc,
    audioBytes: audio.length,
    frameMs,
    realtime,
    durationMs: Date.now() - startedAt,
    providerConnectMs: providerReadyAt ? providerReadyAt - startedAt : null,
    firstPartialMs: firstPartialAt ? firstPartialAt - startedAt : null,
    firstFinalMs: firstFinalAt ? firstFinalAt - startedAt : null,
    partialMessages,
    finalMessages,
    textChars: finalText.length,
    textPreview: finalText.slice(0, 80),
  };
};

const audio = await readFile(resolvedAudioPath);
if (audio.length % 2 !== 0)
  throw new Error(
    "VOLC_ASR_EXPERIMENT_AUDIO must be 16k mono PCM raw with 16-bit samples",
  );

const selectedVariants = parseVariants();
for (let round = 1; round <= warmupRounds + rounds; round += 1) {
  const warmup = round <= warmupRounds;
  for (const variant of selectedVariants) {
    console.log(
      JSON.stringify(
        await runVariant(variant, audio, round - warmupRounds, warmup),
      ),
    );
  }
}
