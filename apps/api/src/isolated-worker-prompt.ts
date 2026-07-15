import type {
  SubmitSessionPromptHooks,
  SubmitSessionPromptInput,
  SubmitSessionPromptResult,
} from "@cohub/core/sessions";
import type {
  IsolatedWorkerPodHandle,
  IsolatedWorkerPolicy,
  IsolatedWorkerRevocationReceipt,
} from "./isolated-worker-pods.js";

const POLICY_FIELDS = new Set([
  "authoritySpaceId",
  "disposableSpaceId",
  "writableRoot",
  "workspaceReadOnly",
  "executionTokenIssued",
  "policySha256",
]);

const ISOLATED_PROMPT_BODY_FIELDS = new Set([
  "content",
  "userId",
  "clientMessageId",
  "source",
  "model",
  "provider",
  "accessMode",
  "isolatedWorkerPolicy",
  "inputsMaterializedAt",
  "dispatchTaskRunId",
  "context",
]);

export type IsolatedWorkerPolicyInput = Omit<IsolatedWorkerPolicy, "podUid">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function assertExactIsolatedWorkerPromptBody(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error("isolated worker prompt body is required");
  const unknownField = Object.keys(value).find((key) => !ISOLATED_PROMPT_BODY_FIELDS.has(key));
  if (unknownField) throw new Error(`isolated worker prompt contains unknown field: ${unknownField}`);
  for (const field of ISOLATED_PROMPT_BODY_FIELDS) {
    if (!(field in value)) throw new Error(`isolated worker prompt is missing field: ${field}`);
  }
}

export function parseIsolatedWorkerPolicyInput(value: unknown, disposableSpaceId: string): IsolatedWorkerPolicyInput {
  if (!isRecord(value)) throw new Error("isolatedWorkerPolicy is required");
  const unknownField = Object.keys(value).find((key) => !POLICY_FIELDS.has(key));
  if (unknownField) throw new Error(`isolatedWorkerPolicy contains unknown field: ${unknownField}`);
  for (const field of POLICY_FIELDS) {
    if (!(field in value)) throw new Error(`isolatedWorkerPolicy.${field} is required`);
  }
  if (typeof value.authoritySpaceId !== "string" || !value.authoritySpaceId.trim()) {
    throw new Error("isolatedWorkerPolicy.authoritySpaceId is required");
  }
  if (value.disposableSpaceId !== disposableSpaceId) throw new Error("isolatedWorkerPolicy disposable space binding mismatch");
  if (value.authoritySpaceId === disposableSpaceId) {
    throw new Error("isolatedWorkerPolicy.disposableSpaceId must differ from authoritySpaceId");
  }
  if (value.writableRoot !== "/workspace/work") throw new Error("isolatedWorkerPolicy.writableRoot must be /workspace/work");
  if (value.workspaceReadOnly !== true) throw new Error("isolatedWorkerPolicy.workspaceReadOnly must be true");
  if (value.executionTokenIssued !== false) throw new Error("isolatedWorkerPolicy.executionTokenIssued must be false");
  if (typeof value.policySha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.policySha256)) {
    throw new Error("isolatedWorkerPolicy.policySha256 must be a lowercase SHA-256 digest");
  }
  return {
    authoritySpaceId: value.authoritySpaceId,
    disposableSpaceId,
    writableRoot: "/workspace/work",
    workspaceReadOnly: true,
    executionTokenIssued: false,
    policySha256: value.policySha256,
  };
}

export async function submitIsolatedWorkerPrompt(input: {
  policy: IsolatedWorkerPolicyInput;
  sessionId: string;
  turnMeta?: Record<string, unknown>;
  prompt: SubmitSessionPromptInput & { accessMode: "isolated_worker" };
  submitPrompt: (prompt: SubmitSessionPromptInput, hooks: SubmitSessionPromptHooks) => Promise<SubmitSessionPromptResult>;
  createPod: (input: IsolatedWorkerPolicyInput & { sessionId: string; turnId: string }) => Promise<IsolatedWorkerPodHandle>;
  onPodCreatedBeforeEnqueue?: (input: {
    handle: IsolatedWorkerPodHandle;
    turnId: string;
    userMessageId: string;
  }) => Promise<{ podCreatedAt: string } | undefined>;
  revokePod: (handle: IsolatedWorkerPodHandle) => Promise<IsolatedWorkerRevocationReceipt>;
}) {
  if (input.prompt.spaceId !== input.policy.disposableSpaceId || input.prompt.sessionId !== input.sessionId) {
    throw new Error("isolated worker prompt binding mismatch");
  }
  let handle: IsolatedWorkerPodHandle | null = null;
  let failureRevoked = false;
  let podCreatedAt: string | null = null;
  try {
    const result = await input.submitPrompt(input.prompt, {
      beforeEnqueue: async ({ turnId }) => {
        handle = await input.createPod({ ...input.policy, sessionId: input.sessionId, turnId });
        return {
          ...(input.turnMeta ?? {}),
          isolatedWorker: handle,
          isolatedWorkerPolicy: handle.isolatedWorkerPolicy,
        };
      },
      afterMetaPersistedBeforeEnqueue: async ({ turnId, userMessageId }) => {
        const createdHandle = handle as IsolatedWorkerPodHandle | null;
        if (!createdHandle) throw new Error("isolated worker pod is missing after meta persistence");
        const completed = await input.onPodCreatedBeforeEnqueue?.({ handle: createdHandle, turnId, userMessageId });
        if (completed) podCreatedAt = completed.podCreatedAt;
      },
      beforeFailureTerminalized: async () => {
        const createdHandle = handle as IsolatedWorkerPodHandle | null;
        if (!createdHandle) return;
        await input.revokePod(createdHandle);
        failureRevoked = true;
      },
    });
    const completedHandle = handle as IsolatedWorkerPodHandle | null;
    if (!completedHandle) throw new Error("isolated worker pod was not created before enqueue");
    if (!podCreatedAt) throw new Error("isolated worker pod creation timestamp was not persisted before enqueue");
    return {
      ...result,
      podUid: completedHandle.isolatedWorkerPolicy.podUid,
      policySha256: completedHandle.isolatedWorkerPolicy.policySha256,
      podCreatedAt,
    };
  } catch (error) {
    if (!handle || failureRevoked) throw error;
    try {
      await input.revokePod(handle);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "isolated worker prompt failed and pod revocation did not complete");
    }
    throw error;
  }
}
