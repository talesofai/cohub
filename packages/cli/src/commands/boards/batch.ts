import { randomUUID } from "node:crypto";
import { BoardSemanticCommandSchema, type BoardSemanticCommand } from "@neta-art/cohub";
import type { Command } from "commander";
import {
  BOARD_TRANSACTION_INPUT_MAX_BYTES,
  readBoardJsonObject,
} from "../../board-command-support.js";
import { handleHttp, json, jsonRequested, ok } from "../../output.js";
import {
  mutateSemantic,
  type JsonOptions,
  resolvedBoard,
  withJson,
} from "./context.js";

export function parseBatchCommands(input: Record<string, unknown>): BoardSemanticCommand[] {
  if (!Array.isArray(input.commands) || input.commands.length === 0) {
    throw new Error("batch input must contain a non-empty commands array");
  }
  return input.commands.map((command, index) => {
    const parsed = BoardSemanticCommandSchema.safeParse(command);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.length ? `.${issue.path.join(".")}` : "";
      throw new Error(`commands[${index}]${path}: ${issue?.message ?? "invalid command"}`);
    }
    return parsed.data;
  });
}

export function registerBoardBatchCommand(boards: Command): void {
  withJson(boards.command("batch <board>")
    .description("Apply an atomic batch of semantic Board changes")
    .requiredOption("-i, --input <file>", "Batch JSON with a commands array; use - for stdin")
    .option("--base-version <version>", "Expected Board version; defaults to latest")
    .option("--mutation-id <id>", "Stable id for safe retries")
    .option("--dry-run", "Validate the whole batch without writing")
    .addHelpText("after", `
Input format:
  {"commands":[{"type":"item.patch","itemId":"title","patch":{"props":{"text":"Updated"}}}]}

Commands are applied atomically. See boards capabilities for supported fields.`))
    .action(async (target: string, options: JsonOptions & {
      input: string;
      baseVersion?: string;
      mutationId?: string;
      dryRun?: boolean;
    }) => {
      try {
        const input = await readBoardJsonObject(options.input, BOARD_TRANSACTION_INPUT_MAX_BYTES);
        const commands = parseBatchCommands(input);
        const parsedVersion = options.baseVersion === undefined ? undefined : Number(options.baseVersion);
        if (parsedVersion !== undefined && (!Number.isSafeInteger(parsedVersion) || parsedVersion < 0)) {
          throw new Error("base version must be a non-negative integer");
        }
        const board = await resolvedBoard(boards, target);
        const result = await mutateSemantic(board, commands, {
          ...(parsedVersion === undefined ? {} : { baseVersion: parsedVersion }),
          mutationId: options.mutationId?.trim() || randomUUID(),
          dryRun: Boolean(options.dryRun),
        });
        if (jsonRequested(options)) return json(result);
        if (result.outcome === "dry-run") {
          ok(`Validated ${commands.length} changes; no changes written`);
        } else if (result.outcome === "noop" || result.status === "validated") {
          ok(`Board already matches the requested ${commands.length} changes`);
        } else {
          ok(`${result.replayed ? "Replayed" : "Applied"} ${commands.length} changes at Board version ${result.board.version}`);
        }
      } catch (cause) {
        handleHttp(cause);
      }
    });
}
