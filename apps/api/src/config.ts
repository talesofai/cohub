import { resolveLogtoEndpoint } from "@cohub/identity";

export type AppConfig = {
  logtoEndpoint: string;
  webOrigin?: string;
  redisUrl: string;
  litellmApiKey?: string;
  talesofaiBillingBaseUrl?: string;
  talesofaiBillingBusinessKey?: string;
  talesofaiBillingAdminApiKey?: string;
  env: "dev" | "prod";
  appEncryptionKey: string;
  sandboxImage: string;
  sandboxNodeSelector: Record<string, string>;
  sandboxTolerations: SandboxToleration[];
  bullmqRedisUrl: string;
  workerSecret: string;
  spaceStorageRoot: string;
  spaceStoragePvc: string;
  checkpointCachePvc: string;
  checkpointCacheRoot: string;
  spaceSystemRoot: string;
  spaceStorageSubpath: string;
  checkpointCacheSubpath: string;
  configsSubpath: string;
  platformConfigRoot: string;
  turnObjectS3Endpoint?: string;
  turnObjectS3PublicEndpoint?: string;
  turnObjectS3Region: string;
  turnObjectS3Bucket?: string;
  turnObjectS3AccessKeyId?: string;
  turnObjectS3SecretAccessKey?: string;
  turnObjectCdnBaseUrl: string;
  publicAssetOssEndpoint?: string;
  publicAssetOssPublicEndpoint?: string;
  publicAssetOssRegion: string;
  publicAssetOssBucket?: string;
  publicAssetOssAccessKeyId?: string;
  publicAssetOssSecretAccessKey?: string;
  publicAssetCdnBaseUrl?: string;
  workAssetCdnBaseUrl?: string;
  workAssetCdnCloudflareZoneId?: string;
  workAssetCdnCloudflareApiToken?: string;
  checkpointAssetOssEndpoint?: string;
  checkpointAssetOssPublicEndpoint?: string;
  checkpointAssetOssRegion: string;
  checkpointAssetOssBucket?: string;
  checkpointAssetOssAccessKeyId?: string;
  checkpointAssetOssSecretAccessKey?: string;
};

export type SandboxToleration = {
  key: string;
  operator: "Equal";
  value: string;
  effect?: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
};

const getSessionsNamespace = (env: string): string => {
  return env === "dev" ? "cohub-sessions-dev" : "cohub-sessions";
};

const getDefaultSandboxImage = (env: "dev" | "prod") => {
  return env === "prod"
    ? "git.talesofai.com/talesofai/cohub-sandbox:v20260325"
    : "git.talesofai.com/talesofai/cohub-sandbox:latest";
};

const env = (process.env.ENV === "prod" ? "prod" : "dev") as "dev" | "prod";

const parseCommaList = (value: string | undefined) => {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const parseSandboxNodeSelector = (value: string | undefined) => {
  return Object.fromEntries(
    parseCommaList(value).map((entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
        throw new Error("SANDBOX_NODE_SELECTOR must use key=value format");
      }
      const key = entry.slice(0, separatorIndex);
      const selectorValue = entry.slice(separatorIndex + 1);
      return [key.trim(), selectorValue.trim()];
    }),
  );
};

const parseSandboxTolerations = (value: string | undefined): SandboxToleration[] => {
  const effects = new Set(["NoSchedule", "PreferNoSchedule", "NoExecute"]);

  return parseCommaList(value).map((entry) => {
    const effectSeparatorIndex = entry.lastIndexOf(":");
    const selector =
      effectSeparatorIndex >= 0 ? entry.slice(0, effectSeparatorIndex) : entry;
    const effect =
      effectSeparatorIndex >= 0 ? entry.slice(effectSeparatorIndex + 1) : "NoSchedule";
    const selectorSeparatorIndex = selector.indexOf("=");
    if (
      selectorSeparatorIndex <= 0 ||
      selectorSeparatorIndex === selector.length - 1
    ) {
      throw new Error("SANDBOX_TOLERATIONS must use key=value:Effect format");
    }
    if (!effects.has(effect)) {
      throw new Error(`SANDBOX_TOLERATIONS contains invalid effect: ${effect}`);
    }
    const key = selector.slice(0, selectorSeparatorIndex);
    const tolerationValue = selector.slice(selectorSeparatorIndex + 1);
    return {
      key: key.trim(),
      operator: "Equal",
      value: tolerationValue.trim(),
      effect: effect as SandboxToleration["effect"],
    };
  });
};

export const config: AppConfig = {
  workerSecret: process.env.WORKER_SECRET ?? "",
  logtoEndpoint: resolveLogtoEndpoint({ endpoint: process.env.LOGTO_ENDPOINT, env }),
  webOrigin: process.env.WEB_ORIGIN,
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  litellmApiKey: process.env.LITELLM_API_KEY,
  talesofaiBillingBaseUrl: process.env.TALESOFAI_BILLING_BASE_URL?.replace(/\/+$/, ""),
  talesofaiBillingBusinessKey: process.env.TALESOFAI_BILLING_BUSINESS_KEY,
  talesofaiBillingAdminApiKey: process.env.TALESOFAI_BILLING_ADMIN_API_KEY,
  env,
  appEncryptionKey: process.env.APP_ENCRYPTION_KEY ?? "",
  sandboxImage:
    process.env.SANDBOX_IMAGE ?? getDefaultSandboxImage(env),
  sandboxNodeSelector: parseSandboxNodeSelector(process.env.SANDBOX_NODE_SELECTOR),
  sandboxTolerations: parseSandboxTolerations(process.env.SANDBOX_TOLERATIONS),
  bullmqRedisUrl:
    process.env.BULLMQ_REDIS_URL ?? "",
  spaceStorageRoot: process.env.SPACE_STORAGE_ROOT ?? "",
  spaceStoragePvc: process.env.SPACE_STORAGE_PVC ?? "cohub-spaces-pvc",
  checkpointCachePvc: process.env.CHECKPOINT_CACHE_PVC ?? process.env.SPACE_STORAGE_PVC ?? "cohub-spaces-pvc",
  checkpointCacheRoot: process.env.CHECKPOINT_CACHE_ROOT ?? "/checkpoint-cache",
  spaceSystemRoot: process.env.SPACE_SYSTEM_ROOT ?? process.env.SPACE_STORAGE_ROOT ?? "",
  spaceStorageSubpath: process.env.SPACE_STORAGE_SUBPATH ?? (env === "prod" ? "cohub-prod" : "cohub-dev"),
  checkpointCacheSubpath: process.env.CHECKPOINT_CACHE_SUBPATH ?? `${process.env.SPACE_STORAGE_SUBPATH ?? (env === "prod" ? "cohub-prod" : "cohub-dev")}/checkpoints`,
  configsSubpath: process.env.CONFIGS_SUBPATH ?? (env === "prod" ? "configs/prod" : "configs/dev"),
  platformConfigRoot: process.env.PLATFORM_CONFIG_ROOT ?? "/configs",
  turnObjectS3Endpoint: process.env.TURN_OBJECT_S3_ENDPOINT ?? "https://oss-us-west-1-internal.aliyuncs.com",
  turnObjectS3PublicEndpoint: process.env.TURN_OBJECT_S3_PUBLIC_ENDPOINT,
  turnObjectS3Region: process.env.TURN_OBJECT_S3_REGION ?? "us-west-1",
  turnObjectS3Bucket: process.env.TURN_OBJECT_S3_BUCKET ?? "cohub-sessions",
  turnObjectS3AccessKeyId: process.env.TURN_OBJECT_S3_ACCESS_KEY_ID,
  turnObjectS3SecretAccessKey: process.env.TURN_OBJECT_S3_SECRET_ACCESS_KEY,
  turnObjectCdnBaseUrl: (process.env.TURN_OBJECT_CDN_BASE_URL ?? "https://sessions.cohub.run").replace(/\/+$/, ""),
  publicAssetOssEndpoint: process.env.PUBLIC_ASSET_OSS_ENDPOINT,
  publicAssetOssPublicEndpoint: process.env.PUBLIC_ASSET_OSS_PUBLIC_ENDPOINT,
  publicAssetOssRegion: process.env.PUBLIC_ASSET_OSS_REGION ?? "us-west-1",
  publicAssetOssBucket: process.env.PUBLIC_ASSET_OSS_BUCKET,
  publicAssetOssAccessKeyId: process.env.PUBLIC_ASSET_OSS_ACCESS_KEY_ID,
  publicAssetOssSecretAccessKey: process.env.PUBLIC_ASSET_OSS_SECRET_ACCESS_KEY,
  publicAssetCdnBaseUrl: process.env.PUBLIC_ASSET_CDN_BASE_URL?.replace(/\/+$/, ""),
  workAssetCdnBaseUrl: process.env.WORK_ASSET_CDN_BASE_URL?.replace(/\/+$/, ""),
  workAssetCdnCloudflareZoneId: process.env.WORK_ASSET_CDN_CLOUDFLARE_ZONE_ID,
  workAssetCdnCloudflareApiToken: process.env.WORK_ASSET_CDN_CLOUDFLARE_API_TOKEN,
  checkpointAssetOssEndpoint: process.env.CHECKPOINT_ASSET_OSS_ENDPOINT ?? process.env.TURN_OBJECT_S3_ENDPOINT ?? "https://oss-us-west-1-internal.aliyuncs.com",
  checkpointAssetOssPublicEndpoint: process.env.CHECKPOINT_ASSET_OSS_PUBLIC_ENDPOINT ?? process.env.TURN_OBJECT_S3_PUBLIC_ENDPOINT,
  checkpointAssetOssRegion: process.env.CHECKPOINT_ASSET_OSS_REGION ?? process.env.TURN_OBJECT_S3_REGION ?? "us-west-1",
  checkpointAssetOssBucket: process.env.CHECKPOINT_ASSET_OSS_BUCKET ?? process.env.TURN_OBJECT_S3_BUCKET,
  checkpointAssetOssAccessKeyId: process.env.CHECKPOINT_ASSET_OSS_ACCESS_KEY_ID ?? process.env.TURN_OBJECT_S3_ACCESS_KEY_ID,
  checkpointAssetOssSecretAccessKey: process.env.CHECKPOINT_ASSET_OSS_SECRET_ACCESS_KEY ?? process.env.TURN_OBJECT_S3_SECRET_ACCESS_KEY,
};

export const sessionsNamespace = getSessionsNamespace(config.env);

export const assertRequiredConfig = () => {
  if (!config.redisUrl) {
    throw new Error("Missing required env: REDIS_URL");
  }
  if (!config.appEncryptionKey) {
    throw new Error("Missing required env: APP_ENCRYPTION_KEY");
  }
  if (!config.workerSecret) {
    throw new Error("Missing required env: WORKER_SECRET");
  }
  if (!config.bullmqRedisUrl) {
    throw new Error("Missing required env: BULLMQ_REDIS_URL");
  }
};
