import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@cohub/db";

export type Db = PostgresJsDatabase<typeof schema>;
