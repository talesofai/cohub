export const escapeAttachmentPath = (path: string) => path.replace(/[\r\n`]/g, "_");
export const escapeAttachmentUrl = (url: string) => url.replace(/[\r\n`]/g, "_");

export function buildFileReferencesText(paths: string[]) {
  const safePaths = paths.map((path) => path.trim()).filter(Boolean);
  if (safePaths.length === 0) return "";
  return [
    "Files:",
    ...safePaths.map((path) => `- \`${escapeAttachmentPath(path)}\``),
  ].join("\n");
}

export function buildImageReferencesText(urls: string[]) {
  const safeUrls = urls.map((url) => url.trim()).filter(Boolean);
  if (safeUrls.length === 0) return "";
  return ["Images:", ...safeUrls.map((url) => `- ${escapeAttachmentUrl(url)}`)].join("\n");
}

export type ViewportVisibleLines = {
  start: number;
  end: number;
};

export type ViewportVisibleRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ViewportSelectedNode = {
  id: string;
  type: string;
  title?: string;
};

export type ViewportFileContext = {
  kind: "file";
  path: string;
  visibleLines?: ViewportVisibleLines;
};

export type ViewportBoardContext = {
  kind: "board";
  path: string;
  /** Board entity id; lets the agent inspect/render the board the user is viewing. */
  boardId?: string;
  visibleRect?: ViewportVisibleRect;
  selectedNodes?: ViewportSelectedNode[];
};

export type ViewportPortContext = {
  kind: "port";
  port: string;
  url?: string;
};

export type ViewportWorkContext = {
  kind: "work";
  workId: string;
  key: string;
  label: string;
  content: string;
};

export type ViewportContext =
  | ViewportFileContext
  | ViewportBoardContext
  | ViewportPortContext
  | ViewportWorkContext;

export function viewportContextId(context: ViewportContext): string {
  if (context.kind === "port") return `port:${context.port}`;
  if (context.kind === "work") return `work:${context.workId}:${context.key}`;
  return `${context.kind}:${context.path}`;
}

function formatVisibleLines(range: ViewportVisibleLines | undefined) {
  if (!range) return "";
  const start = Math.max(1, Math.floor(range.start));
  const end = Math.max(start, Math.floor(range.end));
  return start === end ? `L${start}` : `L${start}-${end}`;
}

function formatVisibleRect(rect: ViewportVisibleRect | undefined) {
  if (!rect) return "";
  return `view ${Math.round(rect.width)}×${Math.round(rect.height)} at (${Math.round(rect.x)}, ${Math.round(rect.y)})`;
}

function escapeViewportLabel(value: string) {
  return value.replace(/[\r\n`]/g, "_").trim();
}

function formatSelectedNodes(nodes: ViewportSelectedNode[] | undefined) {
  if (!nodes || nodes.length === 0) return "";
  const labels = nodes.map((node) => {
    const title = node.title ? escapeViewportLabel(node.title) : "";
    return title || escapeViewportLabel(node.id);
  });
  return `selected: ${labels.join(", ")}`;
}

export function formatViewportContextLabel(context: ViewportContext): string {
  if (context.kind === "file") {
    const name = context.path.split("/").pop() || context.path;
    const lines = formatVisibleLines(context.visibleLines);
    return lines ? `${name} ${lines}` : name;
  }
  if (context.kind === "board") {
    const name = context.path.split("/").pop() || context.path;
    const selected = context.selectedNodes?.length
      ? ` · ${context.selectedNodes.length} selected`
      : "";
    return `${name}${selected}`;
  }
  if (context.kind === "work") return context.label;
  return `:${context.port}`;
}

export function formatViewportContextLine(context: ViewportContext): string {
  if (context.kind === "file") {
    const lines = formatVisibleLines(context.visibleLines);
    const suffix = lines ? ` (${lines})` : "";
    return `- file: \`${escapeAttachmentPath(context.path)}\`${suffix}`;
  }
  if (context.kind === "board") {
    const details = [
      ...(context.boardId
        ? [`id: ${escapeViewportLabel(context.boardId)}`]
        : []),
      formatSelectedNodes(context.selectedNodes),
      formatVisibleRect(context.visibleRect),
    ].filter(Boolean);
    const suffix = details.length > 0 ? ` (${details.join("; ")})` : "";
    return `- board: \`${escapeAttachmentPath(context.path)}\`${suffix}`;
  }
  if (context.kind === "work") {
    const label = escapeViewportLabel(context.label);
    const content = context.content.replace(/\r\n?/g, "\n").trim();
    return `- work: \`${escapeAttachmentPath(context.workId)}\` (${label})\n${content}`;
  }
  const url = context.url?.trim();
  const suffix = url ? ` (${escapeAttachmentUrl(url)})` : "";
  return `- port: \`${escapeAttachmentPath(context.port)}\`${suffix}`;
}

export function buildViewportReferencesText(contexts: ViewportContext[]) {
  if (contexts.length === 0) return "";
  return ["Viewport:", ...contexts.map(formatViewportContextLine)].join("\n");
}

export function buildViewportContentBlock(contexts: ViewportContext[]) {
  const text = buildViewportReferencesText(contexts);
  if (!text) return null;
  return {
    type: "text" as const,
    text,
    _meta: {
      attachmentKind: "viewport" as const,
      viewports: contexts,
    },
  };
}

export function isViewportContentBlock(block: {
  type: string;
  _meta?: Record<string, unknown>;
}): boolean {
  return (
    block.type === "text" &&
    block._meta?.attachmentKind === "viewport"
  );
}

export function parseViewportContextsFromMeta(
  meta: Record<string, unknown> | undefined | null,
): ViewportContext[] {
  const raw = meta?.viewports;
  if (!Array.isArray(raw)) return [];
  const result: ViewportContext[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.kind === "file" && typeof record.path === "string") {
      const visibleLines =
        record.visibleLines &&
        typeof record.visibleLines === "object" &&
        !Array.isArray(record.visibleLines)
          ? (record.visibleLines as Record<string, unknown>)
          : null;
      result.push({
        kind: "file",
        path: record.path,
        ...(visibleLines &&
        typeof visibleLines.start === "number" &&
        typeof visibleLines.end === "number"
          ? {
              visibleLines: {
                start: visibleLines.start,
                end: visibleLines.end,
              },
            }
          : {}),
      });
      continue;
    }
    if (record.kind === "board" && typeof record.path === "string") {
      const visibleRect =
        record.visibleRect &&
        typeof record.visibleRect === "object" &&
        !Array.isArray(record.visibleRect)
          ? (record.visibleRect as Record<string, unknown>)
          : null;
      const selectedNodes = Array.isArray(record.selectedNodes)
        ? record.selectedNodes.flatMap((node) => {
            if (!node || typeof node !== "object" || Array.isArray(node)) return [];
            const entry = node as Record<string, unknown>;
            if (typeof entry.id !== "string" || typeof entry.type !== "string") {
              return [];
            }
            return [
              {
                id: entry.id,
                type: entry.type,
                ...(typeof entry.title === "string" ? { title: entry.title } : {}),
              } satisfies ViewportSelectedNode,
            ];
          })
        : undefined;
      result.push({
        kind: "board",
        path: record.path,
        ...(typeof record.boardId === "string" && record.boardId
          ? { boardId: record.boardId }
          : {}),
        ...(visibleRect &&
        typeof visibleRect.x === "number" &&
        typeof visibleRect.y === "number" &&
        typeof visibleRect.width === "number" &&
        typeof visibleRect.height === "number"
          ? {
              visibleRect: {
                x: visibleRect.x,
                y: visibleRect.y,
                width: visibleRect.width,
                height: visibleRect.height,
              },
            }
          : {}),
        ...(selectedNodes && selectedNodes.length > 0 ? { selectedNodes } : {}),
      });
      continue;
    }
    if (record.kind === "port" && typeof record.port === "string") {
      result.push({
        kind: "port",
        port: record.port,
        ...(typeof record.url === "string" ? { url: record.url } : {}),
      });
      continue;
    }
    if (
      record.kind === "work" &&
      typeof record.workId === "string" &&
      typeof record.key === "string" &&
      typeof record.label === "string" &&
      typeof record.content === "string"
    ) {
      result.push({
        kind: "work",
        workId: record.workId,
        key: record.key,
        label: record.label,
        content: record.content,
      });
    }
  }
  return result;
}
