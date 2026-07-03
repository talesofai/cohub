import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@cohub/db";
import { initDrizzleTracing } from "@cohub/infra/tracing/db";

const connectionString =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/cohub";

const client = postgres(connectionString, { prepare: false });
export const db = initDrizzleTracing(
  drizzle(client, { schema }),
  { dbSystem: "postgresql", dbName: "cohub" },
);
