import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { config } from "./config.js";
import type {
  SpaceFsEntry,
  SpaceFsFileResponse,
  SpaceFsMoveInput,
  SpaceFsTreeResponse,
  SpaceFsWriteFileInput,
} from "@cohub/protocol";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DIR_ENTRIES = 1000;

export class SpaceFsError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const mimeByExt: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".jsx": "text/jsx",
  ".svelte": "text/x-svelte",
  ".css": "text/css",
  ".scss": "text/x-scss",
  ".html": "text/html",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".ini": "text/plain",
  ".env": "text/plain",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".py": "text/x-python",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java-source",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++src",
  ".hpp": "text/x-c++hdr",
  ".sql": "application/sql",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

function getMimeType(path: string) {
  const lower = basename(path).toLowerCase();
  if (lower === "dockerfile") return "text/x-dockerfile";
  if (lower === "makefile") return "text/x-makefile";
  if (lower.startsWith(".env")) return "text/plain";
  return mimeByExt[extname(lower)] ?? null;
}

function isTextMime(mimeType: string | null) {
  if (!mimeType) return true;
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/yaml" ||
    mimeType === "application/toml" ||
    mimeType === "application/sql" ||
    mimeType === "application/x-ndjson"
  );
}

function ensureStorageConfigured() {
  if (!config.spaceStorageRoot) {
    throw new SpaceFsError(503, "space_storage_not_configured", "Space file storage is not configured.");
  }
}

function getSpaceRoot(spaceId: string) {
  ensureStorageConfigured();
  return resolve(config.spaceStorageRoot, spaceId, "workspace");
}

function assertSafeRelativePath(input: string, options?: { allowEmpty?: boolean }) {
  const value = String(input ?? "").replace(/\\/g, "/").trim();
  if (!value) {
    if (options?.allowEmpty) return "";
    throw new SpaceFsError(400, "path_invalid", "Invalid path.");
  }
  if (value.startsWith("/") || value.includes("\0")) {
    throw new SpaceFsError(400, "path_invalid", "Invalid path.");
  }
  return value;
}

async function resolveSpaceRealRoot(spaceId: string) {
  const root = getSpaceRoot(spaceId);
  try {
    const rootReal = await realpath(root);
    return { root, rootReal };
  } catch {
    throw new SpaceFsError(404, "space_not_found", "Space directory not found.");
  }
}

function assertInsideRoot(target: string, root: string) {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return;
  }
  throw new SpaceFsError(400, "path_invalid", "Invalid path.");
}

async function resolveTarget(spaceId: string, inputPath: string, options?: { allowEmpty?: boolean }) {
  const safePath = assertSafeRelativePath(inputPath, { allowEmpty: options?.allowEmpty });
  const { rootReal } = await resolveSpaceRealRoot(spaceId);
  const target = resolve(rootReal, safePath);
  assertInsideRoot(target, rootReal);
  return { root: rootReal, target, relativePath: safePath };
}

function toRelativePath(root: string, absPath: string) {
  return relative(root, absPath).replace(/\\/g, "/");
}

function entryType(stats: Awaited<ReturnType<typeof lstat>>): SpaceFsEntry["type"] {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "dir";
  return "file";
}

async function toEntry(root: string, absPath: string, name: string): Promise<SpaceFsEntry> {
  const stats = await lstat(absPath);
  const type = entryType(stats);
  return {
    name,
    path: toRelativePath(root, absPath),
    type,
    size: stats.size,
    mimeType: type === "file" ? getMimeType(name) : null,
    mtimeMs: stats.mtimeMs,
  };
}

export async function listSpaceDirectory(spaceId: string, path = ""): Promise<SpaceFsTreeResponse> {
  const { root, target, relativePath } = await resolveTarget(spaceId, path, { allowEmpty: true });
  let targetStats: Stats;
  try {
    targetStats = await lstat(target);
  } catch {
    throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
  }
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
    throw new SpaceFsError(400, "not_a_directory", "The selected path is not a directory.");
  }

  const names = await readdir(target);
  const limitedNames = names.slice(0, MAX_DIR_ENTRIES);
  const entries = await Promise.all(limitedNames.map((name) => toEntry(root, join(target, name), name)));

  entries.sort((a: SpaceFsEntry, b: SpaceFsEntry) => {
    const typeRank = (item: SpaceFsEntry) => item.type === "dir" ? 0 : item.type === "symlink" ? 1 : 2;
    return typeRank(a) - typeRank(b) || a.name.localeCompare(b.name);
  });

  return { path: relativePath, entries };
}

export async function readSpaceFile(spaceId: string, path: string): Promise<SpaceFsFileResponse> {
  const { target, relativePath } = await resolveTarget(spaceId, path);
  let stats: Stats;
  try {
    stats = await lstat(target);
  } catch {
    throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
  }
  if (stats.isSymbolicLink()) throw new SpaceFsError(400, "symlink_not_supported", "Symlink preview is not supported.");
  if (!stats.isFile()) throw new SpaceFsError(400, "not_a_file", "The selected path is not a file.");
  if (stats.size > MAX_FILE_BYTES) throw new SpaceFsError(413, "file_too_large", "This file is larger than 10MB and cannot be opened in the web viewer.");

  const buffer = await readFile(target);
  const mimeType = getMimeType(target);
  const kind = isTextMime(mimeType) ? "text" : "binary";
  return {
    path: relativePath,
    name: basename(target),
    size: stats.size,
    mimeType,
    mtimeMs: stats.mtimeMs,
    kind,
    encoding: kind === "text" ? "utf-8" : "base64",
    content: kind === "text" ? buffer.toString("utf8") : buffer.toString("base64"),
  };
}

export async function streamSpaceFile(spaceId: string, path: string): Promise<{ path: string; name: string; size: number; mimeType: string | null; target: string; }> {
  const { target, relativePath } = await resolveTarget(spaceId, path);
  let stats: Stats;
  try {
    stats = await lstat(target);
  } catch {
    throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
  }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new SpaceFsError(400, "not_a_file", "The selected path is not a file.");
  return { path: relativePath, name: basename(target), size: stats.size, mimeType: getMimeType(target), target };
}

export async function writeSpaceFile(spaceId: string, input: SpaceFsWriteFileInput) {
  const { target, relativePath } = await resolveTarget(spaceId, input.path);
  await mkdir(dirname(target), { recursive: true });
  const data = input.encoding === "base64" ? Buffer.from(input.content, "base64") : Buffer.from(input.content, "utf8");
  await writeFile(target, data);
  const file = await stat(target);
  return { path: relativePath, size: file.size, mtimeMs: file.mtimeMs };
}

export async function createSpaceDirectory(spaceId: string, path: string) {
  const { target, relativePath } = await resolveTarget(spaceId, path);
  await mkdir(target, { recursive: true });
  const info = await stat(target);
  return { path: relativePath, mtimeMs: info.mtimeMs };
}

export async function deleteSpaceNode(spaceId: string, path: string, recursive = false) {
  const { target, relativePath } = await resolveTarget(spaceId, path);
  try {
    await rm(target, { recursive, force: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
    if (code === "ENOTEMPTY") throw new SpaceFsError(400, "directory_not_empty", "Directory is not empty.");
    throw error;
  }
  return { path: relativePath, deleted: true };
}

export async function moveSpaceNode(spaceId: string, input: SpaceFsMoveInput) {
  const from = await resolveTarget(spaceId, input.fromPath);
  const to = await resolveTarget(spaceId, input.toPath);
  await mkdir(dirname(to.target), { recursive: true });
  await rename(from.target, to.target);
  return { fromPath: from.relativePath, toPath: to.relativePath };
}

export function spaceFsJsonError(error: unknown) {
  if (error instanceof SpaceFsError) {
    return { status: error.status, body: { code: error.code, message: error.message } };
  }
  const message = error instanceof Error ? error.message : "Space file operation failed.";
  return { status: 500, body: { code: "space_fs_error", message } };
}
