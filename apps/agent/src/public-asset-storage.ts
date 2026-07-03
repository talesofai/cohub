import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { AGENT_IMAGE_MAX_INPUT_BYTES } from "./image-normalizer.js";
import { env } from "./env.js";

const RELAXED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/tiff", "application/octet-stream"]);

let publicAssetS3Client: S3Client | null = null;

const getPublicAssetS3Client = () => {
  if (!env.PUBLIC_ASSET_OSS_BUCKET) return null;
  if (!env.PUBLIC_ASSET_OSS_ENDPOINT) return null;
  if (!env.PUBLIC_ASSET_OSS_ACCESS_KEY_ID || !env.PUBLIC_ASSET_OSS_SECRET_ACCESS_KEY) return null;
  publicAssetS3Client ??= new S3Client({
    endpoint: env.PUBLIC_ASSET_OSS_ENDPOINT,
    region: env.PUBLIC_ASSET_OSS_REGION,
    forcePathStyle: false,
    credentials: {
      accessKeyId: env.PUBLIC_ASSET_OSS_ACCESS_KEY_ID,
      secretAccessKey: env.PUBLIC_ASSET_OSS_SECRET_ACCESS_KEY,
    },
  });
  return publicAssetS3Client;
};

const decodeObjectKeyPath = (value: string) =>
  value
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
    .join("/");

const objectKeyFromBaseUrl = (url: URL, baseValue: string | undefined) => {
  if (!baseValue) return null;
  let base: URL;
  try {
    base = new URL(baseValue);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" || url.origin !== base.origin) return null;
  const basePath = base.pathname.replace(/\/+$/, "");
  if (basePath && !url.pathname.startsWith(`${basePath}/`)) return null;
  const keyPath = basePath ? url.pathname.slice(basePath.length + 1) : url.pathname.replace(/^\/+/, "");
  return decodeObjectKeyPath(keyPath);
};

const isChatAttachmentObjectKey = (objectKey: string) => {
  const prefix = env.ENV === "prod" ? "chat-attachments/" : `${env.ENV}/chat-attachments/`;
  return objectKey.startsWith(prefix);
};

export const publicAssetObjectKeyFromUrl = (value: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const objectKey = objectKeyFromBaseUrl(url, env.PUBLIC_ASSET_CDN_BASE_URL);
  if (!objectKey || !isChatAttachmentObjectKey(objectKey)) return null;
  return objectKey;
};

const bodyToBuffer = async (body: unknown, maxBytes: number) => {
  if (!body) return null;
  const chunks: Buffer[] = [];
  let size = 0;

  if (Symbol.asyncIterator in Object(body)) {
    for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxBytes) return null;
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  }

  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    if (bytes.byteLength > maxBytes) return null;
    return Buffer.from(bytes);
  }

  return null;
};

export async function readPublicAssetImageUrl(url: string) {
  const objectKey = publicAssetObjectKeyFromUrl(url);
  if (!objectKey) return null;
  const client = getPublicAssetS3Client();
  if (!client || !env.PUBLIC_ASSET_OSS_BUCKET) return null;

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), env.PUBLIC_ASSET_OSS_TIMEOUT_MS);
  try {
    const result = await client.send(new GetObjectCommand({
      Bucket: env.PUBLIC_ASSET_OSS_BUCKET,
      Key: objectKey,
    }), { abortSignal: abortController.signal });
    const mimeType = result.ContentType?.split(";")[0]?.trim().toLowerCase() ?? "application/octet-stream";
    if (mimeType && !RELAXED_IMAGE_MIME_TYPES.has(mimeType) && !mimeType.startsWith("image/")) return null;
    if (result.ContentLength && result.ContentLength > AGENT_IMAGE_MAX_INPUT_BYTES) return null;
    const buffer = await bodyToBuffer(result.Body, AGENT_IMAGE_MAX_INPUT_BYTES);
    if (!buffer) return null;
    return { data: buffer, mimeType };
  } finally {
    clearTimeout(timeout);
  }
}
