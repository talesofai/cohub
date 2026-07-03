import { createHash, createHmac, randomUUID } from "node:crypto";

export type PresignStorageConfig = {
  endpoint?: string;
  publicEndpoint?: string;
  region: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
};

const PRESIGN_TTL_SECONDS = 60 * 60;

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();
const hexHmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest("hex");
const toAmzDate = (date: Date) => date.toISOString().replace(/[:-]|\.\d{3}/g, "");
const toDateStamp = (date: Date) => toAmzDate(date).slice(0, 8);
const encodePath = (value: string) => value.split("/").map(encodeURIComponent).join("/");

const signingKey = (secret: string, dateStamp: string, region: string) => {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
};

export const getBucketPublicEndpoint = (storage: PresignStorageConfig) => {
  if (!storage.bucket) throw new Error("bucket is required");
  const endpoint = storage.publicEndpoint ?? storage.endpoint?.replace("-internal.", ".");
  if (!endpoint) throw new Error("endpoint is required");
  const parsed = new URL(endpoint.replace(/\/+$/, ""));
  if (!parsed.hostname.startsWith(`${storage.bucket}.`)) {
    parsed.hostname = `${storage.bucket}.${parsed.hostname}`;
  }
  return parsed.toString().replace(/\/+$/, "");
};

const createPresignedObjectUrl = (
  method: "GET" | "PUT",
  storage: PresignStorageConfig,
  objectKey: string,
  contentType?: string | null,
  cacheControl?: string | null,
) => {
  if (!storage.bucket) throw new Error("bucket is required");
  if (!storage.endpoint) throw new Error("endpoint is required");
  if (!storage.accessKeyId || !storage.secretAccessKey) {
    throw new Error("access key id and secret access key are required");
  }

  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = toDateStamp(now);
  const credentialScope = `${dateStamp}/${storage.region}/s3/aws4_request`;
  const endpoint = getBucketPublicEndpoint(storage);
  const url = new URL(`${endpoint}/${encodePath(objectKey)}`);
  const headers = {
    host: url.host,
    ...(method === "PUT" && contentType ? { "content-type": contentType } : {}),
    ...(method === "PUT" && cacheControl ? { "cache-control": cacheControl } : {}),
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${storage.accessKeyId}/${credentialScope}`);
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
  const signature = hexHmac(signingKey(storage.secretAccessKey, dateStamp, storage.region), stringToSign);
  url.searchParams.set("X-Amz-Signature", signature);

  const uploadHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => key !== "host"));
  return {
    url: url.toString(),
    expiresAt: new Date(now.getTime() + PRESIGN_TTL_SECONDS * 1000).toISOString(),
    headers: method === "PUT" && Object.keys(uploadHeaders).length > 0 ? uploadHeaders : undefined,
  };
};

export const createPresignedPutObjectUrl = (
  storage: PresignStorageConfig,
  objectKey: string,
  contentType?: string | null,
  cacheControl?: string | null,
) => {
  const signed = createPresignedObjectUrl("PUT", storage, objectKey, contentType, cacheControl);
  return { uploadUrl: signed.url, expiresAt: signed.expiresAt, headers: signed.headers };
};

export const createPresignedGetObjectUrl = (
  storage: PresignStorageConfig,
  objectKey: string,
) => {
  const signed = createPresignedObjectUrl("GET", storage, objectKey);
  return { downloadUrl: signed.url, expiresAt: signed.expiresAt };
};

export const buildPublicObjectUrl = (storage: PresignStorageConfig, objectKey: string) =>
  `${getBucketPublicEndpoint(storage)}/${encodePath(objectKey)}`;

export const cacheBuster = () => randomUUID().replaceAll("-", "").slice(0, 12);

export type PresignedPostObject = {
  uploadUrl: string;
  expiresAt: string;
  fields: Record<string, string>;
};

export const createPresignedPostObject = (input: {
  storage: PresignStorageConfig;
  objectKey: string;
  contentType: string;
  maxBytes: number;
  cacheControl?: string | null;
}): PresignedPostObject => {
  const { storage, objectKey, contentType, maxBytes, cacheControl } = input;
  if (!storage.bucket) throw new Error("bucket is required");
  if (!storage.endpoint) throw new Error("endpoint is required");
  if (!storage.accessKeyId || !storage.secretAccessKey) {
    throw new Error("access key id and secret access key are required");
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + PRESIGN_TTL_SECONDS * 1000).toISOString();
  const amzDate = toAmzDate(now);
  const dateStamp = toDateStamp(now);
  const credential = `${storage.accessKeyId}/${dateStamp}/${storage.region}/s3/aws4_request`;
  const policy = {
    expiration: expiresAt,
    conditions: [
      { bucket: storage.bucket },
      { key: objectKey },
      { "Content-Type": contentType },
      ...(cacheControl ? [{ "Cache-Control": cacheControl }] : []),
      { "x-amz-algorithm": "AWS4-HMAC-SHA256" },
      { "x-amz-credential": credential },
      { "x-amz-date": amzDate },
      ["content-length-range", 1, maxBytes],
    ],
  };
  const encodedPolicy = Buffer.from(JSON.stringify(policy)).toString("base64");
  const signature = hexHmac(signingKey(storage.secretAccessKey, dateStamp, storage.region), encodedPolicy);

  return {
    uploadUrl: getBucketPublicEndpoint(storage),
    expiresAt,
    fields: {
      key: objectKey,
      "Content-Type": contentType,
      ...(cacheControl ? { "Cache-Control": cacheControl } : {}),
      "x-amz-algorithm": "AWS4-HMAC-SHA256",
      "x-amz-credential": credential,
      "x-amz-date": amzDate,
      policy: encodedPolicy,
      "x-amz-signature": signature,
    },
  };
};
