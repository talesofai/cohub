import "dotenv/config";
import { parseArgs } from "node:util";
import {
  COHUB_BILLING_TOKEN_TYPES,
  COHUB_BILLING_USAGE_TYPES,
} from "@cohub/billing";
import { enqueueBillingUsage } from "@cohub/core/billing";
import * as schema from "@cohub/db";
import { sessionMessages, spaceSessions, taskRuns } from "@cohub/db";
import type { Usage } from "@cohub/protocol";
import {
  GENERATION_TASK_TYPE,
  type GenerationTaskResult,
} from "@cohub/protocol/generation";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

type BackfillSource = "all" | "llm" | "generation";
type BackfillStats = { scanned: number; candidates: number; enqueued: number; skipped: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const optionalPositiveInteger = (value: string | undefined) => {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--max-rows must be a positive integer");
  }
  return parsed;
};

const positiveUsd = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Number(value.toFixed(8))
    : 0;

const options = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    source: { type: "string", default: "all" },
    "batch-size": { type: "string", default: "200" },
    "max-rows": { type: "string" },
  },
  strict: true,
}).values;
const source = options.source as BackfillSource;
if (source !== "all" && source !== "llm" && source !== "generation") {
  throw new Error("--source must be all, llm, or generation");
}
const apply = options.apply;
const batchSize = Math.min(positiveInteger(options["batch-size"], 200), 1000);
const maxRows = optionalPositiveInteger(options["max-rows"]);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = postgres(databaseUrl, { prepare: false, max: 5 });
const db = drizzle(client, { schema });

const emptyStats = (): BackfillStats => ({ scanned: 0, candidates: 0, enqueued: 0, skipped: 0 });

const resolveMessageActor = (
  message: typeof sessionMessages.$inferSelect,
  anchorUserIds: Map<string, string>,
) => {
  const meta = isRecord(message.meta) ? message.meta : {};
  const actorUserId = typeof meta.actorUserId === "string" ? meta.actorUserId.trim() : "";
  if (actorUserId) return actorUserId;
  const anchorId = typeof meta.anchorUserMessageId === "string" ? meta.anchorUserMessageId : "";
  return anchorUserIds.get(anchorId) ?? null;
};

const backfillLlmUsage = async (): Promise<BackfillStats> => {
  const stats = emptyStats();
  let cursor: string | null = null;
  while (stats.scanned < maxRows) {
    const remaining = Math.min(batchSize, maxRows - stats.scanned);
    const rows = await db
      .select({ message: sessionMessages, spaceId: spaceSessions.spaceId })
      .from(sessionMessages)
      .innerJoin(spaceSessions, eq(spaceSessions.id, sessionMessages.sessionId))
      .where(and(
        eq(sessionMessages.role, "assistant"),
        cursor ? gt(sessionMessages.id, cursor) : undefined,
      ))
      .orderBy(asc(sessionMessages.id))
      .limit(remaining);
    if (rows.length === 0) break;
    stats.scanned += rows.length;
    cursor = rows.at(-1)?.message.id ?? cursor;

    const anchorIds = rows
      .map(({ message }) => isRecord(message.meta) ? message.meta.anchorUserMessageId : null)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const anchors = anchorIds.length > 0
      ? await db.select({ id: sessionMessages.id, meta: sessionMessages.meta })
          .from(sessionMessages)
          .where(inArray(sessionMessages.id, anchorIds))
      : [];
    const anchorUserIds = new Map<string, string>();
    for (const anchor of anchors) {
      const userId = isRecord(anchor.meta) && typeof anchor.meta.userId === "string"
        ? anchor.meta.userId.trim()
        : "";
      if (userId) anchorUserIds.set(anchor.id, userId);
    }

    for (const { message, spaceId } of rows) {
      if (message.errorMessage || message.stopReason === "error" || message.stopReason === "aborted") {
        stats.skipped += 1;
        continue;
      }
      const usage = isRecord(message.usage) ? message.usage as Usage : null;
      const amountUsd = positiveUsd(usage?.cost?.total);
      const userId = resolveMessageActor(message, anchorUserIds);
      if (!userId || amountUsd <= 0) {
        stats.skipped += 1;
        continue;
      }
      stats.candidates += 1;
      if (!apply) continue;
      await enqueueBillingUsage({
        db,
        intent: {
          userId,
          amountUsd,
          tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
          usageType: COHUB_BILLING_USAGE_TYPES.generationLlm,
          sourceId: message.id,
          operationId: `llm:${message.id}`,
          reason: `LLM usage ${message.provider ?? "unknown"}/${message.model ?? "unknown"}`,
          spaceId,
          sessionId: message.sessionId,
          metadata: {
            messageId: message.id,
            provider: message.provider,
            model: message.model,
            source: "billing_ledger_backfill",
          },
        },
      });
      stats.enqueued += 1;
    }
  }
  return stats;
};

const backfillGenerationUsage = async (): Promise<BackfillStats> => {
  const stats = emptyStats();
  let cursor: string | null = null;
  while (stats.scanned < maxRows) {
    const remaining = Math.min(batchSize, maxRows - stats.scanned);
    const rows = await db
      .select()
      .from(taskRuns)
      .where(and(
        eq(taskRuns.taskType, GENERATION_TASK_TYPE),
        eq(taskRuns.status, "completed"),
        cursor ? gt(taskRuns.id, cursor) : undefined,
      ))
      .orderBy(asc(taskRuns.id))
      .limit(remaining);
    if (rows.length === 0) break;
    stats.scanned += rows.length;
    cursor = rows.at(-1)?.id ?? cursor;

    for (const row of rows) {
      const result = isRecord(row.result) ? row.result as GenerationTaskResult : null;
      const billing = result?.billing;
      const amountUsd = positiveUsd(billing?.amountUsd);
      if (!row.userUuid || !billing || amountUsd <= 0) {
        stats.skipped += 1;
        continue;
      }
      stats.candidates += 1;
      if (!apply) continue;
      await enqueueBillingUsage({
        db,
        intent: {
          userId: row.userUuid,
          amountUsd,
          tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
          usageType: billing.usageType,
          sourceId: row.id,
          operationId: `generation:${row.id}`,
          reason: `Generation ${result.model}`,
          spaceId: row.spaceId,
          sessionId: row.sessionId,
          metadata: {
            taskRunId: row.id,
            officialCostUsd: billing.officialCostUsd ?? result.cost ?? null,
            discountMultiplier: billing.discountMultiplier ?? null,
            model: result.model,
            previousBillingStatus: billing.status,
            source: "billing_ledger_backfill",
          },
        },
      });
      stats.enqueued += 1;
    }
  }
  return stats;
};

try {
  const result: Record<string, BackfillStats> = {};
  if (source === "all" || source === "llm") result.llm = await backfillLlmUsage();
  if (source === "all" || source === "generation") {
    result.generation = await backfillGenerationUsage();
  }
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    batchSize,
    maxRows: Number.isFinite(maxRows) ? maxRows : "unbounded",
    result,
  }, null, 2));
} finally {
  await client.end({ timeout: 5 });
}
