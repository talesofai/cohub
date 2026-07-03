import { Hono } from "hono";
import type { SpaceFsModule } from "./index.js";
import type { SpaceFsFileResponse, SpaceFsPreparingFile } from "@cohub/protocol/fs";
import type { SpaceFsCreateUploadInput, SpaceFsCompleteUploadInput } from "@cohub/protocol/fs";

import type { Context } from "hono";
import type { Permission } from "@cohub/core/permissions";
import { createLogger } from "@cohub/infra/logging";
import { assertSafeRelativePath } from "./space-fs.js";
import { FS_CDN_DOWNLOAD_WAIT_TIMEOUT_MS } from "./cdn.js";

const logger = createLogger({ serviceName: "cohub-space-fs" });

export type FsRouterAuth<User extends { uuid: string } = { uuid: string }> = {
  getOptionalAuth: (c: Context) => User | null;
  useAuth: (c: Context) => User;
  requireValidId: (value: string | null | undefined) => boolean;
  authzDenied: (c: Context) => Response;
  hasPermission: (user: User | null, permission: Permission, context: { spaceId: string }) => Promise<boolean>;
};
import type { SpaceUploadDestination, SpaceUploadManifestEntry } from "./upload.js";

const MAX_UPLOAD_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_UPLOAD_FILES = 1000;
const MAX_DOWNLOAD_INLINE_BYTES = 50 * 1024 * 1024;

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

const normalizeUploadDestination = (input: SpaceFsCreateUploadInput["destination"], requireValidId: (value: string | null | undefined) => boolean): SpaceUploadDestination => {
  if (!input || typeof input !== "object") throw new Error("Upload destination is required.");
  if (input.kind === "workspace") {
    return {
      kind: "workspace",
      targetDir: input.targetDir ? assertSafeRelativePath(input.targetDir, { allowEmpty: true }) : "",
    };
  }
  if (input.kind === "sandbox_tmp") {
    if (!input.sessionId || !requireValidId(input.sessionId)) throw new Error("Invalid upload session.");
    return { kind: "sandbox_tmp", sessionId: input.sessionId };
  }
  throw new Error("Invalid upload destination.");
};

const buildUploadDestinationRoot = (destination: SpaceUploadDestination, uploadId: string) => {
  if (destination.kind === "sandbox_tmp") return `/tmp/uploads/${destination.sessionId}/${uploadId}`;
  return destination.targetDir ? `/workspace/${destination.targetDir}` : "/workspace";
};

async function resolveFileViewVisibility<User extends { uuid: string }>(auth: FsRouterAuth<User>, user: User | null, spaceId: string): Promise<"full" | "filtered" | null> {
  if (await auth.hasPermission(user, "file.view", { spaceId })) return "full";
  if (await auth.hasPermission(user, "file.view.filtered", { spaceId })) return "filtered";
  return null;
}

/** Workspace FS routes: tree, file, files, write, dir, delete, move, download, upload. */
export function createFsRouter<User extends { uuid: string }>(module: SpaceFsModule, auth: FsRouterAuth<User>) {
  const { spaceFs, upload, sandboxBash, events } = module;
  const router = new Hono();

  router.get("/:id/fs/tree", async (c) => {
    const user = auth.getOptionalAuth(c);
    const spaceId = c.req.param("id");
    if (!spaceId || !auth.requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
    const visibility = await resolveFileViewVisibility(auth, user, spaceId);
    if (!visibility) return auth.authzDenied(c);

    const path = c.req.query("path") ?? "";
    try {
      return c.json(await spaceFs.listSpaceDirectory(spaceId, path, { visibility }));
    } catch (error) {
      const { status, body } = spaceFs.spaceFsJsonError(error);
      return c.json(body, status as never);
    }
  });

  router.get("/:id/fs/file", async (c) => {
    const user = auth.getOptionalAuth(c);
    const spaceId = c.req.param("id");
    if (!spaceId || !auth.requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
    const visibility = await resolveFileViewVisibility(auth, user, spaceId);
    if (!visibility) return auth.authzDenied(c);

    const path = c.req.query("path") ?? "";
    try {
      const result = await spaceFs.readSpaceFile(spaceId, path, { visibility });
      if (!("content" in result)) return c.json(result, 202);
      return c.json(result);
    } catch (error) {
      const { status, body } = spaceFs.spaceFsJsonError(error);
      return c.json(body, status as never);
    }
  });

  router.post("/:id/fs/files", async (c) => {
    const user = auth.getOptionalAuth(c);
    const spaceId = c.req.param("id");
    if (!spaceId || !auth.requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
    const visibility = await resolveFileViewVisibility(auth, user, spaceId);
    if (!visibility) return auth.authzDenied(c);

    const body = await c.req.json<{ paths: string[] }>().catch(() => null);
    if (!Array.isArray(body?.paths)) return c.json({ message: "paths are required" }, 400);
    try {
      return c.json(await spaceFs.readSpaceFiles(spaceId, body.paths, { visibility }));
    } catch (error) {
      const { status, body: errBody } = spaceFs.spaceFsJsonError(error);
      return c.json(errBody, status as never);
    }
  });

  router.put("/:id/fs/file", async (c) => {
    const user = auth.useAuth(c);
    const spaceId = c.req.param("id");
    if (!spaceId || !auth.requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
    if (!(await auth.hasPermission(user, "file.edit", { spaceId }))) return auth.authzDenied(c);

    const body = await c.req
      .json<{ path: string; content: string; encoding: "utf-8" | "base64" }>()
      .catch(() => null);
    if (!body?.path || typeof body.content !== "string" || !body.encoding) {
      return c.json({ message: "path, content and encoding are required" }, 400);
    }
    try {
      const result = await spaceFs.writeSpaceFile(spaceId, body);
      const changes = [{ path: result.path, kind: "modify" as const, nodeType: "file" as const, size: result.size, mtimeMs: result.mtimeMs }];
      await events.dispatchSpaceFsChanged(spaceId, { source: "api-fs", changes }).catch((error) => logger.error("[SpaceFS] failed to publish file-system change", error));
      return c.json(result);
    } catch (error) {
      const { status, body: errBody } = spaceFs.spaceFsJsonError(error);
      return c.json(errBody, status as never);
    }
  });

  router.post("/:id/fs/dir", async (c) => {
    const user = auth.useAuth(c);
    const spaceId = c.req.param("id");
    if (!spaceId || !auth.requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
    if (!(await auth.hasPermission(user, "file.edit", { spaceId }))) return auth.authzDenied(c);

    const body = await c.req.json<{ path: string }>().catch(() => null);
    if (!body?.path) return c.json({ message: "path is required" }, 400);
    try {
      const result = await spaceFs.createSpaceDirectory(spaceId, body.path);
      await events.dispatchSpaceFsChanged(spaceId, {
        source: "api-fs",
        changes: [{ path: result.path, kind: "create", nodeType: "dir", mtimeMs: result.mtimeMs }],
      }).catch((error) => logger.error("[SpaceFS] failed to publish file-system change", error));
      return c.json(result);
    } catch (error) {
      const { status, body: errBody } = spaceFs.spaceFsJsonError(error);
      return c.json(errBody, status as never);
    }
  });

  router.delete("/:id/fs/node", async (c) => {
    const user = auth.useAuth(c);
    const spaceId = c.req.param("id");
    if (!spaceId || !auth.requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
    if (!(await auth.hasPermission(user, "file.edit", { spaceId }))) return auth.authzDenied(c);

    const path = c.req.query("path") ?? "";
    const recursive = c.req.query("recursive") === "true";
    try {
      const result = await spaceFs.deleteSpaceNode(spaceId, path, recursive);
      await events.dispatchSpaceFsChanged(spaceId, {
        source: "api-fs",
        changes: [{ path: result.path, kind: "delete", nodeType: result.nodeType === "symlink" ? "unknown" : result.nodeType }],
      }).catch((error) => logger.error("[SpaceFS] failed to publish file-system change", error));
      return c.json(result);
    } catch (error) {
      const { status, body: errBody } = spaceFs.spaceFsJsonError(error);
      return c.json(errBody, status as never);
    }
  });

  router.post("/:id/fs/move", async (c) => {
    const user = auth.useAuth(c);
    const spaceId = c.req.param("id");
    if (!spaceId || !auth.requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
    if (!(await auth.hasPermission(user, "file.edit", { spaceId }))) return auth.authzDenied(c);

    const body = await c.req.json<{ fromPath: string; toPath: string }>().catch(() => null);
    if (!body?.fromPath || !body?.toPath) return c.json({ message: "fromPath and toPath are required" }, 400);
    try {
      const result = await spaceFs.moveSpaceNode(spaceId, body);
      await events.dispatchSpaceFsChanged(spaceId, {
        source: "api-fs",
        changes: [{ path: result.toPath, oldPath: result.fromPath, kind: "rename", nodeType: "unknown" }],
      }).catch((error) => logger.error("[SpaceFS] failed to publish file-system change", error));
      return c.json(result);
    } catch (error) {
      const { status, body: errBody } = spaceFs.spaceFsJsonError(error);
      return c.json(errBody, status as never);
    }
  });

  router.get("/:id/fs/download", async (c) => {
    const user = auth.getOptionalAuth(c);
    const spaceId = c.req.param("id");
    if (!spaceId || !auth.requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
    const visibility = await resolveFileViewVisibility(auth, user, spaceId);
    if (!visibility) return auth.authzDenied(c);

    const path = c.req.query("path") ?? "";
    try {
      const info = await spaceFs.streamSpaceFile(spaceId, path, { visibility });
      const meta = {
        spaceId,
        path: info.path,
        name: info.name,
        size: info.size,
        mimeType: info.mimeType,
        mtimeMs: info.mtimeMs,
      };
      if (module.cdn.shouldUseFsCdnForMeta(meta)) {
        const manifest = await module.cdn.ensureFsCdnManifest(meta, "download_miss", FS_CDN_DOWNLOAD_WAIT_TIMEOUT_MS);
        if (!manifest) return c.json({ message: "file is preparing", retryAfterMs: 2000 }, 202);
        return c.redirect(manifest.url, 302);
      }
      const { readFile } = await import("node:fs/promises");
      if (info.size > MAX_DOWNLOAD_INLINE_BYTES) {
        return c.json({ message: "file is too large to download inline", retryAfterMs: 2000 }, 413);
      }
      const buffer = await readFile(info.target);
      return c.body(new Uint8Array(buffer), 200, {
        "content-type": info.mimeType ?? "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(info.name)}`,
      });
    } catch (error) {
      const { status, body: errBody } = spaceFs.spaceFsJsonError(error);
      return c.json(errBody, status as never);
    }
  });

  router.post("/:id/fs/uploads", async (c) => {
    const user = auth.useAuth(c);
    const spaceId = c.req.param("id");
    if (!spaceId || !auth.requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
    if (!(await auth.hasPermission(user, "file.edit", { spaceId }))) return auth.authzDenied(c);

    const body = await c.req.json<SpaceFsCreateUploadInput>().catch(() => null);
    if (!body?.entries?.length) return c.json({ message: "entries are required" }, 400);
    if (body.entries.length > MAX_UPLOAD_FILES) return c.json({ message: "too many files" }, 413);

    const uploadId = upload.createSpaceUploadId();
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    const entries: SpaceUploadManifestEntry[] = [];
    let totalBytes = 0;

    try {
      const destination = normalizeUploadDestination(body.destination, auth.requireValidId);
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
          objectKey: upload.buildSpaceUploadObjectKey({ spaceId, uploadId, entryId: entry.id }),
        });
      }

      const planned = entries.map((entry) => {
        const signed = upload.createPresignedPutUrl(entry.objectKey, entry.mimeType);
        return { id: entry.id, objectKey: entry.objectKey, uploadUrl: signed.uploadUrl, headers: signed.headers };
      });
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await upload.saveSpaceUploadManifest({
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
      const message = error instanceof Error ? error.message.toLowerCase().replace(/\.$/, "") : "failed to create upload";
      return c.json({ message }, 400);
    }
  });

  router.post("/:id/fs/uploads/:uploadId/complete", async (c) => {
    const user = auth.useAuth(c);
    const spaceId = c.req.param("id");
    const uploadId = c.req.param("uploadId");
    if (!spaceId || !auth.requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
    if (!uploadId || !auth.requireValidId(uploadId)) return c.json({ message: "upload not found" }, 404);
    if (!(await auth.hasPermission(user, "file.edit", { spaceId }))) return auth.authzDenied(c);

    const body = await c.req.json<SpaceFsCompleteUploadInput>().catch(() => null);
    if (!body?.entries?.length || !Array.isArray(body.entries)) return c.json({ message: "entries are required" }, 400);
    if (body.entries.some((entry) => typeof entry.id !== "string")) return c.json({ message: "invalid entries" }, 400);
    const completeState = await upload.beginSpaceUploadComplete(spaceId, uploadId);
    if (!completeState.acquired) {
      return c.json({ message: "upload is already being completed" }, 409);
    }

    try {
      const manifest = await upload.getSpaceUploadManifest(spaceId, uploadId);
      if (!manifest || manifest.userId !== user.uuid) {
        await upload.cancelSpaceUploadComplete(spaceId, uploadId);
        return c.json({ message: "upload not found" }, 404);
      }
      const completedIds = new Set(body.entries.map((entry) => entry.id));
      const entries = manifest.entries.filter((entry) => completedIds.has(entry.id));
      if (entries.length === 0) {
        await upload.cancelSpaceUploadComplete(spaceId, uploadId);
        return c.json({ message: "no completed entries" }, 400);
      }

      const destinationRoot = buildUploadDestinationRoot(manifest.destination, manifest.uploadId);
      const sessionId = manifest.destination.kind === "sandbox_tmp" ? manifest.destination.sessionId : `upload:${uploadId}`;
      const result = await sandboxBash.enqueueSandboxUploadFilesJob({
        spaceId,
        sessionId,
        uploadId,
        destinationRoot,
        files: entries.map((entry) => {
          const signed = upload.createPresignedGetUrl(entry.objectKey);
          return {
            relativePath: entry.relativePath,
            name: entry.name,
            size: entry.size,
            mimeType: entry.mimeType,
            downloadUrl: signed.downloadUrl,
          };
        }),
      });

      await upload.deleteSpaceUploadManifest(spaceId, uploadId);
      return c.json({ ok: true, uploaded: result.uploaded });
    } catch (error) {
      await upload.cancelSpaceUploadComplete(spaceId, uploadId);
      logger.error("[space-fs] failed to complete upload", error, { spaceId, uploadId });
      return c.json({ message: "failed to complete upload" }, 500);
    }
  });

  router.post("/:id/fs/upload", async (c) => {
    const user = auth.useAuth(c);
    const spaceId = c.req.param("id");
    if (!spaceId || !auth.requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
    if (!(await auth.hasPermission(user, "file.edit", { spaceId }))) return auth.authzDenied(c);

    const dir = c.req.query("dir") ?? "";
    const formData = await c.req.formData().catch(() => null);
    if (!formData) return c.json({ message: "multipart/form-data required" }, 400);

    const fileEntries = formData.getAll("files");
    const files = fileEntries.filter((e): e is File => e instanceof File);
    if (files.length === 0) return c.json({ message: "at least one file is required" }, 400);

    try {
      const result = await spaceFs.uploadSpaceFiles(spaceId, files, dir);
      if (result.uploaded.length > 0) {
        const changes = result.uploaded.map((file) => ({
          path: file.path,
          kind: "create" as const,
          nodeType: "file" as const,
          size: file.size,
          mtimeMs: file.mtimeMs,
        }));
        await events.dispatchSpaceFsChanged(spaceId, { source: "api-fs", changes }).catch((error) => logger.error("[SpaceFS] failed to publish file-system change", error));
      }
      return c.json(result);
    } catch (error) {
      const { status, body } = spaceFs.spaceFsJsonError(error);
      return c.json(body, status as never);
    }
  });

  return router;
}

/** Checkpoint FS routes: tree, file (read-only, backed by git). */
export function createCheckpointFsRouter<User extends { uuid: string }>(module: SpaceFsModule, auth: FsRouterAuth<User>) {
  const { checkpointFs } = module;
  const router = new Hono();

  router.get("/:id/checkpoints/:checkpointId/fs/tree", async (c) => {
    const user = auth.getOptionalAuth(c);
    const spaceId = c.req.param("id");
    const checkpointId = c.req.param("checkpointId");
    if (!auth.requireValidId(spaceId) || (checkpointId !== "latest" && !auth.requireValidId(checkpointId))) return c.json({ code: "checkpoint_not_found", message: "Checkpoint not found." }, 404);
    if (!(await auth.hasPermission(user, "checkpoint.view", { spaceId }))) return auth.authzDenied(c);

    try {
      return c.json(await checkpointFs.listCheckpointDirectory({ spaceId, checkpointId, path: c.req.query("path") ?? "" }));
    } catch (error) {
      const { status, body } = checkpointFs.checkpointFsJsonError(error);
      return c.json(body, status as never);
    }
  });

  router.get("/:id/checkpoints/:checkpointId/fs/file", async (c) => {
    const user = auth.getOptionalAuth(c);
    const spaceId = c.req.param("id");
    const checkpointId = c.req.param("checkpointId");
    if (!auth.requireValidId(spaceId) || (checkpointId !== "latest" && !auth.requireValidId(checkpointId))) return c.json({ code: "checkpoint_not_found", message: "Checkpoint not found." }, 404);
    if (!(await auth.hasPermission(user, "checkpoint.view", { spaceId }))) return auth.authzDenied(c);

    try {
      return c.json(await checkpointFs.readCheckpointFile({ spaceId, checkpointId, path: c.req.query("path") ?? "" }));
    } catch (error) {
      const { status, body } = checkpointFs.checkpointFsJsonError(error);
      return c.json(body, status as never);
    }
  });

  return router;
}
