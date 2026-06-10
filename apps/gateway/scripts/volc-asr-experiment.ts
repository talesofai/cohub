import {
  parseVolcAsrVariants,
  readPcm16Audio,
  resolveRunnerConfig,
  runVolcAsrTrial,
} from "./volc-asr-runner.js";

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
const rounds = Math.max(
  1,
  Math.trunc(Number(process.env.VOLC_ASR_EXPERIMENT_ROUNDS ?? 1)),
);
const warmupRounds = Math.max(
  0,
  Math.trunc(Number(process.env.VOLC_ASR_EXPERIMENT_WARMUP_ROUNDS ?? 0)),
);
const runnerConfig = resolveRunnerConfig({
  apiKey: resolvedApiKey,
  resourceId: process.env.VOLC_ASR_RESOURCE_ID,
  url: process.env.VOLC_ASR_URL,
  uid: process.env.VOLC_ASR_EXPERIMENT_UID,
  frameMs: process.env.VOLC_ASR_EXPERIMENT_FRAME_MS,
  realtime: process.env.VOLC_ASR_EXPERIMENT_REALTIME,
  closeTimeoutMs: process.env.VOLC_ASR_EXPERIMENT_CLOSE_TIMEOUT_MS,
});
const audio = await readPcm16Audio(resolvedAudioPath);

const selectedVariants = parseVolcAsrVariants(
  process.env.VOLC_ASR_EXPERIMENT_VARIANTS,
);
for (let round = 1; round <= warmupRounds + rounds; round += 1) {
  const warmup = round <= warmupRounds;
  for (const variant of selectedVariants) {
    console.log(
      JSON.stringify(
        await runVolcAsrTrial(runnerConfig, {
          variant,
          audio,
          round: round - warmupRounds,
          warmup,
        }),
      ),
    );
  }
}
