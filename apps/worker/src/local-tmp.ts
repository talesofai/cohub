import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const LOCAL_TMP_ROOT = "/tmp/cohub-worker";
const SAFE_SEGMENT = /[^a-zA-Z0-9._-]/g;

const safeSegment = (value: string) => {
  const cleaned = value.replace(SAFE_SEGMENT, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return cleaned || "tmp";
};

const assertUnderRoot = (path: string) => {
  const root = resolve(LOCAL_TMP_ROOT);
  const target = resolve(path);
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    throw new Error(`unsafe local tmp path: ${path}`);
  }
  return target;
};

const assertRealUnderRoot = (rootReal: string, targetReal: string, path: string) => {
  if (targetReal === rootReal || !targetReal.startsWith(`${rootReal}${sep}`)) {
    throw new Error(`local tmp path escapes root: ${path}`);
  }
};

async function ensureLocalTmpRoot() {
  const parent = dirname(LOCAL_TMP_ROOT);
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error(`unsafe local tmp parent: ${parent}`);
  }
  await mkdir(LOCAL_TMP_ROOT, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const rootInfo = await lstat(LOCAL_TMP_ROOT);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`unsafe local tmp root: ${LOCAL_TMP_ROOT}`);
  }
  await chmod(LOCAL_TMP_ROOT, 0o700).catch(() => undefined);
  return realpath(LOCAL_TMP_ROOT);
}

export function getWorkerLocalTmpDir(...segments: string[]) {
  return join(LOCAL_TMP_ROOT, segments.map(safeSegment).join("-"));
}

export async function ensureWorkerLocalTmpDir(path: string) {
  const rootReal = await ensureLocalTmpRoot();
  const target = assertUnderRoot(path);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { mode: 0o700 });
  const targetInfo = await lstat(target);
  if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) {
    throw new Error(`unsafe local tmp target: ${path}`);
  }
  assertRealUnderRoot(rootReal, await realpath(target), path);
  return target;
}

export async function removeWorkerLocalTmpDir(path: string) {
  const rootReal = await ensureLocalTmpRoot();
  const target = assertUnderRoot(path);
  const targetInfo = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!targetInfo) return;
  if (!targetInfo.isSymbolicLink()) {
    assertRealUnderRoot(rootReal, await realpath(target), path);
  }
  await rm(target, { recursive: true, force: true });
}
