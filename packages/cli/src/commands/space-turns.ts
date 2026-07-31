import type {
  SpaceTurnAuthorFilter,
  SpaceTurnListItem,
  SpaceTurnListOptions,
  SpaceTurnsResponse,
} from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import {
  error,
  handleHttp,
  json as outJson,
  jsonRequested,
  table,
  type Row,
} from "../output.js";
import { resolveSpace } from "../space.js";

const SPACE_TURN_AUTHORS = ["any", "self", "others"] as const;

export type SpaceTurnListCliOptions = {
  author?: string;
  after?: string;
  before?: string;
  cursor?: string;
  limit?: string;
  session?: string;
  json?: boolean;
};

type SpaceTurnsCommandClient = {
  space(spaceId: string): {
    turns: {
      list(options: SpaceTurnListOptions): Promise<SpaceTurnsResponse>;
    };
  };
};

export class InvalidSpaceTurnCliOptionsError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = "InvalidSpaceTurnCliOptionsError";
  }
}

function parseAuthor(value: string | undefined): SpaceTurnAuthorFilter | undefined {
  if (value === undefined) return undefined;
  if ((SPACE_TURN_AUTHORS as readonly string[]).includes(value)) {
    return value as SpaceTurnAuthorFilter;
  }
  throw new InvalidSpaceTurnCliOptionsError(
    "Invalid author",
    `Use one of: ${SPACE_TURN_AUTHORS.join(", ")}`,
  );
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value.trim())) {
    throw new InvalidSpaceTurnCliOptionsError(
      "Invalid limit",
      "limit must be an integer from 1 to 100",
    );
  }
  const limit = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new InvalidSpaceTurnCliOptionsError(
      "Invalid limit",
      "limit must be an integer from 1 to 100",
    );
  }
  return limit;
}

function parseBefore(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim() || Number.isNaN(new Date(value).getTime())) {
    throw new InvalidSpaceTurnCliOptionsError(
      "Invalid before",
      "before must be an ISO 8601 timestamp",
    );
  }
  return value;
}

export function parseSpaceTurnListOptions(
  options: SpaceTurnListCliOptions,
): SpaceTurnListOptions {
  return {
    author: parseAuthor(options.author),
    after: options.after,
    before: parseBefore(options.before),
    cursor: options.cursor,
    limit: parseLimit(options.limit),
    sessionId: options.session,
  };
}

export function toSpaceTurnRows(turns: SpaceTurnListItem[]): Row[] {
  return turns.map((turn) => ({
    createdAt: turn.createdAt,
    author: turn.authorProfile?.displayName ?? turn.userUuid ?? "system",
    sessionTitle: turn.session.title ?? "",
    sessionId: turn.session.id,
    sequence: turn.sequence,
    id: turn.id,
    status: turn.status,
    userPreview: turn.userPreview ?? "",
    assistantPreview: turn.assistantPreview ?? "",
  }));
}

export function registerSpaceTurns(
  spacesCmd: Command,
  dependencies: { createClient?: () => SpaceTurnsCommandClient } = {},
): Command {
  const turnsCmd = spacesCmd
    .command("turns")
    .description("Browse turns across the space")
    .hook("preAction", () => {
      resolveSpace(spacesCmd);
    });

  turnsCmd
    .command("ls")
    .alias("list")
    .description("List recent turns across sessions")
    .option("--author <any|self|others>", "Filter turns by author")
    .option("--after <cursor>", "Only turns after a snapshot cursor")
    .option("--before <timestamp>", "Only turns at or before an ISO 8601 timestamp")
    .option("--cursor <cursor>", "Older-page cursor from a previous result")
    .option("--limit <n>", "Page size, from 1 to 100")
    .option("--session <id>", "Only turns from this session")
    .option("--json", "Output as JSON")
    .action(async (options: SpaceTurnListCliOptions) => {
      let query: SpaceTurnListOptions;
      try {
        query = parseSpaceTurnListOptions(options);
      } catch (cause) {
        if (cause instanceof InvalidSpaceTurnCliOptionsError) {
          return error(cause.message, cause.detail);
        }
        throw cause;
      }

      const spaceId = resolveSpace(spacesCmd);
      const client = dependencies.createClient?.() ?? createClient();
      try {
        const result = await client.space(spaceId).turns.list(query);
        if (jsonRequested(options)) return outJson(result);
        if (result.turns.length === 0) return console.log("  No turns found");

        table(toSpaceTurnRows(result.turns), [
          { key: "createdAt", label: "Created" },
          { key: "author", label: "Author" },
          { key: "sessionTitle", label: "Session" },
          { key: "sessionId", label: "Session ID" },
          { key: "sequence", label: "Seq" },
          { key: "id", label: "Turn ID" },
          { key: "status", label: "Status" },
          { key: "userPreview", label: "User" },
          { key: "assistantPreview", label: "Assistant" },
        ]);
        if (result.pageInfo.hasMore && result.pageInfo.nextCursor) {
          console.log(`\n  More turns available - next cursor: ${result.pageInfo.nextCursor}`);
        }
      } catch (cause) {
        handleHttp(cause);
      }
    });

  return turnsCmd;
}
