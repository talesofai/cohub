import { createHash } from "node:crypto";
import type { TaskPayload } from "@cohub/protocol/task";
import {
  ISOLATED_WORKER_CREATION_PATH,
  ISOLATED_WORKER_DISPATCH_TASK_TYPE,
  type IsolatedWorkerDispatchInput,
  type IsolatedWorkerDispatchResponse,
  type IsolatedWorkerDispatchTaskData,
  type IsolatedWorkerInputBundle,
  type IsolatedWorkerReuseProbeResponse,
  type IsolatedWorkerReuseRejectedTaskData,
} from "@cohub/protocol/isolated-worker";

const FIXED_PROOF = {
  creationPath: ISOLATED_WORKER_CREATION_PATH,
  ordinarySandboxProvisioned: false,
  terminatedSpaceReused: false,
  credentialMode: "engine_scoped_dispatch_authority",
  engineInternalSecretIssued: false,
  publicPromptUsed: false,
  checkpointAdapter: "trusted_production",
} as const;

const PUBLIC_INPUT_FIELDS = new Set([
  "content",
  "inputBundle",
  "clientMessageId",
  "title",
  "source",
  "model",
  "provider",
  "repairOfDisposableSpaceId",
]);
const MAX_DISPATCH_BODY_BYTES = 1_048_576;
const MAX_CONTENT_BLOCKS = 256;

export function parseIsolatedWorkerDispatchInput(value: unknown): IsolatedWorkerDispatchInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be an object");
  const record = value as Record<string, unknown>;
  const unknownField = Object.keys(record).find((field) => !PUBLIC_INPUT_FIELDS.has(field));
  if (unknownField) throw new Error(`unknown isolated worker dispatch field: ${unknownField}`);
  if (!Array.isArray(record.content) || record.content.length === 0 || record.content.length > MAX_CONTENT_BLOCKS) {
    throw new Error(`content must contain between 1 and ${MAX_CONTENT_BLOCKS} blocks`);
  }
  for (const block of record.content) {
    if (!block || typeof block !== "object" || Array.isArray(block) || typeof (block as { type?: unknown }).type !== "string") {
      throw new Error("content contains an invalid block");
    }
  }
  validateInputBundle(record.inputBundle);
  const encoded = JSON.stringify(record);
  if (Buffer.byteLength(encoded, "utf8") > MAX_DISPATCH_BODY_BYTES) throw new Error("isolated worker dispatch body exceeds one MiB");
  for (const field of ["clientMessageId", "title", "source", "model", "provider", "repairOfDisposableSpaceId"] as const) {
    const fieldValue = record[field];
    if (fieldValue !== undefined && fieldValue !== null && typeof fieldValue !== "string") {
      throw new Error(`${field} must be a string or null`);
    }
    if (typeof fieldValue === "string" && fieldValue.length > 2048) throw new Error(`${field} is too long`);
  }
  return record as unknown as IsolatedWorkerDispatchInput;
}

function validateInputBundle(value: unknown): asserts value is IsolatedWorkerInputBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("inputBundle is required");
  const manifest = value as Record<string, unknown>;
  const allowed = new Set([
    "authorityCheckpointId",
    "authorityCheckpointCommit",
    "authorityTreeSha256",
    "inputManifestSha256",
    "runtimeAuthorityReadAllowed",
    "items",
  ]);
  const unknown = Object.keys(manifest).find((field) => !allowed.has(field));
  if (unknown) throw new Error(`unknown inputBundle field: ${unknown}`);
  if (typeof manifest.authorityCheckpointId !== "string" || !/^[a-f0-9-]{36}$/.test(manifest.authorityCheckpointId)) {
    throw new Error("inputBundle.authorityCheckpointId must be a UUID");
  }
  if (typeof manifest.authorityCheckpointCommit !== "string" || !/^[a-f0-9]{40}$/.test(manifest.authorityCheckpointCommit)) {
    throw new Error("inputBundle.authorityCheckpointCommit must be a lowercase Git object id");
  }
  for (const field of ["authorityTreeSha256", "inputManifestSha256"] as const) {
    if (typeof manifest[field] !== "string" || !/^[a-f0-9]{64}$/.test(manifest[field])) throw new Error(`inputBundle.${field} is invalid`);
  }
  if (manifest.runtimeAuthorityReadAllowed !== false) throw new Error("inputBundle.runtimeAuthorityReadAllowed must be false");
  if (!Array.isArray(manifest.items) || manifest.items.length === 0 || manifest.items.length > 32) {
    throw new Error("inputBundle.items must contain between 1 and 32 items");
  }
  const sources = new Set<string>();
  const destinations = new Set<string>();
  for (const [index, rawFile] of manifest.items.entries()) {
    if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile)) throw new Error(`inputBundle.items[${index}] is invalid`);
    const file = rawFile as Record<string, unknown>;
    const unknownFileField = Object.keys(file).find((field) => !["sourcePath", "destinationPath", "contentSha256", "sourceType"].includes(field));
    if (unknownFileField) throw new Error(`unknown inputBundle item field: ${unknownFileField}`);
    if (typeof file.sourcePath !== "string" || !file.sourcePath || file.sourcePath.length > 2048) throw new Error(`inputBundle.items[${index}].sourcePath is invalid`);
    if (typeof file.destinationPath !== "string" || !file.destinationPath || file.destinationPath.length > 2048) throw new Error(`inputBundle.items[${index}].destinationPath is invalid`);
    const source = file.sourcePath;
    const destination = file.destinationPath;
    if (sources.has(source)) throw new Error(`duplicate inputBundle sourcePath: ${source}`);
    if (destinations.has(destination)) throw new Error(`duplicate inputBundle destinationPath: ${destination}`);
    sources.add(source);
    destinations.add(destination);
    if (typeof file.contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.contentSha256)) throw new Error(`inputBundle.items[${index}].contentSha256 is invalid`);
    if (file.sourceType !== "regular_file") throw new Error(`inputBundle.items[${index}].sourceType must be regular_file`);
  }
  const computed = computeIsolatedWorkerInputManifestSha256(manifest as unknown as IsolatedWorkerInputBundle);
  if (computed !== manifest.inputManifestSha256) throw new Error("inputBundle.inputManifestSha256 mismatch");
}

export type IsolatedWorkerDispatchReservation = {
  taskRunId: string;
  payload: TaskPayload;
  space: {
    id: string;
    userUuid: string;
    name: string;
    storageRepoName: string;
    meta: Record<string, unknown>;
  };
  member: { spaceId: string; userId: string; role: "host"; createdBy: string; updatedBy: string };
  session: {
    id: string;
    spaceId: string;
    userUuid: string;
    title: string;
    source: "isolated_worker_dispatch";
    status: "active";
    meta: Record<string, unknown>;
  };
  sandbox: {
    spaceId: string;
    provider: "cloud";
    status: "allocated";
    runtimeStatus: "unknown";
    podName: null;
    meta: Record<string, unknown>;
  };
};

export type IsolatedWorkerDispatchStore = {
  validateInputManifest(input: { authoritySpaceId: string; userId: string; inputBundle: IsolatedWorkerInputBundle }): Promise<void>;
  reserveTask(input: { taskRunId: string; payload: TaskPayload }): Promise<void>;
  enqueue(input: { taskRunId: string; payload: TaskPayload }): Promise<void>;
  markEnqueueFailed(input: { taskRunId: string; disposableSpaceId: string; error: unknown }): Promise<void>;
  assertReusableProbeTarget(input: { authoritySpaceId: string; disposableSpaceId: string; userId: string }): Promise<{
    status: string;
    authoritySpaceId: string;
  }>;
  reserveReuseProbe(input: { taskRunId: string; payload: TaskPayload }): Promise<void>;
};

function requireText(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

export function canonicalIsolatedWorkerJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalIsolatedWorkerJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalIsolatedWorkerJson(record[key])}`).join(",")}}`;
}

export function computeIsolatedWorkerInputManifestSha256(inputBundle: Omit<IsolatedWorkerInputBundle, "inputManifestSha256" | "runtimeAuthorityReadAllowed">) {
  return createHash("sha256").update(canonicalIsolatedWorkerJson({
    authorityCheckpointId: inputBundle.authorityCheckpointId,
    authorityCheckpointCommit: inputBundle.authorityCheckpointCommit,
    authorityTreeSha256: inputBundle.authorityTreeSha256,
    items: inputBundle.items,
  })).digest("hex");
}

export function computeIsolatedWorkerPolicySha256(input: {
  taskRunId: string;
  authoritySpaceId: string;
  disposableSpaceId: string;
  sessionId: string;
  clientMessageId: string;
  content: unknown;
  source: string;
  model: string | null;
  provider: string | null;
  repairOfDisposableSpaceId?: string;
  inputManifestSha256: string;
}) {
  const contentSha256 = createHash("sha256").update(canonicalIsolatedWorkerJson(input.content)).digest("hex");
  const canonical = canonicalIsolatedWorkerJson({
    taskRunId: input.taskRunId,
    authoritySpaceId: input.authoritySpaceId,
    disposableSpaceId: input.disposableSpaceId,
    sessionId: input.sessionId,
    clientMessageId: input.clientMessageId,
    contentSha256,
    source: input.source,
    model: input.model,
    provider: input.provider,
    repairOfDisposableSpaceId: input.repairOfDisposableSpaceId ?? null,
    inputManifestSha256: input.inputManifestSha256,
    writableRoot: "/workspace/work",
    workspaceReadOnly: true,
    executionTokenIssued: false,
    ...FIXED_PROOF,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export async function createIsolatedWorkerDispatch(input: {
  authoritySpaceId: string;
  userId: string;
  input: IsolatedWorkerDispatchInput;
  randomUUID?: () => string;
  store: IsolatedWorkerDispatchStore;
}): Promise<IsolatedWorkerDispatchResponse> {
  const parsedInput = parseIsolatedWorkerDispatchInput(input.input);
  const authoritySpaceId = requireText(input.authoritySpaceId, "authoritySpaceId");
  const userId = requireText(input.userId, "userId");
  const randomUUID = input.randomUUID ?? crypto.randomUUID;
  const disposableSpaceId = randomUUID();
  const sessionId = randomUUID();
  const taskRunId = randomUUID();
  const clientMessageId = parsedInput.clientMessageId?.trim() || randomUUID();
  const repairOfDisposableSpaceId = parsedInput.repairOfDisposableSpaceId?.trim() || undefined;
  if (repairOfDisposableSpaceId === disposableSpaceId || repairOfDisposableSpaceId === authoritySpaceId) {
    throw new Error("repair target must be a prior disposable space");
  }
  if (repairOfDisposableSpaceId) {
    const target = await input.store.assertReusableProbeTarget({ authoritySpaceId, disposableSpaceId: repairOfDisposableSpaceId, userId });
    if (target.authoritySpaceId !== authoritySpaceId || !["stopping", "terminated"].includes(target.status)) {
      throw new Error("repair target must be a stopped disposable space owned by the authority");
    }
  }
  await input.store.validateInputManifest({ authoritySpaceId, userId, inputBundle: parsedInput.inputBundle });
  const inputManifestSha256 = parsedInput.inputBundle.inputManifestSha256;
  const source = parsedInput.source?.trim() || "isolated_worker_dispatch";
  const model = parsedInput.model?.trim() || null;
  const provider = parsedInput.provider?.trim() || null;
  const policyHash = computeIsolatedWorkerPolicySha256({
    taskRunId,
    authoritySpaceId,
    disposableSpaceId,
    sessionId,
    clientMessageId,
    content: parsedInput.content,
    source,
    model,
    provider,
    repairOfDisposableSpaceId,
    inputManifestSha256,
  });

  const taskData: IsolatedWorkerDispatchTaskData = {
    authoritySpaceId,
    disposableSpaceId,
    sessionId,
    clientMessageId,
    content: parsedInput.content,
    source,
    model,
    provider,
    policySha256: policyHash,
    inputBundle: parsedInput.inputBundle,
    inputManifestSha256,
    ...FIXED_PROOF,
    ...(repairOfDisposableSpaceId ? { repairOfDisposableSpaceId } : {}),
  };
  const payload: TaskPayload = {
    type: ISOLATED_WORKER_DISPATCH_TASK_TYPE,
    spaceId: authoritySpaceId,
    sessionId,
    userId,
    data: taskData,
  };
  await input.store.reserveTask({ taskRunId, payload });

  try {
    await input.store.enqueue({ taskRunId, payload });
  } catch (error) {
    await input.store.markEnqueueFailed({ taskRunId, disposableSpaceId, error });
    throw error;
  }

  return {
    taskRunId,
    authoritySpaceId,
    disposableSpaceId,
    sessionId,
    policySha256: policyHash,
    inputManifestSha256,
    ...FIXED_PROOF,
  };
}

export async function createIsolatedWorkerReuseProbe(input: {
  authoritySpaceId: string;
  disposableSpaceId: string;
  sessionId: string;
  userId: string;
  randomUUID?: () => string;
  store: IsolatedWorkerDispatchStore;
}): Promise<IsolatedWorkerReuseProbeResponse> {
  const target = await input.store.assertReusableProbeTarget(input);
  if (target.authoritySpaceId !== input.authoritySpaceId || target.status !== "terminated") {
    throw new Error("reuse probe requires a terminated disposable space owned by the authority");
  }
  const taskRunId = (input.randomUUID ?? crypto.randomUUID)();
  const data: IsolatedWorkerReuseRejectedTaskData = {
    authoritySpaceId: input.authoritySpaceId,
    disposableSpaceId: input.disposableSpaceId,
    reuseRejected: true,
    reason: "terminated_space_reuse_forbidden",
  };
  const payload: TaskPayload = {
    type: ISOLATED_WORKER_DISPATCH_TASK_TYPE,
    spaceId: input.authoritySpaceId,
    sessionId: input.sessionId,
    userId: input.userId,
    data,
  };
  await input.store.reserveReuseProbe({ taskRunId, payload });
  await input.store.enqueue({ taskRunId, payload });
  return { taskRunId, disposableSpaceId: input.disposableSpaceId, rejected: true, reason: data.reason };
}
