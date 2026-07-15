import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { IsolatedWorkerInputBundle } from "@cohub/protocol/isolated-worker";

function safePath(root: string, value: string) {
  if (!value || value.includes("\0") || value.includes("\\") || isAbsolute(value)) throw new Error(`unsafe manifest path: ${value}`);
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`unsafe manifest path: ${value}`);
  if (parts[0] === ".git" || parts[0] === ".cohub" || parts[0] === "work") throw new Error(`reserved manifest path: ${value}`);
  const target = resolve(root, value);
  const rel = relative(resolve(root), target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`manifest path escapes root: ${value}`);
  return target;
}

type PathIdentity = { path: string; dev: number; ino: number };

async function captureDirectoryChain(root: string, relativePath: string): Promise<PathIdentity[]> {
  const identities: PathIdentity[] = [];
  const parts = relativePath.split("/").slice(0, -1);
  let current = resolve(root);
  for (const part of ["", ...parts]) {
    if (part) current = resolve(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`manifest source directory is a symlink or not a directory: ${current}`);
    identities.push({ path: current, dev: entry.dev, ino: entry.ino });
  }
  return identities;
}

async function assertDirectoryChainUnchanged(identities: PathIdentity[]) {
  for (const identity of identities) {
    const entry = await lstat(identity.path);
    if (entry.isSymbolicLink() || !entry.isDirectory() || entry.dev !== identity.dev || entry.ino !== identity.ino) {
      throw new Error(`manifest source directory changed during read: ${identity.path}`);
    }
  }
}

async function readRegularFileNoFollow(root: string, relativePath: string) {
  const path = safePath(root, relativePath);
  const rootRealPath = await realpath(root);
  const chain = await captureDirectoryChain(root, relativePath);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`manifest source is not a regular file: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`manifest source changed before read: ${path}`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error(`manifest source changed during read: ${path}`);
    }
    const resolvedSource = await realpath(path);
    const sourceRelative = relative(rootRealPath, resolvedSource);
    if (!sourceRelative || sourceRelative.startsWith("..") || isAbsolute(sourceRelative)) {
      throw new Error(`manifest source escapes root through symlink: ${relativePath}`);
    }
    await assertDirectoryChainUnchanged(chain);
    return content;
  } finally {
    await handle.close();
  }
}

export async function materializeFrozenInputManifest(input: {
  sourceRoot: string;
  targetRoot: string;
  inputBundle: IsolatedWorkerInputBundle;
}) {
  await mkdir(input.targetRoot, { recursive: true, mode: 0o755 });
  const initial = await readdir(input.targetRoot);
  if (initial.length !== 0) throw new Error("disposable workspace must be empty before frozen input materialization");
  const copied: IsolatedWorkerInputBundle["items"] = [];
  const createdDirs = new Set<string>();
  for (const file of input.inputBundle.items) {
    if (file.sourceType !== "regular_file") throw new Error(`unsupported input source type: ${file.sourceType}`);
    if (!file.destinationPath.startsWith("inputs/")) throw new Error(`input destination must be under inputs/: ${file.destinationPath}`);
    const target = safePath(input.targetRoot, file.destinationPath);
    const content = await readRegularFileNoFollow(input.sourceRoot, file.sourcePath);
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== file.contentSha256) throw new Error(`input hash mismatch: ${file.sourcePath}`);
    const parent = dirname(target);
    await mkdir(parent, { recursive: true, mode: 0o755 });
    createdDirs.add(parent);
    await writeFile(target, content, { flag: "wx", mode: 0o444 });
    copied.push({ ...file });
  }
  await mkdir(resolve(input.targetRoot, "work"), { mode: 0o700 });
  for (const dir of [...createdDirs].sort((a, b) => b.length - a.length)) await chmod(dir, 0o555);
  await chmod(input.targetRoot, 0o555);
  return { files: copied, workRoot: "work/" as const };
}

async function assertWorkspaceDirectory(root: string) {
  const entry = await lstat(root);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`frozen input workspace is not a directory: ${root}`);
  }
}

export async function prepareFrozenInputWorkspaceForPublish(root: string) {
  await assertWorkspaceDirectory(root);
  await chmod(root, 0o755);
}

export async function sealFrozenInputWorkspace(root: string) {
  await assertWorkspaceDirectory(root);
  await chmod(root, 0o555);
}

async function makeFrozenDirectoryTreeRemovable(root: string): Promise<void> {
  await assertWorkspaceDirectory(root);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeFrozenDirectoryTreeRemovable(resolve(root, entry.name));
    }
  }
  await chmod(root, 0o700);
}

export async function removeFrozenInputWorkspace(root: string) {
  try {
    await makeFrozenDirectoryTreeRemovable(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(root, { recursive: true, force: true });
}

async function listInputFiles(root: string, relativeDir: string): Promise<string[]> {
  const dirPath = resolve(root, relativeDir);
  const dir = await lstat(dirPath);
  if (dir.isSymbolicLink() || !dir.isDirectory()) throw new Error(`materialized input directory is unsafe: ${relativeDir}`);
  const files: string[] = [];
  for (const entry of await readdir(dirPath, { withFileTypes: true })) {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`materialized input contains symlink: ${relativePath}`);
    if (entry.isDirectory()) files.push(...await listInputFiles(root, relativePath));
    else if (entry.isFile()) files.push(relativePath);
    else throw new Error(`materialized input contains special file: ${relativePath}`);
  }
  return files;
}

export async function verifyFrozenInputMaterialization(input: {
  targetRoot: string;
  inputBundle: IsolatedWorkerInputBundle;
}) {
  const topLevel = (await readdir(input.targetRoot)).sort();
  if (topLevel.length !== 2 || topLevel[0] !== "inputs" || topLevel[1] !== "work") {
    throw new Error(`materialized workspace has undeclared top-level entries: ${topLevel.join(",")}`);
  }
  const work = await lstat(resolve(input.targetRoot, "work"));
  if (work.isSymbolicLink() || !work.isDirectory()) throw new Error("materialized work root is unsafe");
  const actualFiles = (await listInputFiles(input.targetRoot, "inputs")).sort();
  const expectedFiles = input.inputBundle.items.map((item) => item.destinationPath).sort();
  if (canonicalPaths(actualFiles) !== canonicalPaths(expectedFiles)) {
    throw new Error("materialized input file set does not match frozen manifest");
  }
  for (const file of input.inputBundle.items) {
    const content = await readRegularFileNoFollow(input.targetRoot, file.destinationPath);
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== file.contentSha256) throw new Error(`materialized input hash mismatch: ${file.destinationPath}`);
  }
}

function canonicalPaths(paths: string[]) {
  return JSON.stringify(paths);
}
