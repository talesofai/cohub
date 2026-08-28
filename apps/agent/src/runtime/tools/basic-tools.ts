import { Type, type Static } from "@earendil-works/pi-ai";
import { MAX_RUN_COMMAND_TIMEOUT_SECONDS } from "@cohub/core/commands";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.js";
import { createThrottledTextToolUpdate, tailText } from "./tool-stream-update.js";
import { normalizeAgentToolImageContent } from "../../image-normalizer.js";

export interface ReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  access: (absolutePath: string) => Promise<void>;
  detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
  detectUnsupportedImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
  unsupportedImageMimeTypeMessage?: (mimeType: string) => string;
}

export interface WriteOperations {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}

export interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
  /**
   * Optional atomic read-apply-write: applies the edits to the latest file
   * content in one operation (e.g. sandbox fs.edit, which runs under a
   * per-path lock). When absent, the edit tool falls back to a plain
   * read-modify-write cycle.
   */
  applyEdits?: (absolutePath: string, edits: Array<{ oldText: string; newText: string }>) => Promise<number>;
}

export interface ToolFailureDetails {
  isError: true;
  retryable: boolean;
  infrastructure: boolean;
  rpcErrorCode?: string;
  outputTail?: string;
  message: string;
}

export type ToolResult<T> = T | ToolFailureDetails;

export function createToolFailure(message: string, options?: {
  retryable?: boolean;
  infrastructure?: boolean;
  rpcErrorCode?: string;
  outputTail?: string;
}): ToolFailureDetails {
  return {
    isError: true,
    retryable: options?.retryable ?? false,
    infrastructure: options?.infrastructure ?? false,
    ...(options?.rpcErrorCode ? { rpcErrorCode: options.rpcErrorCode } : {}),
    ...(options?.outputTail ? { outputTail: options.outputTail } : {}),
    message,
  };
}

export function isToolFailureDetails(value: unknown): value is ToolFailureDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).isError === true;
}

function failureToolResult(failure: ToolFailureDetails): AgentToolResult<unknown> {
  const tail = failure.outputTail?.trim();
  return {
    content: [{ type: "text", text: tail ? `${failure.message}\n\n${tail}` : failure.message }],
    details: failure,
  };
}

export type BashTerminationReason = "exited" | "timed_out" | "aborted";

export type BashTermination = {
  reason: BashTerminationReason;
  exitCode: number | null;
  timeoutSecs?: number;
  message?: string;
};

export type BashExecutionResult =
  | { exitCode: number | null; termination?: BashTermination }
  | { failure: ToolFailureDetails };

export type BashCommandRequest = {
  command: string;
  cwd: string;
  signal?: AbortSignal;
  timeout?: number;
  env?: Record<string, string>;
};

export type BashForegroundRequest = BashCommandRequest & {
  onData: (chunk: Buffer) => void;
};

export type BashBackgroundRequest = BashCommandRequest & {
  toolCallId: string;
};

export interface BashOperations {
  exec: (input: BashForegroundRequest) => Promise<BashExecutionResult>;
  startBackground?: (input: BashBackgroundRequest) => Promise<{ taskRunId: string }>;
}

function normalizeBashTermination(result: { exitCode: number | null; termination?: BashTermination }): BashTermination {
  return result.termination ?? { reason: "exited", exitCode: result.exitCode };
}

function formatBashTerminationNote(termination: BashTermination) {
  if (termination.reason === "timed_out") {
    return termination.message ?? `Command timed out${termination.timeoutSecs ? ` after ${termination.timeoutSecs} seconds` : ""}.`;
  }
  if (termination.reason === "aborted") {
    return termination.message ?? "Command aborted.";
  }
  if (termination.exitCode != null && termination.exitCode !== 0) {
    return `Command exited with code ${termination.exitCode}`;
  }
  return "";
}

export interface LsOperations {
  exists: (absolutePath: string) => Promise<boolean>;
  stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }>;
  readdir: (absolutePath: string) => Promise<string[]>;
}

export type FindGlobResult = string[] | { matches: string[]; note?: string; details?: unknown };

export interface FindOperations {
  exists: (absolutePath: string) => Promise<boolean>;
  glob: (pattern: string, cwd: string, options: { limit: number; ignore?: string[]; onUpdate?: AgentToolUpdateCallback<unknown> }) => Promise<FindGlobResult>;
}

export type GrepToolInput = {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
};

export type GrepToolDetails = {
  truncation?: unknown;
  matchLimitReached?: number;
  linesTruncated?: boolean;
  outputLimitReached?: boolean;
  partial?: boolean;
};

function resolveToCwd(path: string, cwd: string): string {
  if (path.startsWith("/")) return path;
  if (path === ".") return cwd;
  return `${cwd.replace(/\/$/, "")}/${path}`;
}

type EditMatch = {
  start: number;
  end: number;
  fuzzy: boolean;
};

type NormalizedEditText = {
  text: string;
  offsets: number[];
};

/**
 * Normalize only representation-level differences that are safe to repair:
 * line endings and spaces or tabs at the end of a line. The boundary map lets
 * a fuzzy match replace the original range without rewriting untouched bytes.
 */
function normalizeEditText(text: string): NormalizedEditText {
  let normalized = "";
  const offsets = [0];

  for (let lineStart = 0; lineStart < text.length;) {
    let lineEnd = lineStart;
    while (lineEnd < text.length && text[lineEnd] !== "\n" && text[lineEnd] !== "\r") lineEnd += 1;

    let contentEnd = lineEnd;
    while (contentEnd > lineStart && (text[contentEnd - 1] === " " || text[contentEnd - 1] === "\t")) contentEnd -= 1;
    normalized += text.slice(lineStart, contentEnd);
    for (let index = lineStart; index < contentEnd; index += 1) offsets.push(index + 1);

    if (lineEnd === text.length) break;
    let newlineEnd = lineEnd + 1;
    if (text[lineEnd] === "\r" && text[newlineEnd] === "\n") newlineEnd += 1;
    normalized += "\n";
    offsets.push(newlineEnd);
    lineStart = newlineEnd;
  }

  return { text: normalized, offsets };
}

function findEditOccurrences(text: string, pattern: string): number[] {
  if (pattern.length === 0) return [];
  const occurrences: number[] = [];
  for (let cursor = 0; cursor <= text.length - pattern.length;) {
    const index = text.indexOf(pattern, cursor);
    if (index === -1) break;
    occurrences.push(index);
    cursor = index + pattern.length;
  }
  return occurrences;
}

function findEditMatches(content: string, oldText: string): EditMatch[] {
  const exactOccurrences = findEditOccurrences(content, oldText);
  if (exactOccurrences.length > 0) {
    return exactOccurrences.map((start) => ({ start, end: start + oldText.length, fuzzy: false }));
  }

  const normalizedContent = normalizeEditText(content);
  const normalizedOldText = normalizeEditText(oldText);
  if (normalizedOldText.text.length === 0) return [];

  return findEditOccurrences(normalizedContent.text, normalizedOldText.text).flatMap((start) => {
    const end = start + normalizedOldText.text.length;
    const originalStart = normalizedContent.offsets[start];
    const originalEnd = normalizedContent.offsets[end];
    return originalStart === undefined || originalEnd === undefined
      ? []
      : [{ start: originalStart, end: originalEnd, fuzzy: true }];
  });
}

function editLineNumber(content: string, offset: number): number {
  return content.slice(0, offset).split(/\r\n|\r|\n/).length;
}

function findEditHintBlock(content: string, oldText: string): string | undefined {
  const contentLines = content.split(/\r\n|\r|\n/);
  const oldLines = oldText.split(/\r\n|\r|\n/);
  const anchors = oldLines
    .map((line) => line.trim())
    .filter((line) => line.length >= 4)
    .sort((left, right) => right.length - left.length);
  const tokens = oldText.match(/[A-Za-z0-9_./:-]{4,}/g) ?? [];
  const candidates = [...anchors, ...[...new Set(tokens)].sort((left, right) => right.length - left.length)];

  for (const candidate of candidates) {
    const lineIndex = contentLines.findIndex((line) => line.includes(candidate));
    if (lineIndex === -1) continue;
    const start = Math.max(0, lineIndex - 1);
    const end = Math.min(contentLines.length, lineIndex + 2);
    return contentLines
      .slice(start, end)
      .map((line, index) => {
        const lineCharacters = Array.from(line);
        const displayLine = lineCharacters.length > 240 ? `${lineCharacters.slice(0, 240).join("")}...` : line;
        return `${start + index + 1}: ${displayLine}`;
      })
      .join("\n");
  }
  return undefined;
}

function restoreEditLineEndings(text: string, content: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (content.includes("\r\n")) return normalized.replace(/\n/g, "\r\n");
  if (content.includes("\r")) return normalized.replace(/\n/g, "\r");
  return normalized;
}

function formatEditMatchError(
  content: string,
  oldText: string,
  path: string,
  index: number,
  total: number,
  matches: EditMatch[],
): string {
  const label = total === 1 ? "oldText" : `edits[${index}].oldText`;
  if (matches.length === 0) {
    const hintBlock = findEditHintBlock(content, oldText);
    const hint = hintBlock
      ? `\nCurrent nearby text:\n${hintBlock}\nCopy the current text exactly; do not reuse stale oldText.`
      : "";
    return `${label} must match exactly one region in ${path}, found 0. Re-read the file and retry with the current text, including whitespace, newlines, and escaping.${hint}`;
  }
  const lines = matches.slice(0, 8).map((match) => editLineNumber(content, match.start));
  const suffix = matches.length > lines.length ? ", ..." : "";
  return `${label} must match exactly one region in ${path}, found ${matches.length} at lines [${lines.join(", ")}${suffix}]. Add surrounding context to oldText`;
}

/**
 * Apply replacements against one original snapshot. Exact matching remains
 * the first choice; normalized matching is accepted only when it is unique.
 * No write occurs unless every edit validates and no ranges overlap.
 */
export function applyEditsToContent(
  content: string,
  edits: Array<{ oldText: string; newText: string }>,
  path: string,
): string {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const original = bom ? content.slice(1) : content;
  const replacements: Array<{ start: number; end: number; newText: string; index: number }> = [];

  for (const [index, edit] of edits.entries()) {
    if (edit.oldText.length === 0) throw new Error(`edits[${index}].oldText must not be empty in ${path}`);
    if (edit.oldText === edit.newText) throw new Error(`edits[${index}].oldText and newText must differ in ${path}`);

    const matches = findEditMatches(original, edit.oldText);
    if (matches.length !== 1) {
      throw new Error(formatEditMatchError(original, edit.oldText, path, index, edits.length, matches));
    }

    const match = matches[0];
    if (!match) throw new Error(`No match was available for edits[${index}] in ${path}`);
    replacements.push({
      start: match.start,
      end: match.end,
      newText: match.fuzzy ? restoreEditLineEndings(edit.newText, original) : edit.newText,
      index,
    });
  }

  replacements.sort((left, right) => left.start - right.start);
  for (let index = 1; index < replacements.length; index += 1) {
    const previous = replacements[index - 1];
    const current = replacements[index];
    if (!previous || !current) continue;
    if (previous.end > current.start) {
      throw new Error(`edits[${previous.index}] and edits[${current.index}] overlap in ${path}; merge nearby changes into one edit`);
    }
  }

  let updated = original;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    if (!replacement) continue;
    updated = updated.slice(0, replacement.start) + replacement.newText + updated.slice(replacement.end);
  }
  return bom + updated;
}

export function createReadTool(cwd: string, options: { operations: ReadOperations }): AgentTool {
  const parameters = Type.Object({
    path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
    offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
  });
  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters,
    async execute(_toolCallId, rawParams): Promise<AgentToolResult<unknown>> {
      const params = rawParams as Static<typeof parameters>;
      const absolutePath = resolveToCwd(params.path, cwd);
      await options.operations.access(absolutePath);
      const mimeType = options.operations.detectImageMimeType ? await options.operations.detectImageMimeType(absolutePath) : null;
      if (mimeType) {
        const buffer = await options.operations.readFile(absolutePath);
        const image = await normalizeAgentToolImageContent({ data: buffer, mimeType, label: params.path });
        return {
          content: [
            { type: "text", text: `Read image file [${mimeType}]` },
            image,
          ],
          details: undefined,
        };
      }
      const unsupportedImageMimeType = options.operations.detectUnsupportedImageMimeType
        ? await options.operations.detectUnsupportedImageMimeType(absolutePath)
        : null;
      if (unsupportedImageMimeType) {
        throw new Error(
          options.operations.unsupportedImageMimeTypeMessage?.(unsupportedImageMimeType)
          ?? `Unsupported image type: ${unsupportedImageMimeType}.`,
        );
      }
      const buffer = await options.operations.readFile(absolutePath);
      const allLines = buffer.toString("utf-8").split("\n");
      const startLine = params.offset ? Math.max(0, params.offset - 1) : 0;
      if (startLine >= allLines.length) {
        throw new Error(`Offset ${params.offset} is beyond end of file (${allLines.length} lines total)`);
      }
      const selected = params.limit !== undefined
        ? allLines.slice(startLine, Math.min(startLine + params.limit, allLines.length)).join("\n")
        : allLines.slice(startLine).join("\n");
      const truncation = truncateHead(selected);
      let output = truncation.content;
      if (truncation.firstLineExceedsLimit) {
        output = `[Line ${startLine + 1} exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit]`;
      } else if (truncation.truncated) {
        const endLineDisplay = startLine + truncation.outputLines;
        output += `\n\n[Showing lines ${startLine + 1}-${endLineDisplay} of ${allLines.length}. Use offset=${endLineDisplay + 1} to continue.]`;
      } else if (params.limit !== undefined && startLine + params.limit < allLines.length) {
        output += `\n\n[${allLines.length - (startLine + params.limit)} more lines in file. Use offset=${startLine + params.limit + 1} to continue.]`;
      }
      return {
        content: [{ type: "text", text: output }],
        details: truncation.truncated ? { truncation } : undefined,
      };
    },
  };
}

export function createWriteTool(cwd: string, options: { operations: WriteOperations }): AgentTool {
  const parameters = Type.Object({
    path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
    content: Type.String({ description: "Content to write to the file" }),
  });
  return {
    name: "write",
    label: "write",
    description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters,
    async execute(_toolCallId, rawParams) {
      const params = rawParams as Static<typeof parameters>;
      const absolutePath = resolveToCwd(params.path, cwd);
      const dir = absolutePath.slice(0, absolutePath.lastIndexOf("/")) || "/";
      await options.operations.mkdir(dir);
      await options.operations.writeFile(absolutePath, params.content);
      return {
        content: [{ type: "text", text: `Successfully wrote ${params.content.length} bytes to ${params.path}` }],
        details: undefined,
      };
    },
  };
}

export function createEditTool(cwd: string, options: { operations: EditOperations }): AgentTool {
  const parameters = Type.Object({
    path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
    edits: Type.Array(Type.Object({
      oldText: Type.String({ description: "Text copied verbatim from a recent read result. Include real newlines and whitespace; do not use the two characters \\n for a newline. It must match one unique region in the current file." }),
      newText: Type.String({ description: "Literal replacement text for this targeted edit. Use an empty string to delete the match." }),
    }), { description: "One or more targeted replacements. All oldText values are checked against the same original file snapshot and must not overlap." }),
  });
  return {
    name: "edit",
    label: "edit",
    description: "Edit a file by applying targeted text replacements. Read the target file first and copy oldText verbatim, including whitespace, newlines, and escaping. Use enough surrounding context to make each oldText unique; do not guess file contents or use literal \\n where the file has a real newline. Nearby changes should be merged into one edit, and edits must not overlap.",
    parameters,
    async execute(_toolCallId, rawParams) {
      const params = rawParams as Static<typeof parameters>;
      const absolutePath = resolveToCwd(params.path, cwd);
      await options.operations.access(absolutePath);
      if (options.operations.applyEdits) {
        // Atomic read-apply-write in the sandbox: edits always apply to the
        // latest content, so concurrent edits compose instead of losing
        // updates.
        await options.operations.applyEdits(absolutePath, params.edits);
      } else {
        let content = (await options.operations.readFile(absolutePath)).toString("utf-8");
        content = applyEditsToContent(content, params.edits, params.path);
        await options.operations.writeFile(absolutePath, content);
      }
      return {
        content: [{ type: "text", text: `Applied ${params.edits.length} edit(s) to ${params.path}` }],
        details: undefined,
      };
    },
  };
}

function clampBashTimeout(timeout: number | undefined) {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) return undefined;
  return Math.min(Math.floor(timeout), MAX_RUN_COMMAND_TIMEOUT_SECONDS);
}

export function createBashTool(cwd: string, options: { operations: BashOperations }): AgentTool {
  const parameters = Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
  });
  type BashToolParams = Static<typeof parameters> & { run_in_background?: boolean };
  return {
    name: "bash",
    label: "bash",
    description: "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB.",
    parameters,
    async execute(_toolCallId, rawParams, signal, onUpdate) {
      const params = rawParams as BashToolParams;
      const timeout = clampBashTimeout(params.timeout);
      if (params.run_in_background) {
        if (!options.operations.startBackground) {
          throw new Error("Background bash execution is not available in this environment.");
        }
        const background = await options.operations.startBackground({
          command: params.command,
          cwd,
          signal,
          timeout,
          toolCallId: _toolCallId,
        });
        return {
          content: [{ type: "text", text: `Background bash command started.\n\nTask ID: ${background.taskRunId}\nYou will be notified when it completes.` }],
          details: { background: true, taskRunId: background.taskRunId },
        };
      }

      const chunks: Buffer[] = [];
      let outputPreview = "";
      const updates = createThrottledTextToolUpdate(onUpdate);
      const result = await options.operations.exec({
        command: params.command,
        cwd,
        onData: (chunk) => {
          chunks.push(chunk);
          outputPreview = tailText(`${outputPreview}${chunk.toString("utf-8")}`);
          updates.push(outputPreview);
        },
        signal,
        timeout,
      });
      updates.flush();

      if ("failure" in result) {
        return failureToolResult(result.failure);
      }

      const output = Buffer.concat(chunks).toString("utf-8");
      const termination = normalizeBashTermination(result);
      const note = formatBashTerminationNote(termination);
      const renderedOutput = note ? `${output}${output ? "\n\n" : ""}[${note}]` : output || "(no output)";
      const truncated = truncateHead(renderedOutput, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
      return {
        content: [{ type: "text", text: truncated.truncated ? truncated.content : renderedOutput }],
        details: {
          exitCode: result.exitCode,
          termination,
          rawOutput: renderedOutput,
          truncation: truncated.truncated ? truncated : undefined,
        },
      };
    },
  };
}

export function createLsTool(cwd: string, options: { operations: LsOperations }): AgentTool {
  const parameters = Type.Object({
    path: Type.String({ description: "Directory to list (default: current directory)" }),
    limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
  });
  return {
    name: "ls",
    label: "ls",
    description: "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories.",
    parameters,
    async execute(_toolCallId, rawParams) {
      const params = rawParams as Static<typeof parameters>;
      const absolutePath = resolveToCwd(params.path || ".", cwd);
      const entries = await options.operations.readdir(absolutePath);
      return {
        content: [{ type: "text", text: entries.slice(0, params.limit ?? 500).join("\n") }],
        details: undefined,
      };
    },
  };
}

export function createFindTool(cwd: string, options: { operations: FindOperations }): AgentTool {
  const parameters = Type.Object({
    path: Type.String({ description: "Directory to search in (default: current directory)" }),
    pattern: Type.String({ description: "Glob pattern to match files" }),
    limit: Type.Optional(Type.Number({ description: "Maximum number of results" })),
  });
  return {
    name: "find",
    label: "find",
    description: "Search for files by glob pattern. Respects .gitignore.",
    parameters,
    async execute(_toolCallId, rawParams, _signal, onUpdate) {
      const params = rawParams as Static<typeof parameters>;
      const absolutePath = resolveToCwd(params.path || ".", cwd);
      const result = await options.operations.glob(params.pattern, absolutePath, { limit: params.limit ?? 1000, onUpdate });
      const matches = Array.isArray(result) ? result : result.matches;
      const output = matches.join("\n");
      const text = !Array.isArray(result) && result.note
        ? output ? `${output}\n\n[${result.note}]` : `[${result.note}]`
        : output;
      return {
        content: [{ type: "text", text }],
        details: Array.isArray(result) ? undefined : result.details,
      };
    },
  };
}

export function createGrepToolDefinition(cwd: string): AgentTool {
  const parameters = Type.Object({
    pattern: Type.String({ description: "Search pattern" }),
    path: Type.Optional(Type.String({ description: "Directory or file to search" })),
    glob: Type.Optional(Type.String({ description: "File glob filter" })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
    literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string" })),
    context: Type.Optional(Type.Number({ description: "Context lines" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of matches" })),
  });
  return {
    name: "grep",
    label: "grep",
    description: "Search file contents for a pattern. Respects .gitignore.",
    parameters,
    async execute() {
      return { content: [{ type: "text", text: `grep not implemented for ${cwd} without override` }], details: undefined };
    },
  };
}
