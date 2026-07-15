import type { V1Pod } from "@kubernetes/client-node";
import { SANDBOX_SPECS } from "@cohub/sandbox-controller";
import { createHash } from "node:crypto";
import { config, sessionsNamespace } from "./config.js";
import { and, eq, sql } from "drizzle-orm";

const BINDING_LABELS = {
  spaceId: "cohub.run/space-id",
  sessionId: "cohub.run/session-id",
  turnId: "cohub.run/turn-id",
} as const;

type IsolatedWorkerBinding = {
  authoritySpaceId: string;
  disposableSpaceId: string;
  sessionId: string;
  turnId: string;
};

export type IsolatedWorkerPodInput = IsolatedWorkerBinding & {
  image: string;
  spaceStoragePvc: string;
  spaceStorageSubpath: string;
  writableRoot: string;
  policySha256: string;
};

export type IsolatedWorkerMetadata = {
  worker_identity: { access_mode: "isolated_worker" };
  write_scope: { mode: "isolated_task_space"; root: "work/" };
  disposable_space_id: string;
  termination_required: true;
  workflow_execution_token_issued: false;
};

export type IsolatedWorkerPolicy = {
  authoritySpaceId: string;
  disposableSpaceId: string;
  writableRoot: string;
  workspaceReadOnly: true;
  executionTokenIssued: false;
  podUid: string;
  policySha256: string;
};

export type IsolatedWorkerPodHandle = {
  sessionId: string;
  turnId: string;
  podName: string;
  podCreatedAt: string;
  isolatedWorkerPolicy: IsolatedWorkerPolicy;
  metadata: IsolatedWorkerMetadata;
  status: "running";
  resumable: false;
};

export type IsolatedWorkerRevocationReceipt = {
  revokeTaskRunId: string;
  automaticTrigger: "turn_terminal_event";
  manualEndpointInvoked: false;
  podUid: string;
  podDeleted: true;
  podDeletedAt: string;
  credentialRevoked: true;
  sandboxTerminated: true;
  checkpointCreatedAfterPodDeletion: true;
  checkpointAdapter: "trusted_production";
  terminatedAt: string;
  checkpointId: string;
  checkpointCommit: string;
  checkpointTreeSha256: string;
};

export type IsolatedWorkerRevocationContext = Pick<
  IsolatedWorkerRevocationReceipt,
  "revokeTaskRunId" | "automaticTrigger" | "manualEndpointInvoked"
>;

export type IsolatedWorkerPodInfra = {
  createPod(input: { namespace: string; pod: V1Pod }): Promise<V1Pod>;
  readPod(input: { namespace: string; podName: string }): Promise<V1Pod | null>;
  waitForPodReady(input: { namespace: string; podName: string; timeoutMs?: number }): Promise<V1Pod | null>;
  deletePod(input: { namespace: string; podName: string; podUid: string }): Promise<void>;
  waitForPodDeleted(input: { namespace: string; podName: string; timeoutMs?: number }): Promise<boolean>;
};

export type IsolatedWorkerPodState = {
  claimCreate(input: { podInput: IsolatedWorkerPodInput; podName: string }): Promise<boolean>;
  markCreateFailed(input: { podInput: IsolatedWorkerPodInput; podName: string; reason: string }): Promise<boolean>;
  markRunning(input: { handle: IsolatedWorkerPodHandle; pod: V1Pod }): Promise<void>;
  readTerminationReceipt(input: { handle: IsolatedWorkerPodHandle }): Promise<IsolatedWorkerRevocationReceipt | null>;
  claimTermination(input: { handle: IsolatedWorkerPodHandle; claimId: string; startedAt: string }): Promise<boolean>;
  markPodDeleted(input: { handle: IsolatedWorkerPodHandle; claimId: string; podDeletedAt: string }): Promise<string | null>;
  claimCheckpoint(input: { handle: IsolatedWorkerPodHandle; claimId: string; checkpointAttemptId: string; checkpointTaskRunId: string }): Promise<boolean | IsolatedWorkerCheckpointAttempt | null>;
  rotateCheckpoint?(input: {
    handle: IsolatedWorkerPodHandle;
    claimId: string;
    checkpointAttemptId: string;
    checkpointTaskRunId: string;
    nextCheckpointAttemptId: string;
    nextCheckpointTaskRunId: string;
  }): Promise<IsolatedWorkerCheckpointAttempt | null>;
  readCheckpoint(input: { handle: IsolatedWorkerPodHandle; claimId: string; checkpointAttemptId: string }): Promise<FrozenCheckpointReadback | null>;
  persistCheckpoint(input: { handle: IsolatedWorkerPodHandle; claimId: string; checkpointAttemptId: string; checkpoint: FrozenCheckpointReadback }): Promise<boolean>;
  completeTermination(input: { handle: IsolatedWorkerPodHandle; claimId: string; checkpointAttemptId: string; receipt: IsolatedWorkerRevocationReceipt }): Promise<boolean>;
};

export type IsolatedWorkerCheckpointAttempt = {
  checkpointAttemptId: string;
  checkpointTaskRunId: string;
};

export type FrozenCheckpointReadback = {
  disposableSpaceId: string;
  checkpointId: string;
  commit: string;
  tree: string;
  treeSha256: string;
  currentHead: string;
  checkpointCreatedAt: string;
};

export class IsolatedWorkerCheckpointNoEffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolatedWorkerCheckpointNoEffectError";
  }
}

export function validateFrozenCheckpointReadback(handle: IsolatedWorkerPodHandle, checkpoint: FrozenCheckpointReadback) {
  if (checkpoint.disposableSpaceId !== handle.isolatedWorkerPolicy.disposableSpaceId) {
    throw new Error("frozen checkpoint disposable space binding mismatch");
  }
  if (!checkpoint.checkpointId.trim() || !checkpoint.commit.trim() || !checkpoint.tree.trim() || !/^[a-f0-9]{64}$/.test(checkpoint.treeSha256) || !checkpoint.currentHead.trim()) {
    throw new Error("frozen checkpoint readback is incomplete");
  }
  if (checkpoint.commit !== checkpoint.currentHead) {
    throw new Error("frozen checkpoint does not match the disposable space current head");
  }
  if (!Number.isFinite(Date.parse(checkpoint.checkpointCreatedAt))) {
    throw new Error("frozen checkpoint creation timestamp is invalid");
  }
  return checkpoint;
}

export function buildIsolatedWorkerSandboxRegistration(handle: IsolatedWorkerPodHandle, pod: V1Pod) {
  const podIp = pod.status?.podIP?.trim();
  if (!podIp) throw new Error("isolated worker pod IP is missing");
  return {
    spaceId: handle.isolatedWorkerPolicy.disposableSpaceId,
    status: "ready" as const,
    runtimeStatus: "healthy" as const,
    podName: handle.podName,
    meta: {
      ...handle.metadata,
      isolatedWorkerPolicy: handle.isolatedWorkerPolicy,
      authoritySpaceId: handle.isolatedWorkerPolicy.authoritySpaceId,
      sessionId: handle.sessionId,
      turnId: handle.turnId,
      podIp,
      wsEndpoint: `ws://${podIp}:8788/sandbox`,
    },
  };
}

const getStatusCode = (error: unknown) =>
  (error as { statusCode?: number; code?: number }).statusCode
  ?? (error as { statusCode?: number; code?: number }).code
  ?? null;

function assertLabelValue(value: string, fieldName: string) {
  if (!/^[a-z0-9](?:[-_.a-z0-9]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error(`${fieldName} must be a Kubernetes label value`);
  }
}

function assertDnsLabel(value: string, fieldName: string) {
  if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error(`${fieldName} must be a Kubernetes DNS label`);
  }
}

function validateRelativeSubpath(value: string) {
  const segments = value.split("/");
  if (!value || value.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("spaceStorageSubpath must be a clean relative path");
  }
  return value;
}

function getWritableRelativePath(writableRoot: string) {
  if (writableRoot !== "/workspace/work") {
    throw new Error("writableRoot must be /workspace/work");
  }
  return "work";
}

function getPodName(disposableSpaceId: string) {
  const podName = `sandbox-${disposableSpaceId}`;
  assertDnsLabel(podName, "isolated worker pod name");
  return podName;
}

function assertBinding(binding: IsolatedWorkerBinding) {
  assertLabelValue(binding.authoritySpaceId, "authoritySpaceId");
  assertLabelValue(binding.disposableSpaceId, "disposableSpaceId");
  assertLabelValue(binding.sessionId, "sessionId");
  assertLabelValue(binding.turnId, "turnId");
}

function assertHandle(handle: IsolatedWorkerPodHandle) {
  const policy = handle.isolatedWorkerPolicy;
  assertBinding({
    authoritySpaceId: policy.authoritySpaceId,
    disposableSpaceId: policy.disposableSpaceId,
    sessionId: handle.sessionId,
    turnId: handle.turnId,
  });
  if (handle.podName !== getPodName(policy.disposableSpaceId)) throw new Error("isolated worker pod name mismatch");
  if (!policy.podUid.trim()) throw new Error("isolated worker pod UID is missing");
  if (!Number.isFinite(Date.parse(handle.podCreatedAt))) throw new Error("isolated worker Pod creation timestamp is invalid");
  if (policy.writableRoot !== "/workspace/work" || policy.workspaceReadOnly !== true || policy.executionTokenIssued !== false) {
    throw new Error("isolated worker policy invariant mismatch");
  }
  if (!/^[a-f0-9]{64}$/.test(policy.policySha256)) throw new Error("isolated worker policy hash is malformed");
}

function readPodCreatedAt(pod: V1Pod) {
  const raw = pod.metadata?.creationTimestamp;
  const date = raw instanceof Date ? raw : typeof raw === "string" ? new Date(raw) : null;
  if (!date || !Number.isFinite(date.getTime())) throw new Error("isolated worker Pod metadata.creationTimestamp is missing");
  return date.toISOString();
}

function assertRevocationContext(context: IsolatedWorkerRevocationContext) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(context.revokeTaskRunId)) {
    throw new Error("isolated worker revoke TaskRun ID is malformed");
  }
  if (context.automaticTrigger !== "turn_terminal_event" || context.manualEndpointInvoked !== false) {
    throw new Error("isolated worker revocation must be bound to an automatic terminal Turn event");
  }
}

function assertReceiptContext(receipt: IsolatedWorkerRevocationReceipt, context: IsolatedWorkerRevocationContext) {
  if (
    receipt.revokeTaskRunId !== context.revokeTaskRunId
    || receipt.automaticTrigger !== context.automaticTrigger
    || receipt.manualEndpointInvoked !== context.manualEndpointInvoked
  ) {
    throw new Error("isolated worker revocation receipt TaskRun binding mismatch");
  }
}

function parseTerminationReceipt(value: unknown, expectedPodUid: string): IsolatedWorkerRevocationReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (
    typeof receipt.revokeTaskRunId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.revokeTaskRunId)
    || receipt.automaticTrigger !== "turn_terminal_event"
    || receipt.manualEndpointInvoked !== false
    || receipt.podUid !== expectedPodUid
    || receipt.podDeleted !== true
    || typeof receipt.podDeletedAt !== "string"
    || !receipt.podDeletedAt.trim()
    || receipt.credentialRevoked !== true
    || receipt.sandboxTerminated !== true
    || receipt.checkpointCreatedAfterPodDeletion !== true
    || receipt.checkpointAdapter !== "trusted_production"
    || typeof receipt.terminatedAt !== "string"
    || !receipt.terminatedAt.trim()
    || typeof receipt.checkpointId !== "string"
    || !receipt.checkpointId.trim()
    || typeof receipt.checkpointCommit !== "string"
    || !receipt.checkpointCommit.trim()
    || typeof receipt.checkpointTreeSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(receipt.checkpointTreeSha256)
    || !Number.isFinite(Date.parse(receipt.podDeletedAt))
    || !Number.isFinite(Date.parse(receipt.terminatedAt))
  ) {
    throw new Error("persisted isolated worker termination receipt is malformed");
  }
  return receipt as IsolatedWorkerRevocationReceipt;
}

export function renderIsolatedWorkerPodTemplate(input: IsolatedWorkerPodInput): V1Pod {
  assertBinding(input);
  if (!input.image.trim()) throw new Error("image is required");
  assertDnsLabel(input.spaceStoragePvc, "spaceStoragePvc");
  if (!/^[a-f0-9]{64}$/.test(input.policySha256)) throw new Error("policySha256 must be a lowercase SHA-256 digest");
  const storageSubpath = validateRelativeSubpath(input.spaceStorageSubpath);
  const writableRelativePath = getWritableRelativePath(input.writableRoot);
  const workspaceSubpath = `${storageSubpath}/${input.disposableSpaceId}/workspace`;

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: getPodName(input.disposableSpaceId),
      labels: {
        "app": "isolated-worker",
        "cohub.run/workload": "isolated-worker",
        [BINDING_LABELS.spaceId]: input.disposableSpaceId,
        [BINDING_LABELS.sessionId]: input.sessionId,
        [BINDING_LABELS.turnId]: input.turnId,
        "cohub.run/authority-space-id": input.authoritySpaceId,
        "cohub.run/disposable-space-id": input.disposableSpaceId,
      },
      annotations: {
        "cohub.run/authority_space_id": input.authoritySpaceId,
        "cohub.run/worker_identity.access_mode": "isolated_worker",
        "cohub.run/write_scope.mode": "isolated_task_space",
        "cohub.run/write_scope.root": "work/",
        "cohub.run/disposable_space_id": input.disposableSpaceId,
        "cohub.run/termination_required": "true",
        "cohub.run/workflow_execution_token_issued": "false",
        "cohub.run/policy_sha256": input.policySha256,
      },
    },
    spec: {
      restartPolicy: "Never",
      imagePullSecrets: [{ name: "gitea-registry" }],
      enableServiceLinks: false,
      automountServiceAccountToken: false,
      ...(Object.keys(config.sandboxNodeSelector).length > 0
        ? { nodeSelector: config.sandboxNodeSelector }
        : {}),
      ...(config.sandboxTolerations.length > 0
        ? { tolerations: config.sandboxTolerations }
        : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [{
        name: "worker",
        image: input.image,
        env: [
          { name: "COHUB_SPACE_ID", value: input.disposableSpaceId },
          { name: "WORKSPACE_DIR", value: "/workspace" },
          { name: "IMAGE_VERSION", value: input.image },
          { name: "POD_IP", valueFrom: { fieldRef: { fieldPath: "status.podIP" } } },
        ],
        ports: [{ name: "sandbox", containerPort: 8788, protocol: "TCP" }],
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          allowPrivilegeEscalation: false,
          capabilities: { drop: ["ALL"] },
          readOnlyRootFilesystem: true,
          seccompProfile: { type: "RuntimeDefault" },
        },
        readinessProbe: {
          httpGet: { path: "/readyz", port: 8788 },
          initialDelaySeconds: 2,
          periodSeconds: 2,
          timeoutSeconds: 1,
          failureThreshold: 30,
        },
        resources: SANDBOX_SPECS.standard.resources,
        volumeMounts: [
          {
            name: "space-storage",
            mountPath: "/workspace",
            subPath: workspaceSubpath,
            readOnly: true,
          },
          {
            name: "space-storage",
            mountPath: input.writableRoot,
            subPath: `${workspaceSubpath}/${writableRelativePath}`,
            readOnly: false,
          },
          {
            name: "runtime-tmp",
            mountPath: "/tmp",
          },
        ],
      }],
      volumes: [
        {
          name: "space-storage",
          persistentVolumeClaim: { claimName: input.spaceStoragePvc },
        },
        {
          name: "runtime-tmp",
          emptyDir: {},
        },
      ],
    },
  };
}

function assertPodBinding(pod: V1Pod, binding: IsolatedWorkerBinding, expectedUid?: string) {
  const labels = pod.metadata?.labels;
  if (
    labels?.[BINDING_LABELS.spaceId] !== binding.disposableSpaceId
    || labels?.[BINDING_LABELS.sessionId] !== binding.sessionId
    || labels?.[BINDING_LABELS.turnId] !== binding.turnId
    || labels?.["cohub.run/authority-space-id"] !== binding.authoritySpaceId
    || labels?.["cohub.run/disposable-space-id"] !== binding.disposableSpaceId
  ) {
    throw new Error("isolated worker pod binding mismatch");
  }
  const podUid = pod.metadata?.uid?.trim();
  if (!podUid) throw new Error("isolated worker pod UID is missing");
  if (expectedUid && podUid !== expectedUid) throw new Error("isolated worker pod UID mismatch");
  return podUid;
}

const defaultInfra: IsolatedWorkerPodInfra = {
  async createPod(input) {
    const { k8sCoreApi } = await import("./k8s.js");
    return k8sCoreApi.createNamespacedPod({ namespace: input.namespace, body: input.pod });
  },
  async readPod(input) {
    const { k8sCoreApi } = await import("./k8s.js");
    try {
      return await k8sCoreApi.readNamespacedPod({ name: input.podName, namespace: input.namespace });
    } catch (error) {
      if (getStatusCode(error) === 404) return null;
      throw error;
    }
  },
  async waitForPodReady(input) {
    const { k8sCoreApi } = await import("./k8s.js");
    const startedAt = Date.now();
    const timeoutMs = input.timeoutMs ?? 120_000;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const pod = await k8sCoreApi.readNamespacedPod({ name: input.podName, namespace: input.namespace });
        const ready = pod.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True") === true;
        if (ready && pod.status?.podIP) return pod;
      } catch (error) {
        if (getStatusCode(error) !== 404) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return null;
  },
  async deletePod(input) {
    const { k8sCoreApi } = await import("./k8s.js");
    try {
      await k8sCoreApi.deleteNamespacedPod({
        name: input.podName,
        namespace: input.namespace,
        body: { preconditions: { uid: input.podUid } },
      });
    } catch (error) {
      if (getStatusCode(error) !== 404) throw error;
    }
  },
  async waitForPodDeleted(input) {
    const { k8sCoreApi } = await import("./k8s.js");
    const startedAt = Date.now();
    const timeoutMs = input.timeoutMs ?? 120_000;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        await k8sCoreApi.readNamespacedPod({ name: input.podName, namespace: input.namespace });
      } catch (error) {
        if (getStatusCode(error) === 404) return true;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  },
};

const defaultState: IsolatedWorkerPodState = {
  async claimCreate(input) {
    const { claimIsolatedWorkerSandboxAllocation } = await import("./space-sandboxes.js");
    return claimIsolatedWorkerSandboxAllocation({
      authoritySpaceId: input.podInput.authoritySpaceId,
      disposableSpaceId: input.podInput.disposableSpaceId,
      sessionId: input.podInput.sessionId,
      turnId: input.podInput.turnId,
      policySha256: input.podInput.policySha256,
      podName: input.podName,
    });
  },
  async markRunning(input) {
    const registration = buildIsolatedWorkerSandboxRegistration(input.handle, input.pod);
    const { completeIsolatedWorkerSandboxAllocation } = await import("./space-sandboxes.js");
    const completed = await completeIsolatedWorkerSandboxAllocation({
      registration,
      authoritySpaceId: input.handle.isolatedWorkerPolicy.authoritySpaceId,
      sessionId: input.handle.sessionId,
      turnId: input.handle.turnId,
      policySha256: input.handle.isolatedWorkerPolicy.policySha256,
      podUid: input.handle.isolatedWorkerPolicy.podUid,
    });
    if (!completed) throw new Error("isolated worker allocation changed before pod registration");
  },
  async markCreateFailed(input) {
    const { markIsolatedWorkerSandboxCreateFailed } = await import("./space-sandboxes.js");
    return markIsolatedWorkerSandboxCreateFailed({
      authoritySpaceId: input.podInput.authoritySpaceId,
      disposableSpaceId: input.podInput.disposableSpaceId,
      sessionId: input.podInput.sessionId,
      turnId: input.podInput.turnId,
      policySha256: input.podInput.policySha256,
      podName: input.podName,
      reason: input.reason,
    });
  },
  async readTerminationReceipt(input) {
    const { getSpaceSandboxBySpaceId } = await import("./space-sandboxes.js");
    const sandbox = await getSpaceSandboxBySpaceId(input.handle.isolatedWorkerPolicy.disposableSpaceId);
    const meta = sandbox?.meta && typeof sandbox.meta === "object" && !Array.isArray(sandbox.meta)
      ? sandbox.meta as Record<string, unknown>
      : null;
    return parseTerminationReceipt(meta?.termination, input.handle.isolatedWorkerPolicy.podUid);
  },
  async claimTermination(input) {
    const { claimIsolatedWorkerTermination } = await import("./space-sandboxes.js");
    return claimIsolatedWorkerTermination({
      spaceId: input.handle.isolatedWorkerPolicy.disposableSpaceId,
      podUid: input.handle.isolatedWorkerPolicy.podUid,
      claimId: input.claimId,
      startedAt: input.startedAt,
    });
  },
  async completeTermination(input) {
    const { completeIsolatedWorkerTermination } = await import("./space-sandboxes.js");
    return completeIsolatedWorkerTermination({
      spaceId: input.handle.isolatedWorkerPolicy.disposableSpaceId,
      podUid: input.handle.isolatedWorkerPolicy.podUid,
      claimId: input.claimId,
      checkpointAttemptId: input.checkpointAttemptId,
      receipt: input.receipt,
    });
  },
  async markPodDeleted(input) {
    const { markIsolatedWorkerPodDeleted } = await import("./space-sandboxes.js");
    return markIsolatedWorkerPodDeleted({
      spaceId: input.handle.isolatedWorkerPolicy.disposableSpaceId,
      podUid: input.handle.isolatedWorkerPolicy.podUid,
      claimId: input.claimId,
      podDeletedAt: input.podDeletedAt,
    });
  },
  async claimCheckpoint(input) {
    const { claimIsolatedWorkerCheckpoint } = await import("./space-sandboxes.js");
    return claimIsolatedWorkerCheckpoint({
      spaceId: input.handle.isolatedWorkerPolicy.disposableSpaceId,
      podUid: input.handle.isolatedWorkerPolicy.podUid,
      claimId: input.claimId,
      checkpointAttemptId: input.checkpointAttemptId,
      checkpointTaskRunId: input.checkpointTaskRunId,
    });
  },
  async rotateCheckpoint(input) {
    const { rotateIsolatedWorkerCheckpointAttempt } = await import("./space-sandboxes.js");
    return rotateIsolatedWorkerCheckpointAttempt({
      spaceId: input.handle.isolatedWorkerPolicy.disposableSpaceId,
      podUid: input.handle.isolatedWorkerPolicy.podUid,
      claimId: input.claimId,
      checkpointAttemptId: input.checkpointAttemptId,
      checkpointTaskRunId: input.checkpointTaskRunId,
      nextCheckpointAttemptId: input.nextCheckpointAttemptId,
      nextCheckpointTaskRunId: input.nextCheckpointTaskRunId,
    });
  },
  async readCheckpoint(input) {
    const { readIsolatedWorkerTerminationCheckpoint } = await import("./space-sandboxes.js");
    return readIsolatedWorkerTerminationCheckpoint({
      spaceId: input.handle.isolatedWorkerPolicy.disposableSpaceId,
      podUid: input.handle.isolatedWorkerPolicy.podUid,
      claimId: input.claimId,
      checkpointAttemptId: input.checkpointAttemptId,
    }) as Promise<FrozenCheckpointReadback | null>;
  },
  async persistCheckpoint(input) {
    const { persistIsolatedWorkerTerminationCheckpoint } = await import("./space-sandboxes.js");
    return persistIsolatedWorkerTerminationCheckpoint({
      spaceId: input.handle.isolatedWorkerPolicy.disposableSpaceId,
      podUid: input.handle.isolatedWorkerPolicy.podUid,
      claimId: input.claimId,
      checkpointAttemptId: input.checkpointAttemptId,
      checkpoint: input.checkpoint,
    });
  },
};

function getTerminationClaimId(handle: IsolatedWorkerPodHandle) {
  return createHash("sha256").update(JSON.stringify({
    authoritySpaceId: handle.isolatedWorkerPolicy.authoritySpaceId,
    disposableSpaceId: handle.isolatedWorkerPolicy.disposableSpaceId,
    sessionId: handle.sessionId,
    turnId: handle.turnId,
    podUid: handle.isolatedWorkerPolicy.podUid,
    policySha256: handle.isolatedWorkerPolicy.policySha256,
  })).digest("hex");
}

function getCheckpointTaskRunId(checkpointAttemptId: string) {
  const hex = createHash("sha256").update(`${checkpointAttemptId}:task-run`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createIsolatedWorkerPodLifecycle(input?: {
  namespace?: string;
  infra?: IsolatedWorkerPodInfra;
  state?: IsolatedWorkerPodState;
  createFrozenCheckpoint?: (handle: IsolatedWorkerPodHandle, checkpointAttemptId: string, checkpointTaskRunId: string) => Promise<FrozenCheckpointReadback>;
  readyTimeoutMs?: number;
  deletionTimeoutMs?: number;
}) {
  const namespace = input?.namespace ?? sessionsNamespace;
  const infra = input?.infra ?? defaultInfra;
  const state = input?.state ?? defaultState;
  const createFrozenCheckpoint = input?.createFrozenCheckpoint ?? (async () => {
    throw new Error("isolated worker frozen checkpoint adapter is not configured");
  });
  const readyTimeoutMs = input?.readyTimeoutMs ?? 120_000;
  const deletionTimeoutMs = input?.deletionTimeoutMs ?? 120_000;
  const revocations = new Map<string, Promise<IsolatedWorkerRevocationReceipt>>();

  return {
    async create(podInput: IsolatedWorkerPodInput): Promise<IsolatedWorkerPodHandle> {
      const requestedPod = renderIsolatedWorkerPodTemplate(podInput);
      const requestedPodName = requestedPod.metadata?.name;
      if (!requestedPodName) throw new Error("isolated worker pod name is missing");
      const claimed = await state.claimCreate({ podInput, podName: requestedPodName });
      if (!claimed) throw new Error("disposable worker space is not allocated or has already been used");
      let createdPod: V1Pod;
      try {
        createdPod = await infra.createPod({ namespace, pod: requestedPod });
      } catch (createError) {
        const observedPod = await infra.readPod({ namespace, podName: requestedPodName });
        if (observedPod) {
          assertPodBinding(observedPod, podInput);
          createdPod = observedPod;
        } else {
          const markedFailed = await state.markCreateFailed({
            podInput,
            podName: requestedPodName,
            reason: createError instanceof Error ? createError.message : String(createError),
          });
          if (!markedFailed) throw new AggregateError([createError], "isolated worker pod create failed and allocation state changed");
          throw createError;
        }
      }
      const podUid = assertPodBinding(createdPod, podInput);
      const podCreatedAt = readPodCreatedAt(createdPod);
      const podName = createdPod.metadata?.name;
      if (!podName || podName !== requestedPod.metadata?.name) throw new Error("isolated worker pod name mismatch");
      const metadata: IsolatedWorkerMetadata = {
        worker_identity: { access_mode: "isolated_worker" },
        write_scope: { mode: "isolated_task_space", root: "work/" },
        disposable_space_id: podInput.disposableSpaceId,
        termination_required: true,
        workflow_execution_token_issued: false,
      };
      const handle: IsolatedWorkerPodHandle = {
        sessionId: podInput.sessionId,
        turnId: podInput.turnId,
        podName,
        podCreatedAt,
        isolatedWorkerPolicy: {
          authoritySpaceId: podInput.authoritySpaceId,
          disposableSpaceId: podInput.disposableSpaceId,
          writableRoot: podInput.writableRoot,
          workspaceReadOnly: true,
          executionTokenIssued: false,
          podUid,
          policySha256: podInput.policySha256,
        },
        metadata,
        status: "running",
        resumable: false,
      };
      const readyPod = await infra.waitForPodReady({ namespace, podName, timeoutMs: readyTimeoutMs });
      try {
        if (!readyPod) throw new Error(`timed out waiting for isolated worker pod readiness: ${podName}`);
        assertPodBinding(readyPod, podInput, podUid);
        if (readPodCreatedAt(readyPod) !== podCreatedAt) throw new Error("isolated worker Pod creation timestamp changed before readiness");
        await state.markRunning({ handle, pod: readyPod });
      } catch (error) {
        try {
          await infra.deletePod({ namespace, podName, podUid });
          const deleted = await infra.waitForPodDeleted({ namespace, podName, timeoutMs: deletionTimeoutMs });
          if (!deleted) throw new Error(`timed out cleaning up isolated worker pod: ${podName}`);
          const markedFailed = await state.markCreateFailed({
            podInput,
            podName,
            reason: error instanceof Error ? error.message : String(error),
          });
          if (!markedFailed) throw new Error("isolated worker pod cleanup completed but allocation state changed");
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], `isolated worker creation failed and pod cleanup did not complete: ${podName}`);
        }
        throw error;
      }
      return handle;
    },

    async revoke(
      handle: IsolatedWorkerPodHandle,
      context: IsolatedWorkerRevocationContext,
    ): Promise<IsolatedWorkerRevocationReceipt> {
      assertRevocationContext(context);
      const revocationKey = `${handle.isolatedWorkerPolicy.disposableSpaceId}:${handle.isolatedWorkerPolicy.podUid}`;
      const activeRevocation = revocations.get(revocationKey);
      if (activeRevocation) {
        const receipt = await activeRevocation;
        assertReceiptContext(receipt, context);
        return receipt;
      }
      const operation = (async () => {
      assertHandle(handle);
      const persistedReceipt = await state.readTerminationReceipt({ handle });
      if (persistedReceipt) {
        assertReceiptContext(persistedReceipt, context);
        return persistedReceipt;
      }
      const claimId = getTerminationClaimId(handle);
      const claimed = await state.claimTermination({ handle, claimId, startedAt: new Date().toISOString() });
      if (!claimed) {
        const racedReceipt = await state.readTerminationReceipt({ handle });
        if (racedReceipt) return racedReceipt;
        throw new Error("isolated worker revocation is already in progress or its state binding changed");
      }
      const binding = {
        authoritySpaceId: handle.isolatedWorkerPolicy.authoritySpaceId,
        disposableSpaceId: handle.isolatedWorkerPolicy.disposableSpaceId,
        sessionId: handle.sessionId,
        turnId: handle.turnId,
      };
      const currentPod = await infra.readPod({ namespace, podName: handle.podName });
      if (currentPod) {
        assertPodBinding(currentPod, binding, handle.isolatedWorkerPolicy.podUid);
        await infra.deletePod({ namespace, podName: handle.podName, podUid: handle.isolatedWorkerPolicy.podUid });
      }
      const deleted = await infra.waitForPodDeleted({ namespace, podName: handle.podName, timeoutMs: deletionTimeoutMs });
      if (!deleted) throw new Error(`timed out waiting for isolated worker pod deletion: ${handle.podName}`);
      const observedPodDeletedAt = new Date().toISOString();
      const podDeletedAt = await state.markPodDeleted({ handle, claimId, podDeletedAt: observedPodDeletedAt });
      if (!podDeletedAt) throw new Error("isolated worker pod deletion state changed before checkpoint");
      const initialCheckpointAttemptId = createHash("sha256").update(`${claimId}:checkpoint`).digest("hex");
      const initialCheckpointTaskRunId = getCheckpointTaskRunId(initialCheckpointAttemptId);
      const checkpointClaim = await state.claimCheckpoint({
        handle,
        claimId,
        checkpointAttemptId: initialCheckpointAttemptId,
        checkpointTaskRunId: initialCheckpointTaskRunId,
      });
      if (!checkpointClaim) throw new Error("isolated worker checkpoint is already in progress");
      let checkpointAttempt = typeof checkpointClaim === "boolean"
        ? { checkpointAttemptId: initialCheckpointAttemptId, checkpointTaskRunId: initialCheckpointTaskRunId }
        : checkpointClaim;
      let checkpoint = await state.readCheckpoint({ handle, claimId, checkpointAttemptId: checkpointAttempt.checkpointAttemptId });
      for (let retries = 0; !checkpoint; retries += 1) {
        try {
          const createdCheckpoint = validateFrozenCheckpointReadback(
            handle,
            await createFrozenCheckpoint(handle, checkpointAttempt.checkpointAttemptId, checkpointAttempt.checkpointTaskRunId),
          );
          const persisted = await state.persistCheckpoint({
            handle,
            claimId,
            checkpointAttemptId: checkpointAttempt.checkpointAttemptId,
            checkpoint: createdCheckpoint,
          });
          if (!persisted) {
            checkpoint = await state.readCheckpoint({ handle, claimId, checkpointAttemptId: checkpointAttempt.checkpointAttemptId });
            if (!checkpoint) throw new Error("isolated worker checkpoint state changed before persistence");
          } else {
            checkpoint = createdCheckpoint;
          }
        } catch (error) {
          if (!(error instanceof IsolatedWorkerCheckpointNoEffectError)) throw error;
          if (!state.rotateCheckpoint || retries >= 2) {
            throw new Error("isolated worker checkpoint exhausted CAS retries after proven no-effect failures", { cause: error });
          }
          const nextCheckpointAttemptId = createHash("sha256")
            .update(`${checkpointAttempt.checkpointAttemptId}:retry`)
            .digest("hex");
          const nextCheckpointTaskRunId = getCheckpointTaskRunId(nextCheckpointAttemptId);
          const rotated = await state.rotateCheckpoint({
            handle,
            claimId,
            checkpointAttemptId: checkpointAttempt.checkpointAttemptId,
            checkpointTaskRunId: checkpointAttempt.checkpointTaskRunId,
            nextCheckpointAttemptId,
            nextCheckpointTaskRunId,
          });
          if (!rotated) throw new Error("isolated worker checkpoint retry CAS changed unexpectedly");
          checkpointAttempt = rotated;
          checkpoint = await state.readCheckpoint({ handle, claimId, checkpointAttemptId: checkpointAttempt.checkpointAttemptId });
        }
      }
      checkpoint = validateFrozenCheckpointReadback(handle, checkpoint);
      if (Date.parse(checkpoint.checkpointCreatedAt) <= Date.parse(podDeletedAt)) {
        throw new Error("isolated worker checkpoint was not created after pod deletion");
      }
      const receipt: IsolatedWorkerRevocationReceipt = {
        ...context,
        podUid: handle.isolatedWorkerPolicy.podUid,
        podDeleted: true,
        podDeletedAt,
        credentialRevoked: true,
        sandboxTerminated: true,
        checkpointCreatedAfterPodDeletion: true,
        checkpointAdapter: "trusted_production",
        terminatedAt: new Date().toISOString(),
        checkpointId: checkpoint.checkpointId,
        checkpointCommit: checkpoint.commit,
        checkpointTreeSha256: checkpoint.treeSha256,
      };
      const completed = await state.completeTermination({
        handle,
        claimId,
        checkpointAttemptId: checkpointAttempt.checkpointAttemptId,
        receipt,
      });
      if (!completed) {
        const racedReceipt = await state.readTerminationReceipt({ handle });
        if (!racedReceipt) throw new Error("isolated worker termination state changed before receipt persistence");
        assertReceiptContext(racedReceipt, context);
        return racedReceipt;
      }
      return receipt;
      })();
      revocations.set(revocationKey, operation);
      try {
        return await operation;
      } finally {
        if (revocations.get(revocationKey) === operation) revocations.delete(revocationKey);
      }
    },
  };
}

async function createTrustedFrozenCheckpoint(
  handle: IsolatedWorkerPodHandle,
  _checkpointAttemptId: string,
  checkpointTaskRunId: string,
): Promise<FrozenCheckpointReadback> {
  const { enqueueTask, taskQueue } = await import("./tasks.js");
  const { db } = await import("./db/index.js");
  const { checkpoints, spaces, taskRuns } = await import("@cohub/db");
  const disposableSpaceId = handle.isolatedWorkerPolicy.disposableSpaceId;
  const [space] = await db.select({
    id: spaces.id,
    userUuid: spaces.userUuid,
  }).from(spaces).where(eq(spaces.id, disposableSpaceId)).limit(1);
  if (!space) throw new Error("isolated worker disposable space not found");

  const readCheckpointCreatedByTask = async (): Promise<FrozenCheckpointReadback | null> => {
    const [frozen] = await db.select({
      checkpointId: checkpoints.id,
      commit: checkpoints.commitHash,
      meta: checkpoints.meta,
      currentHeadCheckpointId: spaces.headCheckpointId,
      checkpointCreatedAt: checkpoints.createdAt,
    }).from(checkpoints)
      .innerJoin(spaces, eq(spaces.id, checkpoints.spaceId))
      .where(and(
        eq(checkpoints.spaceId, disposableSpaceId),
        sql`${checkpoints.meta}->>'sourceTaskRunId' = ${checkpointTaskRunId}`,
      ))
      .limit(1);
    if (!frozen) return null;
    if (frozen.currentHeadCheckpointId !== frozen.checkpointId || !frozen.checkpointCreatedAt) {
      throw new Error("IN_DOUBT: isolated worker checkpoint task left a partial checkpoint record");
    }
    const meta = frozen.meta && typeof frozen.meta === "object" && !Array.isArray(frozen.meta)
      ? frozen.meta as Record<string, unknown>
      : null;
    const gitTree = meta?.gitTree && typeof meta.gitTree === "object" && !Array.isArray(meta.gitTree)
      ? meta.gitTree as Record<string, unknown>
      : null;
    if (typeof gitTree?.hash !== "string" || !gitTree.hash || typeof gitTree.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(gitTree.sha256)) {
      throw new Error("isolated worker checkpoint task recovery readback is malformed");
    }
    return {
      disposableSpaceId,
      checkpointId: frozen.checkpointId,
      commit: frozen.commit,
      tree: gitTree.hash,
      treeSha256: gitTree.sha256,
      currentHead: frozen.commit,
      checkpointCreatedAt: frozen.checkpointCreatedAt.toISOString(),
    };
  };
  const recoveredCheckpoint = await readCheckpointCreatedByTask();
  if (recoveredCheckpoint) return recoveredCheckpoint;

  const checkpointPayload = {
    type: "save_checkpoint" as const,
    spaceId: disposableSpaceId,
    sessionId: handle.sessionId,
    turnId: handle.turnId,
    userId: space.userUuid,
    data: {
      reason: "isolated_worker_revocation",
      description: `Frozen isolated worker turn ${handle.turnId}`,
    },
  };
  const [existingTask] = await db.select({ id: taskRuns.id, status: taskRuns.status }).from(taskRuns)
    .where(eq(taskRuns.id, checkpointTaskRunId)).limit(1);
  if (!existingTask) {
    await enqueueTask(checkpointPayload, {
      attempts: 1,
      removeOnComplete: true,
      taskRunId: checkpointTaskRunId,
    });
  } else if (existingTask.status === "failed") {
    const checkpointAfterFailure = await readCheckpointCreatedByTask();
    if (checkpointAfterFailure) return checkpointAfterFailure;
    throw new IsolatedWorkerCheckpointNoEffectError(
      `isolated worker checkpoint TaskRun ${checkpointTaskRunId} failed with no authoritative checkpoint effect`,
    );
  } else if (existingTask.status === "pending") {
    const existingJob = await taskQueue.getJob(checkpointTaskRunId);
    if (!existingJob) {
      await taskQueue.add(checkpointPayload.type, checkpointPayload, {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
        jobId: checkpointTaskRunId,
      });
    }
  }
  const taskRunId = checkpointTaskRunId;

  const deadline = Date.now() + 300_000;
  let completedResult: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const [task] = await db.select({
      status: taskRuns.status,
      result: taskRuns.result,
      errorMessage: taskRuns.errorMessage,
    }).from(taskRuns).where(eq(taskRuns.id, taskRunId)).limit(1);
    if (!task) throw new Error("isolated worker checkpoint task disappeared");
    if (task.status === "failed") throw new Error(`isolated worker checkpoint failed: ${task.errorMessage ?? "unknown error"}`);
    if (task.status === "completed") {
      if (!task.result || typeof task.result !== "object" || Array.isArray(task.result)) {
        throw new Error("isolated worker checkpoint returned malformed result");
      }
      completedResult = task.result as Record<string, unknown>;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!completedResult) throw new Error("timed out waiting for isolated worker checkpoint");

  const checkpointId = typeof completedResult.checkpointId === "string" ? completedResult.checkpointId : "";
  const commit = typeof completedResult.commitHash === "string" ? completedResult.commitHash : "";
  const tree = typeof completedResult.treeHash === "string" ? completedResult.treeHash : "";
  const treeSha256 = typeof completedResult.checkpointTreeSha256 === "string" ? completedResult.checkpointTreeSha256 : "";
  if (!checkpointId || !commit || !tree || !/^[a-f0-9]{64}$/.test(treeSha256) || completedResult.spaceId !== disposableSpaceId) {
    throw new Error("isolated worker checkpoint result binding mismatch");
  }
  const [frozen] = await db.select({
    checkpointId: checkpoints.id,
    commit: checkpoints.commitHash,
    currentHeadCheckpointId: spaces.headCheckpointId,
    checkpointCreatedAt: checkpoints.createdAt,
    checkpointMeta: checkpoints.meta,
  }).from(checkpoints)
    .innerJoin(spaces, eq(spaces.id, checkpoints.spaceId))
    .where(and(eq(checkpoints.id, checkpointId), eq(checkpoints.spaceId, disposableSpaceId)))
    .limit(1);
  const frozenMeta = frozen?.checkpointMeta && typeof frozen.checkpointMeta === "object" && !Array.isArray(frozen.checkpointMeta)
    ? frozen.checkpointMeta as Record<string, unknown>
    : null;
  const gitTree = frozenMeta?.gitTree && typeof frozenMeta.gitTree === "object" && !Array.isArray(frozenMeta.gitTree)
    ? frozenMeta.gitTree as Record<string, unknown>
    : null;
  if (!frozen?.checkpointCreatedAt || frozen.commit !== commit || frozen.currentHeadCheckpointId !== checkpointId || gitTree?.hash !== tree || gitTree.sha256 !== treeSha256) {
    throw new Error("IN_DOUBT: isolated worker frozen checkpoint does not match disposable space head");
  }
  return {
    disposableSpaceId,
    checkpointId,
    commit,
    tree,
    treeSha256,
    currentHead: frozen.commit,
    checkpointCreatedAt: frozen.checkpointCreatedAt.toISOString(),
  };
}

export const isolatedWorkerPodLifecycle = createIsolatedWorkerPodLifecycle({
  createFrozenCheckpoint: createTrustedFrozenCheckpoint,
});

export function renderConfiguredIsolatedWorkerPodTemplate(input: IsolatedWorkerBinding & { writableRoot: string; policySha256: string }) {
  return renderIsolatedWorkerPodTemplate({
    ...input,
    writableRoot: input.writableRoot,
    image: config.sandboxImage,
    spaceStoragePvc: config.spaceStoragePvc,
    spaceStorageSubpath: config.spaceStorageSubpath,
  });
}
