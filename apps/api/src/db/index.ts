import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@cohub/db";
import { initDrizzleTracing } from "@cohub/infra/tracing/db";
import { LockDbPool, type LockDbClient, type LockDbConnection } from "@cohub/infra/lock-db-pool";

// connection string can be defined in .env
const connectionString =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/cohub";

const positivePoolSize = (name: string, fallback: number) => {
  const value = process.env[name];
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

const createLockDbClient = (): LockDbClient => {
  const client = postgres(connectionString, { prepare: false, max: 1 });
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

// Disable prefetch as it is not supported for "Transaction" pool mode.
export const dbClient = postgres(connectionString, { prepare: false });
export const lockDbPool = new LockDbPool(createLockDbClient, positivePoolSize("API_LOCK_DB_POOL_MAX", 8));
export const db = initDrizzleTracing(
  drizzle(dbClient, { schema }),
  {
    dbSystem: "postgresql",
    dbName: "cohub",
  },
);

export async function closeDb() {
  await Promise.all([
    dbClient.end({ timeout: 5 }).catch(() => undefined),
    lockDbPool.close().catch(() => undefined),
  ]);
}
