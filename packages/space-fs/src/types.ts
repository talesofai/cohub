import type { Redis } from "ioredis";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@cohub/db";

/** Drizzle database instance backed by postgres-js. */
export type Db = PostgresJsDatabase<typeof schema>;

/** Subset of app config required by the space-fs module. */
export type SpaceFsConfig = {
  env: "dev" | "prod";
  appEncryptionKey: string;
  workerSecret: string;
  spaceStorageRoot: string;
  spaceSystemRoot: string;
  bullmqRedisUrl: string;
  turnObjectS3Endpoint?: string;
  turnObjectS3PublicEndpoint?: string;
  turnObjectS3Region: string;
  turnObjectS3Bucket?: string;
  turnObjectS3AccessKeyId?: string;
  turnObjectS3SecretAccessKey?: string;
  turnObjectCdnBaseUrl: string;
  checkpointAssetOssEndpoint?: string;
  checkpointAssetOssPublicEndpoint?: string;
  checkpointAssetOssRegion: string;
  checkpointAssetOssBucket?: string;
  checkpointAssetOssAccessKeyId?: string;
  checkpointAssetOssSecretAccessKey?: string;
};

/** Dependencies injected into every space-fs factory. */
export type SpaceFsDeps = {
  config: SpaceFsConfig;
  db: Db;
  redis: Redis;
  /** OpenTelemetry / logger service name, e.g. "cohub-api" or "cohub-fs-api". */
  serviceName: string;
};
