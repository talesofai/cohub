import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { picomatch } from "../hooks/picomatch-shim.js";
import {
  canonicalizeJson,
  compareManifestEntries,
  detectManifestPathCollisions,
  normalizeWorkspacePath,
  validateManifest,
  type WorkspaceManifestEntry,
  type WorkspaceManifestV1,
} from "@cohub/protocol/workspace-replication";

export type WorkspaceSensitiveContentMode = "exclude_with_warning" | "include_with_consent";

export type WorkspaceScanPolicy = {
  policyVersion: number;
  defaultExcludes?: string[];
  customExcludes?: string[];
  sensitiveContentMode?: WorkspaceSensitiveContentMode;
  maxEntries?: number;
  maxFileBytes?: number;
  maxSnapshotBytes?: number;
  hashWorkers?: number;
};

export type WorkspaceScanWarning = {
  path: string;
  type: "sensitive" | "unsupported";
  reason: string;
};

export type WorkspaceScanBlob = {
  path: string;
  sha256: string;
  size: number;
};

export type WorkspaceScanResult = {
  manifest: WorkspaceManifestV1;
  manifestSha256: string;
  treeHash: string;
  blobs: WorkspaceScanBlob[];
  warnings: WorkspaceScanWarning[];
  ignoredCount: number;
  mutationGeneration: number | null;
};

export class WorkspaceScanError extends Error {
  override name = "WorkspaceScanError";
  constructor(
    message: string,
    public readonly code: "workspace_busy" | "scan_incomplete" | "scan_limit" | "path_collision" | "path_unsupported",
    public readonly paths: string[] = [],
  ) {
    super(message);
  }
}

const DEFAULT_MAX_ENTRIES = 2_000_000;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024 * 1024;
const DEFAULT_HASH_WORKERS = 8;
const SENSITIVE_BASENAME = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks)|credentials?(?:\..*)?|secrets?(?:\..*)?|config\.json|auth\.json)$/i;
const SENSITIVE_PATH = /(?:^|\/)(?:\.ssh|\.aws|\.config\/gcloud|\.pi|\.codex|\.claude)(?:\/|$)/i;
const HARD_EXCLUDED = [".git", ".cohub/system"];

const sha256Bytes = (value: Uint8Array | Buffer) => createHash("sha256").update(value).digest("hex");
const sha256Text = (value: string) => sha256Bytes(Buffer.from(value, "utf8"));
const normalizeSlash = (value: string) => value.replace(/\\/g, "/");
const isInside = (root: string, candidate: string) => {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${candidate.includes("\\") ? "\\" : "/"}`) && !isAbsolute(rel));
};

function makeMatcher(patterns: readonly string[]) {
  const matchers = patterns
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map((pattern) => picomatch(pattern, { dot: true }));
  return {
    ignores(path: string) {
      return matchers.some((matcher) => matcher(path) || matcher(`${path}/`));
    },
  };
}

function hardExcluded(path: string, directory: boolean) {
  const parts = path.split("/");
  if (parts.includes(".git")) return true;
  if (parts[0] === ".cohub" && parts[1] === "system") return true;
  return directory && HARD_EXCLUDED.includes(path);
}

function sensitivePath(path: string) {
  return SENSITIVE_BASENAME.test(basename(path)) || SENSITIVE_PATH.test(path);
}

function stableIdentity(stats: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; birthtimeMs: number }) {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs, stats.birthtimeMs].join(":");
}

async function hashStableFile(path: string, relativePath: string, maxFileBytes: number, mutationGeneration?: () => number): Promise<{ sha256: string; size: number }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await lstat(path).catch((error) => {
      throw new WorkspaceScanError(`Unable to stat managed path ${relativePath}: ${error instanceof Error ? error.message : String(error)}`, "scan_incomplete", [relativePath]);
    });
    if (!before.isFile()) throw new WorkspaceScanError(`Managed path changed type while scanning: ${relativePath}`, "workspace_busy", [relativePath]);
    if (!Number.isSafeInteger(before.size) || before.size > maxFileBytes) throw new WorkspaceScanError(`File exceeds the configured limit: ${relativePath}`, "scan_limit", [relativePath]);
    const generationBefore = mutationGeneration?.() ?? null;
    const hash = createHash("sha256");
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createReadStream(path);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", (error) => reject(new WorkspaceScanError(`Unable to read managed path ${relativePath}: ${error instanceof Error ? error.message : String(error)}`, "scan_incomplete", [relativePath])));
      stream.on("end", () => resolvePromise());
    });
    const after = await lstat(path).catch((error) => {
      throw new WorkspaceScanError(`Unable to restat managed path ${relativePath}: ${error instanceof Error ? error.message : String(error)}`, "scan_incomplete", [relativePath]);
    });
    const generationAfter = mutationGeneration?.() ?? null;
    if (stableIdentity(before) === stableIdentity(after) && generationBefore === generationAfter) {
      return { sha256: hash.digest("hex"), size: after.size };
    }
  }
  throw new WorkspaceScanError(`File remained unstable while scanning: ${relativePath}`, "workspace_busy", [relativePath]);
}

export async function scanWorkspaceReplica(rootInput: string, policy: WorkspaceScanPolicy): Promise<WorkspaceScanResult> {
  const root = resolve(rootInput);
  const maxEntries = policy.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxFileBytes = policy.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxSnapshotBytes = policy.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  const hashWorkers = Math.max(1, Math.min(policy.hashWorkers ?? DEFAULT_HASH_WORKERS, 32));
  if (!Number.isSafeInteger(policy.policyVersion) || policy.policyVersion < 1) throw new WorkspaceScanError("Invalid workspace policy version", "scan_incomplete");
  const matcher = makeMatcher([...(policy.defaultExcludes ?? []), ...(policy.customExcludes ?? [])]);
  const entries: Array<WorkspaceManifestEntry & { absPath?: string }> = [];
  const files: Array<{ entryIndex: number; absPath: string }> = [];
  const warnings: WorkspaceScanWarning[] = [];
  const omitted: string[] = [];
  const listings = new Map<string, string>();
  let ignoredCount = 0;
  let totalBytes = 0;
  let mutationGeneration = 0;
  const readGeneration = () => mutationGeneration;
  const startGeneration = readGeneration();

  const listDirectory = async (directory: string) => {
    const names = await readdir(directory).catch((error) => {
      throw new WorkspaceScanError(`Unable to enumerate managed directory ${normalizeSlash(relative(root, directory)) || "."}: ${error instanceof Error ? error.message : String(error)}`, "scan_incomplete", [normalizeSlash(relative(root, directory)) || "."]);
    });
    return names.sort();
  };

  const walk = async (directory: string): Promise<void> => {
    const names = await listDirectory(directory);
    listings.set(directory, names.join("\0"));
    for (const name of names) {
      const absPath = join(directory, name);
      const relRaw = normalizeSlash(relative(root, absPath));
      let rel: string;
      try {
        rel = normalizeWorkspacePath(relRaw);
      } catch (error) {
        throw new WorkspaceScanError(`Unsupported workspace path ${relRaw}: ${error instanceof Error ? error.message : String(error)}`, "path_unsupported", [relRaw]);
      }
      const stats = await lstat(absPath).catch((error) => {
        throw new WorkspaceScanError(`Unable to inspect managed path ${rel}: ${error instanceof Error ? error.message : String(error)}`, "scan_incomplete", [rel]);
      });
      const directoryNode = stats.isDirectory() && !stats.isSymbolicLink();
      if (hardExcluded(rel, directoryNode) || matcher.ignores(directoryNode ? `${rel}/` : rel)) {
        ignoredCount += 1;
        continue;
      }
      if (sensitivePath(rel) && (policy.sensitiveContentMode ?? "exclude_with_warning") === "exclude_with_warning") {
        warnings.push({ path: rel, type: "sensitive", reason: "sensitive_content_policy" });
        omitted.push(rel);
        ignoredCount += 1;
        continue;
      }
      if (entries.length >= maxEntries) throw new WorkspaceScanError(`Workspace exceeds ${maxEntries} entries`, "scan_limit", [rel]);
      if (directoryNode) {
        entries.push({ path: rel, type: "directory" });
        await walk(absPath);
        continue;
      }
      if (stats.isFile()) {
        if (!Number.isSafeInteger(stats.size) || stats.size > maxFileBytes) throw new WorkspaceScanError(`File exceeds the configured limit: ${rel}`, "scan_limit", [rel]);
        totalBytes += stats.size;
        if (totalBytes > maxSnapshotBytes) throw new WorkspaceScanError(`Workspace exceeds the configured byte limit`, "scan_limit", [rel]);
        const entryIndex = entries.length;
        entries.push({ path: rel, type: "file", size: stats.size, sha256: "0".repeat(64), executable: (stats.mode & 0o111) !== 0, absPath });
        files.push({ entryIndex, absPath });
        continue;
      }
      if (stats.isSymbolicLink()) {
        const target = await readlink(absPath).catch((error) => {
          throw new WorkspaceScanError(`Unable to read symlink ${rel}: ${error instanceof Error ? error.message : String(error)}`, "scan_incomplete", [rel]);
        });
        const resolvedTarget = resolve(dirname(absPath), target);
        if (!target || isAbsolute(target) || !isInside(root, resolvedTarget)) {
          warnings.push({ path: rel, type: "unsupported", reason: "unsafe_symlink_target" });
          omitted.push(rel);
          continue;
        }
        entries.push({ path: rel, type: "symlink", symlinkTarget: normalizeSlash(target) });
        continue;
      }
      warnings.push({ path: rel, type: "unsupported", reason: "unsupported_file_type" });
      omitted.push(rel);
    }
  };

  await walk(root);
  // Re-list every directory after the walk. A file created or removed while
  // the tree was being enumerated would otherwise be silently missing from
  // the manifest and later read as a deletion by the planner.
  for (const [directory, before] of listings) {
    const after = (await listDirectory(directory)).join("\0");
    if (after !== before) {
      throw new WorkspaceScanError(`Directory changed during scan: ${normalizeSlash(relative(root, directory)) || "."}`, "workspace_busy", [normalizeSlash(relative(root, directory)) || "."]);
    }
  }
  const workers = Math.min(hashWorkers, files.length);
  let nextFile = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (true) {
      const index = nextFile++;
      const file = files[index];
      if (!file) return;
      const result = await hashStableFile(file.absPath, (entries[file.entryIndex] as WorkspaceManifestEntry).path, maxFileBytes, readGeneration);
      const entry = entries[file.entryIndex];
      if (entry?.type !== "file") throw new WorkspaceScanError("Scanner index changed unexpectedly", "scan_incomplete");
      entry.sha256 = result.sha256;
      entry.size = result.size;
    }
  }));
  if (readGeneration() !== startGeneration) throw new WorkspaceScanError("Workspace changed during scan", "workspace_busy");

  const cleanEntries = entries.map(({ absPath: _absPath, ...entry }) => entry);
  const collisions = detectManifestPathCollisions(cleanEntries);
  if (collisions.length > 0) throw new WorkspaceScanError("Workspace contains colliding normalized paths", "path_collision", collisions.flatMap((collision) => collision.paths));
  const manifest = validateManifest({
    version: 1,
    policyVersion: policy.policyVersion,
    scanPolicyHash: sha256Text(canonicalizeJson({
      defaultExcludes: policy.defaultExcludes ?? [],
      customExcludes: policy.customExcludes ?? [],
      sensitiveContentMode: policy.sensitiveContentMode ?? "exclude_with_warning",
      maxEntries,
      maxFileBytes,
      maxSnapshotBytes,
    })),
    entries: cleanEntries.sort(compareManifestEntries),
    boundaries: [],
    portableGitState: null,
    omitted,
  });
  const canonicalManifest = canonicalizeJson(manifest);
  const manifestSha256 = sha256Text(canonicalManifest);
  const treeHash = sha256Text(canonicalizeJson({
    scanPolicyHash: manifest.scanPolicyHash,
    entries: manifest.entries,
    boundaries: manifest.boundaries,
    portableGitState: manifest.portableGitState,
  }));
  return {
    manifest,
    manifestSha256,
    treeHash,
    blobs: manifest.entries.filter((entry): entry is Extract<WorkspaceManifestEntry, { type: "file" }> => entry.type === "file").map((entry) => ({ path: entry.path, sha256: entry.sha256, size: entry.size })),
    warnings,
    ignoredCount,
    mutationGeneration: null,
  };
}
