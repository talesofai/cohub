/**
 * Board image export for the CLI.
 *
 * The CLI and web editor share canonical Board geometry and card semantics. Each
 * host selects the renderer primitive suited to its backend; this path uses
 * Canvas2D. Everything platform-specific
 * lives here: fetching the document over HTTP, pulling image bytes out of the
 * space, and locating fonts on disk.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  boardAuthoringSnapshotToDocument,
  boardImageKeySource,
  type BoardDocument,
  type BoardExportRegion,
  type BoardItem,
  imageAssetKey,
  planBoardExport,
  selectBoardExportAssets,
} from "@neta-art/cohub/board";
import {
  type BoardHeadlessExportFormat,
  type BoardHeadlessFont,
  type BoardHeadlessRenderer,
  type BoardHeadlessTexture,
  createBoardHeadlessRenderer,
  exportBoardImageBytes,
} from "@neta-art/cohub/board/headless";
import { resolveBoardId } from "./board-command-support.js";
import { createClient } from "./client.js";
import { downloadPublicImage } from "./safe-remote-image.js";

export const BOARD_EXPORT_FORMATS: BoardHeadlessExportFormat[] = ["png", "jpeg", "webp"];

/** Infer the output format from the file extension, defaulting to PNG. */
export function formatFromPath(path: string): BoardHeadlessExportFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "jpeg";
  if (lower.endsWith(".webp")) return "webp";
  return "png";
}

/**
 * Geist, as shipped to the browser.
 *
 * The board asks for the "Geist" family; registering the exact same font files
 * the web app loads is what makes CLI output match the editor rather than
 * substituting whatever sans-serif the host happens to have. Resolution is
 * best-effort: if the font package is not installed the export still succeeds,
 * falling back through the font stack.
 */
export function resolveBundledFonts(): BoardHeadlessFont[] {
  const require = createRequire(import.meta.url);
  const fonts: BoardHeadlessFont[] = [];
  const candidates: Array<{ pkg: string; file: string; family: string }> = [
    { pkg: "@fontsource/geist", file: "geist-latin-500-normal.woff2", family: "Geist" },
    { pkg: "@fontsource/geist", file: "geist-latin-400-normal.woff2", family: "Geist" },
    { pkg: "@fontsource/geist", file: "geist-latin-600-normal.woff2", family: "Geist" },
    { pkg: "@fontsource/geist-mono", file: "geist-mono-latin-400-normal.woff2", family: "Geist Mono" },
  ];
  for (const candidate of candidates) {
    try {
      const root = dirname(require.resolve(`${candidate.pkg}/package.json`));
      const path = join(root, "files", candidate.file);
      if (existsSync(path)) fonts.push({ path, family: candidate.family });
    } catch {
      // Font package absent; the stack's system fallbacks cover it.
    }
  }
  return fonts;
}

export type BoardExportSource = {
  document: BoardDocument;
  boardId: string;
  title: string | null;
};

/**
 * Load a board document by board id or by the path of its `.board` file.
 *
 * A `.board` file is a manifest holding a board id, so both forms converge on
 * the same inspect call — which is also what the web client does.
 */
export async function loadBoardDocument(
  spaceId: string,
  target: string,
): Promise<BoardExportSource> {
  const client = createClient();
  const boardId = await resolveBoardId(spaceId, target);
  const snapshot = await client.space(spaceId).board(boardId).authoring({ include: ["items", "connections"] });
  return {
    document: boardAuthoringSnapshotToDocument(snapshot),
    boardId: snapshot.board.id,
    title: snapshot.board.title ?? null,
  };
}

/**
 * Fetch every image in `items`, keyed the way the renderers ask for it.
 *
 * Takes the planned items rather than the whole document so a partial export
 * does not download the rest of the board. Failures are collected rather than
 * thrown: one unreadable image should cost a placeholder and a warning, not the
 * whole export. Downloads run concurrently but bounded, so a board with hundreds
 * of images does not open hundreds of sockets.
 */
export async function loadBoardTextures(
  headless: BoardHeadlessRenderer,
  spaceId: string,
  items: BoardItem[],
  options: { concurrency?: number } = {},
): Promise<{
  textures: Map<string, BoardHeadlessTexture>;
  failed: string[];
  omitted: string[];
}> {
  const selection = selectBoardExportAssets(items, imageAssetKey);
  const textures = new Map<string, BoardHeadlessTexture>();
  const failed: string[] = [];
  const pending = [...selection.keys];
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16));
  const client = createClient();

  async function worker() {
    for (;;) {
      const key = pending.shift();
      if (!key) return;
      const source = boardImageKeySource(key);
      if (!source) {
        failed.push(key);
        continue;
      }
      try {
        const { bytes, mimeType } =
          source.kind === "file"
            ? await readSpaceFileBytes(client, spaceId, source.value)
            : await downloadPublicImage(source.value);
        const texture = await headless.decodeImage(bytes, mimeType);
        textures.set(key, texture);
      } catch {
        failed.push(key);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  return { textures, failed, omitted: selection.omittedKeys };
}

async function readSpaceFileBytes(
  client: ReturnType<typeof createClient>,
  spaceId: string,
  path: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const { blob, mimeType } = await client.space(spaceId).files.download(path);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType };
}

export type BoardExportRunOptions = {
  spaceId: string;
  target: string;
  region: BoardExportRegion;
  scale: number;
  padding?: number;
  colorScheme: "dark" | "light";
  background: "paper" | "transparent";
  format: BoardHeadlessExportFormat;
  quality?: number;
  withImages: boolean;
};

export type BoardExportRunResult = {
  bytes: Uint8Array;
  width: number;
  height: number;
  scale: number;
  itemCount: number;
  format: BoardHeadlessExportFormat;
  warnings: string[];
};

/** Render a board to image bytes. Returns null when the region is empty. */
export async function runBoardExport(
  options: BoardExportRunOptions,
): Promise<BoardExportRunResult | null> {
  const { document } = await loadBoardDocument(options.spaceId, options.target);

  // Plan before fetching: a --frame / --items / --rect export should only pull
  // the images it will actually draw, and an empty region should pull none.
  const plan = planBoardExport({
    document,
    region: options.region,
    scale: options.scale,
    ...(options.padding === undefined ? {} : { padding: options.padding }),
  });
  if (!plan) return null;

  const headless = await createBoardHeadlessRenderer({ fonts: resolveBundledFonts() });
  try {
    const warnings: string[] = [];
    let textures: Map<string, BoardHeadlessTexture> | undefined;
    let backgroundTexture: BoardHeadlessTexture | undefined;
    let omittedKeys = new Set<string>();
    if (options.withImages) {
      const loaded = await loadBoardTextures(headless, options.spaceId, plan.items);
      textures = loaded.textures;
      omittedKeys = new Set(loaded.omitted);
      if (loaded.failed.length > 0) {
        warnings.push(
          `${loaded.failed.length} image${loaded.failed.length === 1 ? "" : "s"} could not be loaded: ${loaded.failed.slice(0, 3).join(", ")}${loaded.failed.length > 3 ? ", …" : ""}`,
        );
      }
      if (loaded.omitted.length > 0) {
        warnings.push(
          `${loaded.omitted.length} previews were drawn as placeholders to stay within the export texture limit.`,
        );
      }
    }

    const declaredBackground = document.appearance.background;
    if (
      options.withImages &&
      options.background === "paper" &&
      declaredBackground.kind === "image" &&
      declaredBackground.imageUrl
    ) {
      try {
        const { bytes, mimeType } = await downloadPublicImage(declaredBackground.imageUrl);
        backgroundTexture = await headless.decodeImage(bytes, mimeType);
      } catch {
        warnings.push(
          "The board background image could not be loaded; the fallback color was exported.",
        );
      }
    }

    const videoCount = plan.items.filter((item) => item.type === "video").length;
    if (videoCount > 0) {
      warnings.push(
        `${videoCount} video preview${videoCount === 1 ? " was" : "s were"} drawn as placeholders; headless video decoding is unavailable.`,
      );
    }

    const result = exportBoardImageBytes(headless, document, {
      region: options.region,
      scale: options.scale,
      padding: options.padding,
      colorScheme: options.colorScheme,
      background: options.background,
      textures,
      backgroundImage: backgroundTexture
        ? {
            texture: backgroundTexture,
            fit: declaredBackground.fit ?? "cover",
            position: declaredBackground.position ?? "center",
            opacity: declaredBackground.opacity ?? 1,
          }
        : undefined,
      ...(options.withImages
        ? {
            assetKey: (item: BoardItem) => {
              const key = imageAssetKey(item);
              return key && omittedKeys.has(key) ? null : key;
            },
          }
        : {}),
      format: options.format,
      quality: options.quality,
    });
    if (!result) return null;

    for (const warning of result.warnings) {
      // Missing-image warnings are already reported above with their paths.
      if (warning.kind === "images-missing" && options.withImages) continue;
      warnings.push(describeWarning(warning));
    }
    return {
      bytes: result.bytes,
      width: result.plan.width,
      height: result.plan.height,
      scale: result.plan.scale,
      itemCount: result.plan.items.length,
      format: result.format,
      warnings,
    };
  } finally {
    headless.destroy();
  }
}

function describeWarning(warning: { kind: string; [key: string]: unknown }): string {
  if (warning.kind === "scale-clamped") {
    return `Scale reduced from ${warning.requested}x to ${Number(warning.applied).toFixed(2)}x to stay within the size limit.`;
  }
  if (warning.kind === "images-missing") {
    const keys = warning.keys as string[];
    return `${keys.length} image${keys.length === 1 ? "" : "s"} drawn as placeholders (use --images to fetch them).`;
  }
  if (warning.kind === "many-items") {
    return `${warning.count} items exported.`;
  }
  return warning.kind;
}
