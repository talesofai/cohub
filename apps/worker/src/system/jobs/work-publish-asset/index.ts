import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  collectLocalPageAssetRefs,
  extractHtmlPageMeta,
  fillIconFromSiteFiles,
  normalizeLocalPageAssetRef,
} from "@cohub/core/works";
import {
  BOARD_EXTENSION,
  BOARD_MIME_TYPE,
  isBoardPath,
  parseBoardManifest,
  type BoardSnapshot,
  type WorkBoardArtifactManifest,
  type WorkBoardAsset,
} from "@cohub/protocol";
import type { Job } from "bullmq";
import { captureBoardSnapshots } from "../../../checkpoint/board-snapshot.js";
import { config } from "../../../config.js";
import { registerSystemJob } from "../../registry.js";
import {
  WORK_PUBLISH_ASSET_JOB,
  type WorkPublishAssetJobData,
  type WorkPublishAssetJobResult,
  type WorkPublishExtractedPageMeta,
} from "./types.js";

const MAX_WORK_SITE_BYTES = 1024 * 1024 * 1024;
const MAX_WORK_SITE_FILES = 1000;
const WORK_HTML_METADATA_MAX_BYTES = 5 * 1024 * 1024;
/** Companion icon/image files packed next to a single-file HTML publish. */
const MAX_WORK_PAGE_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_WORK_PAGE_ASSET_FILES = 8;
const WORK_SITE_UPLOAD_CONCURRENCY = 8;
const WORK_FILE_UPLOAD_CONCURRENCY = 2;
const WORK_MULTIPART_PART_BYTES = 16 * 1024 * 1024;
const IMMUTABLE_PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";
const OPEN_READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const PAGE_ASSET_EXT = new Set([
  ".ico",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
]);

class WorkPublishAssetError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
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
  [BOARD_EXTENSION]: BOARD_MIME_TYPE,
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

type WorkSiteFile = {
  relativePath: string;
  content: Buffer;
  mimeType: string | null;
};

type WorkSourceFile = {
  root: string;
  absolutePath: string;
  relativePath: string;
  name: string;
  size: number;
  mimeType: string | null;
};

let s3Client: S3Client | null = null;

function getStorage() {
  return {
    endpoint: config.publicAssetOssEndpoint,
    region: config.publicAssetOssRegion,
    bucket: config.publicAssetOssBucket,
    accessKeyId: config.publicAssetOssAccessKeyId,
    secretAccessKey: config.publicAssetOssSecretAccessKey,
  };
}

function requireStorage() {
  const storage = getStorage();
  if (!storage.bucket || !storage.endpoint || !storage.accessKeyId || !storage.secretAccessKey) {
    throw new WorkPublishAssetError(500, "work asset storage is not configured");
  }
  return {
    ...storage,
    bucket: storage.bucket,
    endpoint: storage.endpoint,
    accessKeyId: storage.accessKeyId,
    secretAccessKey: storage.secretAccessKey,
  };
}

function getS3Client() {
  const storage = requireStorage();
  s3Client ??= new S3Client({
    endpoint: storage.endpoint,
    region: storage.region,
    forcePathStyle: false,
    credentials: {
      accessKeyId: storage.accessKeyId,
      secretAccessKey: storage.secretAccessKey,
    },
  });
  return s3Client;
}

const cacheBuster = () => randomUUID().replaceAll("-", "").slice(0, 12);
const envPrefix = () => (config.env === "prod" ? "" : `${config.env}/`);
const buildWorkAssetPrefix = (input: { spaceId: string; workSlug: string }) => `${envPrefix()}w/${input.spaceId}/${input.workSlug}/${cacheBuster()}`;

function getMimeType(path: string) {
  const lower = basename(path).toLowerCase();
  if (lower === "dockerfile") return "text/x-dockerfile";
  if (lower === "makefile") return "text/x-makefile";
  return mimeByExt[extname(lower)] ?? (lower.startsWith(".") ? "text/plain" : null);
}

function assertSafeRelativePath(input: string, options?: { allowEmpty?: boolean }) {
  const value = String(input ?? "").replace(/\\/g, "/").trim();
  if (!value) {
    if (options?.allowEmpty) return "";
    throw new WorkPublishAssetError(400, "invalid path", "path_invalid");
  }
  if (value.startsWith("/") || value.includes("\0")) throw new WorkPublishAssetError(400, "invalid path", "path_invalid");
  return value;
}

function assertInsideRoot(target: string, root: string) {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new WorkPublishAssetError(400, "invalid path", "path_invalid");
}

async function resolveTarget(spaceId: string, inputPath: string, options?: { allowEmpty?: boolean }) {
  if (!config.spaceStorageRoot) throw new WorkPublishAssetError(503, "Space file storage is not configured.", "space_storage_not_configured");
  const safePath = assertSafeRelativePath(inputPath, { allowEmpty: options?.allowEmpty });
  const root = await realpath(resolve(config.spaceStorageRoot, spaceId, "workspace")).catch(() => {
    throw new WorkPublishAssetError(404, "space directory not found", "space_not_found");
  });
  const target = resolve(root, safePath);
  assertInsideRoot(target, root);
  return { root, target, relativePath: safePath };
}

async function openVerifiedFile(path: string, root: string) {
  const realPath = await realpath(path).catch(() => {
    throw new WorkPublishAssetError(404, "File or directory not found.", "path_not_found");
  });
  assertInsideRoot(realPath, root);
  return open(realPath, OPEN_READ_NOFOLLOW).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP") {
      throw new WorkPublishAssetError(400, "Symlink export is not supported.", "symlink_not_supported");
    }
    throw error;
  });
}

async function readWorkFile(spaceId: string, path: string): Promise<WorkSourceFile> {
  const { root, target, relativePath } = await resolveTarget(spaceId, path);
  const pathStats = await lstat(target).catch(() => {
    throw new WorkPublishAssetError(404, "file not found", "path_not_found");
  });
  if (pathStats.isSymbolicLink()) throw new WorkPublishAssetError(400, "Symlink preview is not supported.", "symlink_not_supported");
  if (!pathStats.isFile()) throw new WorkPublishAssetError(400, "The selected path is not a file.", "not_a_file");

  const handle = await openVerifiedFile(target, root);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new WorkPublishAssetError(400, "The selected path is not a file.", "not_a_file");
    if (stats.size <= 0 || stats.size > MAX_WORK_SITE_BYTES) {
      throw new WorkPublishAssetError(413, "File publish size must be between 1 byte and 1GiB.", "file_too_large");
    }
    return {
      root,
      absolutePath: target,
      relativePath,
      name: basename(relativePath),
      size: stats.size,
      mimeType: getMimeType(relativePath),
    };
  } finally {
    await handle.close();
  }
}

async function readWorkHtmlFile(spaceId: string, path: string) {
  const file = await readWorkFile(spaceId, path);
  const prepared = await prepareWorkFile(file, WORK_HTML_METADATA_MAX_BYTES);
  const html = prepared.prefix?.toString("utf8") ?? "";
  const htmlDir = await realpath(resolve(file.absolutePath, "..")).catch(() => null);
  if (!htmlDir) return { file, prepared, html, companions: [] as WorkSiteFile[] };
  assertInsideRoot(htmlDir, file.root);
  const companions = await readWorkPageCompanionAssets({
    root: file.root,
    htmlDir,
    html,
  });
  return { file, prepared, html, companions };
}

async function readOptionalWorkspaceFile(input: {
  root: string;
  absPath: string;
  maxBytes: number;
}): Promise<Buffer | null> {
  const pathStats = await lstat(input.absPath).catch(() => null);
  if (!pathStats || pathStats.isSymbolicLink() || !pathStats.isFile()) return null;
  if (pathStats.size <= 0 || pathStats.size > input.maxBytes) return null;
  const handle = await openVerifiedFile(input.absPath, input.root).catch(() => null);
  if (!handle) return null;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size <= 0 || stats.size > input.maxBytes) return null;
    return handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Pack local icon/image refs next to a single HTML file so shell/OG URLs resolve on CDN.
 * Missing companions are skipped; publish still succeeds with title/description.
 */
async function readWorkPageCompanionAssets(input: {
  root: string;
  htmlDir: string;
  html: string;
}): Promise<WorkSiteFile[]> {
  const page = extractHtmlPageMeta(input.html);
  const candidates = collectLocalPageAssetRefs(page);
  const files: WorkSiteFile[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (files.length >= MAX_WORK_PAGE_ASSET_FILES) break;
    const relativePath = normalizeLocalPageAssetRef(candidate);
    if (!relativePath) continue;
    const key = relativePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const ext = extname(relativePath).toLowerCase();
    if (!PAGE_ASSET_EXT.has(ext)) continue;

    const absPath = resolve(input.htmlDir, relativePath);
    // Keep companions next to the HTML entry (same publish prefix layout).
    const relToHtmlDir = relative(input.htmlDir, absPath).replace(/\\/g, "/");
    if (
      !relToHtmlDir ||
      relToHtmlDir.startsWith("../") ||
      isAbsolute(relToHtmlDir) ||
      relToHtmlDir.includes("\0")
    ) {
      continue;
    }
    try {
      assertInsideRoot(absPath, input.root);
      assertInsideRoot(absPath, input.htmlDir);
    } catch {
      continue;
    }

    const content = await readOptionalWorkspaceFile({
      root: input.root,
      absPath,
      maxBytes: MAX_WORK_PAGE_ASSET_BYTES,
    });
    if (!content) continue;
    files.push({
      relativePath: relToHtmlDir,
      content,
      mimeType: getMimeType(relToHtmlDir),
    });
  }

  return files;
}

async function readWorkDirectoryFiles(spaceId: string, path: string) {
  const { root, target, relativePath } = await resolveTarget(spaceId, path, { allowEmpty: true });
  const targetStats = await lstat(target).catch(() => {
    throw new WorkPublishAssetError(404, "File or directory not found.", "path_not_found");
  });
  if (targetStats.isSymbolicLink()) throw new WorkPublishAssetError(400, "Symlink export is not supported.", "symlink_not_supported");
  if (!targetStats.isDirectory()) throw new WorkPublishAssetError(400, "The selected path is not a directory.", "not_a_directory");
  const realTarget = await realpath(target).catch(() => {
    throw new WorkPublishAssetError(404, "File or directory not found.", "path_not_found");
  });
  assertInsideRoot(realTarget, root);

  const files: WorkSourceFile[] = [];
  let totalBytes = 0;

  async function walk(dir: string) {
    const names = await readdir(dir);
    names.sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const absPath = resolve(dir, name);
      assertInsideRoot(absPath, root);
      const pathStats = await lstat(absPath);
      if (pathStats.isSymbolicLink()) throw new WorkPublishAssetError(400, "Symlink export is not supported.", "symlink_not_supported");
      if (pathStats.isDirectory()) {
        const realDir = await realpath(absPath);
        assertInsideRoot(realDir, root);
        assertInsideRoot(realDir, realTarget);
        await walk(realDir);
        continue;
      }
      if (!pathStats.isFile()) continue;
      if (files.length >= MAX_WORK_SITE_FILES) {
        throw new WorkPublishAssetError(413, `Cannot publish more than ${MAX_WORK_SITE_FILES} files from a directory.`, "directory_too_many_files");
      }

      const handle = await openVerifiedFile(absPath, root);
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) throw new WorkPublishAssetError(400, "The selected path is not a file.", "not_a_file");
        totalBytes += stats.size;
        if (totalBytes > MAX_WORK_SITE_BYTES) throw new WorkPublishAssetError(413, "Directory publish size exceeds 1GiB.", "directory_too_large");
        const relativePath = relative(realTarget, absPath).replace(/\\/g, "/");
        files.push({
          root,
          absolutePath: absPath,
          relativePath,
          name: basename(relativePath),
          size: stats.size,
          mimeType: getMimeType(absPath),
        });
      } finally {
        await handle.close();
      }
    }
  }

  await walk(realTarget);
  return { path: relativePath, files };
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, mapper: (item: T) => Promise<void>) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await mapper(items[index] as T);
    }
  });
  await Promise.all(workers);
}

async function putWorkAssetObject(input: { objectKey: string; body: Buffer | string; contentType: string; sha256: string }) {
  await getS3Client().send(new PutObjectCommand({
    Bucket: requireStorage().bucket,
    Key: input.objectKey,
    Body: input.body,
    ContentType: input.contentType,
    CacheControl: IMMUTABLE_PUBLIC_CACHE_CONTROL,
    Metadata: { sha256: input.sha256 },
  }));
}

type FileSnapshot = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
};

const fileSnapshot = (stats: Stats): FileSnapshot => ({
  size: stats.size,
  mtimeMs: stats.mtimeMs,
  ctimeMs: stats.ctimeMs,
  ino: stats.ino,
});

const sameFileSnapshot = (left: FileSnapshot, right: FileSnapshot) =>
  left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.ino === right.ino;

async function hashOpenFile(handle: Awaited<ReturnType<typeof open>>, prefixBytes = 0) {
  const hash = createHash("sha256");
  const prefixChunks: Buffer[] = [];
  let prefixRemaining = prefixBytes;
  for await (const rawChunk of handle.createReadStream({ start: 0, autoClose: false })) {
    const chunk = rawChunk as Buffer;
    hash.update(chunk);
    if (prefixRemaining <= 0) continue;
    const captured = chunk.subarray(0, prefixRemaining);
    prefixChunks.push(Buffer.from(captured));
    prefixRemaining -= captured.length;
  }
  return {
    sha256: hash.digest("hex"),
    prefix: prefixBytes > 0 ? Buffer.concat(prefixChunks) : null,
  };
}

type PreparedWorkFile = {
  snapshot: FileSnapshot;
  sha256: string;
  prefix: Buffer | null;
};

async function prepareWorkFile(file: WorkSourceFile, prefixBytes = 0): Promise<PreparedWorkFile> {
  const handle = await openVerifiedFile(file.absolutePath, file.root);
  try {
    const snapshot = fileSnapshot(await handle.stat());
    if (snapshot.size !== file.size) throw new WorkPublishAssetError(409, "Source file changed during publish.", "source_changed");
    const prepared = await hashOpenFile(handle, prefixBytes);
    if (!sameFileSnapshot(snapshot, fileSnapshot(await handle.stat()))) {
      throw new WorkPublishAssetError(409, "Source file changed during publish.", "source_changed");
    }
    return { snapshot, ...prepared };
  } finally {
    await handle.close();
  }
}

async function putWorkFileObject(input: {
  objectKey: string;
  file: WorkSourceFile;
  contentType: string;
  prepared?: PreparedWorkFile;
}) {
  const prepared = input.prepared ?? await prepareWorkFile(input.file);
  const handle = await openVerifiedFile(input.file.absolutePath, input.file.root);
  let uploaded = false;
  try {
    if (!sameFileSnapshot(prepared.snapshot, fileSnapshot(await handle.stat()))) {
      throw new WorkPublishAssetError(409, "Source file changed during publish.", "source_changed");
    }

    const uploadedHash = createHash("sha256");
    const body = handle.createReadStream({ start: 0, autoClose: false }).pipe(
      new Transform({
        transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
          uploadedHash.update(chunk);
          callback(null, chunk);
        },
      }),
    );
    const storage = requireStorage();
    const upload = new Upload({
      client: getS3Client(),
      params: {
        Bucket: storage.bucket,
        Key: input.objectKey,
        Body: body,
        ContentLength: prepared.snapshot.size,
        ContentType: input.contentType,
        CacheControl: IMMUTABLE_PUBLIC_CACHE_CONTROL,
        Metadata: { sha256: prepared.sha256 },
      },
      queueSize: 2,
      partSize: WORK_MULTIPART_PART_BYTES,
      leavePartsOnError: false,
    });
    await upload.done();
    uploaded = true;

    if (uploadedHash.digest("hex") !== prepared.sha256) {
      throw new WorkPublishAssetError(409, "Source file changed during publish.", "source_changed");
    }
    if (!sameFileSnapshot(prepared.snapshot, fileSnapshot(await handle.stat()))) {
      throw new WorkPublishAssetError(409, "Source file changed during publish.", "source_changed");
    }
    return { sha256: prepared.sha256, size: prepared.snapshot.size };
  } catch (error) {
    if (uploaded) {
      const storage = requireStorage();
      await getS3Client().send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: input.objectKey })).catch(() => undefined);
    }
    throw error;
  } finally {
    await handle.close();
  }
}

async function readWorkFilePrefix(file: WorkSourceFile, maxBytes = WORK_HTML_METADATA_MAX_BYTES) {
  const handle = await openVerifiedFile(file.absolutePath, file.root);
  try {
    const length = Math.min(file.size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function workFileTailIsWhitespace(file: WorkSourceFile, start: number) {
  if (start >= file.size) return true;
  const handle = await openVerifiedFile(file.absolutePath, file.root);
  try {
    for await (const chunk of handle.createReadStream({ start, autoClose: false })) {
      if ((chunk as Buffer).some((byte) => byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20)) return false;
    }
    return true;
  } finally {
    await handle.close();
  }
}

function isAbsoluteHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function normalizeSitePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
}

function keepSiteAssetRef(ref: string | null, available: Set<string>): string | null {
  if (!ref) return null;
  // Inline icons and absolute URLs are fine for any target type.
  if (/^data:image\//i.test(ref)) return ref;
  if (isAbsoluteHttpUrl(ref) || ref.startsWith("//")) return ref;
  const cleaned = ref.replace(/^\.\//, "").replace(/^\/+/, "");
  // Relative assets only survive when the publish uploaded that file
  // (directory sites / companions). Missing siblings stay null — do not invent URLs.
  return available.has(normalizeSitePath(cleaned)) ? cleaned : null;
}

function extractPageMetaFromHtml(
  html: string,
  sourcePath: string,
  relativePaths: Iterable<string> = [],
): WorkPublishExtractedPageMeta {
  const paths = Array.from(relativePaths);
  const available = new Set(paths.map((path) => normalizeSitePath(path)));
  const page = fillIconFromSiteFiles(extractHtmlPageMeta(html), paths);
  return {
    title: page.title,
    description: page.description,
    icon: keepSiteAssetRef(page.icon, available),
    image: keepSiteAssetRef(page.image, available),
    lang: page.lang,
    themeColor: page.themeColor,
    sourcePath,
  };
}

async function writeWorkHtmlAsset(input: {
  spaceId: string;
  workSlug: string;
  file: WorkSourceFile;
  prepared: PreparedWorkFile;
  html: string;
  companions?: WorkSiteFile[];
}) {
  const companions = input.companions ?? [];
  const companionBytes = companions.reduce((sum, file) => sum + file.content.byteLength, 0);
  const sizeBytes = input.file.size + companionBytes;
  if (sizeBytes > MAX_WORK_SITE_BYTES) throw new WorkPublishAssetError(413, "HTML publish size exceeds 1GiB.", "file_too_large");

  const prefix = buildWorkAssetPrefix({ spaceId: input.spaceId, workSlug: input.workSlug });
  const objectKey = `${prefix}/index.html`;
  await putWorkFileObject({
    objectKey,
    file: input.file,
    prepared: input.prepared,
    contentType: "text/html; charset=utf-8",
  });
  await mapWithConcurrency(companions, WORK_SITE_UPLOAD_CONCURRENCY, async (file) => {
    await putWorkAssetObject({
      objectKey: `${prefix}/${file.relativePath}`,
      body: file.content,
      contentType: file.mimeType ?? "application/octet-stream",
      sha256: createHash("sha256").update(file.content).digest("hex"),
    });
  });

  const uploadedPaths = ["index.html", ...companions.map((file) => file.relativePath)];
  return {
    assetKey: objectKey,
    sizeBytes,
    fileCount: uploadedPaths.length,
    extracted: extractPageMetaFromHtml(input.html, "index.html", uploadedPaths),
  };
}

async function writeWorkSiteAssets(input: { spaceId: string; workSlug: string; files: WorkSourceFile[] }) {
  if (input.files.length <= 0 || input.files.length > MAX_WORK_SITE_FILES) {
    throw new WorkPublishAssetError(400, `work site must contain 1 to ${MAX_WORK_SITE_FILES} files`);
  }
  const entry = input.files.find((file) => file.relativePath === "index.html");
  if (!entry) throw new WorkPublishAssetError(400, "work site must contain index.html");

  const totalBytes = input.files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes <= 0 || totalBytes > MAX_WORK_SITE_BYTES) throw new WorkPublishAssetError(400, "work site must be 1 byte to 1GiB");

  const preparedEntry = await prepareWorkFile(entry, WORK_HTML_METADATA_MAX_BYTES);
  const prefix = buildWorkAssetPrefix({ spaceId: input.spaceId, workSlug: input.workSlug });
  await mapWithConcurrency(input.files, WORK_FILE_UPLOAD_CONCURRENCY, async (file) => {
    await putWorkFileObject({
      objectKey: `${prefix}/${file.relativePath}`,
      file,
      prepared: file === entry ? preparedEntry : undefined,
      contentType: file.mimeType ?? "application/octet-stream",
    });
  });

  const html = preparedEntry.prefix?.toString("utf8") ?? "";
  return {
    assetKey: `${prefix}/index.html`,
    sizeBytes: totalBytes,
    fileCount: input.files.length,
    extracted: extractPageMetaFromHtml(html, "index.html", input.files.map((file) => file.relativePath)),
  };
}

async function writeWorkFileAsset(input: {
  spaceId: string;
  workSlug: string;
  file: WorkSourceFile;
}) {
  const prefix = buildWorkAssetPrefix({ spaceId: input.spaceId, workSlug: input.workSlug });
  const extension = extname(input.file.name).toLowerCase();
  const objectKey = `${prefix}/content${extension}`;
  const { sha256, size } = await putWorkFileObject({
    objectKey,
    file: input.file,
    contentType: input.file.mimeType ?? "application/octet-stream",
  });
  return {
    assetKey: objectKey,
    sizeBytes: size,
    fileCount: 1,
    extracted: null,
    artifact: {
      kind: "file" as const,
      name: input.file.name,
      mimeType: input.file.mimeType,
      sizeBytes: size,
      sha256,
    },
  };
}

function collectBoardDependencyPaths(snapshot: BoardSnapshot): string[] {
  const paths = new Set<string>();
  for (const node of snapshot.nodes) {
    if ((node.type === "image" || node.type === "video") && node.refPath) {
      paths.add(node.refPath);
    }
    if (node.type === "file" && typeof node.view.coverPath === "string") {
      paths.add(node.view.coverPath);
    }
  }
  for (const owner of [...snapshot.effects, ...snapshot.clips]) {
    for (const ref of owner.assetRefs) {
      if (ref.type === "space-file") paths.add(ref.ref);
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

type CapturedBoardDependency = WorkBoardAsset & {
  file?: WorkSourceFile;
  prepared?: PreparedWorkFile;
};

/** Reserve each dependency before hashing or uploading it. */
async function captureBoardDependency(
  root: string,
  sourcePath: string,
  budget: { reserve: (bytes: number) => boolean },
): Promise<CapturedBoardDependency> {
  let absolutePath: string;
  try {
    const safePath = assertSafeRelativePath(sourcePath);
    absolutePath = resolve(root, safePath);
    assertInsideRoot(absolutePath, root);
  } catch {
    return { sourcePath, status: "rejected", reason: "path_invalid" };
  }
  const stats = await lstat(absolutePath).catch(() => null);
  if (!stats) return { sourcePath, status: "missing", reason: "path_not_found" };
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { sourcePath, status: "rejected", reason: "unsupported_file_type" };
  }
  if (stats.size > MAX_WORK_SITE_BYTES) {
    return { sourcePath, status: "rejected", reason: "asset_too_large" };
  }
  if (!budget.reserve(stats.size)) {
    throw new WorkPublishAssetError(413, "Board asset publish size exceeds 1GiB.", "board_assets_too_large");
  }
  const file: WorkSourceFile = {
    root,
    absolutePath,
    relativePath: sourcePath,
    name: basename(sourcePath),
    size: stats.size,
    mimeType: getMimeType(sourcePath),
  };
  const prepared = await prepareWorkFile(file);
  const extension = extname(sourcePath).toLowerCase();
  return {
    sourcePath,
    status: "captured",
    artifactPath: `assets/${prepared.sha256}${extension}`,
    mimeType: file.mimeType,
    sizeBytes: prepared.snapshot.size,
    sha256: prepared.sha256,
    file,
    prepared,
  };
}

/** Shared byte budget for one Board publish. */
function createByteBudget(limit: number) {
  let remaining = limit;
  return {
    reserve: (bytes: number) => {
      if (bytes > remaining) return false;
      remaining -= bytes;
      return true;
    },
    /** Give back bytes that turned out to be a duplicate of an already-published blob. */
    release: (bytes: number) => {
      remaining += bytes;
    },
    get used() {
      return limit - remaining;
    },
  };
}

async function writeWorkBoardAsset(input: {
  spaceId: string;
  workSlug: string;
  sourcePath: string;
  root: string;
  file: WorkSourceFile;
}) {
  const sourceManifest = await (async () => {
    try {
      const prefix = await readWorkFilePrefix(input.file);
      const manifest = parseBoardManifest(prefix.toString("utf8"));
      if (!(await workFileTailIsWhitespace(input.file, prefix.length))) {
        throw new Error("Board file must contain a single JSON manifest");
      }
      return manifest;
    } catch (cause) {
      // A malformed `.board` file is the publisher's input, not a server fault:
      // surface it as an actionable 400 instead of a generic storage failure.
      throw new WorkPublishAssetError(
        400,
        cause instanceof Error ? cause.message : "Board file is invalid",
        "invalid_board_manifest",
      );
    }
  })();
  const [snapshot] = await captureBoardSnapshots({
    spaceId: input.spaceId,
    boardIds: [sourceManifest.boardId],
  });
  if (!snapshot) throw new WorkPublishAssetError(404, "board not found", "board_not_found");

  const dependencyPaths = collectBoardDependencyPaths(snapshot);
  if (dependencyPaths.length > MAX_WORK_SITE_FILES) {
    throw new WorkPublishAssetError(413, `Board references more than ${MAX_WORK_SITE_FILES} assets.`, "board_too_many_assets");
  }

  const prefix = buildWorkAssetPrefix({ spaceId: input.spaceId, workSlug: input.workSlug });
  const budget = createByteBudget(MAX_WORK_SITE_BYTES);
  const uploaded = new Set<string>();
  // Indexed rather than appended: workers finish out of order, and the manifest
  // should still list assets in the board's stable reference order.
  const assets = new Array<WorkBoardAsset>(dependencyPaths.length);

  await mapWithConcurrency(
    dependencyPaths.map((sourcePath, index) => ({ sourcePath, index })),
    WORK_FILE_UPLOAD_CONCURRENCY,
    async ({ sourcePath, index }) => {
      const { file, prepared, ...asset } = await captureBoardDependency(input.root, sourcePath, budget);
      assets[index] = asset;
      if (!file || !prepared || !asset.artifactPath || !asset.sha256) return;
      // Content-addressed: identical bytes are stored once.
      if (uploaded.has(asset.artifactPath)) {
        budget.release(asset.sizeBytes ?? 0);
        return;
      }
      uploaded.add(asset.artifactPath);
      await putWorkFileObject({
        objectKey: `${prefix}/${asset.artifactPath}`,
        file,
        prepared,
        contentType: asset.mimeType ?? "application/octet-stream",
      });
    },
  );

  const manifest: WorkBoardArtifactManifest = {
    kind: "cohub.work.board",
    version: 1,
    sourcePath: input.sourcePath,
    snapshot,
    assets,
  };
  const body = `${JSON.stringify(manifest)}\n`;
  const objectKey = `${prefix}/board.json`;
  await putWorkAssetObject({
    objectKey,
    body,
    contentType: "application/json; charset=utf-8",
    sha256: createHash("sha256").update(body).digest("hex"),
  });
  const sizeBytes = Buffer.byteLength(body) + budget.used;
  const fileCount = uploaded.size + 1;
  return {
    assetKey: objectKey,
    sizeBytes,
    fileCount,
    extracted: null,
    artifact: {
      kind: "board" as const,
      boardId: snapshot.board.id,
      boardVersion: snapshot.board.version,
      sizeBytes,
      fileCount,
    },
  };
}

async function processWorkPublishAsset(job: Job<WorkPublishAssetJobData>): Promise<WorkPublishAssetJobResult> {
  const { spaceId, slug, targetType, targetRef } = job.data;
  if (targetType === "file") {
    if (/\.html?$/i.test(targetRef)) {
      const { file, prepared, html, companions } = await readWorkHtmlFile(spaceId, targetRef);
      const written = await writeWorkHtmlAsset({ spaceId, workSlug: slug, file, prepared, html, companions });
      return {
        ok: true,
        ...written,
        artifact: {
          kind: "web",
          mimeType: "text/html",
          sizeBytes: written.sizeBytes,
          fileCount: written.fileCount,
        },
      };
    }
    const file = await readWorkFile(spaceId, targetRef);
    const written = isBoardPath(targetRef)
      ? await writeWorkBoardAsset({
          spaceId,
          workSlug: slug,
          sourcePath: file.relativePath,
          root: file.root,
          file,
        })
      : await writeWorkFileAsset({ spaceId, workSlug: slug, file });
    return { ok: true, ...written };
  }
  if (targetType === "directory") {
    const result = await readWorkDirectoryFiles(spaceId, targetRef);
    const written = await writeWorkSiteAssets({ spaceId, workSlug: slug, files: result.files });
    return {
      ok: true,
      ...written,
      artifact: {
        kind: "web",
        mimeType: "text/html",
        sizeBytes: written.sizeBytes,
        fileCount: written.fileCount,
      },
    };
  }
  throw new WorkPublishAssetError(400, "target is invalid");
}

registerSystemJob(WORK_PUBLISH_ASSET_JOB, async (job: Job<WorkPublishAssetJobData>) => {
  try {
    return await processWorkPublishAsset(job);
  } catch (error) {
    if (error instanceof WorkPublishAssetError) {
      return { ok: false, status: error.status, message: error.message, code: error.code };
    }
    throw error;
  }
});
