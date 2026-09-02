type RecordValue = Record<string, unknown>;

const BASE64_KEYS = ["data", "base64", "contentBase64"] as const;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(record: RecordValue | null, keys: readonly string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function detailOutputSource(result: unknown, outputIndex: number) {
  if (!isRecord(result) || !Array.isArray(result.output)) return null;
  const block = result.output[outputIndex];
  if (!isRecord(block)) return null;
  const source = isRecord(block.source) ? block.source : null;
  const url = readString(source, ["url", "src"]) ?? readString(block, ["url", "src"]);
  if (url) return url;
  const data = readString(source, BASE64_KEYS) ?? readString(block, BASE64_KEYS);
  if (!data) return null;
  const mediaType =
    readString(source, ["mediaType", "media_type", "mimeType"]) ??
    readString(block, ["mediaType", "media_type", "mimeType"]) ??
    (block.type === "video" ? "video/mp4" : block.type === "audio" ? "audio/mpeg" : "image/png");
  return `data:${mediaType};base64,${data}`;
}
