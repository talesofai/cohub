export interface WorkerConfig {
  redisUrl: string;
  bullmqRedisUrl: string;
  databaseUrl: string;
  giteaBaseUrl: string;
  giteaToken?: string;
  giteaOrg: string;
  workerSecret: string;
  appEncryptionKey: string;
  spaceStorageRoot: string;
  spaceSystemRoot: string;
  checkpointCacheRoot: string;
  spaceStorageSubpath: string;
  checkpointCacheSubpath: string;
  checkpointAssetThresholdBytes: number;
  platformConfigRoot: string;
  platformSpaceId: string;
  generationApiKey: string;
  generationBaseUrl?: string;
  turnObjectS3Endpoint?: string;
  turnObjectS3Region: string;
  turnObjectS3Bucket?: string;
  turnObjectCdnBaseUrl: string;
  turnObjectS3AccessKeyId?: string;
  turnObjectS3SecretAccessKey?: string;
  publicAssetOssEndpoint?: string;
  publicAssetOssRegion: string;
  publicAssetOssBucket?: string;
  publicAssetOssAccessKeyId?: string;
  publicAssetOssSecretAccessKey?: string;
  checkpointAssetOssEndpoint?: string;
  checkpointAssetOssRegion: string;
  checkpointAssetOssBucket?: string;
  checkpointAssetOssAccessKeyId?: string;
  checkpointAssetOssSecretAccessKey?: string;
  talesofaiBillingBaseUrl?: string;
  talesofaiBillingBusinessKey?: string;
  talesofaiBillingAdminApiKey?: string;
  env: "dev" | "prod";
  /** Author email for checkpoint git commits. */
  checkpointGitAuthorEmail: string;
  workspaceObjectEndpoint?: string;
  workspaceObjectRegion: string;
  workspaceObjectBucket?: string;
  workspaceObjectAccessKeyId?: string;
  workspaceObjectSecretAccessKey?: string;
  workspaceReplicationEnabled: boolean;
}

const env = (process.env.ENV === "prod" ? "prod" : "dev") as "dev" | "prod";

const parseBoolean = (value: string | undefined, fallback: boolean, name: string) => {
  if (value == null || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
};

const assertRedisUrl = (value: string, envName: string) => {
  if (!value) throw new Error(`Missing required env: ${envName}`);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      throw new Error("invalid protocol");
    }
  } catch {
    throw new Error(`Invalid ${envName}: must be a redis:// or rediss:// URL`);
  }
};

export const config: WorkerConfig = {
  redisUrl: process.env.REDIS_URL ?? "",
  bullmqRedisUrl: process.env.BULLMQ_REDIS_URL ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  giteaBaseUrl: process.env.GITEA_BASE_URL ?? "",
  giteaToken: process.env.GITEA_TOKEN,
  giteaOrg: process.env.GITEA_ORG ?? "cohub-spaces",
  workerSecret: process.env.WORKER_SECRET ?? "",
  appEncryptionKey: process.env.APP_ENCRYPTION_KEY ?? "",
  spaceStorageRoot: process.env.SPACE_STORAGE_ROOT ?? "",
  spaceSystemRoot: process.env.SPACE_SYSTEM_ROOT ?? process.env.SPACE_STORAGE_ROOT ?? "",
  checkpointCacheRoot: process.env.CHECKPOINT_CACHE_ROOT ?? process.env.SPACE_STORAGE_ROOT ?? "",
  spaceStorageSubpath: process.env.SPACE_STORAGE_SUBPATH ?? (env === "prod" ? "cohub-prod" : "cohub-dev"),
  checkpointCacheSubpath: process.env.CHECKPOINT_CACHE_SUBPATH ?? `${process.env.SPACE_STORAGE_SUBPATH ?? (env === "prod" ? "cohub-prod" : "cohub-dev")}/checkpoints`,
  checkpointAssetThresholdBytes: Number(process.env.CHECKPOINT_ASSET_THRESHOLD_BYTES ?? 4 * 1024 * 1024),
  platformConfigRoot: process.env.PLATFORM_CONFIG_ROOT ?? "/configs",
  platformSpaceId: process.env.PLATFORM_SPACE_ID ?? "",
  generationApiKey: process.env.GENERATION_API_KEY ?? "",
  generationBaseUrl: process.env.GENERATION_BASE_URL?.trim() || undefined,
  turnObjectS3Endpoint: process.env.TURN_OBJECT_S3_ENDPOINT ?? "http://127.0.0.1:9000",
  turnObjectS3Region: process.env.TURN_OBJECT_S3_REGION ?? "us-west-1",
  turnObjectS3Bucket: process.env.TURN_OBJECT_S3_BUCKET ?? "cohub-sessions",
  turnObjectCdnBaseUrl: (process.env.TURN_OBJECT_CDN_BASE_URL ?? "https://sessions.cohub.live").replace(/\/+$/, ""),
  turnObjectS3AccessKeyId: process.env.TURN_OBJECT_S3_ACCESS_KEY_ID,
  turnObjectS3SecretAccessKey: process.env.TURN_OBJECT_S3_SECRET_ACCESS_KEY,
  publicAssetOssEndpoint: process.env.PUBLIC_ASSET_OSS_ENDPOINT,
  publicAssetOssRegion: process.env.PUBLIC_ASSET_OSS_REGION ?? "us-west-1",
  publicAssetOssBucket: process.env.PUBLIC_ASSET_OSS_BUCKET,
  publicAssetOssAccessKeyId: process.env.PUBLIC_ASSET_OSS_ACCESS_KEY_ID,
  publicAssetOssSecretAccessKey: process.env.PUBLIC_ASSET_OSS_SECRET_ACCESS_KEY,
  checkpointAssetOssEndpoint: process.env.CHECKPOINT_ASSET_OSS_ENDPOINT ?? process.env.TURN_OBJECT_S3_ENDPOINT ?? "http://127.0.0.1:9000",
  checkpointAssetOssRegion: process.env.CHECKPOINT_ASSET_OSS_REGION ?? process.env.TURN_OBJECT_S3_REGION ?? "us-west-1",
  checkpointAssetOssBucket: process.env.CHECKPOINT_ASSET_OSS_BUCKET ?? process.env.TURN_OBJECT_S3_BUCKET,
  checkpointAssetOssAccessKeyId: process.env.CHECKPOINT_ASSET_OSS_ACCESS_KEY_ID ?? process.env.TURN_OBJECT_S3_ACCESS_KEY_ID,
  checkpointAssetOssSecretAccessKey: process.env.CHECKPOINT_ASSET_OSS_SECRET_ACCESS_KEY ?? process.env.TURN_OBJECT_S3_SECRET_ACCESS_KEY,
  talesofaiBillingBaseUrl: process.env.TALESOFAI_BILLING_BASE_URL?.replace(/\/+$/, ""),
  talesofaiBillingBusinessKey: process.env.TALESOFAI_BILLING_BUSINESS_KEY,
  talesofaiBillingAdminApiKey: process.env.TALESOFAI_BILLING_ADMIN_API_KEY,
  env,
  checkpointGitAuthorEmail: process.env.CHECKPOINT_GIT_AUTHOR_EMAIL?.trim() || "noreply@cohub.live",
  workspaceObjectEndpoint: process.env.WORKSPACE_OBJECT_ENDPOINT ?? process.env.USER_UPLOAD_S3_ENDPOINT,
  workspaceObjectRegion: process.env.WORKSPACE_OBJECT_REGION ?? process.env.USER_UPLOAD_S3_REGION ?? "auto",
  workspaceObjectBucket: process.env.WORKSPACE_OBJECT_BUCKET ?? process.env.SPACE_UPLOAD_S3_BUCKET,
  workspaceObjectAccessKeyId: process.env.WORKSPACE_OBJECT_ACCESS_KEY_ID ?? process.env.USER_UPLOAD_S3_ACCESS_KEY_ID,
  workspaceObjectSecretAccessKey: process.env.WORKSPACE_OBJECT_SECRET_ACCESS_KEY ?? process.env.USER_UPLOAD_S3_SECRET_ACCESS_KEY,
  workspaceReplicationEnabled: parseBoolean(process.env.WORKSPACE_REPLICATION_ENABLED, env === "dev", "WORKSPACE_REPLICATION_ENABLED"),
};

export const assertRequiredConfig = () => {
  assertRedisUrl(config.redisUrl, "REDIS_URL");
  assertRedisUrl(config.bullmqRedisUrl, "BULLMQ_REDIS_URL");
  if (!config.databaseUrl) throw new Error("Missing required env: DATABASE_URL");
  if (!config.giteaBaseUrl) throw new Error("Missing required env: GITEA_BASE_URL");
  if (!config.workerSecret) throw new Error("Missing required env: WORKER_SECRET");
  if (!config.appEncryptionKey) throw new Error("Missing required env: APP_ENCRYPTION_KEY");
  if (!config.spaceStorageRoot) throw new Error("Missing required env: SPACE_STORAGE_ROOT");
  if (!config.spaceSystemRoot) throw new Error("Missing required env: SPACE_SYSTEM_ROOT");
  if (!config.checkpointCacheRoot) throw new Error("Missing required env: CHECKPOINT_CACHE_ROOT");
  if (config.workspaceReplicationEnabled) {
    if (!config.workspaceObjectEndpoint) throw new Error("Missing required env: WORKSPACE_OBJECT_ENDPOINT");
    if (!config.workspaceObjectBucket) throw new Error("Missing required env: WORKSPACE_OBJECT_BUCKET");
    if (!config.workspaceObjectAccessKeyId) throw new Error("Missing required env: WORKSPACE_OBJECT_ACCESS_KEY_ID");
    if (!config.workspaceObjectSecretAccessKey) throw new Error("Missing required env: WORKSPACE_OBJECT_SECRET_ACCESS_KEY");
  }
};
