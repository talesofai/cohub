import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readlink, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { ScannedFile } from "./scan.js";
import { CHECKPOINT_ASSET_MANIFEST_PATH, CHECKPOINT_META_PATH } from "./paths.js";

const toPosix = (value: string) => value.replace(/\\/g, "/");
const metaDir = dirname(CHECKPOINT_META_PATH);

function keepPathWithParents(keep: Set<string>, path: string) {
  const parts = toPosix(path).split("/").filter(Boolean);
  for (let index = 1; index <= parts.length; index += 1) keep.add(parts.slice(0, index).join("/"));
}

async function removePath(path: string) {
  await rm(path, { recursive: true, force: true });
}

export async function copyEntryToLatest(file: ScannedFile, latestDir: string) {
  const target = join(latestDir, file.path);
  await mkdir(dirname(target), { recursive: true, mode: 0o775 });
  await removePath(target);
  if (file.type === "symlink") {
    const link = await readlink(file.absPath);
    await symlink(link, target);
    return;
  }
  await copyFile(file.absPath, target, constants.COPYFILE_FICLONE).catch(async () => {
    await copyFile(file.absPath, target);
  });
}

async function collectExisting(root: string, dir = root): Promise<string[]> {
  const names = await readdir(dir).catch(() => []);
  const nested = await Promise.all(names.map(async (name) => {
    const absPath = join(dir, name);
    const rel = toPosix(relative(root, absPath));
    const st = await lstat(absPath).catch(() => null);
    if (!st) return [];
    if (st.isDirectory() && !st.isSymbolicLink()) return [rel, ...await collectExisting(root, absPath)];
    return [rel];
  }));
  return nested.flat();
}

export async function materializeLatest(input: {
  latestDir: string;
  files: ScannedFile[];
  checkpointMeta: Record<string, unknown>;
}) {
  await mkdir(input.latestDir, { recursive: true, mode: 0o775 });
  const keep = new Set<string>();
  for (const file of input.files) keepPathWithParents(keep, file.path);
  keepPathWithParents(keep, CHECKPOINT_META_PATH);

  await Promise.all(input.files.map((file) => copyEntryToLatest(file, input.latestDir)));
  await mkdir(join(input.latestDir, metaDir), { recursive: true, mode: 0o775 });
  const metaTarget = join(input.latestDir, CHECKPOINT_META_PATH);
  const tmpMeta = `${metaTarget}.tmp-${crypto.randomUUID()}`;
  await writeFile(tmpMeta, `${JSON.stringify(input.checkpointMeta, null, 2)}\n`);
  await rename(tmpMeta, metaTarget).finally(() => unlink(tmpMeta).catch(() => undefined));

  const existing = (await collectExisting(input.latestDir)).sort((a, b) => b.length - a.length);
  for (const rel of existing) {
    if (rel === ".cohub" || rel === metaDir || rel === CHECKPOINT_META_PATH) continue;
    if (rel === CHECKPOINT_ASSET_MANIFEST_PATH || !keep.has(rel)) {
      await removePath(join(input.latestDir, rel));
    }
  }
}
