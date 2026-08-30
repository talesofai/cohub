import * as schema from "@cohub/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { LockDbPool, type LockDbClient, type LockDbConnection } from "@cohub/infra/lock-db-pool";
import { env } from "./env.js";

const createLockDbClient = (): LockDbClient => {
  const client = postgres(env.DATABASE_URL, { prepare: false, max: 1 });
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

export const dbClient = postgres(env.DATABASE_URL, { prepare: false });
export const lockDbPool = new LockDbPool(createLockDbClient, env.AGENT_LOCK_DB_POOL_MAX);

export const db = drizzle(dbClient, { schema });

export async function closeDb() {
  await Promise.all([
    dbClient.end({ timeout: 5 }).catch(() => undefined),
    lockDbPool.close().catch(() => undefined),
  ]);
}
