import { createHash } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { buildPublicObjectUrl, cacheBuster, type PresignStorageConfig } from "./object-presign.js";
import { config } from "./config.js";

const MAX_WORK_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_WORK_SITE_BYTES = 100 * 1024 * 1024;
const MAX_WORK_SITE_FILES = 1000;
const WORK_SITE_UPLOAD_CONCURRENCY = 8;

let s3Client: S3Client | null = null;

const getStorage = (): PresignStorageConfig => ({
  endpoint: config.publicAssetOssEndpoint,
  publicEndpoint: config.publicAssetOssPublicEndpoint,
  region: config.publicAssetOssRegion,
  bucket: config.publicAssetOssBucket,
  accessKeyId: config.publicAssetOssAccessKeyId,
  secretAccessKey: config.publicAssetOssSecretAccessKey,
});

const requireStorage = (): PresignStorageConfig & {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
} => {
  const storage = getStorage();
  if (!storage.bucket || !storage.endpoint || !storage.accessKeyId || !storage.secretAccessKey) {
    throw new Error("work asset storage is not configured");
  }
  return {
    ...storage,
    bucket: storage.bucket,
    endpoint: storage.endpoint,
    accessKeyId: storage.accessKeyId,
    secretAccessKey: storage.secretAccessKey,
  };
};

const getS3Client = () => {
  const storage = requireStorage();
  s3Client ??= new S3Client({
    endpoint: storage.endpoint,
    region: storage.region,
    forcePathStyle: false,
    credentials: {
      accessKeyId: storage.accessKeyId,
      secretAccessKey: storage.secretAccessKey,
    },
  });
  return s3Client;
};

const envPrefix = () => (config.env === "prod" ? "" : `${config.env}/`);
const encodeObjectKeyPath = (objectKey: string) => objectKey.split("/").map(encodeURIComponent).join("/");

export const buildWorkAssetPrefix = (input: { spaceId: string; workSlug: string }) =>
  `${envPrefix()}w/${input.spaceId}/${input.workSlug}/${cacheBuster()}`;

export const buildWorkAssetObjectKey = (input: { spaceId: string; workSlug: string }) =>
  `${buildWorkAssetPrefix(input)}/index.html`;

export const createWorkAssetPublicUrl = (objectKey: string) => {
  if (config.publicAssetCdnBaseUrl) return `${config.publicAssetCdnBaseUrl}/${encodeObjectKeyPath(objectKey)}`;
  return buildPublicObjectUrl(requireStorage(), objectKey);
};

export const isConfiguredWorkAssetPublicUrl = (url: string) => {
  try {
    const expected = new URL(createWorkAssetPublicUrl("index.html"));
    const actual = new URL(url);
    return actual.protocol === "https:" && actual.origin === expected.origin;
  } catch {
    return false;
  }
};

const mapWithConcurrency = async <T>(items: T[], concurrency: number, mapper: (item: T) => Promise<void>) => {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await mapper(items[index] as T);
    }
  });
  await Promise.all(workers);
};

const putWorkAssetObject = async (input: {
  objectKey: string;
  body: Buffer | string;
  contentType: string;
  sha256: string;
}) => {
  await getS3Client().send(new PutObjectCommand({
    Bucket: requireStorage().bucket,
    Key: input.objectKey,
    Body: input.body,
    ContentType: input.contentType,
    Metadata: { sha256: input.sha256 },
  }));
};

export const writeWorkHtmlAsset = async (input: {
  spaceId: string;
  workSlug: string;
  html: string;
}) => {
  const content = input.html;
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes <= 0 || sizeBytes > MAX_WORK_ASSET_BYTES) {
    throw new Error("work asset must be 1 byte to 5MB");
  }
  const objectKey = buildWorkAssetObjectKey({ spaceId: input.spaceId, workSlug: input.workSlug });
  const sha256 = createHash("sha256").update(content).digest("hex");
  await putWorkAssetObject({
    objectKey,
    body: content,
    contentType: "text/html; charset=utf-8",
    sha256,
  });
  return {
    objectKey,
    publicUrl: createWorkAssetPublicUrl(objectKey),
    sizeBytes,
    sha256,
  };
};

export const writeWorkSiteAssets = async (input: {
  spaceId: string;
  workSlug: string;
  files: Array<{ relativePath: string; content: Buffer; mimeType: string | null }>;
}) => {
  if (input.files.length <= 0 || input.files.length > MAX_WORK_SITE_FILES) {
    throw new Error(`work site must contain 1 to ${MAX_WORK_SITE_FILES} files`);
  }
  if (!input.files.some((file) => file.relativePath === "index.html")) {
    throw new Error("work site must contain index.html");
  }
  const totalBytes = input.files.reduce((sum, file) => sum + file.content.byteLength, 0);
  if (totalBytes <= 0 || totalBytes > MAX_WORK_SITE_BYTES) {
    throw new Error("work site must be 1 byte to 100MB");
  }
  const prefix = buildWorkAssetPrefix({ spaceId: input.spaceId, workSlug: input.workSlug });
  await mapWithConcurrency(input.files, WORK_SITE_UPLOAD_CONCURRENCY, async (file) => {
    const objectKey = `${prefix}/${file.relativePath}`;
    const sha256 = createHash("sha256").update(file.content).digest("hex");
    await putWorkAssetObject({
      objectKey,
      body: file.content,
      contentType: file.mimeType ?? "application/octet-stream",
      sha256,
    });
  });
  const objectKey = `${prefix}/index.html`;
  return {
    objectKey,
    publicUrl: createWorkAssetPublicUrl(objectKey),
    sizeBytes: totalBytes,
    fileCount: input.files.length,
  };
};
