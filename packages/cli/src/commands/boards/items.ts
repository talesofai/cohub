import { randomUUID } from "node:crypto";
import {
  BoardAuthoringItemSchema,
  BoardItemPatchSchema,
  type BoardAuthoringItem,
  type BoardSemanticCommand,
} from "@neta-art/cohub";
import { computeArrowFrame, computeDrawBounds } from "@neta-art/cohub/board";
import type { Command } from "commander";
import {
  BOARD_DOMAIN_INPUT_MAX_BYTES,
  readBoardJsonObject,
} from "../../board-command-support.js";
import { handleHttp, json, jsonRequested, ok, table } from "../../output.js";
import {
  readInput,
  readOptions,
  type JsonOptions,
  resolvedBoard,
  withJson,
} from "./context.js";

type MutationOptions = JsonOptions & {
  input?: string;
  baseVersion?: string;
  mutationId?: string;
  cascade?: boolean;
  dryRun?: boolean;
};

const baseVersion = (value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("base version must be a non-negative integer");
  }
  return parsed;
};

async function execute(
  boards: Command,
  target: string,
  command: BoardSemanticCommand,
  options: MutationOptions,
) {
  const board = await resolvedBoard(boards, target);
  const snapshot = await board.summary();
  const mutation = {
    mutationId: options.mutationId?.trim() || randomUUID(),
    baseVersion: baseVersion(options.baseVersion, snapshot.board.version),
    dryRun: Boolean(options.dryRun),
    commands: [command],
  };
  // Server-side validation: schema, version, references, cascade rules — the
  // same checks the real write would run, just without persisting anything.
  const receipt = await board.mutateSemantic(mutation);
  if (jsonRequested(options)) return json(receipt);
  if (options.dryRun) {
    ok(`Validated against Board version ${receipt.board.version}; no changes written`);
    return;
  }
  ok(`${receipt.replayed ? "Replayed" : "Applied"} mutation at Board version ${receipt.board.version}`);
}

function mutationOptions(command: Command) {
  return withJson(command)
    .option("--base-version <version>", "Expected Board version; defaults to latest")
    .option("--mutation-id <id>", "Stable id for safe retries")
    .option("--dry-run", "Validate on the server (references, version, cascade) without writing");
}

function itemLayout(item: BoardAuthoringItem) {
  if ("position" in item) {
    const size = "size" in item ? item.size : undefined;
    return { x: item.position.x, y: item.position.y, width: size?.width ?? "", height: size?.height ?? "" };
  }
  if (item.type === "draw") {
    const points = item.props.points;
    const strokeWidth = item.style?.strokeWidth ?? 4;
    const bounds = computeDrawBounds(points, strokeWidth);
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }
  const bounds = computeArrowFrame({
    start: item.props.start,
    end: item.props.end,
    bend: item.props.bend,
    size: item.style?.strokeWidth ?? 2.5,
  });
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

export function registerBoardItemCommands(boards: Command): void {
  const items = boards.command("items").description("Author Board items with semantic JSON");

  readOptions(withJson(items.command("list <board>").alias("ls").description("List semantic Board items")))
    .action(async (target: string, options: JsonOptions & { ids?: string }) => {
      try {
        const board = await resolvedBoard(boards, target);
        const snapshot = await board.authoring(readInput(options, "items"));
        const items = snapshot.items ?? [];
        if (jsonRequested(options)) return json(items);
        table(items.map((item) => ({
          id: item.id,
          type: item.type,
          ...itemLayout(item),
        })), [
          { key: "id", label: "ID" },
          { key: "type", label: "TYPE" },
          { key: "x", label: "X" },
          { key: "y", label: "Y" },
          { key: "width", label: "WIDTH" },
          { key: "height", label: "HEIGHT" },
        ]);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  withJson(items.command("get <board> <item-id>").description("Get one complete Board item"))
    .action(async (target: string, itemId: string, options: JsonOptions) => {
      try {
        const board = await resolvedBoard(boards, target);
        const snapshot = await board.authoring({ include: ["items"], itemIds: [itemId] });
        const item = snapshot.items?.[0];
        if (!item) throw new Error(`Item not found: ${itemId}`);
        if (jsonRequested(options)) return json(item);
        table([{
          id: item.id,
          type: item.type,
          ...itemLayout(item),
        }], [
          { key: "id", label: "ID" },
          { key: "type", label: "TYPE" },
          { key: "x", label: "X" },
          { key: "y", label: "Y" },
          { key: "width", label: "WIDTH" },
          { key: "height", label: "HEIGHT" },
        ]);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  mutationOptions(items.command("create <board>")
    .description("Create one item")
    .requiredOption("-i, --input <file>", "Board Item JSON; use - for stdin")
    .addHelpText("after", `
Minimal text item:
  {"id":"title","type":"text","position":{"x":120,"y":80},"size":{"width":320,"height":48},"props":{"text":"Launch plan","fontSize":32},"style":{"color":"brand"}}`))
    .action(async (target: string, options: MutationOptions & { input: string }) => {
      try {
        const value = await readBoardJsonObject(options.input, BOARD_DOMAIN_INPUT_MAX_BYTES);
        await execute(boards, target, {
          type: "item.create",
          item: BoardAuthoringItemSchema.parse(value),
        }, options);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  mutationOptions(items.command("patch <board> <item-id>")
    .description("Recursively merge item fields")
    .requiredOption("-i, --input <file>", "Board Item patch JSON; use - for stdin")
    .addHelpText("after", `
Objects merge recursively, arrays replace, and null clears optional fields.
Move and rename a text item without replacing its size or font:
  {"position":{"x":160,"y":120},"props":{"text":"Updated"}}`))
    .action(async (target: string, itemId: string, options: MutationOptions & { input: string }) => {
      try {
        const value = await readBoardJsonObject(options.input, BOARD_DOMAIN_INPUT_MAX_BYTES);
        await execute(boards, target, {
          type: "item.patch",
          itemId,
          patch: BoardItemPatchSchema.parse(value),
        }, options);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  mutationOptions(items.command("replace <board> <item-id>")
    .description("Replace one complete item")
    .requiredOption("-i, --input <file>", "Complete Board Item JSON; use - for stdin"))
    .action(async (target: string, itemId: string, options: MutationOptions & { input: string }) => {
      try {
        const value = await readBoardJsonObject(options.input, BOARD_DOMAIN_INPUT_MAX_BYTES);
        await execute(boards, target, {
          type: "item.replace",
          itemId,
          item: BoardAuthoringItemSchema.parse(value),
        }, options);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  mutationOptions(items.command("delete <board> <item-id>").alias("rm")
    .description("Delete one item")
    .option("--cascade", "Atomically remove relations, effects, and animation references"))
    .action(async (target: string, itemId: string, options: MutationOptions) => {
      try {
        await execute(boards, target, {
          type: "item.delete",
          itemId,
          cascade: Boolean(options.cascade),
        }, options);
      } catch (cause) {
        handleHttp(cause);
      }
    });
}
