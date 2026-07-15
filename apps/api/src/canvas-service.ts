import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { canvasDocuments, canvasNodes, canvasUpdates } from "@cohub/db";
import { db } from "./db/index.js";
import { createCanvasTransactionAppliedEvent } from "./canvas-events.js";
import { enqueueRealtimeOutboxEvent } from "./db/outbox.js";
import {
  CanvasServiceError,
  canvasRequestHash,
  normalizeCanvasOps,
  normalizeCanvasTransactionIdentity,
  type normalizeNode,
  type CanvasSemanticOp,
  type NormalizedPatch,
} from "./canvas-protocol.js";

export { CanvasServiceError, normalizeNodes } from "./canvas-protocol.js";
export type { CanvasNodeInput, CanvasSemanticOp } from "./canvas-protocol.js";

type CanvasDatabase = Pick<typeof db, "transaction">;

export type CanvasTransactionResponse = {
  transaction: {
    txId: string;
    baseVersion: number;
    version: number;
    replayed: boolean;
  };
  document: {
    version: number;
    meta: Record<string, unknown>;
  };
  changes: {
    nodes: Array<typeof canvasNodes.$inferSelect>;
    deletedNodeIds: string[];
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

function readStoredTransactionResult(
  value: Record<string, unknown>,
  fallback: { txId: string; baseVersion: number; version: number; meta: Record<string, unknown> },
): CanvasTransactionResponse {
  const transaction = isRecord(value.transaction) ? value.transaction : {};
  const document = isRecord(value.document) ? value.document : {};
  const changes = isRecord(value.changes) ? value.changes : {};
  return {
    transaction: {
      txId: typeof transaction.txId === "string" ? transaction.txId : fallback.txId,
      baseVersion: typeof transaction.baseVersion === "number" ? transaction.baseVersion : fallback.baseVersion,
      version: typeof transaction.version === "number" ? transaction.version : fallback.version,
      replayed: true,
    },
    document: {
      version: typeof document.version === "number" ? document.version : fallback.version,
      meta: isRecord(document.meta) ? document.meta : fallback.meta,
    },
    changes: {
      nodes: Array.isArray(changes.nodes) ? changes.nodes as Array<typeof canvasNodes.$inferSelect> : [],
      deletedNodeIds: Array.isArray(changes.deletedNodeIds) ? changes.deletedNodeIds.filter((id): id is string => typeof id === "string") : [],
    },
  };
}

export async function applyCanvasTransaction(input: {
  spaceId: string;
  documentId: string;
  actorId: string;
  txId: string;
  baseVersion: number;
  clientId?: string | null;
  undoGroupId?: string | null;
  ops: CanvasSemanticOp[];
  broadcast?: boolean;
}, database: CanvasDatabase = db) {
  const { txId } = normalizeCanvasTransactionIdentity(input);
  const normalizedOps = normalizeCanvasOps(input.ops);
  const requestHash = canvasRequestHash(normalizedOps);
  const now = new Date();
  const result = await database.transaction(async (tx) => {
    const [document] = await tx
      .select()
      .from(canvasDocuments)
      .where(and(eq(canvasDocuments.id, input.documentId), eq(canvasDocuments.spaceId, input.spaceId), isNull(canvasDocuments.deletedAt)))
      .for("update")
      .limit(1);
    if (!document) throw new CanvasServiceError(404, "canvas not found");
    const [existingUpdate] = await tx
      .select()
      .from(canvasUpdates)
      .where(and(eq(canvasUpdates.documentId, input.documentId), eq(canvasUpdates.txId, txId)))
      .limit(1);
    if (existingUpdate) {
      if (existingUpdate.requestHash && existingUpdate.requestHash !== requestHash) {
        throw new CanvasServiceError(409, "txId was already used for a different transaction", "tx_id_conflict", document.version);
      }
      return readStoredTransactionResult(existingUpdate.result, {
          txId,
          baseVersion: existingUpdate.baseVersion,
          version: existingUpdate.version,
          meta: document.meta,
        });
    }
    if (input.baseVersion !== document.version) {
      throw new CanvasServiceError(409, "canvas version conflict", "version_conflict", document.version);
    }
    const nextVersion = document.version + 1;
    const changedNodeIds = new Set<string>();
    const deletedNodeIds = new Set<string>();
    let nextMeta = document.meta;

    for (const op of normalizedOps) {
      if (op.type === "node.create") {
        const node = (op.payload as { node: ReturnType<typeof normalizeNode> }).node;
        const values = {
          documentId: input.documentId,
          nodeId: node.nodeId,
          type: node.type,
          parentId: node.parentId,
          orderKey: node.orderKey,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          rotation: node.rotation,
          refKind: node.refKind,
          refPath: node.refPath,
          refUrl: node.refUrl,
          view: node.view,
          style: node.style,
          animation: node.animation,
          data: node.data,
          version: nextVersion,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        const [existingNode] = await tx.select({ deletedAt: canvasNodes.deletedAt })
          .from(canvasNodes)
          .where(and(eq(canvasNodes.documentId, input.documentId), eq(canvasNodes.nodeId, node.nodeId)))
          .limit(1);
        if (existingNode && existingNode.deletedAt == null) {
          throw new CanvasServiceError(409, "canvas node already exists", "node_exists", document.version);
        }
        if (existingNode) {
          await tx.update(canvasNodes).set(values)
            .where(and(eq(canvasNodes.documentId, input.documentId), eq(canvasNodes.nodeId, node.nodeId)));
        } else {
          await tx.insert(canvasNodes).values(values);
        }
        changedNodeIds.add(node.nodeId);
        continue;
      }
      if (op.type === "node.patch") {
        const { nodeId, patch } = op.payload as { nodeId: string; patch: NormalizedPatch };
        const updated = await tx.update(canvasNodes)
          .set({ ...patch, updatedAt: now, version: nextVersion })
          .where(and(eq(canvasNodes.documentId, input.documentId), eq(canvasNodes.nodeId, nodeId), isNull(canvasNodes.deletedAt)))
          .returning({ nodeId: canvasNodes.nodeId });
        if (updated.length === 0) throw new CanvasServiceError(404, "canvas node not found");
        changedNodeIds.add(nodeId);
        continue;
      }
      if (op.type === "node.data.merge") {
        const { nodeId, data } = op.payload as { nodeId: string; data: Record<string, unknown> };
        const updated = await tx.update(canvasNodes)
          .set({ data: sql`${canvasNodes.data} || ${JSON.stringify(data)}::jsonb`, updatedAt: now, version: nextVersion })
          .where(and(eq(canvasNodes.documentId, input.documentId), eq(canvasNodes.nodeId, nodeId), isNull(canvasNodes.deletedAt)))
          .returning({ nodeId: canvasNodes.nodeId });
        if (updated.length === 0) throw new CanvasServiceError(404, "canvas node not found");
        changedNodeIds.add(nodeId);
        continue;
      }
      if (op.type === "document.meta.patch") {
        const { patch } = op.payload as { patch: Record<string, unknown> };
        nextMeta = { ...nextMeta, ...patch };
        continue;
      }
      const nodeId = (op.payload as { nodeId: string }).nodeId;
      const deleted = await tx.update(canvasNodes)
        .set({ deletedAt: now, updatedAt: now, version: nextVersion })
        .where(and(eq(canvasNodes.documentId, input.documentId), eq(canvasNodes.nodeId, nodeId), isNull(canvasNodes.deletedAt)))
        .returning({ nodeId: canvasNodes.nodeId });
      if (deleted.length === 0) throw new CanvasServiceError(404, "canvas node not found");
      changedNodeIds.delete(nodeId);
      deletedNodeIds.add(nodeId);
    }

    await tx.update(canvasDocuments)
      .set({ version: nextVersion, meta: nextMeta, updatedAt: now })
      .where(eq(canvasDocuments.id, input.documentId));
    const nodes = changedNodeIds.size > 0
      ? await tx.select().from(canvasNodes).where(and(
          eq(canvasNodes.documentId, input.documentId),
          inArray(canvasNodes.nodeId, [...changedNodeIds]),
          isNull(canvasNodes.deletedAt),
        ))
      : [];
    const response: CanvasTransactionResponse = {
      transaction: { txId, baseVersion: input.baseVersion, version: nextVersion, replayed: false },
      document: { version: nextVersion, meta: nextMeta },
      changes: { nodes, deletedNodeIds: [...deletedNodeIds] },
    };
    await tx.insert(canvasUpdates).values({
      documentId: input.documentId,
      txId,
      baseVersion: input.baseVersion,
      requestHash,
      version: nextVersion,
      actorId: input.actorId,
      clientId: input.clientId ?? null,
      type: "canvas.tx",
      payload: { ops: normalizedOps },
      result: response,
      undoGroupId: input.undoGroupId ?? null,
      createdAt: now,
    });
    if (input.broadcast !== false) {
      const event = createCanvasTransactionAppliedEvent({
        spaceId: input.spaceId,
        documentId: input.documentId,
        actorId: input.actorId,
        txId,
        version: nextVersion,
        ops: normalizedOps as Array<Record<string, unknown>>,
        occurredAt: now,
      });
      await enqueueRealtimeOutboxEvent(tx, {
        deduplicationKey: `canvas.tx.applied:${input.documentId}:${nextVersion}`,
        aggregateType: "canvas_document",
        aggregateId: input.documentId,
        aggregateSequence: nextVersion,
        event,
      });
    }
    return response;
  });
  return result;
}
