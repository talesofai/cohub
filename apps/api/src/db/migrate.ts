import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createLogger } from "@cohub/infra/logging";


const logger = createLogger({ serviceName: "cohub-api" });
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const client = postgres(connectionString, {
  prepare: false,
  connect_timeout: 10,
  idle_timeout: 30,
});
const db = drizzle(client);

async function runMigrate() {
  logger.info("[Migration] Running V2 database migrations...");

  try {
    await client`SELECT 1`;
    logger.info("[Migration] Database connection verified.");

    // 确保 drizzle schema 和 migration tracking 表存在
    await client`CREATE SCHEMA IF NOT EXISTS drizzle`;
    await client`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash TEXT NOT NULL,
        created_at BIGINT NOT NULL
      )
    `;

    // 检查 v2 schema 状态
    const schemaRows = await client`
      SELECT EXISTS(
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'v2'
      )
    ` as postgres.Row[];
    const hasTables = schemaRows[0]?.exists as boolean;

    // 检查 v2 schema 本身是否存在
    const schemaExistsRows = await client`
      SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name = 'v2')
    ` as postgres.Row[];
    const schemaExists = schemaExistsRows[0]?.exists as boolean;

    if (schemaExists && !hasTables) {
      // 残留的空 schema（之前迁移失败），清理掉让 drizzle 重建
      logger.info("[Migration] v2 schema exists but has no tables (stale), cleaning up...");
      await client`DROP SCHEMA v2 CASCADE`;
    } else if (schemaExists && hasTables) {
      logger.info("[Migration] v2 schema exists with tables, running pending drizzle migrations.");
    }

    // 执行 migration
    // drizzle 会自动比对 __drizzle_migrations 中的 hash，只执行未跑过的 SQL
    await migrate(db, { migrationsFolder: "./drizzle/v2" });
    // This index is built outside Drizzle's transaction so a large session_turns
    // table stays writable while queued-turn recovery is deployed.
    const invalidIndexRows = await client`
      SELECT indexrelid::regclass::text AS name
      FROM pg_index
      WHERE indexrelid = to_regclass('v2.v2_idx_session_turns_queued_session')
        AND NOT indisvalid
    ` as postgres.Row[];
    if (invalidIndexRows.length > 0) {
      await client`DROP INDEX CONCURRENTLY IF EXISTS v2.v2_idx_session_turns_queued_session`;
    }
    await client`CREATE INDEX CONCURRENTLY IF NOT EXISTS v2_idx_session_turns_queued_session
      ON v2.session_turns (session_id)
      WHERE status = 'queued'`;
    logger.info("[Migration] V2 migrations completed successfully.");
  } catch (error) {
    logger.error("[Migration] V2 migration failed:", error);
    throw error;
  } finally {
    await client.end({ timeout: 5 });
  }
}

runMigrate();
