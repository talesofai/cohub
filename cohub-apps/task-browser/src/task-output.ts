import type { TaskRunRecord } from "@neta-art/cohub";

type RecordValue = Record<string, unknown>;

export type GenerationOutput = {
  index: number;
  type: "image" | "video" | "audio" | "text" | "unknown";
  url: string | null;
  poster: string | null;
  label: string;
  text: string | null;
  deferred: boolean;
};

export type GenerationTask = {
  id: string;
  status: TaskRunRecord["status"];
  createdAt: string;
  model: string | null;
  prompt: string | null;
  outputs: GenerationOutput[];
  outputCount: number;
};

const BASE64_KEYS = ["data", "base64", "contentBase64"] as const;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(record: RecordValue | null | undefined, keys: readonly string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function hasInlinePayload(record: RecordValue | null | undefined) {
  return BASE64_KEYS.some((key) => {
    const value = record?.[key];
    return typeof value === "string" && value.length > 0;
  });
}

function remoteUrl(value: string | null) {
  return value && !/^(data|blob):/i.test(value) ? value : null;
}

function taskData(run: TaskRunRecord) {
  if (!isRecord(run.payload)) return null;
  return isRecord(run.payload.data) ? run.payload.data : run.payload;
}

function textFromBlock(block: RecordValue) {
  return block.type === "text"
    ? readString(block, ["text", "content", "value"])
    : null;
}

function generationPrompt(data: RecordValue | null) {
  if (!Array.isArray(data?.content)) return null;
  const prompt = data.content
    .filter(isRecord)
    .map(textFromBlock)
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return prompt || null;
}

function generationOutput(block: RecordValue, index: number): GenerationOutput {
  const source = isRecord(block.source) ? block.source : null;
  const rawType = readString(block, ["type"]);
  const type =
    rawType === "image" || rawType === "video" || rawType === "audio" || rawType === "text"
      ? rawType
      : "unknown";
  const rawUrl = readString(source, ["url", "src"]) ?? readString(block, ["url", "src"]);
  const rawPoster =
    readString(source, ["poster", "thumbnail", "previewUrl"]) ??
    readString(block, ["poster", "thumbnail", "previewUrl"]);
  return {
    index,
    type,
    url: remoteUrl(rawUrl),
    poster: remoteUrl(rawPoster),
    label: readString(block, ["alt", "name", "filename"]) ?? `Output ${index + 1}`,
    text: textFromBlock(block),
    deferred:
      block.deferredBase64 === true ||
      source?.deferredBase64 === true ||
      hasInlinePayload(block) ||
      hasInlinePayload(source) ||
      Boolean(rawUrl && /^(data|blob):/i.test(rawUrl)) ||
      Boolean(rawPoster && /^(data|blob):/i.test(rawPoster)),
  };
}

export function mergeTaskRefresh(
  current: GenerationTask[],
  refreshed: GenerationTask[],
) {
  const refreshedIds = new Set(refreshed.map((task) => task.id));
  return [...refreshed, ...current.filter((task) => !refreshedIds.has(task.id))];
}

export function toGenerationTask(run: TaskRunRecord): GenerationTask {
  const data = taskData(run);
  const result = isRecord(run.result) ? run.result : null;
  const output = Array.isArray(result?.output) ? result.output : [];
  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    model: readString(data, ["model"]) ?? readString(result, ["model"]),
    prompt: generationPrompt(data),
    outputs: output
      .map((block, index) => (isRecord(block) ? generationOutput(block, index) : null))
      .filter((item): item is GenerationOutput => item !== null),
    outputCount: output.length,
  };
}
