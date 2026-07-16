import { and, eq, max, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { labelAssignments, labels } from "@cohub/db";

export type SessionChannelLabelInput = {
  db: PostgresJsDatabase<Record<string, unknown>>;
  spaceId: string;
  sessionId: string;
  channelId: string;
  spaceChannelId?: string | null;
  provider?: string | null;
  userId?: string | null;
};

const ROOT_LABEL_NAME = "Channel";
const CUSTOM_LABEL_NAME_SUFFIX = " (Custom)";
const MAX_LABEL_NAME_LENGTH = 80;

export const SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX = "session-channel:";
export const SESSION_CHANNEL_ROOT_LABEL_SYSTEM_KEY = `${SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX}root`;

export const getSessionChannelLabelSystemKey = (channelId: string) =>
  `${SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX}${channelId}`;

export const parseSessionChannelLabelSystemKey = (systemKey: string | null | undefined) => {
  if (!systemKey?.startsWith(SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX)) return null;
  const channelId = systemKey.slice(SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX.length).trim();
  return channelId && channelId !== "root" ? channelId : null;
};

const normalizeChannelId = (channelId: string | null | undefined) => {
  const normalized = channelId?.trim();
  if (!normalized || normalized.length > MAX_LABEL_NAME_LENGTH || normalized.includes("/")) return null;
  return normalized;
};

const slugifyLabelName = (name: string) => {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "label";
};

async function findLabelByName(
  db: PostgresJsDatabase<Record<string, unknown>>,
  spaceId: string,
  name: string,
  parentId: string | null,
) {
  const [row] = await db
    .select()
    .from(labels)
    .where(and(
      eq(labels.spaceId, spaceId),
      parentId ? eq(labels.parentId, parentId) : sql`${labels.parentId} is null`,
      sql`lower(${labels.name}) = lower(${name})`,
    ))
    .limit(1);
  return row ?? null;
}

async function findLabelBySystemKey(
  db: PostgresJsDatabase<Record<string, unknown>>,
  spaceId: string,
  systemKey: string,
) {
  const [row] = await db
    .select()
    .from(labels)
    .where(and(eq(labels.spaceId, spaceId), eq(labels.systemKey, systemKey)))
    .limit(1);
  return row ?? null;
}

async function nextLabelRank(
  db: PostgresJsDatabase<Record<string, unknown>>,
  spaceId: string,
  parentId: string | null,
) {
  const [{ value } = { value: 0 }] = await db
    .select({ value: max(labels.rank) })
    .from(labels)
    .where(and(
      eq(labels.spaceId, spaceId),
      parentId ? eq(labels.parentId, parentId) : sql`${labels.parentId} is null`,
    ));
  return Number(value ?? 0) + 10;
}

function customFallbackLabelName(name: string, suffix: string) {
  const base = name.length + suffix.length <= 80
    ? name
    : name.slice(0, 80 - suffix.length);
  return `${base}${suffix}`;
}

async function nextAvailableCustomLabelName(
  db: PostgresJsDatabase<Record<string, unknown>>,
  input: { spaceId: string; name: string; parentId: string | null },
) {
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? CUSTOM_LABEL_NAME_SUFFIX : ` (Custom ${index + 1})`;
    const candidate = customFallbackLabelName(input.name, suffix);
    const existing = await findLabelByName(db, input.spaceId, candidate, input.parentId);
    if (!existing) return candidate;
  }
  throw new Error(`failed to rename conflicting user label: ${input.name}`);
}

async function moveConflictingUserLabel(
  db: PostgresJsDatabase<Record<string, unknown>>,
  input: { spaceId: string; name: string; parentId: string | null },
) {
  const existing = await findLabelByName(db, input.spaceId, input.name, input.parentId);
  if (!existing || existing.source === "system") return;
  const name = await nextAvailableCustomLabelName(db, input);
  await db
    .update(labels)
    .set({ name, slug: slugifyLabelName(name), updatedAt: new Date() })
    .where(and(eq(labels.id, existing.id), eq(labels.source, "user")));
}

async function getOrCreateSystemLabel(
  db: PostgresJsDatabase<Record<string, unknown>>,
  input: {
    spaceId: string;
    name: string;
    parentId: string | null;
    depth: 0 | 1;
    systemKey: string;
    userId: string | null;
  },
) {
  const existingBySystemKey = await findLabelBySystemKey(db, input.spaceId, input.systemKey);
  if (existingBySystemKey) return existingBySystemKey;

  await moveConflictingUserLabel(db, {
    spaceId: input.spaceId,
    name: input.name,
    parentId: input.parentId,
  });
  const existingByName = await findLabelByName(db, input.spaceId, input.name, input.parentId);
  if (existingByName?.source === "system") return existingByName;

  const [created] = await db.insert(labels).values({
    spaceId: input.spaceId,
    name: input.name,
    slug: slugifyLabelName(input.name),
    parentId: input.parentId,
    depth: input.depth,
    rank: await nextLabelRank(db, input.spaceId, input.parentId),
    source: "system",
    systemKey: input.systemKey,
    createdBy: input.userId,
  }).onConflictDoNothing().returning();
  if (created) return created;

  const raced = await findLabelBySystemKey(db, input.spaceId, input.systemKey)
    ?? await findLabelByName(db, input.spaceId, input.name, input.parentId);
  if (!raced) throw new Error("failed to create channel label");
  return raced;
}

export async function assignSessionChannelSystemLabel(input: SessionChannelLabelInput) {
  const channelId = normalizeChannelId(input.channelId);
  if (!channelId) return null;

  const rootLabel = await getOrCreateSystemLabel(input.db, {
    spaceId: input.spaceId,
    name: ROOT_LABEL_NAME,
    parentId: null,
    depth: 0,
    systemKey: SESSION_CHANNEL_ROOT_LABEL_SYSTEM_KEY,
    userId: input.userId ?? null,
  });

  const childLabel = await getOrCreateSystemLabel(input.db, {
    spaceId: input.spaceId,
    name: channelId,
    parentId: rootLabel.id,
    depth: 1,
    systemKey: getSessionChannelLabelSystemKey(channelId),
    userId: input.userId ?? null,
  });

  const existingAssignment = await input.db
    .select({ labelId: labelAssignments.labelId })
    .from(labelAssignments)
    .where(and(
      eq(labelAssignments.spaceId, input.spaceId),
      eq(labelAssignments.resourceType, "session"),
      eq(labelAssignments.resourceRef, input.sessionId),
      eq(labelAssignments.labelId, childLabel.id),
    ))
    .limit(1);

  if (existingAssignment.length === 0) {
    await input.db.insert(labelAssignments).values({
      labelId: childLabel.id,
      spaceId: input.spaceId,
      resourceType: "session",
      resourceRef: input.sessionId,
      rank: null,
      source: "system",
      createdBy: input.userId ?? null,
      meta: {
        kind: "session_channel",
        channelId,
        spaceChannelId: input.spaceChannelId ?? null,
        provider: input.provider?.trim() || null,
      },
    }).onConflictDoNothing();
  }

  return childLabel.id;
}
