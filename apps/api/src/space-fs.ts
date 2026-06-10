
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  buildPreparingFile,
  buildUrlFileResponse,
  ensureFsCdnManifest,
  enqueueFsCdnWarmForMeta,
  getFreshFsCdnManifests,
  shouldUseFsCdnForMeta,
  waitForFsCdnManifests,
  type FsCdnFileMeta,
} from "./space-fs-cdn-cache.js";
import { FS_CDN_READ_MANY_WAIT_TIMEOUT_MS, FS_CDN_READ_WAIT_TIMEOUT_MS } from "./space-fs-cdn-constants.js";
import { config } from "./config.js";
import { createSpaceGitignoreFilter, type SpaceFsVisibility } from "./space-fs-ignore.js";
import type {
  SpaceFsEntry,
  SpaceFsFileResponse,
  SpaceFsMoveInput,
  SpaceFsReadFilesError,
  SpaceFsReadFilesResponse,
  SpaceFsPreparingFile,
  SpaceFsTreeResponse,
  SpaceFsUploadResponse,
  SpaceFsWriteFileInput,
} from "@cohub/protocol/fs";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BATCH_READ_FILES = 50;
const MAX_BATCH_READ_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_BATCH_READ_CONCURRENCY = 8;
const MAX_DIR_ENTRIES = 1000;
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;
const MAX_UPLOAD_COUNT = 20;
const MAX_DIRECTORY_EXPORT_FILES = 1000;
const MAX_DIRECTORY_EXPORT_TOTAL_BYTES = 100 * 1024 * 1024;

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
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".pdf": "application/pdf",
  ".exe": "application/x-msdownload",
  ".dmg": "application/x-apple-diskimage",
  ".deb": "application/vnd.debian.binary-package",
  ".rpm": "application/x-rpm",
};

export function getMimeType(path: string) {
  const lower = basename(path).toLowerCase();
  if (lower === "dockerfile") return "text/x-dockerfile";
  if (lower === "makefile") return "text/x-makefile";
  if (lower.startsWith(".env")) return "text/plain";
  return mimeByExt[extname(lower)] ?? null;
}

function isTextMime(mimeType: string | null) {
  if (!mimeType) return false;
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

function getSpaceBaseDir(spaceId: string) {
  ensureStorageConfigured();
  return resolve(config.spaceStorageRoot, spaceId);
}

export function getSpaceRoot(spaceId: string) {
  return resolve(getSpaceBaseDir(spaceId), "workspace");
}

export async function ensureSpaceWorkspaceReady(spaceId: string) {
  const spaceBaseDir = getSpaceBaseDir(spaceId);
  const workspaceDir = getSpaceRoot(spaceId);
  await mkdir(spaceBaseDir, { recursive: true, mode: 0o775 });
  await mkdir(workspaceDir, { recursive: true, mode: 0o775 });
  await Promise.all([
    chmod(spaceBaseDir, 0o775).catch(() => undefined),
    chmod(workspaceDir, 0o775).catch(() => undefined),
  ]);
  return { spaceBaseDir, workspaceDir };
}

export function assertSafeRelativePath(input: string, options?: { allowEmpty?: boolean }) {
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

export function assertInsideRoot(target: string, root: string) {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return;
  }
  throw new SpaceFsError(400, "path_invalid", "Invalid path.");
}

async function resolveTarget(
  spaceId: string,
  inputPath: string,
  options?: { allowEmpty?: boolean },
) {
  const safePath = assertSafeRelativePath(inputPath, { allowEmpty: options?.allowEmpty });
  const { rootReal } = await resolveSpaceRealRoot(spaceId);
  const target = resolve(rootReal, safePath);
  assertInsideRoot(target, rootReal);
  return { root: rootReal, target, relativePath: safePath };
}

async function assertVisiblePath(
  filter: Awaited<ReturnType<typeof createSpaceGitignoreFilter>> | null,
  relativePath: string,
  options?: { isDirectory?: boolean },
) {
  if (!filter || !relativePath) return;
  if (filter.isIgnored(relativePath, options)) {
    throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
  }
}

async function createVisibilityFilter(root: string, visibility: SpaceFsVisibility) {
  return visibility === "filtered" ? await createSpaceGitignoreFilter(root) : null;
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

export async function listSpaceDirectory(
  spaceId: string,
  path = "",
  options?: { visibility?: SpaceFsVisibility },
): Promise<SpaceFsTreeResponse> {
  const visibility = options?.visibility ?? "full";
  const { root, target, relativePath } = await resolveTarget(spaceId, path, { allowEmpty: true });
  let targetStats: Stats;
  try {
    targetStats = await lstat(target);
  } catch {
    throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
  }
  const filter = await createVisibilityFilter(root, visibility);
  await assertVisiblePath(filter, relativePath, { isDirectory: targetStats.isDirectory() });
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
    throw new SpaceFsError(400, "not_a_directory", "The selected path is not a directory.");
  }

  const names = await readdir(target);
  const entries = await Promise.all(
    names.slice(0, MAX_DIR_ENTRIES).map(async (name) => {
      const absPath = join(target, name);
      try {
        const entry = await toEntry(root, absPath, name);
        return filter?.isIgnored(entry.path, { isDirectory: entry.type === "dir" }) ? null : entry;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === "ENOENT") return null;
        throw error;
      }
    }),
  );

  const visibleEntries = entries.filter((entry): entry is SpaceFsEntry => entry !== null);

  visibleEntries.sort((a: SpaceFsEntry, b: SpaceFsEntry) => {
    const typeRank = (item: SpaceFsEntry) => item.type === "dir" ? 0 : item.type === "symlink" ? 1 : 2;
    return typeRank(a) - typeRank(b) || a.name.localeCompare(b.name);
  });

  return { path: relativePath, entries: visibleEntries };
}

async function readSpaceFileMetadata(
  spaceId: string,
  path: string,
  options?: { enforcePreviewLimit?: boolean; visibility?: SpaceFsVisibility },
) {
  const { root, target, relativePath } = await resolveTarget(spaceId, path);
  let stats: Stats;
  try {
    stats = await lstat(target);
  } catch {
    throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
  }
  await assertVisiblePath(await createVisibilityFilter(root, options?.visibility ?? "full"), relativePath, {
    isDirectory: stats.isDirectory(),
  });
  if (stats.isSymbolicLink()) throw new SpaceFsError(400, "symlink_not_supported", "Symlink preview is not supported.");
  if (!stats.isFile()) throw new SpaceFsError(400, "not_a_file", "The selected path is not a file.");
  if (options?.enforcePreviewLimit !== false && stats.size > MAX_FILE_BYTES) {
    throw new SpaceFsError(413, "file_too_large", "This file is larger than 10MB and cannot be opened in the web viewer.");
  }
  return { target, relativePath, stats };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function toReadFilesError(path: string, error: unknown): SpaceFsReadFilesError {
  if (error instanceof SpaceFsError) {
    return { path, code: error.code, message: error.message, status: error.status };
  }
  const message = error instanceof Error ? error.message : "Failed to read file.";
  return { path, code: "space_fs_error", message, status: 500 };
}

function toFsCdnMeta(spaceId: string, target: string, relativePath: string, stats: Stats, mimeType: string | null): FsCdnFileMeta {
  return {
    spaceId,
    path: relativePath,
    name: basename(target),
    size: stats.size,
    mimeType,
    mtimeMs: stats.mtimeMs,
  };
}

function toInlineFileResponse(target: string, relativePath: string, stats: Stats, buffer: Buffer, mimeType: string | null): SpaceFsFileResponse {
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
    delivery: "inline",
  };
}

export async function readSpaceFile(
  spaceId: string,
  path: string,
  options?: { visibility?: SpaceFsVisibility },
): Promise<SpaceFsFileResponse | SpaceFsPreparingFile> {
  const { target, relativePath, stats } = await readSpaceFileMetadata(spaceId, path, {
    enforcePreviewLimit: false,
    visibility: options?.visibility,
  });
  const mimeType = getMimeType(target);
  const cdnMeta = toFsCdnMeta(spaceId, target, relativePath, stats, mimeType);
  if (shouldUseFsCdnForMeta(cdnMeta)) {
    const manifest = await ensureFsCdnManifest(cdnMeta, "read_miss", FS_CDN_READ_WAIT_TIMEOUT_MS);
    if (manifest) return buildUrlFileResponse(cdnMeta, manifest);
    return buildPreparingFile(cdnMeta);
  }

  if (stats.size > MAX_FILE_BYTES) {
    throw new SpaceFsError(413, "file_too_large", "This file is larger than 10MB and cannot be opened in the web viewer.");
  }
  const buffer = await readFile(target);
  return toInlineFileResponse(target, relativePath, stats, buffer, mimeType);
}

export type SpaceFsDirectoryFile = {
  path: string;
  relativePath: string;
  size: number;
  mimeType: string | null;
  content: Buffer;
};

export async function readSpaceDirectoryFiles(
  spaceId: string,
  path: string,
  options?: { visibility?: SpaceFsVisibility },
): Promise<{ path: string; files: SpaceFsDirectoryFile[] }> {
  const { root, target, relativePath } = await resolveTarget(spaceId, path, { allowEmpty: true });
  let targetStats: Stats;
  try {
    targetStats = await lstat(target);
  } catch {
    throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
  }
  const filter = await createVisibilityFilter(root, options?.visibility ?? "full");
  await assertVisiblePath(filter, relativePath, { isDirectory: targetStats.isDirectory() });
  if (targetStats.isSymbolicLink()) throw new SpaceFsError(400, "symlink_not_supported", "Symlink export is not supported.");
  if (!targetStats.isDirectory()) throw new SpaceFsError(400, "not_a_directory", "The selected path is not a directory.");

  const files: SpaceFsDirectoryFile[] = [];
  let totalBytes = 0;

  const walk = async (dir: string) => {
    const names = await readdir(dir);
    names.sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const absPath = join(dir, name);
      const stats = await lstat(absPath);
      const filePath = toRelativePath(root, absPath);
      await assertVisiblePath(filter, filePath, { isDirectory: stats.isDirectory() });
      if (stats.isSymbolicLink()) throw new SpaceFsError(400, "symlink_not_supported", "Symlink export is not supported.");
      if (stats.isDirectory()) {
        await walk(absPath);
        continue;
      }
      if (!stats.isFile()) continue;
      if (files.length >= MAX_DIRECTORY_EXPORT_FILES) {
        throw new SpaceFsError(413, "directory_too_many_files", `Cannot publish more than ${MAX_DIRECTORY_EXPORT_FILES} files from a directory.`);
      }
      totalBytes += stats.size;
      if (totalBytes > MAX_DIRECTORY_EXPORT_TOTAL_BYTES) {
        throw new SpaceFsError(413, "directory_too_large", "Directory publish size exceeds 100MB.");
      }
      const relativeFilePath = relative(target, absPath).replace(/\\/g, "/");
      files.push({
        path: filePath,
        relativePath: relativeFilePath,
        size: stats.size,
        mimeType: getMimeType(absPath),
        content: await readFile(absPath),
      });
    }
  };

  await walk(target);
  return { path: relativePath, files };
}

export async function readSpaceFiles(
  spaceId: string,
  paths: string[],
  options?: { visibility?: SpaceFsVisibility },
): Promise<SpaceFsReadFilesResponse> {
  if (paths.length === 0) throw new SpaceFsError(400, "paths_required", "paths are required.");
  if (paths.length > MAX_BATCH_READ_FILES) {
    throw new SpaceFsError(413, "too_many_files", `Cannot read more than ${MAX_BATCH_READ_FILES} files at once.`);
  }
  const seenPaths = new Set<string>();
  for (const path of paths) {
    if (typeof path !== "string" || !path) throw new SpaceFsError(400, "path_invalid", "Every path must be a non-empty string.");
    if (seenPaths.has(path)) throw new SpaceFsError(400, "duplicate_path", "Duplicate paths are not allowed.");
    seenPaths.add(path);
  }

  const metadataResults = await mapWithConcurrency(paths, MAX_BATCH_READ_CONCURRENCY, async (path) => {
    try {
      return {
        ok: true as const,
        path,
        metadata: await readSpaceFileMetadata(spaceId, path, {
          enforcePreviewLimit: false,
          visibility: options?.visibility,
        }),
      };
    } catch (error) {
      return { ok: false as const, path, error: toReadFilesError(path, error) };
    }
  });

  const readableResults = metadataResults.filter((result) => result.ok);
  const cdnItems: Array<{ target: string; relativePath: string; stats: Stats; meta: FsCdnFileMeta }> = [];
  const inlineItems: Array<{ target: string; relativePath: string; stats: Stats; mimeType: string | null }> = [];

  for (const result of readableResults) {
    const { target, relativePath, stats } = result.metadata;
    const mimeType = getMimeType(target);
    const meta = toFsCdnMeta(spaceId, target, relativePath, stats, mimeType);
    if (shouldUseFsCdnForMeta(meta)) {
      cdnItems.push({ target, relativePath, stats, meta });
    } else {
      inlineItems.push({ target, relativePath, stats, mimeType });
    }
  }

  const inlineTotalBytes = inlineItems.reduce((sum, item) => sum + item.stats.size, 0);
  if (inlineTotalBytes > MAX_BATCH_READ_TOTAL_BYTES) {
    throw new SpaceFsError(413, "batch_too_large", "Total inline file size exceeds 20MB.");
  }

  const files: SpaceFsFileResponse[] = [];
  const preparing: SpaceFsPreparingFile[] = [];
  const errors = metadataResults.filter((result) => !result.ok).map((result) => result.error);

  const initialManifests = await getFreshFsCdnManifests(cdnItems.map((item) => item.meta));
  const missingCdnItems = cdnItems.filter((item) => {
    const manifest = initialManifests.get(item.meta.path);
    if (manifest) {
      files.push(buildUrlFileResponse(item.meta, manifest));
      return false;
    }
    return true;
  });

  await Promise.allSettled(
    missingCdnItems.map(async (item) => {
      try {
        await enqueueFsCdnWarmForMeta(item.meta, "read_many_miss");
      } catch (error) {
        errors.push(toReadFilesError(item.meta.path, error));
      }
    }),
  );

  const enqueuedCdnItems = missingCdnItems.filter((item) => !errors.some((error) => error.path === item.meta.path));
  const waited = await waitForFsCdnManifests(enqueuedCdnItems.map((item) => item.meta), FS_CDN_READ_MANY_WAIT_TIMEOUT_MS);
  for (const item of enqueuedCdnItems) {
    const manifest = waited.ready.get(item.meta.path);
    if (manifest) files.push(buildUrlFileResponse(item.meta, manifest));
  }
  for (const item of waited.pending) preparing.push(buildPreparingFile(item));

  const inlineFiles = await mapWithConcurrency(inlineItems, MAX_BATCH_READ_CONCURRENCY, async (item) => {
    const buffer = await readFile(item.target);
    return toInlineFileResponse(item.target, item.relativePath, item.stats, buffer, item.mimeType);
  });
  files.push(...inlineFiles);

  return { files, preparing, errors };
}

export async function streamSpaceFile(
  spaceId: string,
  path: string,
  options?: { visibility?: SpaceFsVisibility },
): Promise<{ path: string; name: string; size: number; mimeType: string | null; mtimeMs: number; target: string; }> {
  const { root, target, relativePath } = await resolveTarget(spaceId, path);
  let stats: Stats;
  try {
    stats = await lstat(target);
  } catch {
    throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
  }
  await assertVisiblePath(await createVisibilityFilter(root, options?.visibility ?? "full"), relativePath, {
    isDirectory: stats.isDirectory(),
  });
  if (!stats.isFile() || stats.isSymbolicLink()) throw new SpaceFsError(400, "not_a_file", "The selected path is not a file.");
  return { path: relativePath, name: basename(target), size: stats.size, mimeType: getMimeType(target), mtimeMs: stats.mtimeMs, target };
}

export async function writeSpaceFile(spaceId: string, input: SpaceFsWriteFileInput) {
  const { target, relativePath } = await resolveTarget(spaceId, input.path);
  await mkdir(dirname(target), { recursive: true });
  const data = input.encoding === "base64" ? Buffer.from(input.content, "base64") : Buffer.from(input.content, "utf8");
  await writeFile(target, data);
  const file = await stat(target);
  return { path: relativePath, size: file.size, mtimeMs: file.mtimeMs };
}

export async function createSpaceFileExclusive(spaceId: string, input: SpaceFsWriteFileInput) {
  const { target, relativePath } = await resolveTarget(spaceId, input.path);
  await mkdir(dirname(target), { recursive: true });
  const data = input.encoding === "base64" ? Buffer.from(input.content, "base64") : Buffer.from(input.content, "utf8");
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(target, "wx");
    await handle.writeFile(data);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "EEXIST") throw new SpaceFsError(409, "path_exists", "A file already exists at this path.");
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const file = await stat(target);
  return { path: relativePath, size: file.size, mtimeMs: file.mtimeMs };
}

export async function createSpaceDirectory(spaceId: string, path: string) {
  const { target, relativePath } = await resolveTarget(spaceId, path);
  await mkdir(target, { recursive: true });
  const info = await stat(target);
  return { path: relativePath, mtimeMs: info.mtimeMs };
}

export const deleteSpaceNode = async (spaceId: string, path: string, recursive = false) => {
  const { target, relativePath } = await resolveTarget(spaceId, path);
  let nodeType: SpaceFsEntry["type"] | "unknown" = "unknown";
  try {
    const before = await lstat(target);
    nodeType = entryType(before);
    await rm(target, { recursive, force: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") throw new SpaceFsError(404, "path_not_found", "File or directory not found.");
    if (code === "ENOTEMPTY") throw new SpaceFsError(400, "directory_not_empty", "Directory is not empty.");
    throw error;
  }
  return { path: relativePath, deleted: true, nodeType };
}

export async function moveSpaceNode(spaceId: string, input: SpaceFsMoveInput) {
  const from = await resolveTarget(spaceId, input.fromPath);
  const to = await resolveTarget(spaceId, input.toPath);
  await mkdir(dirname(to.target), { recursive: true });
  await rename(from.target, to.target);
  return { fromPath: from.relativePath, toPath: to.relativePath };
}

export function sanitizeFileName(name: string): string | null {
  const cleaned = name
    .replace(/[<>:"/\\|?*]/g, "")
    .split("")
    .filter((c) => c.charCodeAt(0) > 0x1f)
    .join("")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 255);
  return cleaned || null;
}

export async function uploadSpaceFiles(
  spaceId: string,
  files: File[],
  targetDir: string,
): Promise<SpaceFsUploadResponse> {
  const { workspaceDir } = await ensureSpaceWorkspaceReady(spaceId);
  const dir = targetDir ? resolve(workspaceDir, targetDir) : workspaceDir;
  assertInsideRoot(dir, workspaceDir);
  await mkdir(dir, { recursive: true });

  const uploaded: SpaceFsUploadResponse["uploaded"] = [];
  const errors: SpaceFsUploadResponse["errors"] = [];

  for (const file of files.slice(0, MAX_UPLOAD_COUNT)) {
    const safeName = sanitizeFileName(file.name);
    if (!safeName) {
      errors.push({ name: file.name, code: "name_invalid", message: "invalid file name" });
      continue;
    }
    if (file.size > MAX_UPLOAD_SIZE) {
      errors.push({ name: safeName, code: "file_too_large", message: "file exceeds 50MB limit" });
      continue;
    }
    const targetPath = join(dir, safeName);
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      await writeFile(targetPath, buffer);
      const stats = await stat(targetPath);
      uploaded.push({
        path: targetDir ? `${targetDir}/${safeName}` : safeName,
        name: safeName,
        size: stats.size,
        mimeType: getMimeType(safeName),
        mtimeMs: stats.mtimeMs,
      });
    } catch {
      errors.push({ name: safeName, code: "write_failed", message: "failed to write file" });
    }
  }

  return { uploaded, errors };
}

export function spaceFsJsonError(error: unknown) {
  if (error instanceof SpaceFsError) {
    return { status: error.status, body: { code: error.code, message: error.message.toLowerCase().replace(/\.$/, "") } };
  }
  return { status: 500, body: { code: "space_fs_error", message: "space file operation failed" } };
}
