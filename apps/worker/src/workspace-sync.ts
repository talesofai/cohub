import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Job } from "bullmq";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  spaceWorkspacePolicies,
  workspaceBlobs,
  workspaceExecutionAttempts,
  workspaceReplicas,
  workspaceSnapshotBlobs,
  workspaceSnapshots,
  workspaceState,
  workspaceSyncConflicts,
  workspaceSyncCycles,
  workspaceWriterLeases,
} from "@cohub/db";
import {
  WORKSPACE_MAX_DELETION_COUNT,
  WORKSPACE_MAX_DELETION_RATIO,
  WorkspaceManifestSchema,
  canonicalizeJson,
  canonicalJsonSha256,
  reconcileWorkspaceManifests,
  validateManifest,
  type WorkspaceManifestEntry,
  type WorkspaceManifestV1,
  type WorkspaceSyncJobData,
} from "@cohub/protocol";
import { scanWorkspaceReplica, WorkspaceScanError } from "@cohub/core/workspace-replication";
import { createLogger } from "@cohub/infra/logging";
import { config } from "./config.js";
import { db } from "./db.js";
import { publishWorkspaceStateUpdated } from "./workspace-realtime.js";
import { acquireWorkspacePhysicalLock } from "./workspace-physical-lock.js";

const logger = createLogger({ serviceName: "cohub-worker-workspace-sync" });

const INLINE_MANIFEST_MAX_BYTES = 1 * 1024 * 1024;
const isTerminal = (status: string) => ["completed", "conflicted", "failed", "cancelled"].includes(status);
const terminalAttemptTurn = sql`exists (
  select 1 from v2.session_turns attempt_turn
  where attempt_turn.id = v2.workspace_execution_attempts.turn_id
    and attempt_turn.status in ('completed', 'failed', 'interrupted', 'cancelled', 'merged')
)`;
const sha256Text = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const deterministicUuid = (domain: string, value: string) => {
  const bytes = createHash("sha256").update(`cohub-${domain}-v1\0${value}`, "utf8").digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
const workspaceObjectPrefix = () => config.env === "prod" ? "" : `${config.env}/`;
const buildWorkspaceObjectKey = (input: { spaceId: string; kind: "manifest" | "blob"; identity: string }) =>
  `${workspaceObjectPrefix()}local-agent/${input.kind}/${input.spaceId}/${input.identity}`;

function scanOptions(policy: typeof spaceWorkspacePolicies.$inferSelect) {
  const limits = policy.limits as Record<string, unknown>;
  return {
    policyVersion: policy.policyVersion,
    defaultExcludes: policy.defaultExcludes,
    customExcludes: policy.customExcludes,
    sensitiveContentMode: policy.sensitiveContentMode as "exclude_with_warning" | "include_with_consent",
    maxEntries: Number(limits.maxEntries ?? 2_000_000),
    maxFileBytes: Number(limits.maxFileBytes ?? 5 * 1024 * 1024 * 1024),
    maxSnapshotBytes: Number(limits.maxSnapshotBytes ?? 100 * 1024 * 1024 * 1024),
  };
}


let objectClient: S3Client | null = null;
const getObjectClient = () => {
  if (!config.workspaceObjectEndpoint || !config.workspaceObjectBucket || !config.workspaceObjectAccessKeyId || !config.workspaceObjectSecretAccessKey) {
    throw new Error("workspace object storage is not configured on worker");
  }
  objectClient ??= new S3Client({
    endpoint: config.workspaceObjectEndpoint,
    region: config.workspaceObjectRegion,
    forcePathStyle: false,
    credentials: {
      accessKeyId: config.workspaceObjectAccessKeyId,
      secretAccessKey: config.workspaceObjectSecretAccessKey,
    },
  });
  return objectClient;
};

async function readWorkspaceBlob(objectKey: string, expectedSize: number, expectedSha256: string): Promise<Buffer> {
  const response = await getObjectClient().send(new GetObjectCommand({ Bucket: config.workspaceObjectBucket, Key: objectKey }));
  if (!response.Body) throw new Error("workspace blob has no body");
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  if (bytes.length !== expectedSize) throw new Error(`workspace blob size mismatch for ${expectedSha256}`);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== expectedSha256) throw new Error(`workspace blob hash mismatch for ${expectedSha256}`);
  return bytes;
}

function targetPath(root: string, path: string) {
  const parts = path.split("/");
  const candidate = resolve(root, ...parts);
  const rootWithSlash = `${resolve(root)}${root.endsWith("/") ? "" : "/"}`;
  if (candidate !== resolve(root) && !candidate.startsWith(rootWithSlash)) throw new Error(`unsafe workspace target ${path}`);
  return candidate;
}

async function syncFile(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeExisting(path: string) {
  await rm(path, { recursive: true, force: true });
}

async function applyEntry(input: {
  root: string;
  entry: WorkspaceManifestEntry;
  blobByPath: Map<string, typeof workspaceBlobs.$inferSelect>;
  cycleId: string;
}) {
  const destination = targetPath(input.root, input.entry.path);
  if (input.entry.type === "directory") {
    await removeExisting(destination);
    await mkdir(destination, { recursive: true, mode: 0o775 });
    return;
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o775 });
  await removeExisting(destination);
  if (input.entry.type === "symlink") {
    await symlink(input.entry.symlinkTarget, destination);
    return;
  }
  const blob = input.blobByPath.get(input.entry.path);
  if (!blob) throw new Error(`workspace blob mapping is missing for ${input.entry.path}`);
  const bytes = await readWorkspaceBlob(blob.objectKey, blob.size, blob.sha256);
  const fileEntry = input.entry;
  if (fileEntry.type !== "file") throw new Error(`workspace entry changed type for ${input.entry.path}`);
  const temporary = `${destination}.cohub-${input.cycleId}.tmp`;
  await writeFile(temporary, bytes, { mode: fileEntry.executable ? 0o775 : 0o664, flag: "wx" }).catch(async (error) => {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
    await writeFile(temporary, bytes, { mode: fileEntry.executable ? 0o775 : 0o664, flag: "w" });
  });
  await chmod(temporary, fileEntry.executable ? 0o775 : 0o664);
  await syncFile(temporary);
  await rename(temporary, destination);
}

async function applyDelete(root: string, path: string) {
  await removeExisting(targetPath(root, path));
}

function parseManifest(value: unknown): WorkspaceManifestV1 {
  return validateManifest(WorkspaceManifestSchema.parse(value));
}

async function objectContentMatches(input: { objectKey: string; expectedSize: number; expectedSha256: string }) {
  const response = await getObjectClient().send(new GetObjectCommand({ Bucket: config.workspaceObjectBucket, Key: input.objectKey }));
  if (!response.Body) return false;
  const hash = createHash("sha256");
  let size = 0;
  const body = response.Body as unknown as AsyncIterable<Uint8Array>;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > input.expectedSize) return false;
    hash.update(chunk);
  }
  return size === input.expectedSize && hash.digest("hex") === input.expectedSha256;
}

async function ensureCloudBlob(input: { spaceId: string; root: string; entry: Extract<WorkspaceManifestEntry, { type: "file" }> }) {
  const objectKey = buildWorkspaceObjectKey({ spaceId: input.spaceId, kind: "blob", identity: input.entry.sha256 });
  const s3 = getObjectClient();
  let present = false;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: config.workspaceObjectBucket, Key: objectKey }));
    if (head.ContentLength === input.entry.size && head.Metadata?.sha256 === input.entry.sha256) {
      present = true;
    } else if (head.ContentLength === input.entry.size) {
      // Older local uploads did not carry object metadata. Verify them once
      // before allowing the content-addressed row to be reused.
      present = await objectContentMatches({ objectKey, expectedSize: input.entry.size, expectedSha256: input.entry.sha256 });
    }
  } catch {
    present = false;
  }
  if (!present) {
    await s3.send(new PutObjectCommand({
      Bucket: config.workspaceObjectBucket,
      Key: objectKey,
      Body: createReadStream(targetPath(input.root, input.entry.path)),
      ContentLength: input.entry.size,
      ContentType: "application/octet-stream",
      Metadata: { sha256: input.entry.sha256 },
    }));
    if (!await objectContentMatches({ objectKey, expectedSize: input.entry.size, expectedSha256: input.entry.sha256 })) {
      throw new Error(`uploaded cloud blob failed verification for ${input.entry.path}`);
    }
  }
  const verifiedAt = new Date();
  const [row] = await db.insert(workspaceBlobs).values({
    spaceId: input.spaceId,
    sha256: input.entry.sha256,
    size: input.entry.size,
    objectKey,
    contentType: "application/octet-stream",
    status: "ready",
    verifiedAt,
  }).onConflictDoUpdate({
    target: [workspaceBlobs.spaceId, workspaceBlobs.sha256],
    set: { size: input.entry.size, objectKey, status: "ready", verifiedAt, updatedAt: verifiedAt },
  }).returning();
  if (!row) throw new Error(`failed to persist cloud blob ${input.entry.sha256}`);
  return row;
}

async function persistCloudSnapshot(input: {
  snapshotId: string;
  spaceId: string;
  root: string;
  cloudReplicaId: string;
  manifest: WorkspaceManifestV1;
  treeHash: string;
  source: string;
  parentSnapshotId: string | null;
  baseCanonicalSnapshotId: string | null;
  executionAttemptId: string | null;
  generation: number;
}) {
  const snapshotId = input.snapshotId;
  const canonical = canonicalizeJson(input.manifest);
  const canonicalBytes = Buffer.from(canonical, "utf8");
  const manifestSha256 = sha256Text(canonical);
  const manifestObjectKey = buildWorkspaceObjectKey({
    spaceId: input.spaceId,
    kind: "manifest",
    identity: `${snapshotId}.json`,
  });
  const manifestInline = canonicalBytes.byteLength <= INLINE_MANIFEST_MAX_BYTES
    ? input.manifest as unknown as Record<string, unknown>
    : null;
  const expectedFileCount = input.manifest.entries.filter((entry) => entry.type === "file").length;
  const expectedTotalBytes = input.manifest.entries.reduce((sum, entry) => sum + (entry.type === "file" ? entry.size : 0), 0);
  const [existing] = await db.select().from(workspaceSnapshots).where(and(
    eq(workspaceSnapshots.id, snapshotId),
    eq(workspaceSnapshots.spaceId, input.spaceId),
    eq(workspaceSnapshots.replicaId, input.cloudReplicaId),
  )).limit(1);
  let snapshot = existing;
  if (snapshot) {
    if (
      snapshot.replicaGeneration !== input.generation
      || snapshot.parentSnapshotId !== input.parentSnapshotId
      || snapshot.baseCanonicalSnapshotId !== input.baseCanonicalSnapshotId
      || snapshot.manifestSha256 !== manifestSha256
      || snapshot.treeHash !== input.treeHash
      || snapshot.source !== input.source
      || snapshot.sourceExecutionAttemptId !== input.executionAttemptId
    ) {
      throw new Error(`cloud snapshot ${snapshotId} was reused with different provenance or content`);
    }
    if (snapshot.status === "rejected" || snapshot.status === "gc_pending") {
      throw new Error(`cloud snapshot ${snapshotId} is not recoverable from status ${snapshot.status}`);
    }
  } else {
    [snapshot] = await db.insert(workspaceSnapshots).values({
      id: snapshotId,
      spaceId: input.spaceId,
      replicaId: input.cloudReplicaId,
      replicaGeneration: input.generation,
      parentSnapshotId: input.parentSnapshotId,
      baseCanonicalSnapshotId: input.baseCanonicalSnapshotId,
      workspacePolicyVersion: input.manifest.policyVersion,
      manifestVersion: input.manifest.version,
      manifestObjectKey,
      manifestInline,
      manifestSha256,
      manifestTransportSha256: manifestSha256,
      manifestTransportBytes: canonicalBytes.byteLength,
      treeHash: input.treeHash,
      fileCount: expectedFileCount,
      totalBytes: expectedTotalBytes,
      source: input.source,
      sourceExecutionAttemptId: input.executionAttemptId,
      status: "uploading",
    }).returning();
  }
  if (!snapshot) throw new Error("failed to persist cloud workspace snapshot");

  // A snapshot is not publishable until its manifest and every referenced blob
  // are present and verified. Leaving an interrupted row in `uploading` gives
  // the sweeper a durable recovery signal instead of exposing a partial tree.
  if (!manifestInline) {
    await getObjectClient().send(new PutObjectCommand({
      Bucket: config.workspaceObjectBucket,
      Key: manifestObjectKey,
      Body: canonicalBytes,
      ContentLength: canonicalBytes.byteLength,
      ContentType: "application/json",
      Metadata: { sha256: manifestSha256 },
    }));
    if (!await objectContentMatches({ objectKey: manifestObjectKey, expectedSize: canonicalBytes.byteLength, expectedSha256: manifestSha256 })) {
      throw new Error(`uploaded cloud manifest failed verification for ${snapshotId}`);
    }
  }

  const fileEntries = input.manifest.entries.filter((entry): entry is Extract<WorkspaceManifestEntry, { type: "file" }> => entry.type === "file");
  for (const entry of fileEntries) {
    const blob = await ensureCloudBlob({ spaceId: input.spaceId, root: input.root, entry });
    await db.insert(workspaceSnapshotBlobs).values({ snapshotId: snapshot.id, blobId: blob.id, path: entry.path }).onConflictDoNothing();
  }
  const [ready] = await db.update(workspaceSnapshots).set({ status: "ready", updatedAt: new Date() }).where(and(
    eq(workspaceSnapshots.id, snapshot.id),
    eq(workspaceSnapshots.spaceId, input.spaceId),
    sql`${workspaceSnapshots.status} in ('uploading', 'uploaded', 'verifying', 'ready')`,
  )).returning();
  if (!ready) throw new Error(`failed to publish cloud workspace snapshot ${snapshotId}`);
  return ready;
}

async function loadSnapshotManifest(snapshotId: string | null): Promise<WorkspaceManifestV1 | null> {
  if (!snapshotId) return null;
  const [row] = await db.select({
    manifestInline: workspaceSnapshots.manifestInline,
    manifestObjectKey: workspaceSnapshots.manifestObjectKey,
    manifestSha256: workspaceSnapshots.manifestSha256,
    manifestTransportBytes: workspaceSnapshots.manifestTransportBytes,
    manifestTransportSha256: workspaceSnapshots.manifestTransportSha256,
    status: workspaceSnapshots.status,
  }).from(workspaceSnapshots).where(eq(workspaceSnapshots.id, snapshotId)).limit(1);
  if (!row) return null;
  if (row.status !== "ready") throw new Error(`workspace snapshot ${snapshotId} is not ready`);
  if (row.manifestInline) {
    const manifest = parseManifest(row.manifestInline);
    const canonicalHash = await canonicalJsonSha256(manifest);
    if (canonicalHash !== row.manifestSha256) throw new Error(`workspace manifest canonical hash mismatch for ${snapshotId}`);
    const transportBytes = Buffer.from(canonicalizeJson(manifest), "utf8");
    if (row.manifestTransportBytes != null && transportBytes.byteLength !== row.manifestTransportBytes) {
      throw new Error(`workspace manifest transport size mismatch for ${snapshotId}`);
    }
    if (row.manifestTransportSha256 && sha256Text(transportBytes.toString("utf8")) !== row.manifestTransportSha256) {
      throw new Error(`workspace manifest transport hash mismatch for ${snapshotId}`);
    }
    return manifest;
  }
  const response = await getObjectClient().send(new GetObjectCommand({
    Bucket: config.workspaceObjectBucket,
    Key: row.manifestObjectKey,
  }));
  if (!response.Body) throw new Error(`workspace manifest object is empty for ${snapshotId}`);
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  if (bytes.byteLength > 64 * 1024 * 1024) throw new Error(`workspace manifest exceeds 64 MiB for ${snapshotId}`);
  if (row.manifestTransportBytes != null && bytes.byteLength !== row.manifestTransportBytes) {
    throw new Error(`workspace manifest transport size mismatch for ${snapshotId}`);
  }
  if (row.manifestTransportSha256 && sha256Text(bytes.toString("utf8")) !== row.manifestTransportSha256) {
    throw new Error(`workspace manifest transport hash mismatch for ${snapshotId}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`workspace manifest JSON is invalid for ${snapshotId}`);
  }
  const manifest = parseManifest(value);
  const canonicalHash = await canonicalJsonSha256(manifest);
  if (canonicalHash !== row.manifestSha256) throw new Error(`workspace manifest canonical hash mismatch for ${snapshotId}`);
  return manifest;
}

async function recordConflicts(input: { cycleId: string; spaceId: string; conflicts: ReturnType<typeof reconcileWorkspaceManifests>["conflicts"] }) {
  if (input.conflicts.length === 0) return;
  const hashes = [...new Set(input.conflicts.flatMap((conflict) => [conflict.base, conflict.local, conflict.cloud])
    .filter((entry): entry is Extract<WorkspaceManifestEntry, { type: "file" }> => entry?.type === "file")
    .map((entry) => entry.sha256))];
  const blobs = hashes.length > 0
    ? await db.select({ sha256: workspaceBlobs.sha256, objectKey: workspaceBlobs.objectKey }).from(workspaceBlobs).where(and(
        eq(workspaceBlobs.spaceId, input.spaceId),
        inArray(workspaceBlobs.sha256, hashes),
      ))
    : [];
  const objectKeyByHash = new Map(blobs.map((blob) => [blob.sha256, blob.objectKey]));
  const objectKey = (entry: WorkspaceManifestEntry | null) => entry?.type === "file" ? objectKeyByHash.get(entry.sha256) ?? null : null;
  await db.insert(workspaceSyncConflicts).values(input.conflicts.map((conflict) => ({
    cycleId: input.cycleId,
    spaceId: input.spaceId,
    path: conflict.path,
    kind: conflict.kind,
    baseEntry: conflict.base as Record<string, unknown> | null,
    localEntry: conflict.local as Record<string, unknown> | null,
    cloudEntry: conflict.cloud as Record<string, unknown> | null,
    baseObjectKey: objectKey(conflict.base),
    localObjectKey: objectKey(conflict.local),
    cloudObjectKey: objectKey(conflict.cloud),
    status: "open" as const,
  }))).onConflictDoNothing();
}

async function applyPersistedConflictResolutions(input: {
  cycleId: string;
  plan: ReturnType<typeof reconcileWorkspaceManifests>;
}) {
  const resolutions = await db.select({
    path: workspaceSyncConflicts.path,
    resolution: workspaceSyncConflicts.resolution,
  }).from(workspaceSyncConflicts).where(and(
    eq(workspaceSyncConflicts.cycleId, input.cycleId),
    eq(workspaceSyncConflicts.status, "resolved"),
  ));
  if (resolutions.length === 0) return input.plan;
  const operations = input.plan.operations.filter((operation) => !resolutions.some((resolution) => resolution.path === operation.path));
  const conflicts = input.plan.conflicts.filter((conflict) => !resolutions.some((resolution) => resolution.path === conflict.path));
  for (const resolution of resolutions) {
    const conflict = input.plan.conflicts.find((candidate) => candidate.path === resolution.path);
    if (!conflict) continue;
    const kind = resolution.resolution;
    if (kind === "local" || kind === "keep_managed") {
      operations.push(conflict.local === null
        ? { path: conflict.path, action: "delete_cloud", entry: null, expectedBase: conflict.base }
        : { path: conflict.path, action: "apply_local_to_cloud", entry: conflict.local, expectedBase: conflict.base });
    } else if (kind === "deleted") {
      operations.push({ path: conflict.path, action: "delete_cloud", entry: null, expectedBase: conflict.base });
    } else if (kind === "cloud") {
      // Cloud already contains the selected value. The local replica will
      // receive the resulting canonical snapshot on its next apply.
    } else if (kind === "unmanage") {
      throw new Error("unmanage resolution requires a confirmed workspace policy update");
    } else {
      throw new Error(`unsupported persisted workspace resolution ${String(kind)}`);
    }
  }
  return { ...input.plan, operations, conflicts };
}

function mergedManifest(input: { cloud: WorkspaceManifestV1; local: WorkspaceManifestV1; plan: ReturnType<typeof reconcileWorkspaceManifests> }): WorkspaceManifestV1 {
  const entries = new Map(input.cloud.entries.map((entry) => [entry.path, entry]));
  const localEntries = new Map(input.local.entries.map((entry) => [entry.path, entry]));
  for (const operation of input.plan.operations) {
    if (operation.action === "apply_local_to_cloud") {
      const entry = localEntries.get(operation.path);
      if (entry) entries.set(operation.path, entry);
    } else if (operation.action === "delete_cloud") {
      entries.delete(operation.path);
    }
  }
  return validateManifest({
    ...input.cloud,
    entries: [...entries.values()],
  });
}

type ApplyJournalEntry = {
  path: string;
  existed: boolean;
};

type ApplyJournal = {
  rollback: () => Promise<void>;
  cleanup: () => Promise<void>;
};

const pathDepth = (value: string) => value.split("/").length;
const applyJournalRoot = (spaceId: string, cycleId: string) => join(config.spaceSystemRoot, "workspace-apply-journal", spaceId, cycleId);

async function copyWorkspaceNode(source: string, destination: string) {
  const info = await lstat(source);
  await mkdir(dirname(destination), { recursive: true, mode: 0o775 });
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
    return;
  }
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: info.mode & 0o777 });
    for (const child of await readdir(source)) {
      await copyWorkspaceNode(join(source, child), join(destination, child));
    }
    return;
  }
  if (!info.isFile()) throw new Error(`unsupported workspace node in apply journal: ${source}`);
  await cp(source, destination, { force: false, errorOnExist: true, preserveTimestamps: true });
  await chmod(destination, info.mode & 0o777);
  await syncFile(destination);
}

async function rollbackApplyJournal(root: string, stageRoot: string, entries: ApplyJournalEntry[]) {
  const restored: string[] = [];
  for (const entry of entries) {
    if (restored.some((ancestor) => entry.path === ancestor || entry.path.startsWith(`${ancestor}/`))) continue;
    const destination = targetPath(root, entry.path);
    await rm(destination, { recursive: true, force: true });
    if (entry.existed) {
      await copyWorkspaceNode(join(stageRoot, "nodes", ...entry.path.split("/")), destination);
    }
    restored.push(entry.path);
  }
}

async function recoverApplyJournal(root: string, stageRoot: string) {
  const descriptorPath = join(stageRoot, "journal.json");
  const descriptorBytes = await readFile(descriptorPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!descriptorBytes) {
    await rm(stageRoot, { recursive: true, force: true });
    return;
  }
  const descriptor = JSON.parse(descriptorBytes.toString("utf8")) as { version?: unknown; root?: unknown; entries?: unknown };
  if (descriptor.version !== 1 || descriptor.root !== resolve(root) || !Array.isArray(descriptor.entries)) {
    throw new Error("workspace apply journal descriptor is invalid");
  }
  const entries = descriptor.entries.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace apply journal entry is invalid");
    const entry = value as Record<string, unknown>;
    if (typeof entry.path !== "string" || typeof entry.existed !== "boolean") throw new Error("workspace apply journal entry is invalid");
    targetPath(root, entry.path);
    return { path: entry.path, existed: entry.existed };
  });
  await rollbackApplyJournal(root, stageRoot, entries);
  await rm(stageRoot, { recursive: true, force: true });
}

async function createApplyJournal(input: { root: string; cycleId: string; spaceId: string; paths: string[] }): Promise<ApplyJournal> {
  const stageRoot = applyJournalRoot(input.spaceId, input.cycleId);
  if (await lstat(stageRoot).then(() => true).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error))) {
    await recoverApplyJournal(input.root, stageRoot);
  }
  await mkdir(stageRoot, { recursive: true, mode: 0o700 });
  const uniquePaths = [...new Set(input.paths)].sort((left, right) => pathDepth(left) - pathDepth(right) || left.localeCompare(right));
  const entries: ApplyJournalEntry[] = [];
  try {
    for (const path of uniquePaths) {
      // If an ancestor is already journaled, its copy contains this path.
      if (entries.some((entry) => entry.existed && (entry.path === path || path.startsWith(`${entry.path}/`)))) continue;
      const source = targetPath(input.root, path);
      const stagePath = join(stageRoot, "nodes", ...path.split("/"));
      const info = await lstat(source).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!info) {
        entries.push({ path, existed: false });
        continue;
      }
      await copyWorkspaceNode(source, stagePath);
      entries.push({ path, existed: true });
    }
    const descriptorPath = join(stageRoot, "journal.json");
    await writeFile(descriptorPath, JSON.stringify({ version: 1, root: resolve(input.root), entries }), { mode: 0o600, flag: "wx" });
    await syncFile(descriptorPath);
    return {
      rollback: () => rollbackApplyJournal(input.root, stageRoot, entries),
      cleanup: () => rm(stageRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function applyLocalPlan(input: {
  root: string;
  cycleId: string;
  spaceId: string;
  plan: ReturnType<typeof reconcileWorkspaceManifests>;
  local: WorkspaceManifestV1;
  blobs: Array<typeof workspaceBlobs.$inferSelect>;
  allowDestructive: boolean;
}): Promise<ApplyJournal> {
  const localByPath = new Map(input.local.entries.map((entry) => [entry.path, entry]));
  const blobByPath = new Map<string, typeof workspaceBlobs.$inferSelect>();
  for (const blob of input.blobs) {
    const path = (blob as typeof workspaceBlobs.$inferSelect & { path?: string }).path;
    if (path) blobByPath.set(path, blob);
  }
  const deletes = input.plan.operations.filter((operation) => operation.action === "delete_cloud");
  if (!input.allowDestructive && deletes.length > WORKSPACE_MAX_DELETION_COUNT) throw new Error("workspace deletion threshold requires confirmation");
  const previousCount = Math.max(1, input.local.entries.length);
  if (!input.allowDestructive && deletes.length / previousCount > WORKSPACE_MAX_DELETION_RATIO) throw new Error("workspace deletion ratio requires confirmation");
  const journal = await createApplyJournal({
    root: input.root,
    cycleId: input.cycleId,
    spaceId: input.spaceId,
    paths: input.plan.operations
      .filter((operation) => operation.action === "apply_local_to_cloud" || operation.action === "delete_cloud")
      .map((operation) => operation.path),
  });
  try {
    for (const operation of input.plan.operations) {
      if (operation.action === "apply_local_to_cloud") {
        const entry = localByPath.get(operation.path);
        if (!entry) throw new Error(`local entry missing for ${operation.path}`);
        await applyEntry({ root: input.root, entry, blobByPath, cycleId: input.cycleId });
      } else if (operation.action === "delete_cloud") {
        await applyDelete(input.root, operation.path);
      }
    }
    return journal;
  } catch (error) {
    await journal.rollback();
    await journal.cleanup();
    throw error;
  }
}

async function processWorkspaceSyncJobLocked(job: Job<WorkspaceSyncJobData>) {
  const { cycleId, spaceId } = job.data;
  const [cycle] = await db.select().from(workspaceSyncCycles).where(and(eq(workspaceSyncCycles.id, cycleId), eq(workspaceSyncCycles.spaceId, spaceId))).limit(1);
  if (!cycle) throw new Error("workspace_sync_cycle_not_found");
  if (isTerminal(cycle.status)) {
    await rm(applyJournalRoot(spaceId, cycleId), { recursive: true, force: true });
    return { cycleId, status: cycle.status };
  }
  await db.update(workspaceSyncCycles).set({ status: "transferring", updatedAt: new Date() }).where(and(eq(workspaceSyncCycles.id, cycle.id), eq(workspaceSyncCycles.status, "planned")));

  const [policy] = await db.select().from(spaceWorkspacePolicies).where(eq(spaceWorkspacePolicies.spaceId, spaceId)).limit(1);
  const [cloudReplica] = await db.select().from(workspaceReplicas).where(and(eq(workspaceReplicas.spaceId, spaceId), eq(workspaceReplicas.kind, "cloud"))).limit(1);
  const [state] = await db.select().from(workspaceState).where(eq(workspaceState.spaceId, spaceId)).limit(1);
  if (!policy || !cloudReplica || !state) throw new Error("workspace bootstrap state is incomplete");
  if (cycle.executionAttemptId) {
    const [attempt] = await db.select({ workspaceLeaseEpoch: workspaceExecutionAttempts.workspaceLeaseEpoch }).from(workspaceExecutionAttempts).where(and(
      eq(workspaceExecutionAttempts.id, cycle.executionAttemptId),
      eq(workspaceExecutionAttempts.spaceId, spaceId),
    )).limit(1);
    if (!attempt || attempt.workspaceLeaseEpoch !== cycle.leaseEpoch) throw new Error("workspace cycle lease epoch does not match its execution attempt");
  } else if (cycle.leaseEpoch != null) {
    const [lease] = await db.select({ epoch: workspaceWriterLeases.epoch }).from(workspaceWriterLeases).where(eq(workspaceWriterLeases.spaceId, spaceId)).limit(1);
    if (!lease || lease.epoch !== cycle.leaseEpoch) throw new Error("workspace cycle lease epoch is stale");
  }

  let scan: Awaited<ReturnType<typeof scanWorkspaceReplica>>;
  try {
    scan = await scanWorkspaceReplica(join(config.spaceStorageRoot, spaceId, "workspace"), scanOptions(policy));
  } catch (error) {
    const message = error instanceof WorkspaceScanError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
    await db.transaction(async (tx) => {
      await tx.update(workspaceSyncCycles).set({ status: "failed", errorCode: "cloud_scan_failed", errorMessage: message, updatedAt: new Date() }).where(eq(workspaceSyncCycles.id, cycle.id));
      await tx.update(workspaceState).set({ status: "error", activeCycleId: cycle.id, updatedAt: new Date() }).where(eq(workspaceState.spaceId, spaceId));
      await tx.update(workspaceReplicas).set({ status: "error", updatedAt: new Date() }).where(eq(workspaceReplicas.id, cycle.replicaId));
    });
    await publishWorkspaceStateUpdated({ spaceId, replicaId: cycle.replicaId, reason: "cloud_scan_failed" }).catch(() => undefined);
    throw error;
  }

  const currentGeneration = state.generation;
  const [replicaGenerationRow] = await db.select({
    max: sql<number>`coalesce(max(${workspaceSnapshots.replicaGeneration}), 0)::bigint`,
  }).from(workspaceSnapshots).where(eq(workspaceSnapshots.replicaId, cloudReplica.id));
  const cloudSnapshotId = deterministicUuid("workspace-cloud-scan", cycle.id);
  const [existingCloudSnapshot] = await db.select({ replicaGeneration: workspaceSnapshots.replicaGeneration }).from(workspaceSnapshots).where(and(
    eq(workspaceSnapshots.id, cloudSnapshotId),
    eq(workspaceSnapshots.replicaId, cloudReplica.id),
  )).limit(1);
  const nextCloudReplicaGeneration = existingCloudSnapshot?.replicaGeneration ?? Number(replicaGenerationRow?.max ?? 0) + 1;
  const cloudSnapshot = await persistCloudSnapshot({
    snapshotId: cloudSnapshotId,
    spaceId,
    root: join(config.spaceStorageRoot, spaceId, "workspace"),
    cloudReplicaId: cloudReplica.id,
    manifest: scan.manifest,
    treeHash: scan.treeHash,
    source: "cloud_scan",
    parentSnapshotId: state.cloudAppliedSnapshotId,
    baseCanonicalSnapshotId: state.canonicalSnapshotId,
    executionAttemptId: cycle.executionAttemptId,
    generation: nextCloudReplicaGeneration,
  });
  await db.update(workspaceSyncCycles).set({ cloudSnapshotId: cloudSnapshot.id, updatedAt: new Date() }).where(eq(workspaceSyncCycles.id, cycle.id));

  if (!state.canonicalSnapshotId && !cycle.localSnapshotId) {
    await db.transaction(async (tx) => {
      await tx.update(workspaceState).set({ canonicalSnapshotId: cloudSnapshot.id, cloudAppliedSnapshotId: cloudSnapshot.id, generation: currentGeneration + 1, status: "ready", activeCycleId: null, updatedAt: new Date(), lastWriterKind: "cloud_scan", lastWriterId: cloudSnapshot.id }).where(eq(workspaceState.spaceId, spaceId));
      await tx.update(workspaceReplicas).set({ currentSnapshotId: cloudSnapshot.id, appliedSnapshotId: cloudSnapshot.id, lastCommonSnapshotId: cloudSnapshot.id, status: "ready", updatedAt: new Date() }).where(eq(workspaceReplicas.id, cloudReplica.id));
      // Every attached local replica must learn the canonical pointer, but a
      // replica with its own outstanding candidate keeps that pointer until
      // its candidate is explicitly reconciled.
      await tx.update(workspaceReplicas).set({ currentSnapshotId: cloudSnapshot.id, status: "syncing", updatedAt: new Date() }).where(and(
        eq(workspaceReplicas.spaceId, spaceId),
        eq(workspaceReplicas.kind, "local"),
        sql`(${workspaceReplicas.currentSnapshotId} is null or ${workspaceReplicas.currentSnapshotId} = ${workspaceReplicas.appliedSnapshotId})`,
      ));
      await tx.update(workspaceSyncCycles).set({ resultSnapshotId: cloudSnapshot.id, status: "completed", completedAt: new Date(), updatedAt: new Date() }).where(eq(workspaceSyncCycles.id, cycle.id));
    });
    await publishWorkspaceStateUpdated({ spaceId, reason: "bootstrap_completed" }).catch((error) => logger.warn("workspace realtime publish failed", error));
    return { cycleId, status: "completed", snapshotId: cloudSnapshot.id, bootstrapped: true };
  }

  const localSnapshotId = cycle.localSnapshotId;
  const canonicalSnapshotId = state.canonicalSnapshotId;
  if (!localSnapshotId) {
    const [canonicalSnapshot] = canonicalSnapshotId
      ? await db.select({ treeHash: workspaceSnapshots.treeHash }).from(workspaceSnapshots).where(eq(workspaceSnapshots.id, canonicalSnapshotId)).limit(1)
      : [];
    if (canonicalSnapshotId && canonicalSnapshot?.treeHash === scan.treeHash) {
      await db.transaction(async (tx) => {
        const completedAt = new Date();
        await tx.update(workspaceSyncCycles).set({ resultSnapshotId: canonicalSnapshotId, status: "completed", completedAt, updatedAt: completedAt }).where(eq(workspaceSyncCycles.id, cycle.id));
        await tx.update(workspaceState).set({ status: "ready", activeCycleId: null, updatedAt: completedAt }).where(and(
          eq(workspaceState.spaceId, spaceId),
          eq(workspaceState.activeCycleId, cycle.id),
        ));
        if (cycle.executionAttemptId) {
          await tx.update(workspaceExecutionAttempts).set({
            resultSnapshotId: canonicalSnapshotId,
            status: sql`case when ${workspaceExecutionAttempts.transcriptRequired} = false or ${workspaceExecutionAttempts.status} = 'transcript_sealed' or ${terminalAttemptTurn} then 'completed' else 'workspace_sealed' end`,
            completedAt: sql`case when ${workspaceExecutionAttempts.transcriptRequired} = false or ${workspaceExecutionAttempts.status} = 'transcript_sealed' or ${terminalAttemptTurn} then now() else ${workspaceExecutionAttempts.completedAt} end`,
            updatedAt: new Date(),
          }).where(and(eq(workspaceExecutionAttempts.id, cycle.executionAttemptId), inArray(workspaceExecutionAttempts.status, ["running", "transcript_sealed", "awaiting_recovery"])));
        }
      });
      await publishWorkspaceStateUpdated({ spaceId, replicaId: cycle.replicaId, reason: "cloud_snapshot_unchanged" }).catch((error) => logger.warn("workspace realtime publish failed", error));
      return { cycleId, status: "completed", unchanged: true, snapshotId: canonicalSnapshotId };
    }
    await db.transaction(async (tx) => {
      const changedAt = new Date();
      await tx.update(workspaceState).set({ canonicalSnapshotId: cloudSnapshot.id, cloudAppliedSnapshotId: cloudSnapshot.id, generation: currentGeneration + 1, status: "ready", activeCycleId: null, updatedAt: changedAt, lastWriterKind: "cloud_scan", lastWriterId: cloudSnapshot.id }).where(eq(workspaceState.spaceId, spaceId));
      await tx.update(workspaceReplicas).set({ currentSnapshotId: cloudSnapshot.id, appliedSnapshotId: cloudSnapshot.id, lastCommonSnapshotId: cloudSnapshot.id, status: "ready", updatedAt: changedAt }).where(eq(workspaceReplicas.id, cloudReplica.id));
      await tx.update(workspaceReplicas).set({ currentSnapshotId: cloudSnapshot.id, status: "syncing", updatedAt: changedAt }).where(and(
        eq(workspaceReplicas.spaceId, spaceId),
        eq(workspaceReplicas.kind, "local"),
        sql`(${workspaceReplicas.currentSnapshotId} is null or ${workspaceReplicas.currentSnapshotId} = ${workspaceReplicas.appliedSnapshotId})`,
      ));
      await tx.update(workspaceSyncCycles).set({ resultSnapshotId: cloudSnapshot.id, status: "completed", completedAt: changedAt, updatedAt: changedAt }).where(eq(workspaceSyncCycles.id, cycle.id));
      if (cycle.executionAttemptId) {
        await tx.update(workspaceExecutionAttempts).set({
          resultSnapshotId: cloudSnapshot.id,
          status: sql`case when ${workspaceExecutionAttempts.transcriptRequired} = false or ${workspaceExecutionAttempts.status} = 'transcript_sealed' or ${terminalAttemptTurn} then 'completed' else 'workspace_sealed' end`,
          completedAt: sql`case when ${workspaceExecutionAttempts.transcriptRequired} = false or ${workspaceExecutionAttempts.status} = 'transcript_sealed' or ${terminalAttemptTurn} then now() else ${workspaceExecutionAttempts.completedAt} end`,
          updatedAt: changedAt,
        }).where(and(eq(workspaceExecutionAttempts.id, cycle.executionAttemptId), inArray(workspaceExecutionAttempts.status, ["running", "transcript_sealed", "awaiting_recovery"])));
      }
    });
    await publishWorkspaceStateUpdated({ spaceId, replicaId: cycle.replicaId, reason: "cloud_snapshot_completed" }).catch((error) => logger.warn("workspace realtime publish failed", error));
    return { cycleId, status: "completed", snapshotId: cloudSnapshot.id };
  }

  const [localSnapshotMeta] = await db.select({ source: workspaceSnapshots.source }).from(workspaceSnapshots).where(and(eq(workspaceSnapshots.id, localSnapshotId), eq(workspaceSnapshots.spaceId, spaceId))).limit(1);
  if (!localSnapshotMeta) throw new Error("local snapshot metadata is unavailable");
  const localManifest = await loadSnapshotManifest(localSnapshotId);
  const effectiveBaseSnapshotId = localSnapshotMeta.source === "initial_merge"
    ? null
    : cycle.baseSnapshotId ?? state.canonicalSnapshotId;
  const baseManifest = await loadSnapshotManifest(effectiveBaseSnapshotId);
  if (!localManifest) throw new Error("local snapshot manifest is unavailable");
  const initialPlan = reconcileWorkspaceManifests({ base: baseManifest, local: localManifest, cloud: scan.manifest });
  const plan = await applyPersistedConflictResolutions({ cycleId, plan: initialPlan });
  if (plan.conflicts.length > 0) {
    await recordConflicts({ cycleId, spaceId, conflicts: plan.conflicts });
    await db.transaction(async (tx) => {
      await tx.update(workspaceSyncCycles).set({ status: "conflicted", stats: { conflictCount: plan.conflicts.length }, updatedAt: new Date() }).where(eq(workspaceSyncCycles.id, cycleId));
      await tx.update(workspaceState).set({ status: "conflicted", activeCycleId: cycleId, updatedAt: new Date() }).where(eq(workspaceState.spaceId, spaceId));
      await tx.update(workspaceReplicas).set({ status: "conflicted", updatedAt: new Date() }).where(eq(workspaceReplicas.id, cycle.replicaId));
      if (cycle.executionAttemptId) {
        await tx.update(workspaceExecutionAttempts).set({ status: "blocked", workspaceCycleId: cycleId, errorCode: "workspace_conflict", updatedAt: new Date() }).where(eq(workspaceExecutionAttempts.id, cycle.executionAttemptId));
      }
    });
    await publishWorkspaceStateUpdated({ spaceId, replicaId: cycle.replicaId, reason: "conflict_recorded" }).catch((error) => logger.warn("workspace realtime publish failed", error));
    return { cycleId, status: "conflicted", conflictCount: plan.conflicts.length };
  }

  const joinRows = await db.select({ path: workspaceSnapshotBlobs.path, blob: workspaceBlobs }).from(workspaceSnapshotBlobs).innerJoin(workspaceBlobs, eq(workspaceBlobs.id, workspaceSnapshotBlobs.blobId)).where(eq(workspaceSnapshotBlobs.snapshotId, localSnapshotId));
  const pathBlobs = joinRows.map((row) => Object.assign(row.blob, { path: row.path }));
  await db.update(workspaceSyncCycles).set({ status: "applying_cloud", updatedAt: new Date() }).where(eq(workspaceSyncCycles.id, cycleId));
  const applyJournal = await applyLocalPlan({
    root: join(config.spaceStorageRoot, spaceId, "workspace"),
    cycleId,
    spaceId,
    plan,
    local: localManifest,
    blobs: pathBlobs,
    allowDestructive: localSnapshotMeta.source === "initial_use_local",
  });
  let promoted = false;
  try {
    const verified = await scanWorkspaceReplica(join(config.spaceStorageRoot, spaceId, "workspace"), scanOptions(policy));
    const expected = mergedManifest({ cloud: scan.manifest, local: localManifest, plan });
    const expectedTreeHash = await canonicalJsonSha256({ scanPolicyHash: expected.scanPolicyHash, entries: expected.entries, boundaries: expected.boundaries, portableGitState: expected.portableGitState });
    if (verified.treeHash !== expectedTreeHash) throw new Error("cloud workspace verification hash mismatch after apply");
    const resultSnapshotId = deterministicUuid("workspace-reconcile-result", cycle.id);
    const resultSnapshot = await persistCloudSnapshot({
      snapshotId: resultSnapshotId,
      spaceId,
      root: join(config.spaceStorageRoot, spaceId, "workspace"),
      cloudReplicaId: cloudReplica.id,
      manifest: verified.manifest,
      treeHash: verified.treeHash,
      source: "reconcile",
      parentSnapshotId: cloudSnapshot.id,
      baseCanonicalSnapshotId: state.canonicalSnapshotId,
      executionAttemptId: cycle.executionAttemptId,
      generation: nextCloudReplicaGeneration + 1,
    });
    await db.transaction(async (tx) => {
      await tx.update(workspaceState).set({ canonicalSnapshotId: resultSnapshot.id, cloudAppliedSnapshotId: resultSnapshot.id, generation: currentGeneration + 1, status: "ready", activeCycleId: null, updatedAt: new Date(), lastWriterKind: "workspace_sync", lastWriterId: cycle.replicaId }).where(eq(workspaceState.spaceId, spaceId));
      await tx.update(workspaceReplicas).set({ currentSnapshotId: resultSnapshot.id, appliedSnapshotId: resultSnapshot.id, lastCommonSnapshotId: resultSnapshot.id, status: "ready", updatedAt: new Date() }).where(eq(workspaceReplicas.id, cloudReplica.id));
      // The worker changed the cloud copy, not the local filesystem. Advance
      // only the participating local replica's server-side current pointer;
      // locald will promote appliedSnapshotId after a verified disk apply.
      await tx.update(workspaceReplicas).set({ currentSnapshotId: resultSnapshot.id, status: "syncing", updatedAt: new Date() }).where(and(eq(workspaceReplicas.id, cycle.replicaId), eq(workspaceReplicas.kind, "local")));
      await tx.update(workspaceSyncCycles).set({ resultSnapshotId: resultSnapshot.id, status: "completed", completedAt: new Date(), stats: { operationCount: plan.operations.length }, updatedAt: new Date() }).where(eq(workspaceSyncCycles.id, cycleId));
      await tx.update(workspaceSyncConflicts).set({ resolvedSnapshotId: resultSnapshot.id, updatedAt: new Date() }).where(and(
        eq(workspaceSyncConflicts.cycleId, cycleId),
        eq(workspaceSyncConflicts.status, "resolved"),
      ));
      if (cycle.executionAttemptId) {
        await tx.update(workspaceExecutionAttempts).set({
          resultSnapshotId: resultSnapshot.id,
          status: sql`case when ${workspaceExecutionAttempts.transcriptRequired} = false or ${workspaceExecutionAttempts.status} = 'transcript_sealed' or ${terminalAttemptTurn} then 'completed' else 'workspace_sealed' end`,
          completedAt: sql`case when ${workspaceExecutionAttempts.transcriptRequired} = false or ${workspaceExecutionAttempts.status} = 'transcript_sealed' or ${terminalAttemptTurn} then now() else ${workspaceExecutionAttempts.completedAt} end`,
          updatedAt: new Date(),
        }).where(and(eq(workspaceExecutionAttempts.id, cycle.executionAttemptId), inArray(workspaceExecutionAttempts.status, ["running", "transcript_sealed", "awaiting_recovery"])));
      }
    });
    promoted = true;
    await applyJournal.cleanup();
    await publishWorkspaceStateUpdated({ spaceId, replicaId: cycle.replicaId, reason: "reconcile_completed" }).catch((error) => logger.warn("workspace realtime publish failed", error));
    return { cycleId, status: "completed", snapshotId: resultSnapshot.id, operationCount: plan.operations.length };
  } catch (error) {
    if (!promoted) {
      try {
        await applyJournal.rollback();
      } catch (rollbackError) {
        logger.error("workspace apply rollback failed; journal retained for recovery", { spaceId, cycleId, rollbackError });
        throw new AggregateError([error, rollbackError], "workspace apply and rollback both failed");
      }
      await applyJournal.cleanup();
    }
    throw error;
  }
}

export async function processWorkspaceSyncJob(job: Job<WorkspaceSyncJobData>) {
  const lock = await acquireWorkspacePhysicalLock(job.data.spaceId);
  if (!lock) throw new Error("workspace_physical_writer_active");
  let result: Awaited<ReturnType<typeof processWorkspaceSyncJobLocked>> | undefined;
  let operationError: unknown = null;
  let releaseError: unknown = null;
  try {
    result = await processWorkspaceSyncJobLocked(job);
  } catch (error) {
    operationError = error;
  }
  try {
    await lock.release();
  } catch (error) {
    releaseError = error;
  }
  if (operationError) throw operationError;
  if (releaseError) throw releaseError;
  return result;
}
