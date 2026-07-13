import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { buildPublicObjectUrl, type PresignStorageConfig } from "./object-presign.js";
import { config } from "./config.js";
import {
  assertDeleteObjectsSucceeded,
  createCloudflareWorkAssetPrefix,
  purgeCloudflareWorkAssetPrefixes,
  workAssetPrefixFromObjectKey,
} from "./work-asset-delete.js";

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

const encodeObjectKeyPath = (objectKey: string) => objectKey.split("/").map(encodeURIComponent).join("/");

export const createWorkAssetPublicUrl = (objectKey: string) => {
  const baseUrl = config.workAssetCdnBaseUrl || config.publicAssetCdnBaseUrl;
  if (baseUrl) return `${baseUrl}/${encodeObjectKeyPath(objectKey)}`;
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

const deleteWorkAssetObjectsByObjectKey = async (objectKey: string) => {
  const prefix = workAssetPrefixFromObjectKey(objectKey);
  const storage = requireStorage();
  const client = getS3Client();
  let continuationToken: string | undefined;
  let deleted = 0;
  do {
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: storage.bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    const objects = (listed.Contents ?? [])
      .map((item) => item.Key)
      .filter((key): key is string => typeof key === "string" && key.length > 0);
    for (let i = 0; i < objects.length; i += 1000) {
      const batch = objects.slice(i, i + 1000);
      if (batch.length === 0) continue;
      const result = await client.send(new DeleteObjectsCommand({
        Bucket: storage.bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }));
      deleted += assertDeleteObjectsSucceeded(batch, result);
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  return { deleted };
};

export const deleteWorkAssetsByObjectKeys = async (objectKeys: string[]) => {
  const uniqueObjectKeys = Array.from(new Set(objectKeys));
  if (uniqueObjectKeys.length === 0) return { deleted: 0 };

  const failures: Error[] = [];
  let deleted = 0;
  for (const objectKey of uniqueObjectKeys) {
    try {
      deleted += (await deleteWorkAssetObjectsByObjectKey(objectKey)).deleted;
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "work asset storage cleanup failed");

  const cdnBaseUrl = config.workAssetCdnBaseUrl || config.publicAssetCdnBaseUrl;
  if (cdnBaseUrl) {
    await purgeCloudflareWorkAssetPrefixes({
      zoneId: config.workAssetCdnCloudflareZoneId ?? "",
      apiToken: config.workAssetCdnCloudflareApiToken ?? "",
      prefixes: uniqueObjectKeys.map((objectKey) => createCloudflareWorkAssetPrefix(cdnBaseUrl, objectKey)),
    });
  }
  return { deleted };
};
