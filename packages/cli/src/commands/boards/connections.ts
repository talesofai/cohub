import { randomUUID } from "node:crypto";
import { createBoardConnection } from "@neta-art/cohub/board";
import type { Command } from "commander";
import { handleHttp, json, jsonRequested, table } from "../../output.js";
import {
  mutateSemantic,
  readInput,
  readOptions,
  type JsonOptions,
  resolvedBoard,
  showUpdated,
  withJson,
} from "./context.js";

const columns = [
  { key: "id", label: "ID" },
  { key: "source", label: "SOURCE" },
  { key: "target", label: "TARGET" },
  { key: "relation", label: "RELATION" },
  { key: "direction", label: "DIRECTION" },
  { key: "label", label: "LABEL" },
];

function rows(connections: Array<{ id: string; source: { itemId: string }; target: { itemId: string }; relation?: string; direction?: string; label?: string }>) {
  return connections.map((connection) => ({
    id: connection.id,
    source: connection.source.itemId,
    target: connection.target.itemId,
    relation: connection.relation ?? "",
    direction: connection.direction ?? "",
    label: connection.label ?? "",
  }));
}

export function registerBoardConnectionCommands(boards: Command): void {
  const connections = boards.command("connections").description("Manage Board connections");

  readOptions(withJson(connections.command("list <board>").alias("ls").description("List Board connections")))
    .action(async (target: string, options: JsonOptions & { ids?: string }) => {
      try {
        const board = await resolvedBoard(boards, target);
        const result = await board.authoring(readInput(options, "connections"));
        const value = result.connections ?? [];
        if (jsonRequested(options)) return json(value);
        table(rows(value), columns);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  withJson(connections.command("get <board> <connection-id>").description("Get one complete Board connection"))
    .action(async (target: string, connectionId: string, options: JsonOptions) => {
      try {
        const board = await resolvedBoard(boards, target);
        const result = await board.authoring({ include: ["connections"], connectionIds: [connectionId] });
        const connection = result.connections?.[0];
        if (!connection) throw new Error(`Connection not found: ${connectionId}`);
        if (jsonRequested(options)) return json(connection);
        table(rows([connection]), columns);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  withJson(connections.command("create <board> <source> <target>").description("Create a Board connection")
    .option("--id <id>", "Connection id")
    .option("--relation <relation>", "Relation type")
    .option("--direction <direction>", "none, forward, backward, or both", "forward")
    .option("--label <label>", "Connection label")
    .option("--source-port <id>", "Source port id")
    .option("--target-port <id>", "Target port id"))
    .action(async (target: string, source: string, destination: string, options: JsonOptions & {
      id?: string;
      relation?: string;
      direction?: string;
      label?: string;
      sourcePort?: string;
      targetPort?: string;
    }) => {
      try {
        const direction = options.direction ?? "forward";
        if (!["none", "forward", "backward", "both"].includes(direction)) {
          throw new Error("--direction must be none, forward, backward, or both");
        }
        const board = await resolvedBoard(boards, target);
        const connection = createBoardConnection({
          id: options.id ?? randomUUID(),
          sourceItemId: source,
          targetItemId: destination,
          relation: options.relation,
          direction: direction as "none" | "forward" | "backward" | "both",
          label: options.label,
          sourcePortId: options.sourcePort,
          targetPortId: options.targetPort,
        });
        showUpdated(await mutateSemantic(board, [{ type: "connection.create", connection }]), options);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  withJson(connections.command("delete <board> <connection-id>").alias("rm").description("Delete a Board connection"))
    .action(async (target: string, connectionId: string, options: JsonOptions) => {
      try {
        const board = await resolvedBoard(boards, target);
        showUpdated(await mutateSemantic(board, [{ type: "connection.delete", connectionId }]), options);
      } catch (cause) {
        handleHttp(cause);
      }
    });
}
