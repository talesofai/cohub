import {
  applyBoardItemPatch,
  BoardAuthoringItemSchema,
  type BoardAuthoringItem,
  type BoardConnection,
  type BoardItemPatch,
  type BoardSemanticCommand,
} from "@cohub/protocol";
import type { BoardDocument, BoardItem } from "@cohub/protocol/board-document";
import { BoardAppearanceSchema, isUnknownItem } from "@cohub/protocol/board-document";
import {
  boardAuthoringItemToDocumentItem,
  boardItemToAuthoringItem,
} from "./semantic-document.js";
import { boardJsonEquals as sameJson } from "@cohub/protocol";

function semanticItem(item: BoardItem): BoardAuthoringItem {
  const value = boardItemToAuthoringItem(item);
  if (value) return value;
  const raw = isUnknownItem(item) ? BoardAuthoringItemSchema.safeParse(item.raw) : null;
  if (raw?.success) return raw.data;
  throw new Error(`Cannot author unknown Board item ${item.id}; the item has no semantic extension schema`);
}

function mergePatchValue(before: unknown, after: unknown): unknown {
  if (sameJson(before, after)) return undefined;
  if (after === undefined) return null;
  if (
    before && after &&
    typeof before === "object" && typeof after === "object" &&
    !Array.isArray(before) && !Array.isArray(after)
  ) {
    const patch: Record<string, unknown> = {};
    const keys = new Set([
      ...Object.keys(before as Record<string, unknown>),
      ...Object.keys(after as Record<string, unknown>),
    ]);
    for (const key of keys) {
      const value = mergePatchValue(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
      );
      if (value !== undefined) patch[key] = value;
    }
    return patch;
  }
  return after;
}

function itemPatch(before: BoardItem, after: BoardItem): BoardItemPatch | null {
  const beforeAuthoring = semanticItem(before);
  const afterAuthoring = semanticItem(after);
  const patch: Record<string, unknown> = {};
  const beforePosition = "position" in beforeAuthoring ? beforeAuthoring.position : undefined;
  const afterPosition = "position" in afterAuthoring ? afterAuthoring.position : undefined;
  if (!sameJson(beforePosition, afterPosition) && afterPosition) patch.position = afterPosition;
  const beforeSize = "size" in beforeAuthoring ? beforeAuthoring.size : undefined;
  const afterSize = "size" in afterAuthoring ? afterAuthoring.size : undefined;
  if (!sameJson(beforeSize, afterSize)) patch.size = afterSize ?? null;
  if (beforeAuthoring.rotation !== afterAuthoring.rotation) patch.rotation = afterAuthoring.rotation;
  const beforeParent = before.parentId ?? null;
  const afterParent = after.parentId ?? null;
  if (beforeParent !== afterParent) patch.parentId = afterParent;
  if ((before.locked ?? false) !== (after.locked ?? false)) patch.locked = after.locked ?? null;
  const metadata = mergePatchValue(before.metadata, after.metadata);
  if (metadata !== undefined) patch.metadata = after.metadata === undefined ? null : metadata;
  const props = mergePatchValue(beforeAuthoring.props, afterAuthoring.props);
  if (props !== undefined) patch.props = props;
  const beforeStyle = "style" in beforeAuthoring ? beforeAuthoring.style : undefined;
  const afterStyle = "style" in afterAuthoring ? afterAuthoring.style : undefined;
  const style = mergePatchValue(beforeStyle, afterStyle);
  if (style !== undefined) patch.style = afterStyle === undefined ? null : style;
  const beforeSource = "source" in beforeAuthoring ? beforeAuthoring.source : undefined;
  const afterSource = "source" in afterAuthoring ? afterAuthoring.source : undefined;
  const source = mergePatchValue(beforeSource, afterSource);
  if (source !== undefined) patch.source = afterSource === undefined ? null : source;
  return Object.keys(patch).length ? patch as BoardItemPatch : null;
}

function connectionPatch(before: BoardConnection, after: BoardConnection): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  for (const key of ["source", "target", "relation", "direction", "label", "routing", "style", "metadata"] as const) {
    if (!sameJson(before[key], after[key])) patch[key] = after[key];
  }
  return Object.keys(patch).length ? patch : null;
}

/** Compile an editor document delta to the public semantic mutation command set. */
export function boardDocumentToSemanticCommands(
  before: BoardDocument,
  after: BoardDocument,
): BoardSemanticCommand[] {
  const commands: BoardSemanticCommand[] = [];
  if (!sameJson(before.appearance, after.appearance)) {
    commands.push({ type: "board.patch", patch: { metadataPatch: { appearance: after.appearance } } });
  }

  const beforeConnections = new Map(before.connections.map((connection) => [connection.id, connection]));
  const afterConnections = new Map(after.connections.map((connection) => [connection.id, connection]));
  const beforeItems = new Map(before.items.map((item) => [item.id, item]));
  const afterItems = new Map(after.items.map((item) => [item.id, item]));

  // Remove relations before deleting their endpoints.
  for (const [id] of beforeConnections) {
    if (!afterConnections.has(id)) commands.push({ type: "connection.delete", connectionId: id });
  }

  // Creates and patches precede new relations; deletes follow relation removal.
  for (const item of after.items) {
    const previous = beforeItems.get(item.id);
    if (!previous) {
      commands.push({ type: "item.create", item: semanticItem(item) });
      continue;
    }
    if (previous.type !== item.type) {
      commands.push({ type: "item.replace", itemId: item.id, item: semanticItem(item) });
      continue;
    }
    const patch = itemPatch(previous, item);
    if (patch) commands.push({ type: "item.patch", itemId: item.id, patch });
  }
  for (const [id] of beforeItems) {
    if (!afterItems.has(id)) commands.push({ type: "item.delete", itemId: id, cascade: false });
  }

  // Reconcile z-order after creates/deletes. Simulating the current order emits
  // one reorder for a front/back move or insertion instead of reordering every
  // item whose array index shifted.
  const workingOrder = before.items.map((item) => item.id);
  for (const item of after.items) {
    if (!beforeItems.has(item.id)) workingOrder.push(item.id);
  }
  for (const [id] of beforeItems) {
    if (!afterItems.has(id)) workingOrder.splice(workingOrder.indexOf(id), 1);
  }
  for (let index = 0; index < after.items.length; index += 1) {
    const id = after.items[index]?.id;
    if (!id || workingOrder[index] === id) continue;
    const previousIndex = workingOrder.indexOf(id);
    if (previousIndex < 0) continue;
    workingOrder.splice(previousIndex, 1);
    workingOrder.splice(index, 0, id);
    commands.push({ type: "item.reorder", itemId: id, index });
  }

  for (const connection of after.connections) {
    const previous = beforeConnections.get(connection.id);
    if (!previous) {
      commands.push({ type: "connection.create", connection });
      continue;
    }
    const patch = connectionPatch(previous, connection);
    if (patch) commands.push({ type: "connection.patch", connectionId: connection.id, patch });
  }
  return commands;
}

/** Apply public semantic commands to the local render document (undo/rebase). */
export function applyBoardSemanticCommands(
  document: BoardDocument,
  commands: readonly BoardSemanticCommand[],
): BoardDocument {
  let items = [...document.items];
  let connections = [...document.connections];
  let appearance = document.appearance;
  for (const command of commands) {
    if (command.type === "board.patch") {
      const candidate = command.patch.metadataPatch?.appearance ?? command.patch.metadata?.appearance;
      if (candidate !== undefined) {
        const parsed = BoardAppearanceSchema.safeParse(candidate);
        if (parsed.success) appearance = parsed.data;
      }
      continue;
    }
    if (command.type === "item.create") {
      if (!items.some((item) => item.id === command.item.id)) {
        items.push(boardAuthoringItemToDocumentItem(command.item));
      }
      continue;
    }
    if (command.type === "item.patch") {
      items = items.map((item) => item.id === command.itemId
        ? boardAuthoringItemToDocumentItem(applyBoardItemPatch(semanticItem(item), command.patch))
        : item);
      continue;
    }
    if (command.type === "item.replace") {
      items = items.map((item) => item.id === command.itemId
        ? boardAuthoringItemToDocumentItem(command.item)
        : item);
      continue;
    }
    if (command.type === "item.delete") {
      items = items.filter((item) => item.id !== command.itemId);
      connections = connections.filter((connection) =>
        connection.source.itemId !== command.itemId && connection.target.itemId !== command.itemId,
      );
      continue;
    }
    if (command.type === "item.reorder") {
      const index = items.findIndex((item) => item.id === command.itemId);
      if (index < 0) continue;
      const [item] = items.splice(index, 1);
      if (item) items.splice(Math.min(command.index, items.length), 0, item);
      continue;
    }
    if (command.type === "connection.create") {
      if (!connections.some((connection) => connection.id === command.connection.id)) connections.push(command.connection);
      continue;
    }
    if (command.type === "connection.patch") {
      connections = connections.map((connection) => connection.id === command.connectionId
        ? { ...connection, ...command.patch, id: connection.id }
        : connection);
      continue;
    }
    if (command.type === "connection.delete") {
      connections = connections.filter((connection) => connection.id !== command.connectionId);
    }
  }
  return { ...document, appearance, items, connections };
}
