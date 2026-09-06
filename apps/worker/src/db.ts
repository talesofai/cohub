import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "./config.js";
import * as schema from "@cohub/db";
import { initDrizzleTracing } from "@cohub/infra/tracing/db";
import { LockDbPool, type LockDbClient, type LockDbConnection } from "@cohub/infra/lock-db-pool";

const positivePoolSize = (name: string, fallback: number) => {
  const value = process.env[name];
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

export const dbClient = postgres(config.databaseUrl);
const createLockDbClient = (): LockDbClient => {
  const client = postgres(config.databaseUrl, { max: 1 });
  return {
    reserve: async (): Promise<LockDbConnection> => {
      const reserved = await client.reserve();
      return {
        release: () => reserved.release(),
        unsafe: <T extends unknown[]>(query: string, parameters?: unknown[]) =>
          reserved.unsafe<T>(query, parameters as never[]),
      };
    },
    end: (options) => client.end(options),
  };
};
export const lockDbPool = new LockDbPool(createLockDbClient, positivePoolSize("WORKER_LOCK_DB_POOL_MAX", 6));

export async function closeDb() {
  await Promise.all([
    dbClient.end({ timeout: 5 }).catch(() => undefined),
    lockDbPool.close().catch(() => undefined),
  ]);
}

export const db = initDrizzleTracing(
  drizzle(dbClient, { schema }),
  {
    dbSystem: "postgresql",
    dbName: "cohub-worker",
  },
);
