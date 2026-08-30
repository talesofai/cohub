import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedGetObjectUrl, createPresignedPutObjectUrl, type PresignStorageConfig } from "./object-presign.js";
import { config } from "./config.js";

export class LocalAgentObjectStorageError extends Error {
  override name = "LocalAgentObjectStorageError";
}

const requireStorage = (): PresignStorageConfig & {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
} => {
  if (!config.workspaceObjectBucket) throw new LocalAgentObjectStorageError("WORKSPACE_OBJECT_BUCKET or SPACE_UPLOAD_S3_BUCKET is required");
  if (!config.workspaceObjectEndpoint) throw new LocalAgentObjectStorageError("WORKSPACE_OBJECT_ENDPOINT or USER_UPLOAD_S3_ENDPOINT is required");
  if (!config.workspaceObjectAccessKeyId || !config.workspaceObjectSecretAccessKey) {
    throw new LocalAgentObjectStorageError("workspace object storage credentials are required");
  }
  return {
    endpoint: config.workspaceObjectEndpoint,
    publicEndpoint: config.workspaceObjectEndpoint,
    region: config.workspaceObjectRegion,
    bucket: config.workspaceObjectBucket,
    accessKeyId: config.workspaceObjectAccessKeyId,
    secretAccessKey: config.workspaceObjectSecretAccessKey,
    includeUnsignedPayloadQuery: true,
  };
};

let client: S3Client | null = null;
const getClient = () => {
  const storage = requireStorage();
  client ??= new S3Client({
    endpoint: storage.endpoint,
    region: storage.region,
    forcePathStyle: false,
    credentials: {
      accessKeyId: storage.accessKeyId,
      secretAccessKey: storage.secretAccessKey,
    },
  });
  return { client, storage };
};

const assertObjectKey = (value: string) => {
  const key = value.trim().replace(/^\/+/, "");
  if (!key || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new LocalAgentObjectStorageError("invalid local agent object key");
  }
  return key;
};

const envPrefix = () => config.env === "prod" ? "" : `${config.env}/`;

export const buildLocalAgentObjectKey = (input: {
  spaceId: string;
  kind: "manifest" | "blob" | "native_payload";
  identity: string;
}) => {
  const identity = assertObjectKey(input.identity);
  return `${envPrefix()}local-agent/${input.kind}/${input.spaceId}/${identity}`;
};

export const createLocalAgentObjectPutUrl = (input: {
  objectKey: string;
  contentType: string;
  contentLength: number;
  sha256: string;
}) => {
  const { storage } = getClient();
  return createPresignedPutObjectUrl(
    storage,
    assertObjectKey(input.objectKey),
    input.contentType,
    "private, max-age=0",
    undefined,
    {
      contentLength: input.contentLength,
      checksumSha256Base64: Buffer.from(input.sha256, "hex").toString("base64"),
    },
  );
};

export const createLocalAgentObjectGetUrl = (objectKey: string) => {
  const { storage } = getClient();
  return createPresignedGetObjectUrl(storage, assertObjectKey(objectKey));
};

export async function headLocalAgentObject(objectKey: string): Promise<{
  size: number;
  etag: string | null;
  contentType: string | null;
}> {
  const { client: s3, storage } = getClient();
  const result = await s3.send(new HeadObjectCommand({
    Bucket: storage.bucket,
    Key: assertObjectKey(objectKey),
  }));
  const size = result.ContentLength;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new LocalAgentObjectStorageError("object storage returned an invalid content length");
  }
  return {
    size,
    etag: result.ETag?.replace(/^"|"$/g, "") ?? null,
    contentType: result.ContentType ?? null,
  };
}
