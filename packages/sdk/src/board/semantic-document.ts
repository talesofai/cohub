import {
  BoardAuthoringItemSchema,
  boardAuthoringItemToNode,
  boardDrawPointsToWorld,
  type BoardAuthoringItem,
  type BoardAuthoringSnapshot,
  type BoardMutationReceipt,
} from "@cohub/protocol";
import {
  BOARD_DOCUMENT_KIND,
  BoardAppearanceSchema,
  type BoardDocument,
  type BoardItem,
  parseBoardDocument,
  UNKNOWN_BOARD_ITEM_TYPE,
  isUnknownItem,
} from "@cohub/protocol/board-document";

export const DEFAULT_BOARD_APPEARANCE = BoardAppearanceSchema.parse({
  theme: "clean",
  background: { kind: "solid" },
  grid: { visible: false, size: 24, opacity: 0.12 },
  mood: "clean",
});

/** Convert a public authoring Item to the renderer/editor document shape. */
export function boardAuthoringItemToDocumentItem(item: BoardAuthoringItem): BoardItem {
  const node = boardAuthoringItemToNode(item);
  const base = {
    id: item.id,
    frame: { x: node.x, y: node.y, width: node.width, height: node.height, rotation: node.rotation },
    ...(item.parentId !== undefined ? { parentId: item.parentId } : {}),
    ...(item.locked ? { locked: true } : {}),
    ...(item.metadata ? { metadata: item.metadata } : {}),
  };
  const props = item.props as Record<string, unknown>;
  const style = "style" in item ? item.style as Record<string, unknown> | undefined : undefined;
  const source = "source" in item ? item.source as { path?: string; snapshot?: Record<string, unknown> } | undefined : undefined;
  switch (item.type) {
    case "text": return { ...base, type: "text", text: String(props.text ?? ""), fontSize: Number(props.fontSize ?? 24), color: String(style?.color ?? "neutral") } as BoardItem;
    case "geo": return { ...base, type: "geo", geo: String(props.shape ?? "rectangle"), text: String(props.text ?? ""), color: String(style?.color ?? "brand"), fillOpacity: Number(style?.fillOpacity ?? 0) } as BoardItem;
    case "draw": return { ...base, type: "draw", points: node.data.points as Extract<BoardItem, { type: "draw" }>["points"], color: String(style?.color ?? "brand"), size: Number(style?.strokeWidth ?? 4) } as BoardItem;
    case "arrow": return { ...base, type: "arrow", ...props, color: String(style?.color ?? "brand"), size: Number(style?.strokeWidth ?? 2.5) } as BoardItem;
    case "frame": return { ...base, type: "frame", label: String(props.label ?? "Frame"), color: String(style?.color ?? "neutral") } as BoardItem;
    case "image": return { ...base, type: "image", ref: { kind: "space-file", path: String(source?.path ?? "") }, ...(source?.snapshot ? { snapshot: source.snapshot } : {}), ...(props.crop ? { crop: props.crop } : {}) } as BoardItem;
    case "video": return { ...base, type: "video", ref: { kind: "space-file", path: String(source?.path ?? "") }, ...(source?.snapshot ? { snapshot: source.snapshot } : {}) } as BoardItem;
    case "audio": return { ...base, type: "audio", ref: { kind: "space-file", path: String(source?.path ?? "") }, ...(source?.snapshot ? { snapshot: source.snapshot } : {}) } as BoardItem;
    case "file": return { ...base, type: "file", ref: { kind: "space-file", path: String(source?.path ?? "") }, ...(source?.snapshot ? { snapshot: source.snapshot } : {}) } as BoardItem;
    case "task": return { ...base, type: "task", taskRunId: String(props.taskRunId ?? ""), snapshot: props.snapshot } as BoardItem;
    default:
      return {
        ...base,
        type: UNKNOWN_BOARD_ITEM_TYPE,
        raw: item as unknown as Record<string, unknown>,
      };
  }
}

/** Convert the renderer/editor item back to the public authoring envelope. */
export function boardItemToAuthoringItem(item: BoardItem): BoardAuthoringItem | null {
  if (isUnknownItem(item)) {
    const parsed = BoardAuthoringItemSchema.safeParse(item.raw);
    return parsed.success ? parsed.data : null;
  }
  const base = {
    id: item.id,
    ...(item.type === "draw" || item.type === "arrow" ? {} : {
      position: { x: item.frame.x, y: item.frame.y },
      size: { width: item.frame.width, height: item.frame.height },
    }),
    rotation: item.frame.rotation,
    ...(item.parentId !== undefined ? { parentId: item.parentId } : {}),
    ...(item.locked ? { locked: true } : {}),
    ...(item.metadata ? { metadata: item.metadata } : {}),
  };
  switch (item.type) {
    case "text": return { ...base, type: "text", props: { text: item.text, fontSize: item.fontSize }, style: { color: item.color } } as BoardAuthoringItem;
    case "geo": return { ...base, type: "geo", props: { shape: item.geo, text: item.text }, style: { color: item.color, fillOpacity: item.fillOpacity } } as BoardAuthoringItem;
    case "draw": return { ...base, type: "draw", props: { points: boardDrawPointsToWorld(item.points, item.frame.x, item.frame.y) }, style: { color: item.color, strokeWidth: item.size } } as BoardAuthoringItem;
    case "arrow": return { ...base, type: "arrow", props: { start: item.start, end: item.end, bend: item.bend, arrowStart: item.arrowStart, arrowEnd: item.arrowEnd, label: item.label }, style: { color: item.color, strokeWidth: item.size } } as BoardAuthoringItem;
    case "frame": return { ...base, type: "frame", props: { label: item.label }, style: { color: item.color } } as BoardAuthoringItem;
    case "image": return { ...base, type: "image", props: item.crop ? { crop: item.crop } : {}, source: { kind: "space-file", path: item.ref.path, ...(item.snapshot ? { snapshot: item.snapshot } : {}) } } as BoardAuthoringItem;
    case "video": return { ...base, type: "video", props: {}, source: { kind: "space-file", path: item.ref.path, ...(item.snapshot ? { snapshot: item.snapshot } : {}) } } as BoardAuthoringItem;
    case "audio": return { ...base, type: "audio", props: {}, source: { kind: "space-file", path: item.ref.path, ...(item.snapshot ? { snapshot: item.snapshot } : {}) } } as BoardAuthoringItem;
    case "file": return { ...base, type: "file", props: {}, source: { kind: "space-file", path: item.ref.path, snapshot: item.snapshot } } as BoardAuthoringItem;
    case "task": return { ...base, type: "task", props: { taskRunId: item.taskRunId, snapshot: item.snapshot } } as BoardAuthoringItem;
  }
}

export function boardAuthoringSnapshotToDocument(input: BoardAuthoringSnapshot): BoardDocument {
  const appearance = BoardAppearanceSchema.safeParse(input.board.metadata.appearance);
  return parseBoardDocument({
    kind: BOARD_DOCUMENT_KIND,
    version: 1,
    appearance: appearance.success ? appearance.data : DEFAULT_BOARD_APPEARANCE,
    viewport: { x: 0, y: 0, zoom: 1 },
    items: (input.items ?? []).map(boardAuthoringItemToDocumentItem),
    connections: input.connections ?? [],
  });
}

export function applyBoardAuthoringSnapshot(
  document: BoardDocument,
  input: BoardAuthoringSnapshot,
  changed: BoardMutationReceipt["changed"],
): BoardDocument {
  let items = document.items;
  if (changed.orderChanged && input.items) {
    items = input.items.map(boardAuthoringItemToDocumentItem);
  } else if (input.items !== undefined || changed.items.length > 0) {
    const received = new Map((input.items ?? []).map((item) => [item.id, item]));
    const changedIds = new Set(changed.items);
    items = document.items
      .filter((item) => !changedIds.has(item.id) || received.has(item.id))
      .map((item) => received.has(item.id) ? boardAuthoringItemToDocumentItem(received.get(item.id) as BoardAuthoringItem) : item);
    const present = new Set(items.map((item) => item.id));
    for (const item of received.values()) if (!present.has(item.id)) items.push(boardAuthoringItemToDocumentItem(item));
  }
  let connections = document.connections;
  if (input.connections !== undefined || changed.connections.length > 0) {
    const received = new Map((input.connections ?? []).map((connection) => [connection.id, connection]));
    const changedIds = new Set(changed.connections);
    connections = document.connections
      .filter((connection) => !changedIds.has(connection.id) || received.has(connection.id))
      .map((connection) => received.get(connection.id) ?? connection);
    const present = new Set(connections.map((connection) => connection.id));
    for (const connection of received.values()) if (!present.has(connection.id)) connections.push(connection);
  }
  const appearance = changed.board ? BoardAppearanceSchema.safeParse(input.board.metadata.appearance) : null;
  return parseBoardDocument({
    ...document,
    ...(appearance?.success ? { appearance: appearance.data } : {}),
    items,
    connections,
  });
}
