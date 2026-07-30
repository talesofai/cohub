import "dotenv/config";
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: "apps/api/.env", override: false });

import { resolveMessageTurnId } from "@cohub/core/sessions";
import * as schema from "@cohub/db";
import { asc, gt, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/cohub";
const dbClient = postgres(connectionString, { prepare: false });
const db = drizzle(dbClient, { schema });
const { sessionMessages, sessionTurns } = schema;

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 5_000;
const DEFAULT_SLEEP_MS = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Backfill session_messages.turn_id from validated meta.turnId values.
 * Dry-run is the default; pass --write to persist changes.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-session-message-turn-ids.ts \
 *     [--write] [--batch-size N] [--sleep-ms N] \
 *     [--after-message UUID] [--max-messages N]
 */
type Args = {
  write: boolean;
  batchSize: number;
  sleepMs: number;
  afterMessage: string | null;
  maxMessages: number | null;
};

type Stats = {
  scanned: number;
  updated: number;
  alreadyPopulated: number;
  missingMetaTurnId: number;
  invalidMetaTurnId: number;
  missingTurn: number;
  sessionMismatch: number;
  columnMetaMismatch: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(rawArgv: string[]): Args {
  const argv = rawArgv.filter((arg) => arg !== "--");
  const readValue = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const readNumber = (name: string, fallback: number, max: number) => {
    const value = Number(readValue(name) ?? fallback);
    if (!Number.isFinite(value)) throw new Error(`Invalid ${name}`);
    return Math.min(Math.max(Math.floor(value), 0), max);
  };
  const maxMessagesValue = readValue("--max-messages");
  const maxMessages = maxMessagesValue == null ? null : Number(maxMessagesValue);
  if (maxMessages != null && (!Number.isFinite(maxMessages) || maxMessages < 1)) {
    throw new Error("Invalid --max-messages");
  }
  const afterMessageValue = readValue("--after-message");
  const afterMessage = afterMessageValue?.trim().toLowerCase() || null;
  if (afterMessage && !UUID_PATTERN.test(afterMessage)) throw new Error("Invalid --after-message");
  return {
    write: argv.includes("--write"),
    batchSize: Math.max(1, readNumber("--batch-size", DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE)),
    sleepMs: readNumber("--sleep-ms", DEFAULT_SLEEP_MS, 60_000),
    afterMessage,
    maxMessages: maxMessages == null ? null : Math.floor(maxMessages),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stats: Stats = {
    scanned: 0,
    updated: 0,
    alreadyPopulated: 0,
    missingMetaTurnId: 0,
    invalidMetaTurnId: 0,
    missingTurn: 0,
    sessionMismatch: 0,
    columnMetaMismatch: 0,
  };
  let cursor = args.afterMessage;
  let completed = false;

  console.log(JSON.stringify({
    event: "session_message_turn_id_backfill_started",
    mode: args.write ? "write" : "dry-run",
    batchSize: args.batchSize,
    sleepMs: args.sleepMs,
    afterMessage: cursor,
    maxMessages: args.maxMessages,
  }));

  while (args.maxMessages == null || stats.scanned < args.maxMessages) {
    const remaining = args.maxMessages == null ? args.batchSize : args.maxMessages - stats.scanned;
    const limit = Math.min(args.batchSize, remaining);
    if (limit <= 0) break;

    const rows = await db.select({
      id: sessionMessages.id,
      sessionId: sessionMessages.sessionId,
      turnId: sessionMessages.turnId,
      meta: sessionMessages.meta,
    })
      .from(sessionMessages)
      .where(cursor ? gt(sessionMessages.id, cursor) : undefined)
      .orderBy(asc(sessionMessages.id))
      .limit(limit);

    if (rows.length === 0) {
      completed = true;
      break;
    }

    stats.scanned += rows.length;
    cursor = rows.at(-1)?.id ?? cursor;

    const candidates: Array<{ messageId: string; sessionId: string; turnId: string }> = [];
    for (const row of rows) {
      const metaRecord = row.meta && typeof row.meta === "object" && !Array.isArray(row.meta)
        ? row.meta as Record<string, unknown>
        : null;
      const rawTurnId = metaRecord?.turnId;
      const metaTurnId = resolveMessageTurnId(row.meta);

      if (row.turnId) {
        stats.alreadyPopulated += 1;
        if (metaTurnId && row.turnId !== metaTurnId) stats.columnMetaMismatch += 1;
        continue;
      }
      if (rawTurnId == null || rawTurnId === "") {
        stats.missingMetaTurnId += 1;
        continue;
      }
      if (!metaTurnId) {
        stats.invalidMetaTurnId += 1;
        continue;
      }
      candidates.push({ messageId: row.id, sessionId: row.sessionId, turnId: metaTurnId });
    }

    const turnIds = [...new Set(candidates.map((candidate) => candidate.turnId))];
    const turns = turnIds.length > 0
      ? await db.select({ id: sessionTurns.id, sessionId: sessionTurns.sessionId })
        .from(sessionTurns)
        .where(inArray(sessionTurns.id, turnIds))
      : [];
    const turnSessionById = new Map(turns.map((turn) => [turn.id, turn.sessionId]));
    const validCandidates = candidates.filter((candidate) => {
      const turnSessionId = turnSessionById.get(candidate.turnId);
      if (!turnSessionId) {
        stats.missingTurn += 1;
        return false;
      }
      if (turnSessionId !== candidate.sessionId) {
        stats.sessionMismatch += 1;
        return false;
      }
      return true;
    });

    if (args.write && validCandidates.length > 0) {
      const values = sql.join(
        validCandidates.map((candidate) => sql`(${candidate.messageId}::uuid, ${candidate.turnId}::uuid)`),
        sql`, `,
      );
      const updated = await db.execute<{ id: string }>(sql`
        UPDATE ${sessionMessages} AS message
        SET turn_id = candidate.turn_id
        FROM (VALUES ${values}) AS candidate(message_id, turn_id)
        WHERE message.id = candidate.message_id
          AND message.turn_id IS NULL
        RETURNING message.id
      `);
      stats.updated += updated.length;
    }

    console.log(JSON.stringify({
      event: "session_message_turn_id_backfill_batch",
      cursor,
      batchScanned: rows.length,
      validCandidates: validCandidates.length,
      ...stats,
    }));

    if (rows.length < limit) {
      completed = true;
      break;
    }
    if (args.write && args.sleepMs > 0) await sleep(args.sleepMs);
  }

  console.log(JSON.stringify({
    event: "session_message_turn_id_backfill_finished",
    mode: args.write ? "write" : "dry-run",
    completed,
    resumeAfterMessage: completed ? null : cursor,
    ...stats,
  }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await dbClient.end({ timeout: 5 });
  });
