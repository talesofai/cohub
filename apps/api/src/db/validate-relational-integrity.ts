import "dotenv/config";
import { parseArgs } from "node:util";
import postgres, { type Sql } from "postgres";

type RelationalConstraint = {
  constraintName: string;
  constraintType: "check" | "foreign_key";
  schemaName: string;
  tableName: string;
  validated: boolean;
};

type ValidationResult = RelationalConstraint & {
  status: "validated" | "validatable" | "blocked";
  errorCode?: string;
  errorMessage?: string;
};

const positiveInteger = (value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("timeout values must be positive integers");
  return parsed;
};

const options = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "lock-timeout-ms": { type: "string", default: "5000" },
    "statement-timeout-ms": { type: "string", default: "300000" },
  },
  strict: true,
}).values;

const apply = options.apply;
const lockTimeoutMs = positiveInteger(options["lock-timeout-ms"], 5_000);
const statementTimeoutMs = positiveInteger(options["statement-timeout-ms"], 300_000);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = postgres(databaseUrl, { prepare: false, max: 2 });

const readError = (error: unknown) => {
  const value = error && typeof error === "object"
    ? error as { code?: unknown; message?: unknown }
    : {};
  return {
    errorCode: typeof value.code === "string" ? value.code : "unknown",
    errorMessage: typeof value.message === "string" ? value.message : String(error),
  };
};

async function validateConstraint(
  connection: Sql,
  constraint: RelationalConstraint,
): Promise<ValidationResult> {
  if (constraint.validated) return { ...constraint, status: "validated" };

  await connection`begin`;
  try {
    await connection`select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`;
    await connection`select set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)`;
    await connection`
      alter table ${connection(constraint.schemaName)}.${connection(constraint.tableName)}
      validate constraint ${connection(constraint.constraintName)}
    `;
    await connection.unsafe(apply ? "commit" : "rollback");
    return {
      ...constraint,
      validated: apply,
      status: apply ? "validated" : "validatable",
    };
  } catch (error) {
    await connection`rollback`;
    return { ...constraint, status: "blocked", ...readError(error) };
  }
}

try {
  const rows = await client<RelationalConstraint[]>`
    select constraint_name as "constraintName",
           constraint_type as "constraintType",
           schema_name as "schemaName",
           table_name as "tableName",
           validated
    from (
      select fk.conname as constraint_name,
             case fk.contype when 'f' then 'foreign_key' else 'check' end as constraint_type,
             namespace.nspname as schema_name,
             relation.relname as table_name,
             fk.convalidated as validated
      from pg_constraint fk
      join pg_namespace namespace on namespace.oid = fk.connamespace
      join pg_class relation on relation.oid = fk.conrelid
      where fk.contype in ('f', 'c')
        and namespace.nspname = 'v2'
    ) relational_constraints
    order by table_name, constraint_type, constraint_name
  `;

  const connection = await client.reserve();
  const results: ValidationResult[] = [];
  try {
    for (const row of rows) results.push(await validateConstraint(connection, row));
  } finally {
    connection.release();
  }

  const summary = { validated: 0, validatable: 0, blocked: 0 };
  for (const result of results) summary[result.status] += 1;
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    lockTimeoutMs,
    statementTimeoutMs,
    summary,
    constraints: results.filter((result) => result.status !== "validated"),
  }, null, 2));
  if (summary.blocked > 0) process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
