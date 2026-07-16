import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { checkpoints, labelAssignments, type labels, spaceSessions } from "@cohub/db";
import { listLabelsByRank } from "./index.js";

export type LabelResourceType = "session" | "checkpoint" | "file";

type LabelsDb = PostgresJsDatabase<Record<string, unknown>>;

function buildHref(spaceId: string, resourceType: string, resourceRef: string) {
  if (resourceType === "session") return `/spaces/${spaceId}/sessions/${resourceRef}`;
  if (resourceType === "checkpoint") return `/spaces/${spaceId}/checkpoints/${resourceRef}`;
  if (resourceType === "file") return `/spaces/${spaceId}/files/${resourceRef.split("/").map(encodeURIComponent).join("/")}`;
  return `/spaces/${spaceId}`;
}

export function buildLabelTree(rows: Array<typeof labels.$inferSelect>) {
  const sorted = [...rows].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.name.localeCompare(b.name);
  });
  const byId = new Map(sorted.map((label) => [label.id, { ...label, children: [] as Array<typeof label & { children: never[] }> }]));
  const roots: Array<typeof sorted[number] & { children: Array<typeof sorted[number]> }> = [];
  for (const label of byId.values()) {
    if (label.parentId) {
      const parent = byId.get(label.parentId);
      if (parent) {
        parent.children.push(label as never);
        continue;
      }
    }
    roots.push(label as never);
  }
  return roots;
}

export async function hydrateLabelAssignments(
  db: LabelsDb,
  spaceId: string,
  rows: Array<typeof labelAssignments.$inferSelect>,
) {
  const sessionIds = rows.filter((m) => m.resourceType === "session").map((m) => m.resourceRef);
  const checkpointIds = rows.filter((m) => m.resourceType === "checkpoint").map((m) => m.resourceRef);
  const sessionRows = sessionIds.length > 0
    ? await db.select().from(spaceSessions).where(and(eq(spaceSessions.spaceId, spaceId), inArray(spaceSessions.id, sessionIds)))
    : [];
  const checkpointRows = checkpointIds.length > 0
    ? await db.select().from(checkpoints).where(and(eq(checkpoints.spaceId, spaceId), inArray(checkpoints.id, checkpointIds)))
    : [];
  const sessionsById = new Map(sessionRows.map((s) => [s.id, s]));
  const checkpointsById = new Map(checkpointRows.map((cp) => [cp.id, cp]));

  return rows.flatMap((assignment) => {
    if (assignment.resourceType === "session") {
      const session = sessionsById.get(assignment.resourceRef);
      if (!session) return [];
      return [{
        ...assignment,
        href: buildHref(spaceId, assignment.resourceType, assignment.resourceRef),
        resource: {
          title: session.title ?? session.latestMessageText ?? "New chat",
          subtitle: session.lastMessageAt ? new Date(session.lastMessageAt).toISOString() : null,
          status: session.status ?? null,
        },
      }];
    }
    if (assignment.resourceType === "checkpoint") {
      const checkpoint = checkpointsById.get(assignment.resourceRef);
      if (!checkpoint) return [];
      return [{
        ...assignment,
        href: buildHref(spaceId, assignment.resourceType, assignment.resourceRef),
        resource: {
          title: checkpoint.description || checkpoint.commitHash.slice(0, 12),
          subtitle: checkpoint.createdAt ? new Date(checkpoint.createdAt).toISOString() : null,
          status: null,
        },
      }];
    }
    if (assignment.resourceType === "file") {
      return [{
        ...assignment,
        href: buildHref(spaceId, assignment.resourceType, assignment.resourceRef),
        resource: {
          title: assignment.resourceRef.split("/").pop() ?? assignment.resourceRef,
          subtitle: assignment.resourceRef,
          status: null,
        },
      }];
    }
    return [];
  });
}

export async function buildResourceLabelSnapshot(input: {
  db: LabelsDb;
  spaceId: string;
  resourceType: LabelResourceType;
  resourceRef: string;
  affectedLabelIds?: string[];
}) {
  const [allLabels, assignments] = await Promise.all([
    listLabelsByRank(input.db, input.spaceId),
    input.db
      .select()
      .from(labelAssignments)
      .where(and(
        eq(labelAssignments.spaceId, input.spaceId),
        eq(labelAssignments.resourceType, input.resourceType),
        eq(labelAssignments.resourceRef, input.resourceRef),
      ))
      .orderBy(sql`${labelAssignments.rank} asc nulls last`, asc(labelAssignments.createdAt), asc(labelAssignments.id)),
  ]);
  const items = await hydrateLabelAssignments(input.db, input.spaceId, assignments);
  return {
    labels: buildLabelTree(allLabels),
    assignments,
    items,
    affectedLabelIds: Array.from(new Set([
      ...(input.affectedLabelIds ?? []),
      ...assignments.map((assignment) => assignment.labelId),
    ])),
  };
}
