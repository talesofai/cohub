import { randomUUID } from "node:crypto";

import type {
  BoardCreateInput,
  BoardPlaybackSnapshot,
  BoardSummary,
} from "@neta-art/cohub";
import type { BoardExportRegion } from "@neta-art/cohub/board";
import type { Command } from "commander";
import {
  BOARD_CREATE_INPUT_MAX_BYTES,
  parseBoardJsonObject,
  readBoardJsonObject,
  resolveBoardId,
  writeBoardOutput,
} from "../board-command-support.js";
import { BOARD_EXPORT_FORMATS, formatFromPath, runBoardExport } from "../board-export.js";
import { registerBoardDomainCommands } from "./board-domain.js";
import { createClient, createRealtimeClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";
import { resolveSpace } from "../space.js";

type JsonOptions = { json?: boolean };
type PlaybackOptions = JsonOptions & { commandId?: string };

export const parseJsonObject = parseBoardJsonObject;

function parseNumber(value: string, name: string, options: { min?: number; max?: number; integer?: boolean } = {}): number {
  if (!value.trim()) throw new Error(`${name} must be a finite number`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  if (options.integer && !Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  if (options.min !== undefined && parsed < options.min) throw new Error(`${name} must be at least ${options.min}`);
  if (options.max !== undefined && parsed > options.max) throw new Error(`${name} must be at most ${options.max}`);
  return parsed;
}

export function parseViewport(value?: string): { x: number; y: number; width: number; height: number } | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length !== 4) throw new Error("viewport must be x,y,width,height");
  const [xValue, yValue, widthValue, heightValue] = parts;
  if (xValue === undefined || yValue === undefined || widthValue === undefined || heightValue === undefined) {
    throw new Error("viewport must be x,y,width,height");
  }
  const x = parseNumber(xValue, "viewport x");
  const y = parseNumber(yValue, "viewport y");
  const width = parseNumber(widthValue, "viewport width");
  const height = parseNumber(heightValue, "viewport height");
  if (width <= 0 || height <= 0) throw new Error("viewport width and height must be greater than zero");
  return { x, y, width, height };
}

export function showCreated(
  result: { board: { id: string; title: string; version: number } },
  path: string,
): void {
  table([{ path, ...result.board }], [
    { key: "path", label: "Path" },
    { key: "id", label: "ID" },
    { key: "title", label: "Title" },
    { key: "version", label: "Version" },
  ]);
}

function showSummary(result: BoardSummary): void {
  const background = result.board.metadata.appearance as
    | { background?: { kind?: string } }
    | undefined;
  table([{
    id: result.board.id,
    title: result.board.title,
    version: result.board.version,
    ...result.counts,
    background: background?.background?.kind ?? "default",
    updatedAt: result.board.updatedAt,
  }], [
    { key: "id", label: "ID" },
    { key: "title", label: "TITLE" },
    { key: "version", label: "VERSION" },
    { key: "items", label: "ITEMS" },
    { key: "connections", label: "CONNECTIONS" },
    { key: "effects", label: "EFFECTS" },
    { key: "compositions", label: "COMPOSITIONS" },
    { key: "background", label: "BACKGROUND" },
    { key: "updatedAt", label: "UPDATED" },
  ]);
}

function showPlayback(result: BoardPlaybackSnapshot): void {
  table([result], [
    { key: "playbackId", label: "Playback ID" },
    { key: "compositionId", label: "Composition" },
    { key: "status", label: "Status" },
    { key: "position", label: "Position" },
    { key: "timeScale", label: "Time Scale" },
  ]);
}

function withJson(command: Command): Command {
  return command.option("--json", "Output as JSON");
}

function capabilityUnits(schema: Record<string, unknown> | undefined): string {
  const params = schema?.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return "";
  return Object.entries(params).flatMap(([field, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const meta = value as { coordinateSpace?: unknown; unit?: unknown };
    const detail = [meta.coordinateSpace, meta.unit]
      .filter((item): item is string => typeof item === "string")
      .join("/");
    return detail ? [`${field}:${detail}`] : [];
  }).join(", ");
}

function commandId(options: PlaybackOptions): string {
  return options.commandId?.trim() || randomUUID();
}

type ExportOptions = JsonOptions & {
  out?: string;
  scale?: string;
  padding?: string;
  frame?: string;
  items?: string;
  rect?: string;
  theme?: string;
  background?: string;
  format?: string;
  quality?: string;
  images?: boolean;
  force?: boolean;
};

/**
 * Resolve the mutually exclusive region flags.
 *
 * Selecting more than one is rejected rather than silently ranked: "why did
 * --items win over --frame" is a worse experience than being told to pick one.
 */
function parseExportRegion(options: ExportOptions): BoardExportRegion {
  const chosen = [
    options.frame ? "--frame" : null,
    options.items ? "--items" : null,
    options.rect ? "--rect" : null,
  ].filter(Boolean);
  if (chosen.length > 1) {
    throw new Error(`Pick one region: ${chosen.join(", ")} cannot be combined`);
  }
  if (options.frame) return { kind: "frame", id: options.frame };
  if (options.items) {
    const ids = options.items.split(",").map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) throw new Error("--items needs at least one node id");
    return { kind: "items", ids };
  }
  if (options.rect) {
    const rect = parseViewport(options.rect);
    if (!rect) throw new Error("--rect must be x,y,width,height");
    return { kind: "rect", rect };
  }
  return { kind: "all" };
}

function parseExportFormat(options: ExportOptions, outPath: string) {
  if (!options.format) return formatFromPath(outPath);
  const format = options.format.toLowerCase();
  if (!BOARD_EXPORT_FORMATS.includes(format as (typeof BOARD_EXPORT_FORMATS)[number])) {
    throw new Error(`Unknown format "${options.format}"; use ${BOARD_EXPORT_FORMATS.join(", ")}`);
  }
  return format as (typeof BOARD_EXPORT_FORMATS)[number];
}

function parseColorMode(value: string | undefined): "dark" | "light" {
  if (!value || value === "dark") return "dark";
  if (value === "light") return "light";
  throw new Error('--theme must be "dark" or "light"');
}

function parseBackground(value: string | undefined): "paper" | "transparent" {
  if (!value || value === "paper") return "paper";
  if (value === "transparent") return "transparent";
  throw new Error('--background must be "paper" or "transparent"');
}

function registerExportCommand(boards: Command): void {
  withJson(boards.command("export <board>")
    .description("Render a Board to an image (board id or .board path)")
    .requiredOption("-o, --out <file>", "Output file; extension selects the format")
    .option("--scale <factor>", "Output pixels per world unit", "2")
    .option("--padding <units>", "World-space padding around the content")
    .option("--frame <node-id>", "Export a single frame as a page")
    .option("--items <ids>", "Comma-separated node ids to export")
    .option("--rect <rect>", "World rect as x,y,width,height")
    .option("--theme <mode>", "dark or light", "dark")
    .option("--background <mode>", "paper or transparent", "paper")
    .option("--format <format>", `Override format (${BOARD_EXPORT_FORMATS.join(", ")})`)
    .option("--quality <q>", "JPEG/WebP quality from 0 to 1", "0.92")
    .option("--no-images", "Skip image downloads and draw placeholders")
    .option("--force", "Replace an existing output file"))
    .action(async (board: string, options: ExportOptions) => {
      try {
        const out = options.out;
        if (!out) throw new Error("--out is required");
        const result = await runBoardExport({
          spaceId: resolveSpace(boards),
          target: board,
          region: parseExportRegion(options),
          scale: parseNumber(options.scale ?? "2", "scale", { min: 0.01, max: 16 }),
          ...(options.padding === undefined
            ? {}
            : { padding: parseNumber(options.padding, "padding", { min: 0 }) }),
          colorScheme: parseColorMode(options.theme),
          background: parseBackground(options.background),
          format: parseExportFormat(options, out),
          quality: parseNumber(options.quality ?? "0.92", "quality", { min: 0, max: 1 }),
          withImages: options.images !== false,
        });
        if (!result) {
          return error(
            "Nothing to export",
            "The selected region contains no items.",
          );
        }
        await writeBoardOutput(out, result.bytes, Boolean(options.force));
        if (jsonRequested(options)) {
          return outJson({
            path: out,
            width: result.width,
            height: result.height,
            scale: result.scale,
            items: result.itemCount,
            format: result.format,
            bytes: result.bytes.length,
            warnings: result.warnings,
          });
        }
        ok(`Exported ${result.width}×${result.height} ${result.format.toUpperCase()} to ${out}`);
        for (const warning of result.warnings) console.log(`  ! ${warning}`);
      } catch (cause) {
        handleHttp(cause);
      }
    });
}

export function registerBoards(program: Command): Command {
  const boards = program
    .command("boards")
    .description("Inspect and update Boards by ID or .board path")
    .hook("preAction", () => { resolveSpace(boards); });

  withJson(boards.command("create <path>")
    .description("Create a Board")
    .option("--title <title>", "Board title")
    .option("--mutation-id <id>", "Stable id for safe retries")
    .option("-i, --input <file>", "Semantic Board seed JSON; use - for stdin")
    .addHelpText("after", `
Create an empty Board, or provide items, connections, effects, compositions, and metadata in --input.
Generate an editable seed:
  cohub boards examples create > board.json
  cohub boards create plan.board -i board.json`))
    .action(async (path: string, options: JsonOptions & { title?: string; input?: string; mutationId?: string }) => {
      try {
        const content = options.input
          ? await readBoardJsonObject(options.input, BOARD_CREATE_INPUT_MAX_BYTES)
          : {};
        if ("path" in content || "title" in content) {
          throw new Error("create input must not contain path or title; use the command argument and --title");
        }
        const input = {
          ...content,
          path,
          mutationId:
            options.mutationId ??
            (typeof content.mutationId === "string" ? content.mutationId : randomUUID()),
          ...(options.title ? { title: options.title } : {}),
        } as BoardCreateInput;
        const result = await createClient().space(resolveSpace(boards)).boards.create(input);
        if (jsonRequested(options)) return outJson({ ...result, path });
        ok(`Board created: ${path}`);
        showCreated(result, path);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  withJson(boards.command("inspect <board>")
    .alias("get")
    .description("Show Board metadata and semantic resource counts")
    .addHelpText("after", `
Inspect resources with:
  cohub boards items list <board> --json
  cohub boards connections list <board> --json
  cohub boards effects list <board> --json
  cohub boards compositions list <board> --json
Apply multiple changes atomically:
  cohub boards batch <board> --input changes.json --dry-run`))
    .action(async (target: string, options: JsonOptions) => {
      try {
        const spaceId = resolveSpace(boards);
        const boardId = await resolveBoardId(spaceId, target);
        const result = await createClient().space(spaceId).board(boardId).summary();
        if (jsonRequested(options)) return outJson(result);
        showSummary(result);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  withJson(boards.command("capabilities <board>")
    .description("Show authoring schemas and runtime capabilities")
    .addHelpText("after", `
Use --json for complete Item, patch, mutation, effect, Composition, and create JSON Schemas.
Coordinates:
  draw points and arrow start/end points are world-space.
  Position and size are optional; Board geometry derives the persisted frame automatically.
Use boards examples for editable starter JSON.`))
    .action(async (target: string, options: JsonOptions) => {
      try {
        const spaceId = resolveSpace(boards);
        const boardId = await resolveBoardId(spaceId, target);
        const result = await createClient().space(spaceId).board(boardId).capabilities();
        if (jsonRequested(options)) return outJson(result);
        table(result.capabilities.map((capability) => ({
          ...capability,
          renderers: capability.renderers?.join(", ") ?? "",
          coordinates: capabilityUnits(capability.schema),
        })), [
          { key: "kind", label: "Kind" },
          { key: "id", label: "ID" },
          { key: "version", label: "Version" },
          { key: "renderers", label: "Renderers" },
          { key: "coordinates", label: "Coordinates / units" },
          { key: "digest", label: "Digest" },
        ]);
        console.log();
        table([{
          types: result.items.types.join(", "),
          colors: result.items.colors.join(", "),
          shapes: result.items.shapes.join(", "),
          drawPoints: result.items.coordinates.drawPoints,
          arrowEndpoints: result.items.coordinates.arrowEndpoints,
        }], [
          { key: "types", label: "Item types" },
          { key: "colors", label: "Colors" },
          { key: "shapes", label: "Shapes" },
          { key: "drawPoints", label: "Draw points" },
          { key: "arrowEndpoints", label: "Arrow endpoints" },
        ]);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  registerBoardDomainCommands(boards);
  registerExportCommand(boards);

  const playback = boards.command("playback").description("Control shared Board playback");

  withJson(playback.command("play <board> <composition-id>")
    .description("Start shared playback")
    .option("--position <time>", "Initial position in milliseconds")
    .option("--time-scale <scale>", "Playback speed from 0 to 4")
    .option("--seed <seed>", "Deterministic playback seed")
    .option("--command-id <id>", "Idempotency command ID"))
    .action(async (target: string, compositionId: string, options: PlaybackOptions & { position?: string; timeScale?: string; seed?: string }) => {
      try {
        const spaceId = resolveSpace(boards);
        const boardId = await resolveBoardId(spaceId, target);
        const result = await createClient().space(spaceId).board(boardId).play({
          commandId: commandId(options),
          type: "play",
          compositionId,
          shared: true,
          ...(options.position === undefined ? {} : { position: parseNumber(options.position, "position", { min: 0 }) }),
          ...(options.timeScale === undefined ? {} : { timeScale: parseNumber(options.timeScale, "timeScale", { min: Number.EPSILON, max: 4 }) }),
          ...(options.seed ? { seed: options.seed } : {}),
        });
        if (jsonRequested(options)) return outJson(result);
        showPlayback(result);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  const playbackAction = (type: "pause" | "stop") => async (
    target: string,
    playbackId: string,
    options: PlaybackOptions,
  ) => {
    try {
      const spaceId = resolveSpace(boards);
      const boardId = await resolveBoardId(spaceId, target);
      const board = createClient().space(spaceId).board(boardId);
      const id = commandId(options);
      const result = type === "pause"
        ? await board.pause({ commandId: id, type: "pause", playbackId })
        : await board.stop({ commandId: id, type: "stop", playbackId });
      if (jsonRequested(options)) return outJson(result);
      showPlayback(result);
    } catch (cause) {
      handleHttp(cause);
    }
  };

  withJson(playback.command("pause <board> <playback-id>")
    .description("Pause playback")
    .option("--command-id <id>", "Idempotency command ID"))
    .action(playbackAction("pause"));

  withJson(playback.command("seek <board> <playback-id> <position>")
    .description("Seek playback")
    .option("--command-id <id>", "Idempotency command ID"))
    .action(async (target: string, playbackId: string, position: string, options: PlaybackOptions) => {
      try {
        const spaceId = resolveSpace(boards);
        const boardId = await resolveBoardId(spaceId, target);
        const result = await createClient().space(spaceId).board(boardId).seek({
          commandId: commandId(options),
          type: "seek",
          playbackId,
          position: parseNumber(position, "position", { min: 0 }),
        });
        if (jsonRequested(options)) return outJson(result);
        showPlayback(result);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  withJson(playback.command("stop <board> <playback-id>")
    .description("Stop playback")
    .option("--command-id <id>", "Idempotency command ID"))
    .action(playbackAction("stop"));

  withJson(boards.command("watch <board>")
    .description("Stream Board events"))
    .action(async (target: string, options: JsonOptions) => {
      try {
        const spaceId = resolveSpace(boards);
        const boardId = await resolveBoardId(spaceId, target);
        const client = createRealtimeClient();
        const board = client.space(spaceId).board(boardId);
        if (!jsonRequested(options)) process.stderr.write(`Listening for Board ${boardId} events...\n`);
        const offConnection = client.onConnection((state) => {
          if (jsonRequested(options)) {
            process.stdout.write(`${JSON.stringify({ type: "connection", ...state })}\n`);
          } else {
            const detail = state.state === "reconnecting" && state.attempt
              ? ` (attempt ${state.attempt})`
              : "";
            process.stderr.write(`${state.state}${detail}\n`);
          }
        });
        const offBoard = board.subscribe({
          event(event) {
            if (jsonRequested(options)) {
              process.stdout.write(`${JSON.stringify(event)}\n`);
              return;
            }
            if (event.type === "board.changed") {
              process.stdout.write(`version ${event.payload.version}  mutation ${event.payload.mutationId}\n`);
            } else if (event.type === "board.playback.changed") {
              process.stdout.write(`${event.payload.status}  composition ${event.payload.compositionId}  position ${event.payload.position}\n`);
            } else if (event.type === "board.awareness.updated") {
              process.stdout.write(`awareness ${event.payload.actorName}  ${event.payload.update.type}\n`);
            }
          },
        });
        process.once("SIGINT", () => {
          offBoard();
          offConnection();
          process.exit(0);
        });
      } catch (cause) {
        handleHttp(cause);
      }
    });

  return boards;
}
