import { and, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  boardClips,
  boardConnections,
  boardEffects,
  boardNodes,
  boardOperations,
  boardPlaybackStates,
  boardCompositions,
  boardTracks,
  boardTransactions,
  boards,
} from "@cohub/db";
import type {
  BoardBootstrap,
  BoardCapabilities,
  BoardInspectInput,
  BoardNodeInput,
  BoardComposition,
  BoardEffect,
  BoardOperation,
  BoardMutationReceipt,
  BoardPlaybackCommand,
  BoardPlaybackSnapshot,
  BoardSummary,
  BoardAnimationTarget,
  RequestSource,
} from "@cohub/protocol";
import {
  BOARD_ANIMATION_CHANNEL_CAPABILITIES,
  BOARD_AUTHORING_ITEM_CAPABILITIES,
  BOARD_ANIMATION_PATCH_MAX_BYTES,
  BOARD_AUTHORING_SCHEMAS,
  BOARD_BUILTIN_CAPABILITIES,
  BOARD_PROTOCOL_VERSION,
  DEFAULT_BOARD_RENDER_LIMITS,
  isPureBoardAnimationChange,
} from "@cohub/protocol";
import {
  boardCompositionInputFromRows as compositionInputFromRows,
  boardCompositionsFromRows as compositionsFromRows,
  boardClipValues as clipValues,
  boardConnectionFromRow as connectionFromRow,
  boardConnectionValues as connectionValues,
  boardEffectFromRow as effectFromRow,
  boardTrackValues as trackValues,
  boardJsonEquals,
  boardMutationChanged,
  diffBoardCompositionWrite,
} from "@cohub/core/board";
import {
  collectTouchedConnectionIds,
  type ExistingConnectionRow,
  planConnectionWrites,
} from "./board-connection-plan.js";
import {
  collectTouchedNodeIds,
  type ExistingNodeRow,
  planNodeWrites,
} from "./board-node-plan.js";
import { collectValidationNodeIds } from "./board-validation-projection.js";
import { db } from "./db/index.js";
import { dispatchBoardChanged, dispatchBoardPlaybackChanged } from "./board-events.js";
import {
  BoardServiceError,
  contextualValidation,
  normalizeBoardTransaction,
  normalizePlaybackPosition,
  NODE_WRITE_CHUNK,
  type BoardValidationContext,
} from "./board-ops.js";

export * from "./board-ops.js";

const BOARD_CAPABILITIES: BoardCapabilities = {
  protocolVersion: BOARD_PROTOCOL_VERSION,
  capabilities: BOARD_BUILTIN_CAPABILITIES,
  limits: DEFAULT_BOARD_RENDER_LIMITS,
  items: BOARD_AUTHORING_ITEM_CAPABILITIES,
  animationChannels: BOARD_ANIMATION_CHANNEL_CAPABILITIES,
  authoring: BOARD_AUTHORING_SCHEMAS,
};

function dateString(value: Date | null | undefined): string | null {
  return value?.toISOString() ?? null;
}

function playbackFromRow(row: typeof boardPlaybackStates.$inferSelect): BoardPlaybackSnapshot {
  return {
    boardId: row.boardId,
    playbackId: row.playbackId,
    compositionId: row.compositionId,
    compositionRevision: row.compositionRevision,
    playbackRevision: row.playbackRevision,
    status: row.status as BoardPlaybackSnapshot["status"],
    position: row.position,
    effectiveAt: row.effectiveAt.getTime(),
    timeScale: row.timeScale,
    seed: row.seed,
  };
}

export async function inspectBoard(
  spaceId: string,
  boardId: string,
  input: BoardInspectInput = {},
): Promise<BoardBootstrap> {
  const [board] = await db.select().from(boards).where(and(eq(boards.id, boardId), eq(boards.spaceId, spaceId))).limit(1);
  if (!board) throw new BoardServiceError(404, "board not found", "BOARD_NOT_FOUND");
  const included = input.include ? new Set(input.include) : null;
  const wants = (section: NonNullable<BoardInspectInput["include"]>[number]) => !included || included.has(section);
  const viewport = input.viewport;
  const nodeWhere = and(
    eq(boardNodes.boardId, boardId),
    isNull(boardNodes.deletedAt),
    ...(input.nodeIds?.length ? [inArray(boardNodes.nodeId, input.nodeIds)] : []),
    ...(viewport ? [
      lt(boardNodes.x, viewport.x + viewport.width),
      gt(sql<number>`${boardNodes.x} + ${boardNodes.width}`, viewport.x),
      lt(boardNodes.y, viewport.y + viewport.height),
      gt(sql<number>`${boardNodes.y} + ${boardNodes.height}`, viewport.y),
    ] : []),
  );
  const [nodes, connections, effects, compositions, tracks, clips, playback] = await Promise.all([
    wants("nodes") ? db.select().from(boardNodes).where(nodeWhere).orderBy(boardNodes.orderKey) : Promise.resolve([]),
    wants("connections")
      ? db.select().from(boardConnections)
        .where(and(
          eq(boardConnections.boardId, boardId),
          isNull(boardConnections.deletedAt),
          ...(input.connectionIds?.length ? [inArray(boardConnections.connectionId, input.connectionIds)] : []),
        ))
        .orderBy(boardConnections.connectionId)
      : Promise.resolve([]),
    wants("effects") ? db.select().from(boardEffects).where(and(
      eq(boardEffects.boardId, boardId),
      ...(input.effectIds?.length ? [inArray(boardEffects.id, input.effectIds)] : []),
    )) : Promise.resolve([]),
    wants("compositions") ? db.select().from(boardCompositions).where(and(
      eq(boardCompositions.boardId, boardId),
      ...(input.compositionIds?.length ? [inArray(boardCompositions.id, input.compositionIds)] : []),
    )) : Promise.resolve([]),
    wants("compositions") ? db.select().from(boardTracks).where(and(
      eq(boardTracks.boardId, boardId),
      ...(input.compositionIds?.length ? [inArray(boardTracks.compositionId, input.compositionIds)] : []),
    )).orderBy(boardTracks.compositionId, boardTracks.id) : Promise.resolve([]),
    wants("compositions") ? db.select().from(boardClips).where(and(
      eq(boardClips.boardId, boardId),
      ...(input.compositionIds?.length ? [inArray(boardClips.compositionId, input.compositionIds)] : []),
    )).orderBy(boardClips.compositionId, boardClips.start) : Promise.resolve([]),
    wants("playback") ? db.select().from(boardPlaybackStates).where(eq(boardPlaybackStates.boardId, boardId)).limit(1) : Promise.resolve([]),
  ]);
  // A viewport read culls nodes, so connections are narrowed to the ones whose
  // endpoints are both present. Returning an edge to a node the caller was not
  // given would make the response internally inconsistent - the reader could not
  // tell a clipped endpoint from a deleted one.
  const visibleConnections = viewport && wants("nodes")
    ? (() => {
        const present = new Set(nodes.map((node) => node.nodeId));
        return connections.filter(
          (row) => present.has(row.sourceNodeId) && present.has(row.targetNodeId),
        );
      })()
    : connections;
  return {
    board: {
      id: board.id,
      spaceId: board.spaceId,
      title: board.title,
      version: board.version,
      metadata: board.metadata,
      createdAt: dateString(board.createdAt),
      updatedAt: dateString(board.updatedAt),
    },
    nodes: nodes.map(({ deletedAt: _deletedAt, ...node }) => ({
      ...node,
      createdAt: dateString(node.createdAt),
      updatedAt: dateString(node.updatedAt),
    })),
    connections: visibleConnections.map(connectionFromRow),
    effects: effects.map(effectFromRow),
    compositions: compositionsFromRows(compositions, tracks, clips),
    playback: playback[0] ? playbackFromRow(playback[0]) : null,
  };
}

export async function summarizeBoard(
  spaceId: string,
  boardId: string,
): Promise<BoardSummary> {
  const [summaryRows, playback] = await Promise.all([
    db.select({
      id: boards.id,
      spaceId: boards.spaceId,
      title: boards.title,
      version: boards.version,
      metadata: boards.metadata,
      createdAt: boards.createdAt,
      updatedAt: boards.updatedAt,
      items: sql<number>`(select count(*)::int from ${boardNodes} where ${boardNodes.boardId} = ${boardId} and ${boardNodes.deletedAt} is null)`,
      connections: sql<number>`(select count(*)::int from ${boardConnections} where ${boardConnections.boardId} = ${boardId} and ${boardConnections.deletedAt} is null)`,
      effects: sql<number>`(select count(*)::int from ${boardEffects} where ${boardEffects.boardId} = ${boardId})`,
      compositions: sql<number>`(select count(*)::int from ${boardCompositions} where ${boardCompositions.boardId} = ${boardId})`,
    }).from(boards)
      .where(and(eq(boards.id, boardId), eq(boards.spaceId, spaceId)))
      .limit(1),
    db.select().from(boardPlaybackStates).where(eq(boardPlaybackStates.boardId, boardId)).limit(1),
  ]);
  const summary = summaryRows[0];
  if (!summary) throw new BoardServiceError(404, "board not found", "BOARD_NOT_FOUND");
  return {
    board: {
      id: summary.id,
      spaceId: summary.spaceId,
      title: summary.title,
      version: summary.version,
      metadata: summary.metadata,
      createdAt: dateString(summary.createdAt),
      updatedAt: dateString(summary.updatedAt),
    },
    counts: {
      items: summary.items,
      connections: summary.connections,
      effects: summary.effects,
      compositions: summary.compositions,
    },
    playback: playback[0] ? playbackFromRow(playback[0]) : null,
  };
}

export async function getBoardCapabilities(spaceId: string, boardId: string): Promise<BoardCapabilities> {
  const [board] = await db.select({ id: boards.id }).from(boards).where(and(eq(boards.id, boardId), eq(boards.spaceId, spaceId))).limit(1);
  if (!board) throw new BoardServiceError(404, "board not found", "BOARD_NOT_FOUND");
  return BOARD_CAPABILITIES;
}

function nodeInputFromRow(row: typeof boardNodes.$inferSelect): BoardNodeInput {
  const {
    boardId: _boardId,
    version: _version,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    deletedAt: _deletedAt,
    ...node
  } = row;
  return node;
}

function createValidationContext(input: {
  boardVersion: number;
  metadata: Record<string, unknown>;
  nodes: Array<{ nodeId: string }>;
  nodeInputs?: BoardNodeInput[];
  connections: Array<typeof boardConnections.$inferSelect>;
  effects: Array<typeof boardEffects.$inferSelect>;
  compositions: Array<typeof boardCompositions.$inferSelect>;
  tracks: Array<typeof boardTracks.$inferSelect>;
  clips: Array<typeof boardClips.$inferSelect>;
}): BoardValidationContext {
  return {
    boardVersion: input.boardVersion,
    metadata: input.metadata,
    nodeIds: input.nodes.map((node) => node.nodeId),
    nodes: input.nodeInputs,
    connections: input.connections.map(connectionFromRow),
    effects: input.effects.map(effectFromRow),
    compositions: compositionsFromRows(input.compositions, input.tracks, input.clips),
  };
}


function effectValues(boardId: string, effect: BoardOperation & { type: "effect.upsert" }, revision: number, now: Date) {
  const value = effect.payload.effect;
  return {
    id: value.id,
    boardId,
    targetType: value.target.type,
    targetId: value.target.type === "item" ? value.target.itemId : null,
    kind: value.kind,
    kindVersion: value.kindVersion,
    enabled: value.enabled,
    lifecycle: value.lifecycle,
    timeOrigin: value.timeOrigin,
    layer: value.layer,
    seed: value.seed,
    params: value.params,
    assetRefs: value.assetRefs,
    metadata: value.metadata,
    revision,
    updatedAt: now,
  };
}


export function receiptFromStoredTransaction(input: {
  boardId: string;
  txId: string;
  resultVersion: number | null;
  operations: unknown;
  receipt: unknown;
}): BoardMutationReceipt {
  const stored = input.receipt && typeof input.receipt === "object" && !Array.isArray(input.receipt)
    ? input.receipt as Partial<BoardMutationReceipt>
    : {};
  if (
    typeof stored.mutationId === "string" &&
    (stored.status === "applied" || stored.status === "validated") &&
    stored.board && typeof stored.board.version === "number" &&
    stored.changed
  ) {
    return {
      ...(stored as BoardMutationReceipt),
      outcome: stored.outcome ?? (stored.status === "applied" ? "applied" : "noop"),
      replayed: true,
    };
  }
  const operations = Array.isArray(input.operations) ? input.operations as BoardOperation[] : [];
  return {
    mutationId: input.txId,
    status: input.resultVersion === null ? "validated" : "applied",
    outcome: input.resultVersion === null ? "noop" : "applied",
    replayed: true,
    board: { id: input.boardId, version: input.resultVersion ?? 0 },
    changed: boardMutationChanged(operations),
  };
}

export async function applyBoardTransaction(input: {
  spaceId: string;
  actorId: string;
  transaction: unknown;
  requestSource?: RequestSource | null;
  broadcast?: boolean;
  allowNoop?: boolean;
  /** Validate (schema + contextual references) without writing or recording. */
  dryRun?: boolean;
}): Promise<BoardMutationReceipt> {
  const transaction = normalizeBoardTransaction(input.transaction, {
    allowEmpty: input.allowNoop,
  });
  const transactionMetadata: Record<string, unknown> = input.requestSource
    ? { source: input.requestSource }
    : {};
  const now = new Date();
  const result: {
    idempotent: boolean;
    receipt: BoardMutationReceipt;
    playback: BoardPlaybackSnapshot | null;
    animationPatch?: {
      effects: BoardEffect[];
      compositions: BoardComposition[];
      playback?: BoardPlaybackSnapshot | null;
    } | null;
  } = await db.transaction(async (tx) => {
    const [board] = await tx.select().from(boards)
      .where(and(eq(boards.id, transaction.boardId), eq(boards.spaceId, input.spaceId))).for("update").limit(1);
    if (!board) throw new BoardServiceError(404, "board not found", "BOARD_NOT_FOUND");

    const [existing] = await tx.select({
      receipt: boardTransactions.receipt,
      resultVersion: boardTransactions.resultVersion,
      operations: boardTransactions.operations,
    })
      .from(boardTransactions)
      .where(and(eq(boardTransactions.boardId, transaction.boardId), eq(boardTransactions.txId, transaction.txId))).limit(1);
    if (existing) {
      return {
        idempotent: true,
        receipt: receiptFromStoredTransaction({
          boardId: transaction.boardId,
          txId: transaction.txId,
          resultVersion: existing.resultVersion,
          operations: existing.operations,
          receipt: existing.receipt,
        }),
        playback: null,
      };
    }

    // dryRun must return before any transaction row is inserted: a validated
    // dry-run must not consume the mutationId, or a later real submit with the
    // same id would replay the dry-run's empty receipt and never write.
    // (The full-validation dryRun return lives after contextualValidation.)

    if (transaction.operations.length === 0) {
      if (transaction.baseVersion !== board.version) {
        throw new BoardServiceError(
          409,
          `expected Board version ${board.version}, received ${transaction.baseVersion}`,
          "VERSION_CONFLICT",
        );
      }
      // dryRun on a no-op semantic mutation: validation (above) already ran the
      // version check; nothing to write, nothing to record, no id consumed.
      if (input.dryRun) {
        return {
          idempotent: false,
          receipt: {
            mutationId: transaction.txId,
            status: "validated",
            outcome: "dry-run",
            replayed: false,
            board: { id: transaction.boardId, version: board.version },
            changed: { items: [], connections: [], effects: [], compositions: [], board: false, orderChanged: false },
          },
          playback: null,
        };
      }
      const receipt: BoardMutationReceipt = {
        mutationId: transaction.txId,
        status: "validated",
        outcome: "noop",
        replayed: false,
        board: { id: transaction.boardId, version: board.version },
        changed: { items: [], connections: [], effects: [], compositions: [], board: false, orderChanged: false },
      };
      await tx.insert(boardTransactions).values({
        boardId: transaction.boardId,
        txId: transaction.txId,
        baseVersion: transaction.baseVersion,
        resultVersion: null,
        actorId: input.actorId,
        clientId: transaction.clientId ?? null,
        undoGroupId: transaction.undoGroupId ?? null,
        operations: [],
        receipt,
        metadata: transactionMetadata,
        createdAt: now,
      });
      return { idempotent: false, receipt, playback: null };
    }

    const touchedNodeIds = collectTouchedNodeIds(transaction.operations);
    const validationNodeIds = collectValidationNodeIds(transaction.operations);
    const operationTypes = new Set(transaction.operations.map((operation) => operation.type));
    const hasNodeDelete = operationTypes.has("node.delete");
    const hasEffectDelete = operationTypes.has("effect.delete");
    const hasCompositionOperation = operationTypes.has("composition.apply") || operationTypes.has("composition.delete");
    const hasBoardPatch = operationTypes.has("board.patch");
    const hasConnectionOperation = [...operationTypes].some((type) => type.startsWith("connection."));
    const needsAllCompositions = hasNodeDelete || hasEffectDelete;
    const needsCompositionHeaders = needsAllCompositions || hasCompositionOperation || hasBoardPatch || Boolean(board.metadata.playback);
    const validationTouchedConnectionIds = collectTouchedConnectionIds(transaction.operations);
    const touchedEffectIds = transaction.operations
      .filter((operation) => operation.type === "effect.upsert" || operation.type === "effect.delete")
      .map((operation) => operation.type === "effect.upsert" ? operation.payload.effect.id : operation.payload.effectId);
    const [validationNodes, nodeRows, validationConnections, validationEffects, validationCompositions, validationTracks, validationClips] = await Promise.all([
      validationNodeIds.length
        ? tx.select({ nodeId: boardNodes.nodeId }).from(boardNodes).where(and(
            eq(boardNodes.boardId, board.id),
            inArray(boardNodes.nodeId, validationNodeIds),
            isNull(boardNodes.deletedAt),
          ))
        : Promise.resolve([]),
      touchedNodeIds.length
        ? tx.select().from(boardNodes).where(and(
            eq(boardNodes.boardId, transaction.boardId),
            inArray(boardNodes.nodeId, touchedNodeIds),
          ))
        : Promise.resolve([]),
      hasNodeDelete
        ? tx.select().from(boardConnections).where(and(eq(boardConnections.boardId, board.id), isNull(boardConnections.deletedAt)))
        : hasConnectionOperation && validationTouchedConnectionIds.length
          ? tx.select().from(boardConnections).where(and(
              eq(boardConnections.boardId, board.id),
              inArray(boardConnections.connectionId, validationTouchedConnectionIds),
              isNull(boardConnections.deletedAt),
            ))
          : Promise.resolve([]),
      hasNodeDelete || hasEffectDelete || hasCompositionOperation
        ? tx.select().from(boardEffects).where(eq(boardEffects.boardId, board.id))
        : touchedEffectIds.length
          ? tx.select().from(boardEffects).where(and(eq(boardEffects.boardId, board.id), inArray(boardEffects.id, touchedEffectIds)))
          : Promise.resolve([]),
      needsCompositionHeaders
        ? tx.select().from(boardCompositions).where(eq(boardCompositions.boardId, board.id))
        : Promise.resolve([]),
      needsAllCompositions
        ? tx.select().from(boardTracks).where(eq(boardTracks.boardId, board.id))
        : Promise.resolve([]),
      needsAllCompositions
        ? tx.select().from(boardClips).where(eq(boardClips.boardId, board.id))
        : Promise.resolve([]),
    ]);
    const validationNodeSet = new Set(validationNodes.map((node) => node.nodeId));
    // Existing connection endpoints are trusted current state. A label/style-only
    // patch still validates its unchanged endpoints without scanning all nodes.
    for (const connection of validationConnections) {
      validationNodeSet.add(connection.sourceNodeId);
      validationNodeSet.add(connection.targetNodeId);
    }
    const validation = contextualValidation(transaction, createValidationContext({
      boardVersion: board.version,
      metadata: board.metadata,
      nodes: [...validationNodeSet].map((nodeId) => ({ nodeId })),
      nodeInputs: nodeRows
        .filter((row) => row.deletedAt === null)
        .map(nodeInputFromRow),
      connections: validationConnections,
      effects: validationEffects,
      compositions: validationCompositions,
      tracks: validationTracks,
      clips: validationClips,
    }));
    const validationError = validation.diagnostics.find((diagnostic) => diagnostic.severity === "error");
    if (validationError) {
      const conflict = validationError.code === "VERSION_CONFLICT" || validationError.code.endsWith("_EXISTS") || validationError.code.endsWith("_REFERENCED");
      const status = conflict ? 409 : validationError.code.endsWith("_NOT_FOUND") ? 404 : 400;
      throw new BoardServiceError(
        status,
        validationError.message,
        validationError.code,
        [validationError],
      );
    }
    // dryRun must return after full contextual validation but before any write
    // or transaction row is inserted: version, references, and cascade rules
    // are all checked (same as a real submit), while the mutationId is not
    // consumed — a later real submit with the same id writes normally.
    if (input.dryRun) {
      return {
        idempotent: false,
        receipt: {
          mutationId: transaction.txId,
          status: "validated",
          outcome: "dry-run",
          replayed: false,
          board: { id: transaction.boardId, version: board.version },
          changed: boardMutationChanged(transaction.operations),
        },
        playback: null,
      };
    }
    const nextVersion = board.version + 1;
    const operationRows: Array<{ type: string; payload: Record<string, unknown>; inverse: Record<string, unknown> | null }> = [];
    let title = board.title;
    let metadata = board.metadata;
    let playback: BoardPlaybackSnapshot | null = null;
    let playbackChanged = false;

    // Node writes are planned in memory and flushed in bulk below, so their cost is
    // a fixed number of round-trips rather than a few queries per operation - which
    // is what let a large selection edit hold the board's row lock for as long as it
    // had nodes. Effect/sequence/playback operations stay inline: they are few by
    // nature and each carries its own bespoke cascade.
    const existingNodes = new Map<string, ExistingNodeRow>();
    for (const row of nodeRows) {
      const { boardId: _boardId, version: _version, createdAt: _createdAt, updatedAt: _updatedAt, deletedAt, ...fields } = row;
      existingNodes.set(row.nodeId, { ...fields, deleted: deletedAt !== null });
    }
    const nodePlan = planNodeWrites(transaction.operations, { existing: existingNodes });

    // Connections are planned the same way and for the same reason: relations are
    // edited in bulk (delete a selection, connect a fan-out), so their cost must
    // track round-trips rather than operation count.
    const touchedConnectionIds = collectTouchedConnectionIds(transaction.operations);
    const connectionRows = touchedConnectionIds.length
      ? await tx.select().from(boardConnections)
        .where(and(
          eq(boardConnections.boardId, transaction.boardId),
          inArray(boardConnections.connectionId, touchedConnectionIds),
        ))
      : [];
    const existingConnections = new Map<string, ExistingConnectionRow>();
    for (const row of connectionRows) {
      const { boardId: _boardId, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } =
        connectionFromRow(row);
      existingConnections.set(row.connectionId, {
        ...rest,
        deleted: row.deletedAt !== null,
      });
    }
    const connectionPlan = planConnectionWrites(transaction.operations, {
      existing: existingConnections,
    });
    const connectionRevisions = new Map(
      connectionRows.map((row) => [row.connectionId, row.revision]),
    );
    const connectionCreatedAt = new Map(
      connectionRows.map((row) => [row.connectionId, row.createdAt]),
    );
    const animationEffects = new Map<string, BoardEffect>();
    const animationCompositions = new Map<string, BoardComposition>();

    for (const [opIndex, operation] of transaction.operations.entries()) {
      // Planned above; splice its journal entry back into the operation order.
      const plannedEntry = nodePlan.journal.get(opIndex) ?? connectionPlan.journal.get(opIndex);
      if (plannedEntry) {
        operationRows.push(plannedEntry);
        continue;
      }
      if (operation.type === "board.patch") {
        const nextTitle = operation.payload.patch.title ?? title;
        let nextMetadata = operation.payload.patch.metadata ?? metadata;
        if (operation.payload.patch.metadataPatch) {
          nextMetadata = { ...nextMetadata, ...operation.payload.patch.metadataPatch };
        }
        if (nextTitle === title && boardJsonEquals(nextMetadata, metadata)) continue;
        operationRows.push({ type: operation.type, payload: operation.payload, inverse: { patch: { title, metadata } } });
        title = nextTitle;
        metadata = nextMetadata;
        continue;
      }
      if (operation.type === "effect.upsert") {
        const [previous] = await tx.select().from(boardEffects)
          .where(and(eq(boardEffects.boardId, transaction.boardId), eq(boardEffects.id, operation.payload.effect.id))).limit(1);
        const previousEffect = previous ? effectFromRow(previous) : null;
        if (previousEffect) {
          const { boardId: _boardId, revision: _revision, ...authored } = previousEffect;
          if (boardJsonEquals(authored, operation.payload.effect)) {
            animationEffects.set(previousEffect.id, previousEffect);
            continue;
          }
        }
        const values = effectValues(transaction.boardId, operation, (previous?.revision ?? -1) + 1, now);
        await tx.insert(boardEffects).values({ ...values, createdAt: previous?.createdAt ?? now })
          .onConflictDoUpdate({ target: [boardEffects.boardId, boardEffects.id], set: values });
        animationEffects.set(operation.payload.effect.id, {
          ...operation.payload.effect,
          boardId: transaction.boardId,
          revision: values.revision,
        });
        operationRows.push({
          type: operation.type,
          payload: operation.payload,
          inverse: previous
            ? { type: "effect.upsert", payload: { effect: effectFromRow(previous) } }
            : { type: "effect.delete", payload: { effectId: operation.payload.effect.id } },
        });
        continue;
      }
      if (operation.type === "effect.delete") {
        const clips = await tx.select({ id: boardClips.id, target: boardClips.target }).from(boardClips).where(eq(boardClips.boardId, transaction.boardId));
        if (clips.some((clip) => (clip.target as BoardAnimationTarget).type === "effect" && (clip.target as { type: "effect"; effectId: string }).effectId === operation.payload.effectId)) {
          throw new BoardServiceError(409, "effect is referenced by a composition", "EFFECT_REFERENCED");
        }
        const [deleted] = await tx.delete(boardEffects).where(and(eq(boardEffects.boardId, transaction.boardId), eq(boardEffects.id, operation.payload.effectId))).returning();
        if (!deleted) throw new BoardServiceError(404, "board effect not found", "EFFECT_NOT_FOUND");
        operationRows.push({ type: operation.type, payload: operation.payload, inverse: { type: "effect.upsert", payload: { effect: effectFromRow(deleted) } } });
        animationEffects.delete(operation.payload.effectId);
        continue;
      }
      if (operation.type === "composition.apply") {
        const value = operation.payload.composition;
        const [previous, previousTracks, previousClips] = await Promise.all([
          tx.select().from(boardCompositions)
            .where(and(eq(boardCompositions.boardId, transaction.boardId), eq(boardCompositions.id, value.id))).limit(1)
            .then((rows) => rows[0]),
          tx.select().from(boardTracks)
            .where(and(eq(boardTracks.boardId, transaction.boardId), eq(boardTracks.compositionId, value.id))),
          tx.select().from(boardClips)
            .where(and(eq(boardClips.boardId, transaction.boardId), eq(boardClips.compositionId, value.id))),
        ]);
        const writePlan = diffBoardCompositionWrite(
          previous ? { name: previous.name, duration: previous.duration, playback: previous.playback, markers: previous.markers, metadata: previous.metadata } : null,
          previousTracks,
          previousClips,
          value,
        );
        // Unchanged re-apply short-circuit: no row writes, no revision bump, no
        // playback stop, no board version bump, no realtime broadcast. The
        // transaction row is still recorded (for idempotent replay) with a
        // validated receipt, so retries return the same answer.
        if (!writePlan.changed) {
          if (previous) {
            animationCompositions.set(
              value.id,
              compositionsFromRows([previous], previousTracks, previousClips)[0] as BoardComposition,
            );
          }
          continue;
        }
        const revision = (previous?.revision ?? -1) + 1;
        const compositionValues = {
          id: value.id,
          boardId: transaction.boardId,
          name: value.name,
          duration: value.timeline.duration,
          playback: value.playback,
          markers: value.timeline.markers,
          metadata: value.metadata,
          revision,
          updatedAt: now,
        };
        await tx.insert(boardCompositions).values({ ...compositionValues, createdAt: previous?.createdAt ?? now })
          .onConflictDoUpdate({ target: [boardCompositions.boardId, boardCompositions.id], set: compositionValues });
        animationCompositions.set(value.id, { ...value, revision });
        const { removedTrackIds, removedClipIds, changedTracks, changedClips } = writePlan;
        const ROW_WRITE_CHUNK = 500;
        if (removedTrackIds.length) {
          for (let offset = 0; offset < removedTrackIds.length; offset += ROW_WRITE_CHUNK) {
            await tx.delete(boardTracks).where(and(
              eq(boardTracks.boardId, transaction.boardId),
              eq(boardTracks.compositionId, value.id),
              inArray(boardTracks.id, removedTrackIds.slice(offset, offset + ROW_WRITE_CHUNK)),
            ));
          }
        }
        if (removedClipIds.length) {
          for (let offset = 0; offset < removedClipIds.length; offset += ROW_WRITE_CHUNK) {
            await tx.delete(boardClips).where(and(
              eq(boardClips.boardId, transaction.boardId),
              eq(boardClips.compositionId, value.id),
              inArray(boardClips.id, removedClipIds.slice(offset, offset + ROW_WRITE_CHUNK)),
            ));
          }
        }
        for (let offset = 0; offset < changedTracks.length; offset += ROW_WRITE_CHUNK) {
          const chunk = changedTracks.slice(offset, offset + ROW_WRITE_CHUNK).map((track) => trackValues(transaction.boardId, value.id, track));
          await tx.insert(boardTracks).values(chunk)
            .onConflictDoUpdate({
              target: [boardTracks.boardId, boardTracks.compositionId, boardTracks.id],
              set: {
                target: sql`excluded.target`,
                channel: sql`excluded.channel`,
                channelVersion: sql`excluded.channel_version`,
                interpolation: sql`excluded.interpolation`,
                fill: sql`excluded.fill`,
                keyframes: sql`excluded.keyframes`,
                metadata: sql`excluded.metadata`,
              },
            });
        }
        for (let offset = 0; offset < changedClips.length; offset += ROW_WRITE_CHUNK) {
          const chunk = changedClips.slice(offset, offset + ROW_WRITE_CHUNK).map((clip) => clipValues(transaction.boardId, value.id, clip));
          await tx.insert(boardClips).values(chunk)
            .onConflictDoUpdate({
              target: [boardClips.boardId, boardClips.compositionId, boardClips.id],
              set: {
                kind: sql`excluded.kind`,
                kindVersion: sql`excluded.kind_version`,
                target: sql`excluded.target`,
                start: sql`excluded.start`,
                duration: sql`excluded.duration`,
                layer: sql`excluded.layer`,
                fill: sql`excluded.fill`,
                easing: sql`excluded.easing`,
                params: sql`excluded.params`,
                assetRefs: sql`excluded.asset_refs`,
                seed: sql`excluded.seed`,
                metadata: sql`excluded.metadata`,
              },
            });
        }
        const [activePlayback] = await tx.select().from(boardPlaybackStates).where(and(
          eq(boardPlaybackStates.boardId, transaction.boardId),
          eq(boardPlaybackStates.compositionId, value.id),
        )).limit(1);
        if (activePlayback) {
          const [stopped] = await tx.update(boardPlaybackStates).set({
            compositionRevision: revision,
            playbackRevision: activePlayback.playbackRevision + 1,
            status: "stopped",
            position: currentPosition(activePlayback, now, value.timeline.duration),
            effectiveAt: now,
            commandId: `composition-update:${transaction.txId}`,
            updatedAt: now,
          }).where(eq(boardPlaybackStates.boardId, transaction.boardId)).returning();
          if (!stopped) throw new BoardServiceError(500, "failed to stop stale playback");
          playback = playbackFromRow(stopped);
          playbackChanged = true;
        }
        operationRows.push({
          type: operation.type,
          payload: operation.payload,
          inverse: previous
            ? {
                type: "composition.apply",
                payload: {
                  composition: compositionInputFromRows(previous, previousTracks, previousClips),
                },
              }
            : { type: "composition.delete", payload: { compositionId: value.id } },
        });
        continue;
      }
      if (operation.type !== "composition.delete") continue;
      const [previous, previousTracks, previousClips] = await Promise.all([
        tx.select().from(boardCompositions)
          .where(and(eq(boardCompositions.boardId, transaction.boardId), eq(boardCompositions.id, operation.payload.compositionId))).limit(1)
          .then((rows) => rows[0]),
        tx.select().from(boardTracks)
          .where(and(eq(boardTracks.boardId, transaction.boardId), eq(boardTracks.compositionId, operation.payload.compositionId))),
        tx.select().from(boardClips)
          .where(and(eq(boardClips.boardId, transaction.boardId), eq(boardClips.compositionId, operation.payload.compositionId))),
      ]);
      if (!previous) throw new BoardServiceError(404, "board composition not found", "COMPOSITION_NOT_FOUND");
      const [deletedPlayback] = await tx.delete(boardPlaybackStates)
        .where(and(eq(boardPlaybackStates.boardId, transaction.boardId), eq(boardPlaybackStates.compositionId, operation.payload.compositionId)))
        .returning();
      if (deletedPlayback) {
        playback = null;
        playbackChanged = true;
      }
      animationCompositions.delete(operation.payload.compositionId);
      await Promise.all([
        tx.delete(boardTracks).where(and(eq(boardTracks.boardId, transaction.boardId), eq(boardTracks.compositionId, operation.payload.compositionId))),
        tx.delete(boardClips).where(and(eq(boardClips.boardId, transaction.boardId), eq(boardClips.compositionId, operation.payload.compositionId))),
      ]);
      await tx.delete(boardCompositions).where(and(eq(boardCompositions.boardId, transaction.boardId), eq(boardCompositions.id, operation.payload.compositionId)));
      operationRows.push({
        type: operation.type,
        payload: operation.payload,
        inverse: {
          type: "composition.apply",
          payload: {
            composition: compositionInputFromRows(previous, previousTracks, previousClips),
          },
        },
      });
    }

    // Every operation short-circuited (e.g. re-applying an identical
    // composition): the mutation is valid but changed nothing, so record it as a
    // no-op receipt instead of bumping the board version and broadcasting a
    // phantom change. Mirrors the semantic no-op path above.
    if (operationRows.length === 0 && nodePlan.writes.length === 0 && connectionPlan.writes.length === 0) {
      const receipt: BoardMutationReceipt = {
        mutationId: transaction.txId,
        status: "validated",
        outcome: "noop",
        replayed: false,
        board: { id: transaction.boardId, version: board.version },
        changed: { items: [], connections: [], effects: [], compositions: [], board: false, orderChanged: false },
      };
      await tx.insert(boardTransactions).values({
        boardId: transaction.boardId,
        txId: transaction.txId,
        baseVersion: transaction.baseVersion,
        resultVersion: null,
        actorId: input.actorId,
        clientId: transaction.clientId ?? null,
        undoGroupId: transaction.undoGroupId ?? null,
        operations: transaction.operations,
        receipt,
        metadata: transactionMetadata,
        createdAt: now,
      });
      return { idempotent: false, receipt, playback: null };
    }

    // Flush the planned node writes. Every touched node is written as its final
    // state via one upsert, so a create, a patch, a revive of a soft-deleted row
    // and a soft delete all collapse into the same statement. Chunked because
    // Postgres caps bind parameters per statement.
    if (nodePlan.writes.length) {
      for (let offset = 0; offset < nodePlan.writes.length; offset += NODE_WRITE_CHUNK) {
        const chunk = nodePlan.writes.slice(offset, offset + NODE_WRITE_CHUNK);
        await tx.insert(boardNodes)
          .values(chunk.map((write) => ({
            ...write.fields,
            boardId: transaction.boardId,
            version: nextVersion,
            createdAt: now,
            updatedAt: now,
            deletedAt: write.deleted ? now : null,
          })))
          .onConflictDoUpdate({
            target: [boardNodes.boardId, boardNodes.nodeId],
            // createdAt is deliberately absent: an existing row keeps its original.
            set: {
              type: sql`excluded.type`,
              parentId: sql`excluded.parent_id`,
              orderKey: sql`excluded.order_key`,
              x: sql`excluded.x`,
              y: sql`excluded.y`,
              width: sql`excluded.width`,
              height: sql`excluded.height`,
              rotation: sql`excluded.rotation`,
              refKind: sql`excluded.ref_kind`,
              refPath: sql`excluded.ref_path`,
              refUrl: sql`excluded.ref_url`,
              view: sql`excluded.view`,
              style: sql`excluded.style`,
              data: sql`excluded.data`,
              version: sql`excluded.version`,
              updatedAt: sql`excluded.updated_at`,
              deletedAt: sql`excluded.deleted_at`,
            },
          });
      }
    }

    // Flush planned connection writes. Same shape as the node flush: one upsert
    // per touched row carrying its final state, so create / patch / revive /
    // soft-delete all collapse into a single statement.
    if (connectionPlan.writes.length) {
      for (let offset = 0; offset < connectionPlan.writes.length; offset += NODE_WRITE_CHUNK) {
        const chunk = connectionPlan.writes.slice(offset, offset + NODE_WRITE_CHUNK);
        await tx.insert(boardConnections)
          .values(chunk.map((write) => ({
            ...connectionValues(transaction.boardId, write.fields),
            revision: (connectionRevisions.get(write.connectionId) ?? -1) + 1,
            createdAt: connectionCreatedAt.get(write.connectionId) ?? now,
            updatedAt: now,
            deletedAt: write.deleted ? now : null,
          })))
          .onConflictDoUpdate({
            target: [boardConnections.boardId, boardConnections.connectionId],
            // createdAt is deliberately absent: an existing row keeps its original.
            set: {
              sourceNodeId: sql`excluded.source_node_id`,
              targetNodeId: sql`excluded.target_node_id`,
              relation: sql`excluded.relation`,
              direction: sql`excluded.direction`,
              label: sql`excluded.label`,
              sourceAnchor: sql`excluded.source_anchor`,
              targetAnchor: sql`excluded.target_anchor`,
              routing: sql`excluded.routing`,
              style: sql`excluded.style`,
              metadata: sql`excluded.metadata`,
              revision: sql`excluded.revision`,
              updatedAt: sql`excluded.updated_at`,
              deletedAt: sql`excluded.deleted_at`,
            },
          });
      }
    }

    const receipt: BoardMutationReceipt = {
      mutationId: transaction.txId,
      status: "applied",
      outcome: "applied",
      replayed: false,
      board: { id: transaction.boardId, version: nextVersion },
      changed: boardMutationChanged(transaction.operations),
    };
    const [storedTransaction] = await tx.insert(boardTransactions).values({
      boardId: transaction.boardId,
      txId: transaction.txId,
      baseVersion: transaction.baseVersion,
      resultVersion: nextVersion,
      actorId: input.actorId,
      clientId: transaction.clientId ?? null,
      undoGroupId: transaction.undoGroupId ?? null,
      operations: transaction.operations,
      receipt,
      metadata: transactionMetadata,
      createdAt: now,
    }).returning({ id: boardTransactions.id });
    if (!storedTransaction) throw new BoardServiceError(500, "failed to store board transaction");
    await tx.insert(boardOperations).values(operationRows.map((operation, index) => ({
      boardId: transaction.boardId,
      transactionId: storedTransaction.id,
      operationIndex: index,
      type: operation.type,
      payload: operation.payload,
      inverse: operation.inverse,
      createdAt: now,
    })));
    await tx.update(boards).set({ title, metadata, version: nextVersion, updatedAt: now }).where(eq(boards.id, transaction.boardId));

    let animationPatch: {
      effects: BoardEffect[];
      compositions: BoardComposition[];
      playback?: BoardPlaybackSnapshot | null;
    } | null = null;
    const pureAnimation = isPureBoardAnimationChange(receipt.changed);
    if (pureAnimation) {
      animationPatch = {
        effects: [...animationEffects.values()],
        compositions: [...animationCompositions.values()],
        ...(playbackChanged ? { playback } : {}),
      };
    }
    return { idempotent: false, receipt, playback, animationPatch };
  });

  // Patch size is a transport concern, not a transaction concern. Check it after
  // commit so large timelines do not extend the Board row lock.
  if (
    result.animationPatch &&
    Buffer.byteLength(JSON.stringify(result.animationPatch), "utf8") > BOARD_ANIMATION_PATCH_MAX_BYTES
  ) result.animationPatch = null;

  // Broadcast only real changes. A validated/no-op receipt means no board
  // version was produced: broadcasting it would push a phantom event that a
  // lagging client would apply as a real delta and desynchronize its sync
  // version forever.
  if (
    input.broadcast !== false &&
    !result.idempotent &&
    result.receipt.status === "applied" &&
    transaction.operations.length > 0
  ) {
    await dispatchBoardChanged({
      spaceId: input.spaceId,
      boardId: transaction.boardId,
      actorId: input.actorId,
      mutationId: transaction.txId,
      version: result.receipt.board.version,
      changed: result.receipt.changed,
      ...(result.animationPatch ? { animationPatch: result.animationPatch } : {}),
      source: input.requestSource,
    }).catch(() => undefined);
    if (result.playback) {
      await dispatchBoardPlaybackChanged({
        spaceId: input.spaceId,
        snapshot: result.playback,
      }).catch(() => undefined);
    }
  }
  return result.receipt;
}

function currentPosition(
  row: typeof boardPlaybackStates.$inferSelect,
  now: Date,
  duration: number,
): number {
  const position = row.status === "playing"
    ? row.position + Math.max(0, now.getTime() - row.effectiveAt.getTime()) * row.timeScale
    : row.position;
  return normalizePlaybackPosition(position, duration);
}

export async function applyBoardPlaybackCommand(input: {
  spaceId: string;
  boardId: string;
  command: BoardPlaybackCommand;
}): Promise<BoardPlaybackSnapshot> {
  if (input.command.type === "play" && input.command.shared === false) {
    throw new BoardServiceError(400, "local playback must be handled by a Board runtime", "LOCAL_PLAYBACK_REQUIRES_RUNTIME");
  }
  const now = new Date();
  const snapshot = await db.transaction(async (tx) => {
    const [board] = await tx.select({ id: boards.id }).from(boards)
      .where(and(eq(boards.id, input.boardId), eq(boards.spaceId, input.spaceId))).for("update").limit(1);
    if (!board) throw new BoardServiceError(404, "board not found", "BOARD_NOT_FOUND");
    const [existing] = await tx.select().from(boardPlaybackStates).where(eq(boardPlaybackStates.boardId, input.boardId)).limit(1);
    if (existing?.commandId === input.command.commandId) return playbackFromRow(existing);

    if (input.command.type === "play") {
      const [composition] = await tx.select().from(boardCompositions).where(and(
        eq(boardCompositions.boardId, input.boardId),
        eq(boardCompositions.id, input.command.compositionId),
      )).limit(1);
      if (!composition) throw new BoardServiceError(404, "board composition not found", "COMPOSITION_NOT_FOUND");
      const position = normalizePlaybackPosition(input.command.position ?? 0, composition.duration);
      const timeScale = input.command.timeScale ?? 1;
      const values = {
        boardId: input.boardId,
        playbackId: crypto.randomUUID(),
        compositionId: composition.id,
        compositionRevision: composition.revision,
        playbackRevision: (existing?.playbackRevision ?? 0) + 1,
        status: "playing",
        position,
        effectiveAt: now,
        timeScale,
        seed: input.command.seed ?? composition.id,
        commandId: input.command.commandId,
        updatedAt: now,
      };
      const [row] = await tx.insert(boardPlaybackStates).values(values)
        .onConflictDoUpdate({ target: boardPlaybackStates.boardId, set: values }).returning();
      if (!row) throw new BoardServiceError(500, "failed to store playback state");
      return playbackFromRow(row);
    }

    if (!existing || existing.playbackId !== input.command.playbackId) {
      throw new BoardServiceError(409, "playback is no longer current", "PLAYBACK_CONFLICT");
    }
    const [composition] = await tx.select({ duration: boardCompositions.duration }).from(boardCompositions).where(and(
      eq(boardCompositions.boardId, input.boardId),
      eq(boardCompositions.id, existing.compositionId),
    )).limit(1);
    if (!composition) throw new BoardServiceError(404, "board composition not found", "COMPOSITION_NOT_FOUND");
    const position = normalizePlaybackPosition(
      input.command.type === "seek"
        ? input.command.position
        : currentPosition(existing, now, composition.duration),
      composition.duration,
    );
    const status = input.command.type === "pause" ? "paused" : input.command.type === "stop" ? "stopped" : existing.status;
    const [row] = await tx.update(boardPlaybackStates).set({
      status,
      position,
      effectiveAt: now,
      playbackRevision: existing.playbackRevision + 1,
      commandId: input.command.commandId,
      updatedAt: now,
    }).where(eq(boardPlaybackStates.boardId, input.boardId)).returning();
    if (!row) throw new BoardServiceError(500, "failed to update playback state");
    return playbackFromRow(row);
  });
  await dispatchBoardPlaybackChanged({ spaceId: input.spaceId, snapshot }).catch(() => undefined);
  return snapshot;
}
