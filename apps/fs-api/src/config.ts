import { resolveLogtoEndpoint } from "@cohub/identity";
import type { SpaceFsConfig } from "@cohub/space-fs";

const env = (process.env.ENV === "prod" ? "prod" : "dev") as "dev" | "prod";

export type FsApiConfig = SpaceFsConfig & {
  logtoEndpoint: string;
  redisUrl: string;
};

export const config: FsApiConfig = {
  env,
  appEncryptionKey: process.env.APP_ENCRYPTION_KEY ?? "",
  workerSecret: process.env.WORKER_SECRET ?? "",
  logtoEndpoint: resolveLogtoEndpoint({ endpoint: process.env.LOGTO_ENDPOINT, env }),
  redisUrl: process.env.REDIS_URL ?? "",
  bullmqRedisUrl: process.env.BULLMQ_REDIS_URL ?? "",
  spaceStorageRoot: process.env.SPACE_STORAGE_ROOT ?? "",
  spaceSystemRoot: process.env.SPACE_SYSTEM_ROOT ?? "",
  turnObjectS3Endpoint: process.env.TURN_OBJECT_S3_ENDPOINT ?? "https://oss-us-west-1-internal.aliyuncs.com",
  turnObjectS3PublicEndpoint: process.env.TURN_OBJECT_S3_PUBLIC_ENDPOINT,
  turnObjectS3Region: process.env.TURN_OBJECT_S3_REGION ?? "us-west-1",
  turnObjectS3Bucket: process.env.TURN_OBJECT_S3_BUCKET ?? "cohub-sessions",
  turnObjectS3AccessKeyId: process.env.TURN_OBJECT_S3_ACCESS_KEY_ID,
  turnObjectS3SecretAccessKey: process.env.TURN_OBJECT_S3_SECRET_ACCESS_KEY,
  turnObjectCdnBaseUrl: (process.env.TURN_OBJECT_CDN_BASE_URL ?? "https://sessions.cohub.run").replace(/\/+$/, ""),
  checkpointAssetOssEndpoint: process.env.CHECKPOINT_ASSET_OSS_ENDPOINT ?? process.env.TURN_OBJECT_S3_ENDPOINT ?? "https://oss-us-west-1-internal.aliyuncs.com",
  checkpointAssetOssPublicEndpoint: process.env.CHECKPOINT_ASSET_OSS_PUBLIC_ENDPOINT ?? process.env.TURN_OBJECT_S3_PUBLIC_ENDPOINT,
  checkpointAssetOssRegion: process.env.CHECKPOINT_ASSET_OSS_REGION ?? process.env.TURN_OBJECT_S3_REGION ?? "us-west-1",
  checkpointAssetOssBucket: process.env.CHECKPOINT_ASSET_OSS_BUCKET ?? process.env.TURN_OBJECT_S3_BUCKET,
  checkpointAssetOssAccessKeyId: process.env.CHECKPOINT_ASSET_OSS_ACCESS_KEY_ID ?? process.env.TURN_OBJECT_S3_ACCESS_KEY_ID,
  checkpointAssetOssSecretAccessKey: process.env.CHECKPOINT_ASSET_OSS_SECRET_ACCESS_KEY ?? process.env.TURN_OBJECT_S3_SECRET_ACCESS_KEY,
};

export const assertRequiredConfig = () => {
  if (!config.redisUrl) throw new Error("Missing required env: REDIS_URL");
  if (!config.appEncryptionKey) throw new Error("Missing required env: APP_ENCRYPTION_KEY");
  if (!config.bullmqRedisUrl) throw new Error("Missing required env: BULLMQ_REDIS_URL");
  if (!config.spaceStorageRoot) throw new Error("Missing required env: SPACE_STORAGE_ROOT");
};
