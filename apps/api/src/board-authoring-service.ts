import {
	applyBoardItemPatch,
	boardAuthoringItemToNode,
	boardNodePatch,
	boardNodeToAuthoringItem,
	preserveOpaqueNodeFields,
} from "@cohub/core/board";
import {
	BoardAuthoringReadInputSchema,
	BoardSemanticMutationSchema,
	assignOrderKeys,
	type BoardAuthoringReadInput,
	type BoardAuthoringSnapshot,
	type BoardComposition,
	type BoardConnection,
	type BoardEffect,
	type BoardMutationReceipt,
	type BoardNodeInput,
	type BoardOperation,
	type BoardSemanticMutation,
	type RequestSource,
} from "@cohub/protocol";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { boardNodes, boardTransactions, boards } from "@cohub/db";
import {
	applyBoardTransaction,
	inspectBoard,
	receiptFromStoredTransaction,
} from "./board-service.js";
import { db } from "./db/index.js";
import { BoardServiceError, boardSchemaDiagnostics } from "./board-ops.js";

const inputFromRecord = (node: Pick<BoardNodeInput, keyof BoardNodeInput>): BoardNodeInput => ({
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
	data: node.data,
});

export async function inspectBoardAuthoring(
	spaceId: string,
	boardId: string,
	input: BoardAuthoringReadInput = {},
): Promise<BoardAuthoringSnapshot> {
	const parsed = BoardAuthoringReadInputSchema.parse(input);
	const include = new Set(parsed.include === undefined ? ["items"] : parsed.include);
	const raw = await inspectBoard(spaceId, boardId, {
		include: [
			...(include.has("items") ? (["nodes"] as const) : []),
			...(include.has("connections") ? (["connections"] as const) : []),
			...(include.has("effects") ? (["effects"] as const) : []),
			...(include.has("compositions") ? (["compositions"] as const) : []),
			...(include.has("playback") ? (["playback"] as const) : []),
		],
		...(parsed.itemIds?.length ? { nodeIds: parsed.itemIds } : {}),
		...(parsed.connectionIds?.length ? { connectionIds: parsed.connectionIds } : {}),
		...(parsed.effectIds?.length ? { effectIds: parsed.effectIds } : {}),
		...(parsed.compositionIds?.length ? { compositionIds: parsed.compositionIds } : {}),
		...(parsed.viewport ? { viewport: parsed.viewport } : {}),
	});
	const itemIds = parsed.itemIds ? new Set(parsed.itemIds) : null;
	const result: BoardAuthoringSnapshot = {
		board: {
			id: raw.board.id,
			title: raw.board.title,
			version: raw.board.version,
			metadata: raw.board.metadata,
			updatedAt: raw.board.updatedAt,
		},
	};
	if (include.has("items")) {
		result.items = raw.nodes
			.filter((node) => !itemIds || itemIds.has(node.nodeId))
			.map(boardNodeToAuthoringItem);
	}
	if (include.has("connections")) result.connections = raw.connections.map(({ boardId: _boardId, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...connection }) => connection);
	if (include.has("effects")) result.effects = raw.effects.map(({ boardId: _boardId, ...effect }) => effect);
	if (include.has("compositions")) result.compositions = raw.compositions;
	if (include.has("playback")) result.playback = raw.playback;
	return result;
}

function nextOrderKey(nodes: Iterable<BoardNodeInput>): () => string {
	let last: string | null = null;
	for (const node of nodes) {
		if (node.orderKey && (last === null || node.orderKey > last)) last = node.orderKey;
	}
	return () => {
		if (last === null) {
			last = "00004096";
			return last;
		}
		if (/^\d+$/.test(last)) {
			const value = Number(last);
			if (Number.isSafeInteger(value)) {
				const next = String(value + 4096).padStart(last.length, "0");
				if (next.length === last.length && next > last) {
					last = next;
					return last;
				}
			}
		}
		last = `${last}5`;
		return last;
	};
}

function compositionReferencesItem(composition: BoardComposition, itemId: string): boolean {
	return (
		composition.timeline.tracks.some(
			(track) => track.target.type === "item" && track.target.itemId === itemId,
		) ||
		composition.timeline.clips.some((clip) => {
			if (clip.target.type === "item" && clip.target.itemId === itemId) return true;
			if (clip.kind !== "camera.focus") return false;
			const focus = clip.params.focus;
			if (!focus || typeof focus !== "object" || Array.isArray(focus)) return false;
			const value = focus as Record<string, unknown>;
			return value.itemId === itemId ||
				(Array.isArray(value.itemIds) && value.itemIds.includes(itemId)) ||
				value.frameId === itemId;
		})
	);
}

function withoutCascadeReferences(
	composition: BoardComposition,
	itemId: string,
	effectIds: ReadonlySet<string>,
): Omit<BoardComposition, "revision"> {
	return {
		id: composition.id,
		name: composition.name,
		timeline: {
			...composition.timeline,
			tracks: composition.timeline.tracks.filter((track) =>
				!(track.target.type === "item" && track.target.itemId === itemId) &&
				!(track.target.type === "effect" && effectIds.has(track.target.effectId)),
			),
			clips: composition.timeline.clips.filter((clip) => {
				if (clip.target.type === "item" && clip.target.itemId === itemId) return false;
				if (clip.target.type === "effect" && effectIds.has(clip.target.effectId)) return false;
				if (clip.kind !== "camera.focus") return true;
				const focus = clip.params.focus;
				if (!focus || typeof focus !== "object" || Array.isArray(focus)) return true;
				const value = focus as Record<string, unknown>;
				return value.itemId !== itemId &&
					!(Array.isArray(value.itemIds) && value.itemIds.includes(itemId)) &&
					value.frameId !== itemId;
			}),
		},
		playback: composition.playback,
		metadata: composition.metadata,
	};
}


/** Compile one item.patch / item.replace command against its current node. */
function compileItemCommand(
	command: Extract<BoardSemanticMutation["commands"][number], { type: "item.patch" | "item.replace" }>,
	existing: BoardNodeInput,
	path = "item",
): { operation: BoardOperation | null; next: BoardNodeInput } {
	if (command.type === "item.replace" && command.item.id !== command.itemId) {
		throw new BoardServiceError(400, "replacement item id must match itemId", "INVALID_BOARD_ITEM");
	}
	const item = command.type === "item.patch"
		? applyBoardItemPatch(boardNodeToAuthoringItem(existing), command.patch, path)
		: command.item;
	const next = command.type === "item.patch"
		? preserveOpaqueNodeFields(
			existing,
			boardAuthoringItemToNode(item, { orderKey: existing.orderKey, path }),
			{ preserveSource: command.patch.source !== null, preserveStyle: command.patch.style !== null },
		)
		: boardAuthoringItemToNode(item, { orderKey: existing.orderKey, path });
	const patch = boardNodePatch(existing, next);
	if (Object.keys(patch).length === 0) return { operation: null, next };
	return { operation: { type: "node.patch", payload: { nodeId: command.itemId, patch } }, next };
}

/** Compile semantic authoring commands into one authoritative Board transaction. */
export async function applySemanticBoardMutation(input: {
	spaceId: string;
	boardId: string;
	actorId: string;
	mutation: unknown;
	requestSource?: RequestSource | null;
}): Promise<BoardMutationReceipt> {
	const parsed = BoardSemanticMutationSchema.safeParse(input.mutation);
	if (!parsed.success) {
		throw new BoardServiceError(
			400,
			"Board mutation is invalid.",
			"INVALID_BOARD_MUTATION",
			boardSchemaDiagnostics(parsed.error, "INVALID_BOARD_MUTATION", "mutation"),
		);
	}
	const mutation = parsed.data as BoardSemanticMutation;
	const [ownedBoard] = await db.select({ id: boards.id })
		.from(boards)
		.where(and(eq(boards.id, input.boardId), eq(boards.spaceId, input.spaceId)))
		.limit(1);
	if (!ownedBoard) throw new BoardServiceError(404, "board not found", "BOARD_NOT_FOUND");
	const [storedTransaction] = await db.select({
		receipt: boardTransactions.receipt,
		resultVersion: boardTransactions.resultVersion,
		operations: boardTransactions.operations,
	})
		.from(boardTransactions)
		.where(
			and(
				eq(boardTransactions.boardId, input.boardId),
				eq(boardTransactions.txId, mutation.mutationId),
			),
		)
		.limit(1);
	if (storedTransaction) {
		return receiptFromStoredTransaction({
			boardId: input.boardId,
			txId: mutation.mutationId,
			resultVersion: storedTransaction.resultVersion,
			operations: storedTransaction.operations,
			receipt: storedTransaction.receipt,
		});
	}
	const needsAggregate = mutation.commands.some(
		(command) => command.type === "item.reorder" ||
			(command.type === "item.delete" && command.cascade),
	);
	if (!needsAggregate) {
		const existingItemIds = [...new Set(mutation.commands.flatMap((command) =>
			command.type === "item.patch" || command.type === "item.replace"
				? [command.itemId]
				: [],
		))];
		const [rows, lastRows] = await Promise.all([
			existingItemIds.length
				? db.select().from(boardNodes).where(and(
					eq(boardNodes.boardId, input.boardId),
					inArray(boardNodes.nodeId, existingItemIds),
					isNull(boardNodes.deletedAt),
				))
				: Promise.resolve([]),
			mutation.commands.some((command) => command.type === "item.create")
				? db.select().from(boardNodes).where(and(
					eq(boardNodes.boardId, input.boardId),
					isNull(boardNodes.deletedAt),
				)).orderBy(desc(boardNodes.orderKey)).limit(1)
				: Promise.resolve([]),
		]);
		const nodes = new Map(rows.map((row) => [row.nodeId, inputFromRecord(row)]));
		const allocateOrderKey = nextOrderKey(lastRows.map(inputFromRecord));
		const operations: BoardOperation[] = [];
		for (const [commandIndex, command] of mutation.commands.entries()) {
			if (command.type === "board.patch") {
				operations.push({
					type: "board.patch",
					payload: { patch: {
						...(command.patch.title !== undefined ? { title: command.patch.title } : {}),
						...(command.patch.metadata !== undefined ? { metadata: command.patch.metadata ?? {} } : {}),
						...(command.patch.metadataPatch !== undefined ? { metadataPatch: command.patch.metadataPatch } : {}),
					} },
				});
			} else if (command.type === "item.create") {
				const node = boardAuthoringItemToNode(command.item, { orderKey: allocateOrderKey(), path: `commands.${commandIndex}.item` });
				nodes.set(node.nodeId, node);
				operations.push({ type: "node.create", payload: { node } });
			} else if (command.type === "item.patch" || command.type === "item.replace") {
				const existing = nodes.get(command.itemId);
				if (!existing) throw new BoardServiceError(404, `item does not exist: ${command.itemId}`, "ITEM_NOT_FOUND");
				const { operation, next } = compileItemCommand(command, existing, `commands.${commandIndex}.item`);
				if (operation) operations.push(operation);
				nodes.set(command.itemId, next);
			} else if (command.type === "item.delete") {
				operations.push({ type: "node.delete", payload: { nodeId: command.itemId } });
				nodes.delete(command.itemId);
			} else if (command.type === "connection.create") {
				operations.push({ type: "connection.create", payload: { connection: command.connection } });
			} else if (command.type === "connection.patch") {
				operations.push({ type: "connection.patch", payload: { connectionId: command.connectionId, patch: command.patch } });
			} else if (command.type === "connection.delete") {
				operations.push({ type: "connection.delete", payload: { connectionId: command.connectionId } });
			} else if (command.type === "effect.apply") {
				operations.push({ type: "effect.upsert", payload: { effect: command.effect } });
			} else if (command.type === "effect.delete") {
				operations.push({ type: "effect.delete", payload: { effectId: command.effectId } });
			} else if (command.type === "composition.apply") {
				operations.push({ type: "composition.apply", payload: { composition: command.composition } });
			} else if (command.type === "composition.delete") {
				operations.push({ type: "composition.delete", payload: { compositionId: command.compositionId } });
			}
		}
		return applyBoardTransaction({
			spaceId: input.spaceId,
			actorId: input.actorId,
			requestSource: input.requestSource,
			allowNoop: true,
			dryRun: mutation.dryRun,
			transaction: {
				txId: mutation.mutationId,
				boardId: input.boardId,
				baseVersion: mutation.baseVersion,
				...(mutation.clientId ? { clientId: mutation.clientId } : {}),
				...(mutation.undoGroupId ? { undoGroupId: mutation.undoGroupId } : {}),
				operations,
			},
		});
	}

	// Read only the sections the commands can touch. Every non-item command needs
	// its own section for existence/reference checks; nodes are needed for any
	// command that creates, deletes, or repoints references (connection endpoints,
	// effect/track targets, cascade rewrites) — a pure board/composition/effect
	// mutation does not pay for the node list.
	const touchedTypes = new Set(mutation.commands.map((command) => command.type));
	// nodes are needed for existence checks on any item command and for
	// reference checks when other commands point at items.
	const needsNodes = touchedTypes.has("item.create") || touchedTypes.has("item.patch") ||
		touchedTypes.has("item.replace") || touchedTypes.has("item.delete") || touchedTypes.has("item.reorder") ||
		touchedTypes.has("connection.create") || touchedTypes.has("connection.patch") ||
		touchedTypes.has("effect.apply") ||
		touchedTypes.has("composition.apply");
	const needsConnections = touchedTypes.has("connection.create") || touchedTypes.has("connection.patch") || touchedTypes.has("connection.delete") || touchedTypes.has("item.delete");
	const needsEffects = touchedTypes.has("effect.apply") || touchedTypes.has("effect.delete") || touchedTypes.has("composition.apply") || touchedTypes.has("item.delete");
	const needsCompositions = touchedTypes.has("composition.apply") || touchedTypes.has("composition.delete") || touchedTypes.has("effect.delete") || touchedTypes.has("item.delete");
	const current = await inspectBoard(input.spaceId, input.boardId, {
		include: [
			...(needsNodes ? (["nodes"] as const) : []),
			...(needsConnections ? (["connections"] as const) : []),
			...(needsEffects ? (["effects"] as const) : []),
			...(needsCompositions ? (["compositions"] as const) : []),
		],
	});
	if (mutation.baseVersion !== current.board.version) {
		throw new BoardServiceError(
			409,
			`expected Board version ${current.board.version}, received ${mutation.baseVersion}`,
			"VERSION_CONFLICT",
		);
	}

	const nodes = new Map(current.nodes.map((node) => [node.nodeId, inputFromRecord(node)]));
	const orderedItemIds = current.nodes.map((node) => node.nodeId);
	const connections = new Map<string, BoardConnection>(current.connections.map((connection) => [connection.id, connection]));
	const effects = new Map<string, BoardEffect>(current.effects.map((effect) => [effect.id, effect]));
	const compositions = new Map<string, BoardComposition>(current.compositions.map((composition) => [composition.id, composition]));
	const allocateOrderKey = nextOrderKey(nodes.values());
	const operations: BoardOperation[] = [];

	for (const [commandIndex, command] of mutation.commands.entries()) {
		if (command.type === "board.patch") {
			const patch = {
				...(command.patch.title === undefined ? {} : { title: command.patch.title }),
				...(command.patch.metadata === undefined ? {} : { metadata: command.patch.metadata ?? {} }),
				...(command.patch.metadataPatch === undefined ? {} : { metadataPatch: command.patch.metadataPatch }),
			};
			operations.push({ type: "board.patch", payload: { patch } });
			continue;
		}
		if (command.type === "connection.create") {
			if (connections.has(command.connection.id)) {
				throw new BoardServiceError(409, `connection already exists: ${command.connection.id}`, "CONNECTION_EXISTS");
			}
			const connection = { ...command.connection, boardId: input.boardId, revision: 0 };
			connections.set(connection.id, connection);
			operations.push({ type: "connection.create", payload: { connection } });
			continue;
		}
		if (command.type === "connection.patch") {
			const existing = connections.get(command.connectionId);
			if (!existing) throw new BoardServiceError(404, `connection does not exist: ${command.connectionId}`, "CONNECTION_NOT_FOUND");
			const next = { ...existing, ...command.patch, id: existing.id, boardId: input.boardId, revision: 0 };
			connections.set(next.id, next);
			operations.push({ type: "connection.patch", payload: { connectionId: next.id, patch: command.patch } });
			continue;
		}
		if (command.type === "connection.delete") {
			if (!connections.has(command.connectionId)) throw new BoardServiceError(404, `connection does not exist: ${command.connectionId}`, "CONNECTION_NOT_FOUND");
			connections.delete(command.connectionId);
			operations.push({ type: "connection.delete", payload: { connectionId: command.connectionId } });
			continue;
		}
		if (command.type === "effect.apply") {
			const effect = { ...command.effect, boardId: input.boardId, revision: 0 };
			effects.set(effect.id, effect);
			operations.push({ type: "effect.upsert", payload: { effect: command.effect } });
			continue;
		}
		if (command.type === "effect.delete") {
			if (!effects.has(command.effectId)) throw new BoardServiceError(404, `effect does not exist: ${command.effectId}`, "EFFECT_NOT_FOUND");
			effects.delete(command.effectId);
			operations.push({ type: "effect.delete", payload: { effectId: command.effectId } });
			continue;
		}
		if (command.type === "composition.apply") {
			const currentComposition = compositions.get(command.composition.id);
			const composition = { ...command.composition, revision: currentComposition?.revision ?? 0 };
			compositions.set(composition.id, composition);
			operations.push({ type: "composition.apply", payload: { composition } });
			continue;
		}
		if (command.type === "composition.delete") {
			if (!compositions.has(command.compositionId)) throw new BoardServiceError(404, `composition does not exist: ${command.compositionId}`, "COMPOSITION_NOT_FOUND");
			compositions.delete(command.compositionId);
			operations.push({ type: "composition.delete", payload: { compositionId: command.compositionId } });
			continue;
		}
		if (command.type === "item.create") {
			if (nodes.has(command.item.id)) {
				throw new BoardServiceError(409, `item already exists: ${command.item.id}`, "ITEM_EXISTS");
			}
			const node = boardAuthoringItemToNode(command.item, {
				orderKey: allocateOrderKey(),
				path: `commands.${commandIndex}.item`,
			});
			nodes.set(node.nodeId, node);
			orderedItemIds.push(node.nodeId);
			operations.push({ type: "node.create", payload: { node } });
			continue;
		}
		const existing = nodes.get(command.itemId);
		if (!existing) {
			throw new BoardServiceError(404, `item does not exist: ${command.itemId} (it may have been deleted earlier in this mutation)`, "ITEM_NOT_FOUND");
		}
		if (command.type === "item.reorder") {
			const previousIndex = orderedItemIds.indexOf(command.itemId);
			if (previousIndex < 0) throw new BoardServiceError(404, `item does not exist: ${command.itemId}`, "ITEM_NOT_FOUND");
			if (command.index >= orderedItemIds.length) {
				throw new BoardServiceError(400, `item reorder index ${command.index} exceeds Board item count ${orderedItemIds.length}`, "INVALID_BOARD_ITEM_ORDER");
			}
			orderedItemIds.splice(previousIndex, 1);
			orderedItemIds.splice(command.index, 0, command.itemId);
			const changed = assignOrderKeys(
				orderedItemIds.length,
				(index) => orderedItemIds[index] as string,
				(index) => nodes.get(orderedItemIds[index] as string)?.orderKey ?? null,
			);
			for (const [itemId, orderKey] of changed) {
				const item = nodes.get(itemId);
				if (!item || item.orderKey === orderKey) continue;
				operations.push({ type: "node.patch", payload: { nodeId: itemId, patch: { orderKey } } });
				nodes.set(itemId, { ...item, orderKey });
			}
			continue;
		}
		if (command.type === "item.patch" || command.type === "item.replace") {
			const { operation, next } = compileItemCommand(command, existing, `commands.${commandIndex}.item`);
			if (operation) {
				operations.push(operation);
				nodes.set(command.itemId, next);
			}
			continue;
		}

		if (command.cascade) {
			const effectIds = new Set(
				[...effects.values()]
					.filter((effect) => effect.target.type === "item" && effect.target.itemId === command.itemId)
					.map((effect) => effect.id),
			);
			for (const connection of connections.values()) {
				if (connection.source.itemId === command.itemId || connection.target.itemId === command.itemId) {
					operations.push({
						type: "connection.delete",
						payload: { connectionId: connection.id, reason: "node-cascade" },
					});
					connections.delete(connection.id);
				}
			}
			for (const composition of compositions.values()) {
				const touchesEffect = composition.timeline.tracks.some(
					(track) => track.target.type === "effect" && effectIds.has(track.target.effectId),
				) || composition.timeline.clips.some(
					(clip) => clip.target.type === "effect" && effectIds.has(clip.target.effectId),
				);
				if (compositionReferencesItem(composition, command.itemId) || touchesEffect) {
					const nextComposition = withoutCascadeReferences(composition, command.itemId, effectIds);
					operations.push({
						type: "composition.apply",
						payload: { composition: nextComposition },
					});
					compositions.set(composition.id, { ...nextComposition, revision: composition.revision });
				}
			}
			for (const effectId of effectIds) {
				operations.push({ type: "effect.delete", payload: { effectId } });
				effects.delete(effectId);
			}
		}
		operations.push({ type: "node.delete", payload: { nodeId: command.itemId } });
		nodes.delete(command.itemId);
		const orderIndex = orderedItemIds.indexOf(command.itemId);
		if (orderIndex >= 0) orderedItemIds.splice(orderIndex, 1);
	}

	const receipt = await applyBoardTransaction({
		spaceId: input.spaceId,
		actorId: input.actorId,
		requestSource: input.requestSource,
		allowNoop: true,
		dryRun: mutation.dryRun,
		transaction: {
			txId: mutation.mutationId,
			boardId: input.boardId,
			baseVersion: mutation.baseVersion,
			...(mutation.clientId ? { clientId: mutation.clientId } : {}),
			...(mutation.undoGroupId ? { undoGroupId: mutation.undoGroupId } : {}),
			operations,
		},
	});
	return receipt;
}
