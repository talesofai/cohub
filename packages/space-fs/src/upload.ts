import { createHash, createHmac, randomUUID } from "node:crypto";
import type { SpaceFsDeps } from "./types.js";

const UPLOAD_TTL_SECONDS = 24 * 60 * 60;
const PRESIGN_TTL_SECONDS = 60 * 60;

export type SpaceUploadManifestEntry = {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  mimeType: string | null;
  objectKey: string;
};

export type SpaceUploadDestination =
  | { kind: "workspace"; targetDir?: string }
  | { kind: "sandbox_tmp"; sessionId: string };

export type SpaceUploadManifest = {
  uploadId: string;
  spaceId: string;
  userId: string;
  destination: SpaceUploadDestination;
  entries: SpaceUploadManifestEntry[];
  createdAt: string;
  expiresAt: string;
};

const toAmzDate = (date: Date) => date.toISOString().replace(/[:-]|\.\d{3}/g, "");
const toDateStamp = (date: Date) => toAmzDate(date).slice(0, 8);
const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();
const hexHmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest("hex");
const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

const signingKey = (secret: string, dateStamp: string, region: string) => {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
};

const encodePath = (value: string) => value.split("/").map(encodeURIComponent).join("/");

const bucketEndpoint = (bucket: string, endpoint: string | undefined) => {
  if (!endpoint) throw new Error("TURN_OBJECT_S3_ENDPOINT is required for uploads");
  const parsed = new URL(endpoint.replace(/\/+$/, ""));
  if (!parsed.hostname.startsWith(`${bucket}.`)) {
    parsed.hostname = `${bucket}.${parsed.hostname}`;
  }
  return parsed.toString().replace(/\/+$/, "");
};

export function createSpaceUpload(deps: SpaceFsDeps) {
  const { config, redis } = deps;

  const requireObjectConfig = () => {
    if (!config.turnObjectS3Bucket) throw new Error("TURN_OBJECT_S3_BUCKET is required for uploads");
    if (!config.turnObjectS3Endpoint) throw new Error("TURN_OBJECT_S3_ENDPOINT is required for uploads");
    if (!config.turnObjectS3AccessKeyId || !config.turnObjectS3SecretAccessKey) {
      throw new Error("TURN_OBJECT_S3_ACCESS_KEY_ID and TURN_OBJECT_S3_SECRET_ACCESS_KEY are required for uploads");
    }
  };

  const createSpaceUploadId = () => randomUUID();

  const buildSpaceUploadObjectKey = (input: { spaceId: string; uploadId: string; entryId: string }) => {
    const envPrefix = config.env === "prod" ? "" : `${config.env}/`;
    return `${envPrefix}uploads/${input.spaceId}/${input.uploadId}/${input.entryId}`;
  };

  const manifestKey = (spaceId: string, uploadId: string) => `space:fs:upload:${spaceId}:${uploadId}`;
  const completeKey = (spaceId: string, uploadId: string) => `space:fs:upload:complete:${spaceId}:${uploadId}`;

  const saveSpaceUploadManifest = async (manifest: SpaceUploadManifest) => {
    await redis.set(
      manifestKey(manifest.spaceId, manifest.uploadId),
      JSON.stringify(manifest),
      "EX",
      UPLOAD_TTL_SECONDS,
    );
  };

  const getSpaceUploadManifest = async (spaceId: string, uploadId: string) => {
    const raw = await redis.get(manifestKey(spaceId, uploadId));
    return raw ? JSON.parse(raw) as SpaceUploadManifest : null;
  };

  const deleteSpaceUploadManifest = async (spaceId: string, uploadId: string) => {
    await redis.del(manifestKey(spaceId, uploadId));
  };

  const beginSpaceUploadComplete = async (spaceId: string, uploadId: string) => {
    const key = completeKey(spaceId, uploadId);
    const ok = await redis.set(key, "pending", "EX", UPLOAD_TTL_SECONDS, "NX");
    if (ok === "OK") return { acquired: true as const };
    return { acquired: false as const, taskRunId: await redis.get(key) };
  };

  const finishSpaceUploadComplete = async (spaceId: string, uploadId: string, taskRunId: string) => {
    await redis.set(completeKey(spaceId, uploadId), taskRunId, "EX", UPLOAD_TTL_SECONDS);
  };

  const cancelSpaceUploadComplete = async (spaceId: string, uploadId: string) => {
    const key = completeKey(spaceId, uploadId);
    const value = await redis.get(key);
    if (value === "pending") await redis.del(key);
  };

  const publicEndpoint = (bucket: string) => bucketEndpoint(bucket, config.turnObjectS3PublicEndpoint ?? config.turnObjectS3Endpoint?.replace("-internal.", "."));
  const internalEndpoint = (bucket: string) => bucketEndpoint(bucket, config.turnObjectS3Endpoint);

  const createPresignedObjectUrl = (method: "GET" | "PUT", objectKey: string, options: { contentType?: string | null; internalEndpoint?: boolean } = {}) => {
    requireObjectConfig();
    const accessKeyId = config.turnObjectS3AccessKeyId as string;
    const secretAccessKey = config.turnObjectS3SecretAccessKey as string;
    const region = config.turnObjectS3Region;
    const bucket = config.turnObjectS3Bucket as string;
    const now = new Date();
    const amzDate = toAmzDate(now);
    const dateStamp = toDateStamp(now);
    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const endpoint = options.internalEndpoint ? internalEndpoint(bucket) : publicEndpoint(bucket);
    const url = new URL(`${endpoint}/${encodePath(objectKey)}`);
    const headers: Record<string, string> = { host: url.host };
    if (method === "PUT" && options.contentType) headers["content-type"] = options.contentType;
    const signedHeaders = Object.keys(headers).sort().join(";");
    url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
    url.searchParams.set("X-Amz-Credential", `${accessKeyId}/${credentialScope}`);
    url.searchParams.set("X-Amz-Date", amzDate);
    url.searchParams.set("X-Amz-Expires", String(PRESIGN_TTL_SECONDS));
    url.searchParams.set("X-Amz-SignedHeaders", signedHeaders);

    const canonicalQuery = Array.from(url.searchParams.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
    const canonicalHeaders = Object.entries(headers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}:${value}\n`)
      .join("");
    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const signature = hexHmac(signingKey(secretAccessKey, dateStamp, region), stringToSign);
    url.searchParams.set("X-Amz-Signature", signature);

    return {
      url: url.toString(),
      expiresAt: new Date(now.getTime() + PRESIGN_TTL_SECONDS * 1000).toISOString(),
      headers: method === "PUT" && options.contentType ? { "content-type": options.contentType } : undefined,
    };
  };

  const createPresignedPutUrl = (objectKey: string, contentType?: string | null) => {
    const signed = createPresignedObjectUrl("PUT", objectKey, { contentType });
    return { uploadUrl: signed.url, expiresAt: signed.expiresAt, headers: signed.headers };
  };

  const createInternalPresignedPutUrl = (objectKey: string, contentType?: string | null) => {
    const signed = createPresignedObjectUrl("PUT", objectKey, { contentType, internalEndpoint: true });
    return { uploadUrl: signed.url, expiresAt: signed.expiresAt, headers: signed.headers };
  };

  const createPresignedGetUrl = (objectKey: string) => {
    const signed = createPresignedObjectUrl("GET", objectKey);
    return { downloadUrl: signed.url, expiresAt: signed.expiresAt };
  };

  return {
    createSpaceUploadId,
    buildSpaceUploadObjectKey,
    saveSpaceUploadManifest,
    getSpaceUploadManifest,
    deleteSpaceUploadManifest,
    beginSpaceUploadComplete,
    finishSpaceUploadComplete,
    cancelSpaceUploadComplete,
    createPresignedPutUrl,
    createInternalPresignedPutUrl,
    createPresignedGetUrl,
  };
}

export type SpaceUpload = ReturnType<typeof createSpaceUpload>;
