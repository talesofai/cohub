import type {
  SpaceTurnAuthorFilter,
  SpaceTurnListItem,
  SpaceTurnsResponse,
} from "@cohub/protocol/model";
import { sessionTurns, spaceSessions } from "@cohub/db";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "./db/index.js";
import {
  hydrateTurnIndexAuthorProfiles,
  toTurnIndexItem,
  type SessionTurnIndexRow,
} from "./session-turns.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SpaceTurnCursor = {
  createdAt: Date;
  id: string;
};

export class InvalidSpaceTurnListQueryError extends Error {
  constructor(message = "invalid space turn query") {
    super(message);
    this.name = "InvalidSpaceTurnListQueryError";
  }
}

export function encodeSpaceTurnCursor(input: {
  createdAt: Date | string;
  id: string;
}): string {
  const createdAt = input.createdAt instanceof Date
    ? input.createdAt
    : new Date(input.createdAt);
  if (Number.isNaN(createdAt.getTime()) || !UUID_RE.test(input.id)) {
    throw new InvalidSpaceTurnListQueryError("invalid cursor boundary");
  }
  return Buffer.from(JSON.stringify({ v: 1, t: createdAt.toISOString(), i: input.id })).toString("base64url");
}

export function decodeSpaceTurnCursor(value: string | null | undefined): SpaceTurnCursor | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      v?: unknown;
      t?: unknown;
      i?: unknown;
    };
    if (parsed.v !== 1 || typeof parsed.t !== "string" || typeof parsed.i !== "string" || !UUID_RE.test(parsed.i)) {
      throw new InvalidSpaceTurnListQueryError("invalid cursor");
    }
    const createdAt = new Date(parsed.t);
    if (Number.isNaN(createdAt.getTime())) throw new InvalidSpaceTurnListQueryError("invalid cursor");
    return { createdAt, id: parsed.i };
  } catch (error) {
    if (error instanceof InvalidSpaceTurnListQueryError) throw error;
    throw new InvalidSpaceTurnListQueryError("invalid cursor");
  }
}

function parseBefore(value: string | null | undefined): Date {
  if (!value?.trim()) return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new InvalidSpaceTurnListQueryError("invalid before");
  return date;
}

function resolveLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(value)) throw new InvalidSpaceTurnListQueryError("invalid limit");
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
}

function authorCondition(author: SpaceTurnAuthorFilter, userUuid: string | null): SQL | undefined {
  if (author === "any") return undefined;
  if (author === "self") {
    return userUuid ? eq(sessionTurns.userUuid, userUuid) : sql`false`;
  }
  return userUuid
    ? and(isNotNull(sessionTurns.userUuid), ne(sessionTurns.userUuid, userUuid))
    : isNotNull(sessionTurns.userUuid);
}

export async function listSpaceTurns(input: {
  spaceId: string;
  userUuid: string | null;
  author?: SpaceTurnAuthorFilter;
  after?: string | null;
  before?: string | null;
  cursor?: string | null;
  limit?: number;
  sessionId?: string | null;
  accessibleSessionIds?: string[] | null;
}): Promise<SpaceTurnsResponse> {
  const author = input.author ?? "any";
  if (author !== "any" && author !== "self" && author !== "others") {
    throw new InvalidSpaceTurnListQueryError("invalid author");
  }
  const after = decodeSpaceTurnCursor(input.after);
  const cursor = decodeSpaceTurnCursor(input.cursor);
  const before = parseBefore(input.before);
  const limit = resolveLimit(input.limit);
  const accessibleSessionIds = input.accessibleSessionIds;

  if (accessibleSessionIds && accessibleSessionIds.length === 0) {
    return {
      turns: [],
      snapshotAt: before.toISOString(),
      snapshotCursor: encodeSpaceTurnCursor({ createdAt: before, id: MAX_UUID }),
      pageInfo: { hasMore: false, nextCursor: null },
    };
  }

  const conditions: SQL[] = [
    eq(spaceSessions.spaceId, input.spaceId),
    lte(sessionTurns.createdAt, before),
  ];
  const authorFilter = authorCondition(author, input.userUuid);
  if (authorFilter) conditions.push(authorFilter);
  if (input.sessionId) conditions.push(eq(sessionTurns.sessionId, input.sessionId));
  if (accessibleSessionIds) conditions.push(inArray(sessionTurns.sessionId, accessibleSessionIds));
  if (after) {
    conditions.push(or(
      gt(sessionTurns.createdAt, after.createdAt),
      and(eq(sessionTurns.createdAt, after.createdAt), gt(sessionTurns.id, after.id)),
    ) as SQL);
  }
  if (cursor) {
    conditions.push(or(
      lt(sessionTurns.createdAt, cursor.createdAt),
      and(eq(sessionTurns.createdAt, cursor.createdAt), lt(sessionTurns.id, cursor.id)),
    ) as SQL);
  }

  const rows = await db
    .select({
      id: sessionTurns.id,
      sessionId: sessionTurns.sessionId,
      sequence: sessionTurns.sequence,
      status: sessionTurns.status,
      intent: sessionTurns.intent,
      userUuid: sessionTurns.userUuid,
      startedAt: sessionTurns.startedAt,
      completedAt: sessionTurns.completedAt,
      durationMs: sessionTurns.durationMs,
      createdAt: sessionTurns.createdAt,
      updatedAt: sessionTurns.updatedAt,
      userText: sessionTurns.userText,
      assistantText: sessionTurns.assistantText,
      provider: sessionTurns.provider,
      model: sessionTurns.model,
      finalUsage: sessionTurns.finalUsage,
      totalUsage: sessionTurns.totalUsage,
      errorMessage: sessionTurns.errorMessage,
      sessionTitle: spaceSessions.title,
      sessionSource: spaceSessions.source,
    })
    .from(sessionTurns)
    .innerJoin(spaceSessions, eq(spaceSessions.id, sessionTurns.sessionId))
    .where(and(...conditions))
    .orderBy(desc(sessionTurns.createdAt), desc(sessionTurns.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const indexItems = await hydrateTurnIndexAuthorProfiles(
    pageRows.map((row) => toTurnIndexItem(row as SessionTurnIndexRow)),
  );
  const turns: SpaceTurnListItem[] = indexItems.map((turn, index) => ({
    ...turn,
    session: {
      id: turn.sessionId,
      title: pageRows[index]?.sessionTitle ?? null,
      source: pageRows[index]?.sessionSource ?? null,
    },
  }));
  const last = pageRows.at(-1);

  return {
    turns,
    snapshotAt: before.toISOString(),
    snapshotCursor: encodeSpaceTurnCursor({ createdAt: before, id: MAX_UUID }),
    pageInfo: {
      hasMore,
      nextCursor: hasMore && last
        ? encodeSpaceTurnCursor({ createdAt: last.createdAt ?? new Date(0), id: last.id })
        : null,
    },
  };
}
