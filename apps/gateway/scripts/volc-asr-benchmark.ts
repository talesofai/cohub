import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import {
  parseVolcAsrVariants,
  readPcm16Audio,
  resolveRunnerConfig,
  runVolcAsrTrial,
  type VolcAsrTrialResult,
} from "./volc-asr-runner.js";

type BenchmarkSample = {
  id: string;
  dataset: string;
  audioPath: string;
  text: string;
  language?: string | null;
  tags?: string[];
};

type BenchmarkResultRow = {
  kind: "result";
  sampleId: string;
  dataset: string;
  variant: string;
  language: string | null;
  tags: string[];
  expectedText: string;
  recognizedText: string;
  cer: number | null;
  wer: number | null;
  editDistanceChars: number | null;
  editDistanceWords: number | null;
  referenceChars: number;
  referenceWords: number;
  success: boolean;
  error: string | null;
  trial: VolcAsrTrialResult | null;
};

type SummaryRow = {
  kind: "summary";
  dataset: string;
  variant: string;
  samples: number;
  failures: number;
  avgCer: number | null;
  avgWer: number | null;
  avgDurationMs: number | null;
  avgFirstPartialMs: number | null;
  avgFirstFinalMs: number | null;
};

const apiKey = process.env.VOLC_ASR_API_KEY;
const manifestPath = process.env.VOLC_ASR_BENCHMARK_MANIFEST;

if (!apiKey || !manifestPath) {
  console.error(
    "Set VOLC_ASR_API_KEY and VOLC_ASR_BENCHMARK_MANIFEST to run the benchmark.",
  );
  process.exit(2);
}

const outputPath = process.env.VOLC_ASR_BENCHMARK_OUTPUT;
const output = outputPath ? createWriteStream(outputPath, { flags: "w" }) : null;
const manifestDir = path.dirname(path.resolve(manifestPath));
const limit = Math.max(
  0,
  Math.trunc(Number(process.env.VOLC_ASR_BENCHMARK_LIMIT ?? 0)),
);
const offset = Math.max(
  0,
  Math.trunc(Number(process.env.VOLC_ASR_BENCHMARK_OFFSET ?? 0)),
);
const rounds = Math.max(
  1,
  Math.trunc(Number(process.env.VOLC_ASR_BENCHMARK_ROUNDS ?? 1)),
);
const warmupRounds = Math.max(
  0,
  Math.trunc(Number(process.env.VOLC_ASR_BENCHMARK_WARMUP_ROUNDS ?? 0)),
);
const runnerConfig = resolveRunnerConfig({
  apiKey,
  resourceId: process.env.VOLC_ASR_RESOURCE_ID,
  url: process.env.VOLC_ASR_URL,
  uid: process.env.VOLC_ASR_BENCHMARK_UID,
  frameMs:
    process.env.VOLC_ASR_BENCHMARK_FRAME_MS ??
    process.env.VOLC_ASR_EXPERIMENT_FRAME_MS,
  realtime:
    process.env.VOLC_ASR_BENCHMARK_REALTIME ??
    process.env.VOLC_ASR_EXPERIMENT_REALTIME,
  closeTimeoutMs:
    process.env.VOLC_ASR_BENCHMARK_CLOSE_TIMEOUT_MS ??
    process.env.VOLC_ASR_EXPERIMENT_CLOSE_TIMEOUT_MS,
});
const variants = parseVolcAsrVariants(
  process.env.VOLC_ASR_BENCHMARK_VARIANTS ??
    process.env.VOLC_ASR_EXPERIMENT_VARIANTS,
);

const emit = (row: BenchmarkResultRow | SummaryRow) => {
  const line = JSON.stringify(row);
  console.log(line);
  output?.write(`${line}\n`);
};

const parseManifest = async (filePath: string) => {
  const content = await readFile(filePath, "utf-8");
  const samples: BenchmarkSample[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const value = JSON.parse(trimmed) as Partial<BenchmarkSample>;
    if (!value.id || !value.dataset || !value.audioPath || !value.text) {
      throw new Error(`invalid manifest row ${index + 1}`);
    }
    samples.push({
      id: value.id,
      dataset: value.dataset,
      audioPath: value.audioPath,
      text: value.text,
      language: value.language ?? null,
      tags: value.tags ?? [],
    });
  }
  const selected = samples.slice(offset, limit > 0 ? offset + limit : undefined);
  if (selected.length === 0) throw new Error("benchmark manifest has no samples");
  return selected;
};

const normalizeText = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const charsForCer = (text: string) =>
  Array.from(normalizeText(text).replace(/\s+/g, ""));

const wordsForWer = (text: string) =>
  normalizeText(text)
    .split(/\s+/)
    .filter(Boolean);

const distance = <T>(left: T[], right: T[]) => {
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + substitution,
      );
    }
    previous = current;
  }
  return previous[right.length];
};

const divide = (value: number, total: number) => (total > 0 ? value / total : null);

const canScoreWer = (language: string | null | undefined, expected: string) => {
  if (language?.toLowerCase().startsWith("zh")) return false;
  return !/\p{Script=Han}/u.test(expected);
};

const score = (expected: string, actual: string, language?: string | null) => {
  const expectedChars = charsForCer(expected);
  const actualChars = charsForCer(actual);
  const expectedWords = wordsForWer(expected);
  const actualWords = wordsForWer(actual);
  const editDistanceChars = distance(expectedChars, actualChars);
  const editDistanceWords =
    canScoreWer(language, expected) && expectedWords.length > 1
      ? distance(expectedWords, actualWords)
      : null;
  return {
    cer: divide(editDistanceChars, expectedChars.length),
    wer:
      editDistanceWords == null
        ? null
        : divide(editDistanceWords, expectedWords.length),
    editDistanceChars,
    editDistanceWords,
    referenceChars: expectedChars.length,
    referenceWords: expectedWords.length,
  };
};

const average = (values: Array<number | null | undefined>) => {
  const numbers = values.filter((value): value is number => value != null);
  if (numbers.length === 0) return null;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
};

const summarize = (rows: BenchmarkResultRow[]) => {
  const keys = new Set(
    rows.flatMap((row) => [
      `${row.dataset}\t${row.variant}`,
      `all\t${row.variant}`,
    ]),
  );
  for (const key of keys) {
    const [dataset, variant] = key.split("\t");
    const bucket = rows.filter(
      (row) =>
        (dataset === "all" || row.dataset === dataset) &&
        row.variant === variant,
    );
    const successful = bucket.filter((row) => row.success);
    emit({
      kind: "summary",
      dataset,
      variant,
      samples: bucket.length,
      failures: bucket.length - successful.length,
      avgCer: average(successful.map((row) => row.cer)),
      avgWer: average(successful.map((row) => row.wer)),
      avgDurationMs: average(successful.map((row) => row.trial?.durationMs)),
      avgFirstPartialMs: average(
        successful.map((row) => row.trial?.firstPartialMs),
      ),
      avgFirstFinalMs: average(successful.map((row) => row.trial?.firstFinalMs)),
    });
  }
};

const samples = await parseManifest(manifestPath);
const rows: BenchmarkResultRow[] = [];

for (let round = 1; round <= warmupRounds + rounds; round += 1) {
  const warmup = round <= warmupRounds;
  for (const sample of samples) {
    const audioPath = path.resolve(manifestDir, sample.audioPath);
    const audio = await readPcm16Audio(audioPath);
    for (const variant of variants) {
      try {
        const trial = await runVolcAsrTrial(runnerConfig, {
          audio,
          variant,
          language: sample.language,
          round: round - warmupRounds,
          warmup,
        });
        if (warmup) continue;
        const recognizedText = trial.finalText || trial.latestPartialText;
        const metrics = score(sample.text, recognizedText, sample.language);
        const row: BenchmarkResultRow = {
          kind: "result",
          sampleId: sample.id,
          dataset: sample.dataset,
          variant: variant.name,
          language: sample.language ?? null,
          tags: sample.tags ?? [],
          expectedText: sample.text,
          recognizedText,
          ...metrics,
          success:
            trial.closeReason === "closed" &&
            trial.providerErrors.length === 0 &&
            recognizedText.length > 0,
          error:
            trial.providerErrors.length > 0 ? trial.providerErrors.join("; ") : null,
          trial,
        };
        rows.push(row);
        emit(row);
      } catch (error) {
        if (warmup) continue;
        const row: BenchmarkResultRow = {
          kind: "result",
          sampleId: sample.id,
          dataset: sample.dataset,
          variant: variant.name,
          language: sample.language ?? null,
          tags: sample.tags ?? [],
          expectedText: sample.text,
          recognizedText: "",
          cer: null,
          wer: null,
          editDistanceChars: null,
          editDistanceWords: null,
          referenceChars: charsForCer(sample.text).length,
          referenceWords: wordsForWer(sample.text).length,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          trial: null,
        };
        rows.push(row);
        emit(row);
      }
    }
  }
}

summarize(rows);
output?.end();
if (output) await finished(output);
