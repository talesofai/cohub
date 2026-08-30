import { z } from "zod";

export const WORKSPACE_REPLICATION_PROTOCOL_VERSION = 1 as const;
export const WORKSPACE_MANIFEST_VERSION = 1 as const;
export const WORKSPACE_RECONCILE_PLAN_VERSION = 1 as const;
export const WORKSPACE_MAX_DELETION_COUNT = 1_000;
export const WORKSPACE_MAX_DELETION_RATIO = 0.2;

export type WorkspaceSyncJobData = {
  cycleId: string;
  spaceId: string;
  replicaId: string;
  requestId?: string | null;
};

export type WorkspaceReplicaKind = "cloud" | "local";
export type WorkspaceReplicaStatus =
  | "attaching"
  | "ready"
  | "syncing"
  | "conflicted"
  | "offline"
  | "error"
  | "detached";
export type WorkspaceSyncMode =
  | "two_way_safe"
  | "one_way_to_cloud"
  | "one_way_to_local"
  | "handoff";
export type WorkspaceSnapshotStatus =
  | "uploading"
  | "uploaded"
  | "verifying"
  | "ready"
  | "rejected"
  | "gc_pending";
export type WorkspaceConflictKind =
  | "content"
  | "delete_modify"
  | "type"
  | "case_collision"
  | "path_normalization"
  | "path_unsupported"
  | "git_ref"
  | "scan_policy";
export type WorkspaceConflictStatus = "open" | "resolved" | "discarded";
export type WorkspaceConflictResolution =
  | "local"
  | "cloud"
  | "merged"
  | "deleted"
  | "keep_managed"
  | "unmanage";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const NonNegativeIntegerSchema = z.number().int().nonnegative();

export const WorkspaceManifestEntrySchema = z.discriminatedUnion("type", [
  z.object({
    path: z.string().min(1),
    type: z.literal("directory"),
  }).strict(),
  z.object({
    path: z.string().min(1),
    type: z.literal("file"),
    size: NonNegativeIntegerSchema,
    sha256: Sha256Schema,
    executable: z.boolean(),
  }).strict(),
  z.object({
    path: z.string().min(1),
    type: z.literal("symlink"),
    symlinkTarget: z.string().min(1),
  }).strict(),
]);

export type WorkspaceManifestEntry = z.infer<typeof WorkspaceManifestEntrySchema>;

export const WorkspaceManifestBoundarySchema = z.object({
  path: z.string().min(1),
  mode: z.enum(["unmanaged_outer", "same_space_nested"]),
  replicaId: z.string().min(1).optional(),
}).strict();

export type WorkspaceManifestBoundary = z.infer<typeof WorkspaceManifestBoundarySchema>;

export const WorkspaceManifestSchema = z.object({
  version: z.literal(WORKSPACE_MANIFEST_VERSION),
  policyVersion: NonNegativeIntegerSchema,
  scanPolicyHash: Sha256Schema,
  entries: z.array(WorkspaceManifestEntrySchema),
  boundaries: z.array(WorkspaceManifestBoundarySchema).default([]),
  portableGitState: z.record(z.string(), z.unknown()).nullable().default(null),
}).strict();

export type WorkspaceManifestV1 = z.infer<typeof WorkspaceManifestSchema>;

export const WorkspaceSnapshotDescriptorSchema = z.object({
  version: z.literal(WORKSPACE_REPLICATION_PROTOCOL_VERSION),
  snapshotId: z.string().min(1),
  replicaId: z.string().min(1),
  replicaGeneration: NonNegativeIntegerSchema,
  parentSnapshotId: z.string().min(1).nullable(),
  baseCanonicalSnapshotId: z.string().min(1).nullable(),
  policyVersion: NonNegativeIntegerSchema,
  executionAttemptId: z.string().min(1).nullable(),
  manifestSha256: Sha256Schema,
  manifestTransportSha256: Sha256Schema,
  manifestTransportBytes: NonNegativeIntegerSchema,
  manifestUncompressedBytes: NonNegativeIntegerSchema,
  fileCount: NonNegativeIntegerSchema,
  totalBytes: NonNegativeIntegerSchema,
}).strict();

export type WorkspaceSnapshotDescriptorV1 = z.infer<typeof WorkspaceSnapshotDescriptorSchema>;

export type WorkspaceReconcileOperation = {
  path: string;
  action: "apply_local_to_cloud" | "apply_cloud_to_local" | "delete_local" | "delete_cloud";
  entry: WorkspaceManifestEntry | null;
  expectedBase: WorkspaceManifestEntry | null;
};

export type WorkspaceReconcileConflict = {
  path: string;
  kind: WorkspaceConflictKind;
  base: WorkspaceManifestEntry | null;
  local: WorkspaceManifestEntry | null;
  cloud: WorkspaceManifestEntry | null;
};

export type WorkspaceReconcileResult = {
  version: typeof WORKSPACE_RECONCILE_PLAN_VERSION;
  operations: WorkspaceReconcileOperation[];
  conflicts: WorkspaceReconcileConflict[];
  unchangedPaths: string[];
};

/**
 * RFC 8785-compatible canonical JSON for JSON values accepted by the protocol.
 * JavaScript's JSON number/string serialization is the ECMAScript serialization
 * required by JCS; object keys use the specified UTF-16 lexicographic order.
 */
export function canonicalizeJson(value: unknown): string {
  const encode = (input: unknown): string => {
    if (input === null) return "null";
    if (typeof input === "string") return JSON.stringify(input);
    if (typeof input === "boolean") return input ? "true" : "false";
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new TypeError("JCS does not support non-finite numbers");
      const encoded = JSON.stringify(input);
      if (encoded === undefined) throw new TypeError("JCS number serialization failed");
      return encoded;
    }
    if (Array.isArray(input)) {
      return `[${input.map((item) => encode(item)).join(",")}]`;
    }
    if (typeof input === "object") {
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("JCS accepts plain JSON objects only");
      }
      const record = input as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((key) => {
        const nested = record[key];
        if (nested === undefined || typeof nested === "function" || typeof nested === "symbol") {
          throw new TypeError(`JCS value at key ${key} is not JSON data`);
        }
        return `${JSON.stringify(key)}:${encode(nested)}`;
      }).join(",")}}`;
    }
    throw new TypeError(`JCS cannot encode ${typeof input}`);
  };

  return encode(value);
}

export const canonicalizeJsonBytes = (value: unknown): Uint8Array =>
  new TextEncoder().encode(canonicalizeJson(value));

const compareUtf8Bytes = (left: string, right: string): number => {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
};

/** Sort manifest paths by UTF-8 bytes, with parents before descendants. */
export const compareManifestEntries = (
  left: Pick<WorkspaceManifestEntry, "path" | "type">,
  right: Pick<WorkspaceManifestEntry, "path" | "type">,
): number => {
  const pathOrder = compareUtf8Bytes(left.path, right.path);
  if (pathOrder !== 0) return pathOrder;
  return left.type.localeCompare(right.type);
};

const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const isPortablePathSegment = (part: string) => {
  if (!part || new TextEncoder().encode(part).byteLength > 255 || part === "." || part === ".." || part.split("").some((char) => char.charCodeAt(0) <= 0x1f)) return false;
  if (part.endsWith(".") || part.endsWith(" ")) return false;
  return !WINDOWS_RESERVED_BASENAME.test(part);
};

const normalizedPath = (value: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error("path_empty");
  if (value.includes("\\") || value.includes("\0")) throw new Error("path_unsafe");
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) throw new Error("path_absolute");
  const normalized = value.normalize("NFC");
  if (new TextEncoder().encode(normalized).byteLength > 4096) throw new Error("path_too_long");
  if (normalized.split("/").some((part) => !isPortablePathSegment(part))) throw new Error("path_segments_unsafe");
  return normalized;
};

export const normalizeWorkspacePath = normalizedPath;

export function validateManifest(manifest: WorkspaceManifestV1): WorkspaceManifestV1 {
  const parsed = WorkspaceManifestSchema.parse(manifest);
  const paths = new Set<string>();
  const normalized = parsed.entries.map((entry) => {
    const path = normalizedPath(entry.path);
    if (path !== entry.path) throw new Error("path_normalization_conflict");
    if (paths.has(path)) throw new Error(`path_duplicate:${path}`);
    paths.add(path);
    if (entry.type === "symlink") {
      const target = entry.symlinkTarget.normalize("NFC");
      if (target.startsWith("/") || target.includes("\\") || target.split("/").some((part) => !isPortablePathSegment(part))) {
        throw new Error(`symlink_unsafe:${path}`);
      }
    }
    return entry.type === "symlink" ? { ...entry, path, symlinkTarget: entry.symlinkTarget.normalize("NFC") } : { ...entry, path };
  });
  const collisions = detectManifestPathCollisions(normalized);
  if (collisions.length > 0) throw new Error(`path_collision:${collisions[0]?.paths.join(",") ?? "unknown"}`);
  const sorted = [...normalized].sort(compareManifestEntries);
  return { ...parsed, entries: sorted, boundaries: [...parsed.boundaries].sort((a, b) => compareUtf8Bytes(a.path, b.path)) };
}

export function detectManifestPathCollisions(
  entries: readonly Pick<WorkspaceManifestEntry, "path">[],
): Array<{ kind: "case" | "normalization"; paths: string[] }> {
  const collisions: Array<{ kind: "case" | "normalization"; paths: string[] }> = [];
  const byCase = new Map<string, string[]>();
  const byNfc = new Map<string, string[]>();
  for (const entry of entries) {
    const nfc = entry.path.normalize("NFC");
    const folded = nfc.toLocaleLowerCase("en-US");
    byNfc.set(nfc, [...(byNfc.get(nfc) ?? []), entry.path]);
    byCase.set(folded, [...(byCase.get(folded) ?? []), entry.path]);
  }
  for (const paths of byNfc.values()) if (new Set(paths).size > 1) collisions.push({ kind: "normalization", paths });
  for (const paths of byCase.values()) if (new Set(paths).size > 1) collisions.push({ kind: "case", paths });
  return collisions;
}

const entryEqual = (left: WorkspaceManifestEntry | null, right: WorkspaceManifestEntry | null): boolean =>
  (left === null && right === null) || (left !== null && right !== null && canonicalizeJson(left) === canonicalizeJson(right));

const manifestMap = (manifest: WorkspaceManifestV1 | null): Map<string, WorkspaceManifestEntry> =>
  new Map((manifest?.entries ?? []).map((entry) => [entry.path, entry]));

/**
 * Build a deterministic path-based three-way plan. The planner never guesses
 * a delete/modify or type conflict and never drops a version from the result.
 */
export function reconcileWorkspaceManifests(input: {
  base: WorkspaceManifestV1 | null;
  local: WorkspaceManifestV1;
  cloud: WorkspaceManifestV1;
}): WorkspaceReconcileResult {
  const base = manifestMap(input.base);
  const local = manifestMap(input.local);
  const cloud = manifestMap(input.cloud);
  const paths = [...new Set([...base.keys(), ...local.keys(), ...cloud.keys()])].sort(compareUtf8Bytes);
  const operations: WorkspaceReconcileOperation[] = [];
  const conflicts: WorkspaceReconcileConflict[] = [];
  const unchangedPaths: string[] = [];

  for (const path of paths) {
    const b = base.get(path) ?? null;
    const l = local.get(path) ?? null;
    const c = cloud.get(path) ?? null;
    if (entryEqual(l, c)) {
      unchangedPaths.push(path);
      continue;
    }
    if (entryEqual(l, b)) {
      if (c === null) operations.push({ path, action: "delete_local", entry: null, expectedBase: b });
      else operations.push({ path, action: "apply_cloud_to_local", entry: c, expectedBase: b });
      continue;
    }
    if (entryEqual(c, b)) {
      if (l === null) operations.push({ path, action: "delete_cloud", entry: null, expectedBase: b });
      else operations.push({ path, action: "apply_local_to_cloud", entry: l, expectedBase: b });
      continue;
    }
    conflicts.push({ path, kind: l === null || c === null ? "delete_modify" : l.type !== c.type ? "type" : "content", base: b, local: l, cloud: c });
  }

  return {
    version: WORKSPACE_RECONCILE_PLAN_VERSION,
    operations,
    conflicts,
    unchangedPaths,
  };
}

export function manifestTreeHash(manifest: WorkspaceManifestV1): Promise<string> {
  return manifestTreeHashAsync(manifest);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function canonicalJsonSha256(value: unknown): Promise<string> {
  return sha256Hex(canonicalizeJsonBytes(value));
}

export async function manifestTreeHashAsync(manifest: WorkspaceManifestV1): Promise<string> {
  const validated = validateManifest(manifest);
  return canonicalJsonSha256({
    scanPolicyHash: validated.scanPolicyHash,
    entries: validated.entries,
    boundaries: validated.boundaries,
    portableGitState: validated.portableGitState,
  });
}

export const workspaceSnapshotStatusIsTerminal = (status: WorkspaceSnapshotStatus): boolean =>
  status === "ready" || status === "rejected" || status === "gc_pending";

export const workspaceConflictIsOpen = (status: WorkspaceConflictStatus): boolean => status === "open";
