import { and, desc, eq, sql } from "drizzle-orm";
import {
  spaceVoiceLexiconEntries,
  userVoiceLexiconEntries,
  type VoiceLexiconSource,
} from "@cohub/db";
import { db } from "./db/index.js";

const MAX_TERM_LENGTH = 80;
const MAX_ORIGINAL_TEXT_LENGTH = 240;
const MAX_ENTRIES = 240;
const VALID_SOURCES = new Set<VoiceLexiconSource>(["manual", "auto", "correction"]);

export class VoiceLexiconValidationError extends Error {
  override name = "VoiceLexiconValidationError";
}

export class VoiceLexiconConflictError extends Error {
  override name = "VoiceLexiconConflictError";
}

export type VoiceLexiconScope = "user" | "space";

type UserVoiceLexiconRow = typeof userVoiceLexiconEntries.$inferSelect;
type SpaceVoiceLexiconRow = typeof spaceVoiceLexiconEntries.$inferSelect;
type VoiceLexiconRow = UserVoiceLexiconRow | SpaceVoiceLexiconRow;

export type VoiceLexiconEntryResponse = {
  id: string;
  scope: VoiceLexiconScope;
  term: string;
  source: VoiceLexiconSource;
  originalText: string | null;
  usageCount: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export type VoiceLexiconInput = {
  term?: unknown;
  source?: unknown;
  originalText?: unknown;
};

const stripTermDecorators = (value: string) =>
  value.replace(/[`*_#[\]()>]/g, "").replace(/\s+/g, " ").trim();

export function normalizeVoiceLexiconTerm(value: unknown) {
  if (typeof value !== "string") return null;
  const term = stripTermDecorators(value);
  if (term.length < 2 || term.length > MAX_TERM_LENGTH) return null;
  return term;
}

export function getVoiceLexiconTermKey(term: string) {
  return term.toLowerCase();
}

function normalizeSource(
  value: unknown,
  fallback: VoiceLexiconSource | undefined = "manual",
): VoiceLexiconSource {
  if (value === undefined && fallback) return fallback;
  if (
    typeof value === "string" &&
    VALID_SOURCES.has(value as VoiceLexiconSource)
  ) {
    return value as VoiceLexiconSource;
  }
  throw new VoiceLexiconValidationError(
    "source must be manual, auto, or correction",
  );
}

function normalizeOriginalText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, MAX_ORIGINAL_TEXT_LENGTH) : null;
}

function serializeVoiceLexiconEntry(
  scope: VoiceLexiconScope,
  row: VoiceLexiconRow,
): VoiceLexiconEntryResponse {
  return {
    id: row.id,
    scope,
    term: row.term,
    source: row.source,
    originalText: row.originalText ?? null,
    usageCount: row.usageCount,
    createdAt: row.createdAt?.toISOString() ?? null,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

function parseInput(input: VoiceLexiconInput) {
  const term = normalizeVoiceLexiconTerm(input.term);
  if (!term) {
    throw new VoiceLexiconValidationError(
      `term must be 2-${MAX_TERM_LENGTH} characters`,
    );
  }
  return {
    term,
    termKey: getVoiceLexiconTermKey(term),
    source: normalizeSource(input.source),
    originalText: normalizeOriginalText(input.originalText),
  };
}

function parsePatchInput(input: VoiceLexiconInput) {
  const term = normalizeVoiceLexiconTerm(input.term);
  if (!term) {
    throw new VoiceLexiconValidationError(
      `term must be 2-${MAX_TERM_LENGTH} characters`,
    );
  }
  return {
    term,
    termKey: getVoiceLexiconTermKey(term),
    ...(input.source !== undefined
      ? { source: normalizeSource(input.source) }
      : {}),
    ...(input.originalText !== undefined
      ? { originalText: normalizeOriginalText(input.originalText) }
      : {}),
  };
}

function getUniqueViolationConstraint(error: unknown) {
  const record = error as { code?: string; constraint_name?: string; constraint?: string };
  if (record.code !== "23505") return null;
  return record.constraint_name ?? record.constraint ?? null;
}

function rethrowVoiceLexiconConflict(error: unknown): never {
  const constraint = getUniqueViolationConstraint(error);
  if (constraint?.includes("voice_lexicon")) {
    throw new VoiceLexiconConflictError("term already exists");
  }
  throw error;
}

export async function listUserVoiceLexiconEntries(userUuid: string) {
  const rows = await db
    .select()
    .from(userVoiceLexiconEntries)
    .where(eq(userVoiceLexiconEntries.userUuid, userUuid))
    .orderBy(desc(userVoiceLexiconEntries.updatedAt))
    .limit(MAX_ENTRIES);
  return rows.map((row) => serializeVoiceLexiconEntry("user", row));
}

export async function upsertUserVoiceLexiconEntry(
  userUuid: string,
  input: VoiceLexiconInput,
) {
  const parsed = parseInput(input);
  const now = new Date();
  const [row] = await db
    .insert(userVoiceLexiconEntries)
    .values({
      userUuid,
      term: parsed.term,
      termKey: parsed.termKey,
      source: parsed.source,
      originalText: parsed.originalText,
      usageCount: parsed.source === "manual" ? 0 : 1,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        userVoiceLexiconEntries.userUuid,
        userVoiceLexiconEntries.termKey,
      ],
      set: {
        term: parsed.term,
        source: sql<VoiceLexiconSource>`case
          when excluded.source = 'manual' or ${userVoiceLexiconEntries.source} = 'manual' then 'manual'
          when excluded.source = 'correction' or ${userVoiceLexiconEntries.source} = 'correction' then 'correction'
          else 'auto'
        end`,
        originalText: sql<string | null>`coalesce(excluded.original_text, ${userVoiceLexiconEntries.originalText})`,
        usageCount: sql<number>`case
          when excluded.source = 'manual' then ${userVoiceLexiconEntries.usageCount}
          else ${userVoiceLexiconEntries.usageCount} + 1
        end`,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("failed to upsert user voice lexicon entry");
  return serializeVoiceLexiconEntry("user", row);
}

export async function updateUserVoiceLexiconEntry(
  userUuid: string,
  entryId: string,
  input: VoiceLexiconInput,
) {
  const parsed = parsePatchInput(input);
  const now = new Date();
  try {
    const [row] = await db
      .update(userVoiceLexiconEntries)
      .set({
        term: parsed.term,
        termKey: parsed.termKey,
        ...(parsed.source !== undefined ? { source: parsed.source } : {}),
        ...(parsed.originalText !== undefined
          ? { originalText: parsed.originalText }
          : {}),
        updatedAt: now,
      })
      .where(and(
        eq(userVoiceLexiconEntries.id, entryId),
        eq(userVoiceLexiconEntries.userUuid, userUuid),
      ))
      .returning();
    return row ? serializeVoiceLexiconEntry("user", row) : null;
  } catch (error) {
    rethrowVoiceLexiconConflict(error);
  }
}

export async function deleteUserVoiceLexiconEntry(userUuid: string, entryId: string) {
  const [row] = await db
    .delete(userVoiceLexiconEntries)
    .where(and(
      eq(userVoiceLexiconEntries.id, entryId),
      eq(userVoiceLexiconEntries.userUuid, userUuid),
    ))
    .returning({ id: userVoiceLexiconEntries.id });
  return Boolean(row);
}

export async function listSpaceVoiceLexiconEntries(spaceId: string) {
  const rows = await db
    .select()
    .from(spaceVoiceLexiconEntries)
    .where(eq(spaceVoiceLexiconEntries.spaceId, spaceId))
    .orderBy(desc(spaceVoiceLexiconEntries.updatedAt))
    .limit(MAX_ENTRIES);
  return rows.map((row) => serializeVoiceLexiconEntry("space", row));
}

export async function upsertSpaceVoiceLexiconEntry(
  spaceId: string,
  createdBy: string,
  input: VoiceLexiconInput,
) {
  const parsed = parseInput(input);
  const now = new Date();
  const [row] = await db
    .insert(spaceVoiceLexiconEntries)
    .values({
      spaceId,
      createdBy,
      term: parsed.term,
      termKey: parsed.termKey,
      source: parsed.source,
      originalText: parsed.originalText,
      usageCount: parsed.source === "manual" ? 0 : 1,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        spaceVoiceLexiconEntries.spaceId,
        spaceVoiceLexiconEntries.termKey,
      ],
      set: {
        term: parsed.term,
        source: sql<VoiceLexiconSource>`case
          when excluded.source = 'manual' or ${spaceVoiceLexiconEntries.source} = 'manual' then 'manual'
          when excluded.source = 'correction' or ${spaceVoiceLexiconEntries.source} = 'correction' then 'correction'
          else 'auto'
        end`,
        originalText: sql<string | null>`coalesce(excluded.original_text, ${spaceVoiceLexiconEntries.originalText})`,
        usageCount: sql<number>`case
          when excluded.source = 'manual' then ${spaceVoiceLexiconEntries.usageCount}
          else ${spaceVoiceLexiconEntries.usageCount} + 1
        end`,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("failed to upsert space voice lexicon entry");
  return serializeVoiceLexiconEntry("space", row);
}

export async function updateSpaceVoiceLexiconEntry(
  spaceId: string,
  entryId: string,
  input: VoiceLexiconInput,
) {
  const parsed = parsePatchInput(input);
  const now = new Date();
  try {
    const [row] = await db
      .update(spaceVoiceLexiconEntries)
      .set({
        term: parsed.term,
        termKey: parsed.termKey,
        ...(parsed.source !== undefined ? { source: parsed.source } : {}),
        ...(parsed.originalText !== undefined
          ? { originalText: parsed.originalText }
          : {}),
        updatedAt: now,
      })
      .where(and(
        eq(spaceVoiceLexiconEntries.id, entryId),
        eq(spaceVoiceLexiconEntries.spaceId, spaceId),
      ))
      .returning();
    return row ? serializeVoiceLexiconEntry("space", row) : null;
  } catch (error) {
    rethrowVoiceLexiconConflict(error);
  }
}

export async function deleteSpaceVoiceLexiconEntry(spaceId: string, entryId: string) {
  const [row] = await db
    .delete(spaceVoiceLexiconEntries)
    .where(and(
      eq(spaceVoiceLexiconEntries.id, entryId),
      eq(spaceVoiceLexiconEntries.spaceId, spaceId),
    ))
    .returning({ id: spaceVoiceLexiconEntries.id });
  return Boolean(row);
}
