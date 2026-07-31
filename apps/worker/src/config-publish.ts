import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { isStorageSafePrincipalId } from "@cohub/identity";

const DIR_MODE = 0o775;
const FILE_MODE = 0o664;
const EXECUTABLE_FILE_MODE = 0o775;
const CONFIG_ANCHOR_DIRS = [".agents"] as const;

const USER_CONFIG_PUBLISH_WHITELIST = [
  "AGENTS.md",
  "CLAUDE.md",
  ".agents",
  ".cohub",
] as const;
const MAX_COPY_DEPTH = 16;

function assertValidUserId(userId: string) {
  const value = userId.trim();
  if (!isStorageSafePrincipalId(value)) {
    throw new Error(`Invalid userId: ${userId}`);
  }
  return value;
}

export const getPublishedUserConfigDir = (userId: string) => {
  return join(config.platformConfigRoot, "users", assertValidUserId(userId));
};

function fileModeFor(mode: number) {
  return (mode & 0o111) === 0 ? FILE_MODE : EXECUTABLE_FILE_MODE;
}

function isConfigAnchorDir(name: string, depth: number) {
  return depth === 0 && CONFIG_ANCHOR_DIRS.includes(name as (typeof CONFIG_ANCHOR_DIRS)[number]);
}

async function normalizePermissions(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink()) return;

  if (info.isDirectory()) {
    await chmod(path, DIR_MODE).catch(() => undefined);
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      await normalizePermissions(join(path, entry.name));
    }
    return;
  }

  await chmod(path, fileModeFor(info.mode)).catch(() => undefined);
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyRecursive(src: string, dest: string, depth = 0): Promise<void> {
  if (depth > MAX_COPY_DEPTH) {
    throw new Error(`config publish exceeded max depth at ${src}`);
  }

  const info = await lstat(src);
  if (info.isSymbolicLink()) {
    throw new Error(`symbolic links are not allowed in published config: ${src}`);
  }

  if (info.isDirectory()) {
    await mkdir(dest, { recursive: true, mode: DIR_MODE });
    const entries = await readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      await copyRecursive(join(src, entry.name), join(dest, entry.name), depth + 1);
    }
    return;
  }

  await mkdir(dirname(dest), { recursive: true, mode: DIR_MODE });
  await copyFile(src, dest);
}

async function copyIfExists(srcRoot: string, destRoot: string, relativePath: string) {
  const src = join(srcRoot, relativePath);
  if (!(await pathExists(src))) return false;
  await copyRecursive(src, join(destRoot, relativePath));
  return true;
}

async function forceChmod(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info) return;

  if (info.isDirectory() && !info.isSymbolicLink()) {
    await chmod(path, DIR_MODE).catch(() => undefined);
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      await forceChmod(join(path, entry.name));
    }
    return;
  }

  await chmod(path, FILE_MODE).catch(() => undefined);
}

async function forceRm(path: string): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return;

  if (info.isSymbolicLink()) {
    await rm(path, { force: true });
    return;
  }

  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    await forceChmod(path);
    await rm(path, { recursive: true, force: true });
  }
}

async function clearDirectoryContents(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    await forceRm(join(path, entry.name));
  }
  await chmod(path, DIR_MODE).catch(() => undefined);
}

async function replaceFile(src: string, dest: string) {
  const srcInfo = await lstat(src);
  await mkdir(dirname(dest), { recursive: true, mode: DIR_MODE });
  const tmpFile = `${dest}.__tmp__.${randomUUID()}`;
  await copyFile(src, tmpFile);
  await chmod(tmpFile, fileModeFor(srcInfo.mode)).catch(() => undefined);
  await rename(tmpFile, dest).catch(async (error) => {
    await rm(tmpFile, { force: true }).catch(() => undefined);
    throw error;
  });
}

async function syncDirectoryContents(srcDir: string, destDir: string, depth = 0): Promise<void> {
  if (depth > MAX_COPY_DEPTH) {
    throw new Error(`config publish exceeded max depth while syncing ${srcDir}`);
  }

  await mkdir(destDir, { recursive: true, mode: DIR_MODE });
  await chmod(destDir, DIR_MODE).catch(() => undefined);

  const srcEntries = await readdir(srcDir, { withFileTypes: true });
  const srcByName = new Map(srcEntries.map((entry) => [entry.name, entry]));
  const destEntries = await readdir(destDir, { withFileTypes: true }).catch(() => []);

  for (const srcEntry of srcEntries) {
    if (srcEntry.isSymbolicLink()) {
      throw new Error(`symbolic links are not allowed in published config: ${join(srcDir, srcEntry.name)}`);
    }

    const srcPath = join(srcDir, srcEntry.name);
    const destPath = join(destDir, srcEntry.name);
    const destInfo = await lstat(destPath).catch(() => null);

    if (srcEntry.isDirectory()) {
      if (destInfo && (!destInfo.isDirectory() || destInfo.isSymbolicLink())) {
        await forceRm(destPath);
      }
      await mkdir(destPath, { recursive: true, mode: DIR_MODE });
      await chmod(destPath, DIR_MODE).catch(() => undefined);
      await syncDirectoryContents(srcPath, destPath, depth + 1);
      continue;
    }

    if (destInfo?.isDirectory()) {
      await forceRm(destPath);
    }
    await replaceFile(srcPath, destPath);
  }

  for (const destEntry of destEntries) {
    if (!srcByName.has(destEntry.name)) {
      if (isConfigAnchorDir(destEntry.name, depth)) {
        const anchorPath = join(destDir, destEntry.name);
        await clearDirectoryContents(anchorPath);
        await normalizePermissions(anchorPath);
        continue;
      }
      await forceRm(join(destDir, destEntry.name));
    }
  }
}

export interface PublishConfigResult {
  targetDir: string;
  copiedPaths: string[];
  meta: Record<string, unknown>;
}

export async function publishConfigFromWorkspace(input: {
  workspaceDir: string;
  checkpointId: string;
  targetDir: string;
  whitelist: readonly string[];
  sourceLabel: string;
}): Promise<PublishConfigResult> {
  const opId = `${input.checkpointId}-${randomUUID()}`;
  const tmpDir = `${input.targetDir}.__tmp__.${opId}`;

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true, mode: DIR_MODE });

  const copiedPaths: string[] = [];
  try {
    for (const relativePath of input.whitelist) {
      if (await copyIfExists(input.workspaceDir, tmpDir, relativePath)) {
        copiedPaths.push(relativePath);
      }
    }

    const meta = {
      sourceSpaceId: input.sourceLabel,
      sourceCheckpointId: input.checkpointId,
      publishedAt: new Date().toISOString(),
      copiedPaths,
    };
    await mkdir(join(tmpDir, ".cohub"), { recursive: true, mode: DIR_MODE });
    await writeFile(join(tmpDir, ".cohub", "config-meta.json"), JSON.stringify(meta, null, 2));

    await syncDirectoryContents(tmpDir, input.targetDir);
    await normalizePermissions(input.targetDir);

    return {
      targetDir: input.targetDir,
      copiedPaths,
      meta,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function publishUserConfigFromWorkspace(input: {
  userId: string;
  spaceId: string;
  checkpointId: string;
  workspaceDir: string;
}): Promise<PublishConfigResult> {
  return publishConfigFromWorkspace({
    workspaceDir: input.workspaceDir,
    checkpointId: input.checkpointId,
    targetDir: getPublishedUserConfigDir(input.userId),
    whitelist: USER_CONFIG_PUBLISH_WHITELIST,
    sourceLabel: input.spaceId,
  });
}

export async function readPublishedUserConfigMeta(userId: string) {
  const metaPath = join(getPublishedUserConfigDir(userId), ".cohub", "config-meta.json");
  const raw = await readFile(metaPath, "utf-8").catch(() => null);
  return raw ? JSON.parse(raw) as Record<string, unknown> : null;
}
