// In production, /api/spaces/:id/fs/* is routed by the gateway to the
// fs-api deployment. See deploy/fs-api/manifests/httproute.tmpl.yaml.
import { createLogger } from "@cohub/infra/logging";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { ensureFsCdnManifest, shouldUseFsCdnForMeta } from "../../space-fs-cdn-cache.js";
import { FS_CDN_DOWNLOAD_WAIT_TIMEOUT_MS } from "../../space-fs-cdn-constants.js";
import { getOptionalAuth, useAuth, requireValidId, authzDenied } from "../../lib/middleware.js";
import { hasPermission } from "../../permissions.js";
import { identityEquals } from "../../identity-bridge.js";
import { getSpacePendingDiffFile, getSpacePendingDiffSummary } from "../../checkpoint-pending-diff.js";
import { checkpointFsJsonError } from "../../checkpoint-fs.js";
import {
  assertSafeRelativePath,
  createSpaceDirectory,
  deleteSpaceNode,
  listSpaceDirectory,
  moveSpaceNode,
  readSpaceFile,
  readSpaceFiles,
  resolveSpaceFileDownload,
  spaceFsJsonError,
  streamSpaceFile,
  uploadSpaceFiles,
  writeSpaceFile,
} from "../../space-fs-backend.js";
import { buildCreatedDirectoryChanges, buildFileMutationChanges } from "../../space-fs-change.js";
import { dispatchSpaceFsChanged } from "../../space-events.js";
import type { SpaceFsVisibility } from "../../space-fs-ignore.js";
import {
  beginSpaceUploadComplete,
  buildSpaceUploadObjectKey,
  cancelSpaceUploadComplete,
  consumeSpaceUploadQuota,
  createPresignedGetUrl,
  createPresignedPutUrl,
  createSpaceUploadId,
  deleteSpaceUploadManifest,
  getSpaceUploadManifest,
  saveSpaceUploadManifest,
  SpaceUploadRateLimitError,
  type SpaceUploadDestination,
  type SpaceUploadManifestEntry,
} from "../../space-upload-storage.js";
import { enqueueSandboxUploadFilesJob } from "../../sandbox-bash-queue.js";
import { isAllowedPublicAssetDownloadUrl } from "../../public-asset-storage.js";
import type {
  SpaceFsCreateUploadInput,
  SpaceFsCompleteUploadInput,
} from "@cohub/protocol/fs";


const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

const MAX_UPLOAD_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_UPLOAD_FILES = 1000;

const assertSafeUploadPathPart = (part: string) => {
  if (
    !part ||
    part === "." ||
    part === ".." ||
    part.length > 255 ||
    part.trim() !== part ||
    /[<>:"/\\|?*]/.test(part) ||
    part.split("").some((char) => char.charCodeAt(0) <= 0x1f)
  ) {
    throw new Error("Invalid upload path.");
  }
  return part;
};

const normalizeUploadRelativePath = (input: string) => {
  const raw = assertSafeRelativePath(input, { allowEmpty: false });
  const parts = raw.split("/").map(assertSafeUploadPathPart);
  const normalized = parts.join("/");
  if (normalized.length > 4096) throw new Error("Upload path is too long.");
  return normalized;
};

const normalizeUploadDestination = (input: SpaceFsCreateUploadInput["destination"]): SpaceUploadDestination => {
  if (!input || typeof input !== "object") throw new Error("Upload destination is required.");
  if (input.kind === "workspace") {
    return {
      kind: "workspace",
      targetDir: input.targetDir ? assertSafeRelativePath(input.targetDir, { allowEmpty: true }) : "",
    };
  }
  if (input.kind === "sandbox_tmp") {
    if (input.sessionId != null && input.sessionId !== "" && !requireValidId(input.sessionId)) {
      throw new Error("Invalid upload session.");
    }
    return { kind: "sandbox_tmp", sessionId: input.sessionId || undefined };
  }
  throw new Error("Invalid upload destination.");
};

const buildUploadDestinationRoot = (destination: SpaceUploadDestination, uploadId: string) => {
  if (destination.kind === "sandbox_tmp") return `/tmp/uploads/${uploadId}`;
  return destination.targetDir ? `/workspace/${destination.targetDir}` : "/workspace";
};

async function resolveFileViewVisibility(user: ReturnType<typeof getOptionalAuth>, spaceId: string): Promise<SpaceFsVisibility | null> {
  if (await hasPermission(user, "file.view", { spaceId })) return "full";
  if (await hasPermission(user, "file.view.filtered", { spaceId })) return "filtered";
  return null;
}

router.get("/tree", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  const visibility = await resolveFileViewVisibility(user, spaceId);
  if (!visibility) return authzDenied(c);

  const path = c.req.query("path") ?? "";
  try {
    return c.json(await listSpaceDirectory(spaceId, path, { visibility }));
  } catch (error) {
    const { status, body } = spaceFsJsonError(error);
    return c.json(body, status as never);
  }
});

router.get("/file", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  const visibility = await resolveFileViewVisibility(user, spaceId);
  if (!visibility) return authzDenied(c);

  const path = c.req.query("path") ?? "";
  try {
    const result = await readSpaceFile(spaceId, path, { visibility });
    if (!("content" in result)) return c.json(result, 202);
    return c.json(result);
  } catch (error) {
    const { status, body } = spaceFsJsonError(error);
    return c.json(body, status as never);
  }
});

// Pending workspace changes vs head checkpoint (create-save preview).
router.get("/diff", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  // Full file.view only — filtered guests must not enumerate ignored paths via pending diff.
  if (!(await hasPermission(user, "file.view", { spaceId }))) return authzDenied(c);

  try {
    return c.json(await getSpacePendingDiffSummary(spaceId));
  } catch (error) {
    const { status, body } = checkpointFsJsonError(error);
    return c.json(body, status as never);
  }
});

router.get("/diff/file", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "file.view", { spaceId }))) return authzDenied(c);

  const path = c.req.query("path") ?? "";
  if (!path) return c.json({ code: "path_invalid", message: "path is required" }, 400);

  try {
    return c.json(await getSpacePendingDiffFile(spaceId, path));
  } catch (error) {
    const { status, body } = checkpointFsJsonError(error);
    return c.json(body, status as never);
  }
});

router.post("/files", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  const visibility = await resolveFileViewVisibility(user, spaceId);
  if (!visibility) return authzDenied(c);

  const body = await c.req.json<{ paths: string[] }>().catch(() => null);
  if (!Array.isArray(body?.paths)) return c.json({ message: "paths are required" }, 400);
  try {
    return c.json(await readSpaceFiles(spaceId, body.paths, { visibility }));
  } catch (error) {
    const { status, body: errBody } = spaceFsJsonError(error);
    return c.json(errBody, status as never);
  }
});

router.put("/file", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "file.edit", { spaceId }))) return authzDenied(c);

  const body = await c.req
    .json<{
      path: string;
      content: string;
      encoding: "utf-8" | "base64";
      expected?: { mtimeMs: number; size: number };
      mutationId?: string;
    }>()
    .catch(() => null);
  if (!body?.path || typeof body.content !== "string" || !body.encoding) {
    return c.json({ message: "path, content and encoding are required" }, 400);
  }
  if (
    body.expected &&
    (!Number.isFinite(body.expected.mtimeMs) ||
      !Number.isFinite(body.expected.size) ||
      body.expected.size < 0)
  ) {
    return c.json({ message: "expected file version is invalid" }, 400);
  }
  if (body.mutationId !== undefined && (typeof body.mutationId !== "string" || body.mutationId.length > 128)) {
    return c.json({ message: "mutationId is invalid" }, 400);
  }
  try {
    const result = await writeSpaceFile(spaceId, body);
    const changes = buildFileMutationChanges(result);
    await dispatchSpaceFsChanged(spaceId, {
      source: "api-fs",
      mutationId: body.mutationId,
      changes,
    }).catch((error) => logger.error("[SpaceFS] failed to publish file-system change", error));
    return c.json(result);
  } catch (error) {
    const { status, body: errBody } = spaceFsJsonError(error);
    return c.json(errBody, status as never);
  }
});

router.post("/dir", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "file.edit", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<{ path: string }>().catch(() => null);
  if (!body?.path) return c.json({ message: "path is required" }, 400);
  try {
    const result = await createSpaceDirectory(spaceId, body.path);
    if (result.createdDirs.length > 0) {
      await dispatchSpaceFsChanged(spaceId, {
        source: "api-fs",
        changes: buildCreatedDirectoryChanges(result.createdDirs).map((change) =>
          change.path === result.path ? { ...change, mtimeMs: result.mtimeMs } : change),
      }).catch((error) => logger.error("[SpaceFS] failed to publish file-system change", error));
    }
    return c.json(result);
  } catch (error) {
    const { status, body: errBody } = spaceFsJsonError(error);
    return c.json(errBody, status as never);
  }
});

router.delete("/node", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "file.edit", { spaceId }))) return authzDenied(c);

  const rawPath = c.req.query("path") ?? "";
  const recursive = c.req.query("recursive") === "true";
  try {
    const path = assertSafeRelativePath(rawPath);
    const result = await deleteSpaceNode(spaceId, path, recursive);
    await dispatchSpaceFsChanged(spaceId, {
      source: "api-fs",
      changes: [{ path: result.path, kind: "delete", nodeType: result.nodeType === "symlink" ? "unknown" : result.nodeType }],
    }).catch((error) => logger.error("[SpaceFS] failed to publish file-system change", error));
    return c.json(result);
  } catch (error) {
    const { status, body: errBody } = spaceFsJsonError(error);
    return c.json(errBody, status as never);
  }
});

router.post("/move", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "file.edit", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<unknown>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ message: "fromPath and toPath are required" }, 400);
  const input = body as Record<string, unknown>;
  if (typeof input.fromPath !== "string" || typeof input.toPath !== "string") return c.json({ message: "fromPath and toPath are required" }, 400);
  try {
    const move = {
      fromPath: assertSafeRelativePath(input.fromPath),
      toPath: assertSafeRelativePath(input.toPath),
    };
    const result = await moveSpaceNode(spaceId, move);
    await dispatchSpaceFsChanged(spaceId, {
      source: "api-fs",
      changes: [
        ...buildCreatedDirectoryChanges(result.createdDirs),
        { path: result.toPath, oldPath: result.fromPath, kind: "rename", nodeType: result.nodeType === "symlink" ? "unknown" : result.nodeType },
      ],
    }).catch((error) => logger.error("[SpaceFS] failed to publish file-system change", error));
    return c.json(result);
  } catch (error) {
    const { status, body: errBody } = spaceFsJsonError(error);
    return c.json(errBody, status as never);
  }
});

router.get("/download", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  const visibility = await resolveFileViewVisibility(user, spaceId);
  if (!visibility) return authzDenied(c);

  const path = c.req.query("path") ?? "";
  try {
    const download = await resolveSpaceFileDownload(spaceId, path, { visibility });
    if (download.kind === "buffer") {
      return c.body(new Uint8Array(download.buffer), 200, {
        "content-type": download.mimeType ?? "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(download.name)}`,
      });
    }
    const info = await streamSpaceFile(spaceId, path, { visibility });
    const meta = {
      spaceId,
      path: info.path,
      name: info.name,
      size: info.size,
      mimeType: info.mimeType,
      mtimeMs: info.mtimeMs,
    };
    if (shouldUseFsCdnForMeta(meta)) {
      const manifest = await ensureFsCdnManifest(meta, "download_miss", FS_CDN_DOWNLOAD_WAIT_TIMEOUT_MS);
      if (!manifest) return c.json({ message: "file is preparing", retryAfterMs: 2000 }, 202);
      return c.redirect(manifest.url, 302);
    }
    const buffer = await readFile(info.target);
    return c.body(new Uint8Array(buffer), 200, {
      "content-type": info.mimeType ?? "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(info.name)}`,
    });
  } catch (error) {
    const { status, body: errBody } = spaceFsJsonError(error);
    return c.json(errBody, status as never);
  }
});


router.post("/uploads", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "file.edit", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<SpaceFsCreateUploadInput>().catch(() => null);
  if (!body?.entries?.length) return c.json({ message: "entries are required" }, 400);
  if (body.entries.length > MAX_UPLOAD_FILES) return c.json({ message: "too many files" }, 413);

  const uploadId = createSpaceUploadId();
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const entries: SpaceUploadManifestEntry[] = [];
  let totalBytes = 0;

  try {
    const destination = normalizeUploadDestination(body.destination);
    for (const entry of body.entries) {
      if (typeof entry.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.id) || seenIds.has(entry.id)) {
        return c.json({ message: "entry ids must be unique safe strings" }, 400);
      }
      seenIds.add(entry.id);
      if (typeof entry.name !== "string" || entry.name.length === 0 || entry.name.length > 255) {
        return c.json({ message: "invalid file name" }, 400);
      }
      if (typeof entry.relativePath !== "string" || entry.relativePath.length === 0 || entry.relativePath.length > 4096) {
        return c.json({ message: "invalid upload path" }, 400);
      }
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_UPLOAD_FILE_BYTES) {
        return c.json({ message: "file too large" }, 413);
      }
      if (entry.mimeType != null && (typeof entry.mimeType !== "string" || entry.mimeType.length > 255)) {
        return c.json({ message: "invalid mime type" }, 400);
      }
      const downloadUrl =
        typeof entry.downloadUrl === "string" && entry.downloadUrl.trim()
          ? entry.downloadUrl.trim()
          : null;
      if (downloadUrl && !isAllowedPublicAssetDownloadUrl(downloadUrl)) {
        return c.json({ message: "invalid download url" }, 400);
      }
      totalBytes += entry.size;
      if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) return c.json({ message: "upload too large" }, 413);
      const relativePath = normalizeUploadRelativePath(entry.relativePath || entry.name);
      if (seenPaths.has(relativePath)) return c.json({ message: "duplicate upload path" }, 400);
      seenPaths.add(relativePath);
      const name = relativePath.split("/").at(-1) ?? entry.name;
      entries.push({
        id: entry.id,
        name,
        relativePath,
        size: entry.size,
        mimeType: entry.mimeType ?? null,
        ...(downloadUrl
          ? { downloadUrl }
          : { objectKey: buildSpaceUploadObjectKey({ spaceId, uploadId, entryId: entry.id }) }),
      });
    }

    // Charge quota only after full validation so bad requests cannot burn the window.
    await consumeSpaceUploadQuota(user.uuid, entries.length);

    const planned = entries.map((entry) => {
      if (entry.downloadUrl) {
        return { id: entry.id, downloadUrl: entry.downloadUrl };
      }
      const signed = createPresignedPutUrl(entry.objectKey as string, entry.mimeType);
      return { id: entry.id, objectKey: entry.objectKey, uploadUrl: signed.uploadUrl, headers: signed.headers };
    });
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await saveSpaceUploadManifest({
      uploadId,
      spaceId,
      userId: user.uuid,
      destination,
      entries,
      createdAt: new Date().toISOString(),
      expiresAt,
    });
    return c.json({ uploadId, expiresAt, entries: planned });
  } catch (error) {
    if (error instanceof SpaceUploadRateLimitError) {
      return c.json({ message: error.message }, 429);
    }
    const message = error instanceof Error ? error.message.toLowerCase().replace(/\.$/, "") : "failed to create upload";
    return c.json({ message }, 400);
  }
});

router.post("/uploads/:uploadId/complete", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const uploadId = c.req.param("uploadId");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!uploadId || !requireValidId(uploadId)) return c.json({ message: "upload not found" }, 404);
  if (!(await hasPermission(user, "file.edit", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<SpaceFsCompleteUploadInput>().catch(() => null);
  if (!body?.entries?.length || !Array.isArray(body.entries)) return c.json({ message: "entries are required" }, 400);
  if (body.entries.some((entry) => typeof entry.id !== "string")) return c.json({ message: "invalid entries" }, 400);
  const completeState = await beginSpaceUploadComplete(spaceId, uploadId);
  if (!completeState.acquired) {
    return c.json({ message: "upload is already being completed" }, 409);
  }

  try {
    const manifest = await getSpaceUploadManifest(spaceId, uploadId);
    if (!manifest || !identityEquals(user, manifest.userId)) {
      await cancelSpaceUploadComplete(spaceId, uploadId);
      return c.json({ message: "upload not found" }, 404);
    }
    const completedIds = new Set(body.entries.map((entry) => entry.id));
    const entries = manifest.entries.filter((entry) => completedIds.has(entry.id));
    if (entries.length === 0) {
      await cancelSpaceUploadComplete(spaceId, uploadId);
      return c.json({ message: "no completed entries" }, 400);
    }

    const destinationRoot = buildUploadDestinationRoot(manifest.destination, manifest.uploadId);
    const sessionId =
      manifest.destination.kind === "sandbox_tmp"
        ? (manifest.destination.sessionId || `upload:${uploadId}`)
        : `upload:${uploadId}`;
    const result = await enqueueSandboxUploadFilesJob({
      spaceId,
      sessionId,
      uploadId,
      destinationRoot,
      files: entries.map((entry) => {
        const rawUrl = entry.downloadUrl
          ? entry.downloadUrl
          : createPresignedGetUrl(entry.objectKey as string).downloadUrl;
        return {
          relativePath: entry.relativePath,
          name: entry.name,
          size: entry.size,
          mimeType: entry.mimeType,
          downloadUrl: rawUrl,
        };
      }),
    });

    await deleteSpaceUploadManifest(spaceId, uploadId);
    return c.json({
      ok: true,
      uploaded: result.uploaded,
    });
  } catch (error) {
    await cancelSpaceUploadComplete(spaceId, uploadId);
    logger.error("[space-fs] failed to complete upload", error, {
      spaceId,
      uploadId,
      requestedEntries: body.entries.length,
    });
    return c.json({ message: "failed to complete upload" }, 500);
  }
});

router.post("/upload", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "file.edit", { spaceId }))) return authzDenied(c);

  const dir = c.req.query("dir") ?? "";
  const formData = await c.req.formData().catch(() => null);
  if (!formData) return c.json({ message: "multipart/form-data required" }, 400);

  const fileEntries = formData.getAll("files");
  const files = fileEntries.filter((e): e is File => e instanceof File);
  if (files.length === 0) return c.json({ message: "at least one file is required" }, 400);

  try {
    const result = await uploadSpaceFiles(spaceId, files, dir);
    if (result.uploaded.length > 0 || (result.createdDirs?.length ?? 0) > 0) {
      const changes = [
        ...buildCreatedDirectoryChanges(result.createdDirs),
        ...result.uploaded.flatMap((file) => buildFileMutationChanges({
          ...file,
          created: file.created !== false,
        })),
      ];
      await dispatchSpaceFsChanged(spaceId, {
        source: "api-fs",
        changes,
      }).catch((error) => logger.error("[SpaceFS] failed to publish file-system change", error));
    }
    return c.json(result);
  } catch (error) {
    const { status, body } = spaceFsJsonError(error);
    return c.json(body, status as never);
  }
});

export default router;
