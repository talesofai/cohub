import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { labelAssignments, labels } from "@cohub/db";
import type { LabelResourceType } from "./resource-events.js";

/**
 * User-scoped labels — the same label/assignment model as space-scoped labels,
 * but under scope_type='user' with scope_id=<userUuid>.
 *
 * The built-in "Pinned" system label (system_key='user:pinned') lets a user
 * bookmark spaces across the product. User-scoped labels are private to the
 * owner; only the viewer can see or mutate their own labels.
 */

type LabelsDb = PostgresJsDatabase<Record<string, unknown>>;
export type UserLabelIdentity = string | { uuid: string; aliases?: readonly string[] };

const userLabelIdentity = (identity: UserLabelIdentity) => {
  const uuid = (typeof identity === "string" ? identity : identity.uuid).trim();
  const aliases = typeof identity === "string" ? [] : identity.aliases ?? [];
  return {
    uuid,
    keys: [...new Set([uuid, ...aliases].map((value) => value.trim()).filter(Boolean))],
  };
};

export type UserLabelAssignment = typeof labelAssignments.$inferSelect & {
  labelSystemKey: string | null;
  labelName: string;
};

export const USER_LABEL_SCOPE_TYPE = "user";
export const PINNED_LABEL_NAME = "Pinned";
export const PINNED_LABEL_SYSTEM_KEY = "user:pinned";

const MAX_LABEL_NAME_LENGTH = 80;
const RESERVED_SYSTEM_ROOT_LABELS = new Set(["pinned"]);

const hasControlCharacter = (value: string) => [...value].some((char) => {
  const code = char.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
});

export function normalizeLabelName(value: unknown): string {
  if (typeof value !== "string") throw new Error("label name must be a string");
  if (hasControlCharacter(value)) throw new Error("label name cannot contain control characters");
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || name.length > MAX_LABEL_NAME_LENGTH) throw new Error(`label name must be 1-${MAX_LABEL_NAME_LENGTH} characters`);
  if (name.includes("/")) throw new Error('label name cannot contain "/"');
  return name;
}

export function slugifyLabelName(name: string) {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "label";
}

async function findUserLabelByName(db: LabelsDb, identity: UserLabelIdentity, name: string) {
  const rows = await db
    .select()
    .from(labels)
    .where(and(
      eq(labels.scopeType, USER_LABEL_SCOPE_TYPE),
      inArray(labels.scopeId, userLabelIdentity(identity).keys),
      sql`lower(${labels.name}) = lower(${name})`,
    ))
  if (rows.length > 1) throw new Error("user label identity conflict requires repair");
  return rows[0] ?? null;
}

async function findUserLabelBySystemKey(db: LabelsDb, identity: UserLabelIdentity, systemKey: string) {
  const rows = await db
    .select()
    .from(labels)
    .where(and(
      eq(labels.scopeType, USER_LABEL_SCOPE_TYPE),
      inArray(labels.scopeId, userLabelIdentity(identity).keys),
      eq(labels.systemKey, systemKey),
    ))
  if (rows.length > 1) throw new Error("user label identity conflict requires repair");
  return rows[0] ?? null;
}

async function nextUserLabelRank(db: LabelsDb, identity: UserLabelIdentity) {
  const [{ value } = { value: 0 }] = await db
    .select({ value: max(labels.rank) })
    .from(labels)
    .where(and(eq(labels.scopeType, USER_LABEL_SCOPE_TYPE), inArray(labels.scopeId, userLabelIdentity(identity).keys)));
  return Number(value ?? 0) + 10;
}

/** Get-or-create the user's built-in "Pinned" system label. */
export async function ensurePinnedLabel(db: LabelsDb, identity: UserLabelIdentity) {
  const { uuid } = userLabelIdentity(identity);
  const existing = await findUserLabelBySystemKey(db, identity, PINNED_LABEL_SYSTEM_KEY);
  if (existing) return existing;

  const [created] = await db.insert(labels).values({
    scopeType: USER_LABEL_SCOPE_TYPE,
    scopeId: uuid,
    name: PINNED_LABEL_NAME,
    slug: slugifyLabelName(PINNED_LABEL_NAME),
    parentId: null,
    depth: 0,
    rank: await nextUserLabelRank(db, identity),
    source: "system",
    systemKey: PINNED_LABEL_SYSTEM_KEY,
    createdBy: uuid,
  }).onConflictDoNothing().returning();
  if (created) return created;

  const raced = await findUserLabelBySystemKey(db, identity, PINNED_LABEL_SYSTEM_KEY);
  if (!raced) throw new Error("failed to create pinned label");
  return raced;
}

/** Resolve a label ref (name) to an existing user-scope label, or null. */
export async function resolveUserLabelRef(db: LabelsDb, identity: UserLabelIdentity, labelRef: string) {
  const name = normalizeLabelName(labelRef);
  if (RESERVED_SYSTEM_ROOT_LABELS.has(name.toLowerCase())) {
    return ensurePinnedLabel(db, identity);
  }
  return findUserLabelByName(db, identity, name);
}

/** Resolve or create user-scope labels by ref (name). */
export async function resolveOrCreateUserLabelRefs(db: LabelsDb, identity: UserLabelIdentity, labelRefs: string[]) {
  const { uuid } = userLabelIdentity(identity);
  const refs = [...new Set(labelRefs.map((ref) => ref.trim()).filter(Boolean))];
  const labelIds: string[] = [];
  for (const ref of refs) {
    const name = normalizeLabelName(ref);
    if (RESERVED_SYSTEM_ROOT_LABELS.has(name.toLowerCase())) {
      labelIds.push((await ensurePinnedLabel(db, identity)).id);
      continue;
    }
    const existing = await findUserLabelByName(db, identity, name);
    if (existing) {
      labelIds.push(existing.id);
      continue;
    }
    const [created] = await db.insert(labels).values({
      scopeType: USER_LABEL_SCOPE_TYPE,
      scopeId: uuid,
      name,
      slug: slugifyLabelName(name),
      parentId: null,
      depth: 0,
      rank: await nextUserLabelRank(db, identity),
      source: "user",
      createdBy: uuid,
    }).onConflictDoNothing().returning();
    if (created) {
      labelIds.push(created.id);
    } else {
      const raced = await findUserLabelByName(db, identity, name);
      if (raced) labelIds.push(raced.id);
    }
  }
  return [...new Set(labelIds)];
}

/** List all labels under the user's scope. */
export async function listUserLabels(db: LabelsDb, identity: UserLabelIdentity) {
  return db
    .select()
    .from(labels)
    .where(and(eq(labels.scopeType, USER_LABEL_SCOPE_TYPE), inArray(labels.scopeId, userLabelIdentity(identity).keys)))
    .orderBy(asc(labels.rank), asc(labels.name));
}

/** Get the set of spaceIds the user has pinned. */
export async function getPinnedSpaceIds(db: LabelsDb, identity: UserLabelIdentity): Promise<Set<string>> {
  const label = await ensurePinnedLabel(db, identity);
  const rows = await db
    .select({ resourceRef: labelAssignments.resourceRef })
    .from(labelAssignments)
    .where(and(
      eq(labelAssignments.scopeType, USER_LABEL_SCOPE_TYPE),
      inArray(labelAssignments.scopeId, userLabelIdentity(identity).keys),
      eq(labelAssignments.labelId, label.id),
      eq(labelAssignments.resourceType, "space"),
    ));
  return new Set(rows.map((row) => row.resourceRef));
}

/** Attach a label to a resource (idempotent). */
export async function attachUserLabel(db: LabelsDb, identity: UserLabelIdentity, labelId: string, resourceType: LabelResourceType, resourceRef: string) {
  const { uuid, keys } = userLabelIdentity(identity);
  const [{ value: maxRank } = { value: 0 }] = await db
    .select({ value: max(labelAssignments.rank) })
    .from(labelAssignments)
    .where(eq(labelAssignments.labelId, labelId));
  const [assignment] = await db.insert(labelAssignments).values({
    labelId,
    scopeType: USER_LABEL_SCOPE_TYPE,
    scopeId: uuid,
    resourceType,
    resourceRef,
    rank: Number(maxRank ?? 0) + 10,
    source: "user",
    createdBy: uuid,
  }).onConflictDoNothing().returning();
  if (assignment) return assignment;
  const [existing] = await db
    .select()
    .from(labelAssignments)
    .where(and(
      eq(labelAssignments.labelId, labelId),
      eq(labelAssignments.scopeType, USER_LABEL_SCOPE_TYPE),
      inArray(labelAssignments.scopeId, keys),
      eq(labelAssignments.resourceType, resourceType),
      eq(labelAssignments.resourceRef, resourceRef),
    ))
    .limit(1);
  return existing ?? null;
}

/** Detach a label from a resource (idempotent). */
export async function detachUserLabel(db: LabelsDb, identity: UserLabelIdentity, labelId: string, resourceType: LabelResourceType, resourceRef: string) {
  await db.delete(labelAssignments).where(and(
    eq(labelAssignments.labelId, labelId),
    eq(labelAssignments.scopeType, USER_LABEL_SCOPE_TYPE),
    inArray(labelAssignments.scopeId, userLabelIdentity(identity).keys),
    eq(labelAssignments.resourceType, resourceType),
    eq(labelAssignments.resourceRef, resourceRef),
  ));
}

/** Get all label assignments for a resource under user scope, with label metadata. */
export async function getUserResourceLabelAssignments(db: LabelsDb, identity: UserLabelIdentity, resourceType: LabelResourceType, resourceRef: string): Promise<UserLabelAssignment[]> {
  const rows = await db
    .select({
      assignment: labelAssignments,
      labelSystemKey: labels.systemKey,
      labelName: labels.name,
    })
    .from(labelAssignments)
    .innerJoin(labels, eq(labels.id, labelAssignments.labelId))
    .where(and(
      eq(labelAssignments.scopeType, USER_LABEL_SCOPE_TYPE),
      inArray(labelAssignments.scopeId, userLabelIdentity(identity).keys),
      eq(labelAssignments.resourceType, resourceType),
      eq(labelAssignments.resourceRef, resourceRef),
    ))
    .orderBy(sql`${labelAssignments.rank} asc nulls last`, asc(labelAssignments.createdAt), asc(labelAssignments.id));
  return rows.map((row) => ({ ...row.assignment, labelSystemKey: row.labelSystemKey, labelName: row.labelName }));
}

/** Patch a resource's user-scope labels by ref (add/remove). */
export async function patchUserResourceLabels(db: LabelsDb, identity: UserLabelIdentity, resourceType: LabelResourceType, resourceRef: string, input: {
  addLabelRefs?: string[];
  removeLabelRefs?: string[];
}) {
  const [addLabelIds, removeLabels] = await Promise.all([
    input.addLabelRefs?.length
      ? resolveOrCreateUserLabelRefs(db, identity, input.addLabelRefs)
      : Promise.resolve([]),
    input.removeLabelRefs?.length
      ? Promise.all(input.removeLabelRefs.map((ref) => resolveUserLabelRef(db, identity, ref)))
      : Promise.resolve([]),
  ]);

  for (const labelId of addLabelIds) {
    if (labelId) await attachUserLabel(db, identity, labelId, resourceType, resourceRef);
  }
  for (const label of removeLabels) {
    if (label) await detachUserLabel(db, identity, label.id, resourceType, resourceRef);
  }
  return getUserResourceLabelAssignments(db, identity, resourceType, resourceRef);
}
