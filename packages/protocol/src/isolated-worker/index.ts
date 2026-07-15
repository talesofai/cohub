import type { ContentBlock } from "../core/index.js";

export const ISOLATED_WORKER_DISPATCH_TASK_TYPE = "isolated_worker_dispatch" as const;
export const ISOLATED_WORKER_REVOKE_TASK_TYPE = "isolated_worker_revoke" as const;
export const ISOLATED_WORKER_RECEIPT_SCAN_TASK_TYPE = "isolated_worker_receipt_scan" as const;
export const ISOLATED_WORKER_CREATION_PATH = "dedicated_disposable_space_without_standard_sandbox" as const;

export type IsolatedWorkerDispatchInput = {
  content: ContentBlock[];
  inputBundle: IsolatedWorkerInputBundle;
  clientMessageId?: string | null;
  title?: string | null;
  source?: string | null;
  model?: string | null;
  provider?: string | null;
  repairOfDisposableSpaceId?: string | null;
};

export type IsolatedWorkerInputItem = {
  sourcePath: string;
  destinationPath: string;
  contentSha256: string;
  sourceType: "regular_file";
};

export type IsolatedWorkerInputBundle = {
  authorityCheckpointId: string;
  authorityCheckpointCommit: string;
  authorityTreeSha256: string;
  inputManifestSha256: string;
  runtimeAuthorityReadAllowed: false;
  items: IsolatedWorkerInputItem[];
};

export type IsolatedWorkerReuseProbeInput = {
  disposableSpaceId: string;
  sessionId: string;
};

export type IsolatedWorkerDispatchResponse = {
  taskRunId: string;
  authoritySpaceId: string;
  disposableSpaceId: string;
  sessionId: string;
  policySha256: string;
  inputManifestSha256: string;
  creationPath: typeof ISOLATED_WORKER_CREATION_PATH;
  ordinarySandboxProvisioned: false;
  terminatedSpaceReused: false;
  credentialMode: "engine_scoped_dispatch_authority";
  engineInternalSecretIssued: false;
  publicPromptUsed: false;
  checkpointAdapter: "trusted_production";
};

export type IsolatedWorkerReuseProbeResponse = {
  taskRunId: string;
  disposableSpaceId: string;
  rejected: true;
  reason: "terminated_space_reuse_forbidden";
};

export type IsolatedWorkerTerminalStatus = "completed" | "failed" | "cancelled" | "interrupted";

export type IsolatedWorkerRevokeTaskData = {
  trigger: "turn_terminal_event";
  terminalStatus: IsolatedWorkerTerminalStatus;
  authoritySpaceId: string;
  disposableSpaceId: string;
  sessionId: string;
  turnId: string;
  podUid: string;
};

export type IsolatedWorkerReceiptScanTaskData = {
  authoritySpaceId: string;
  disposableSpaceId: string;
  workerSessionId: string;
  workerTurnId: string;
  podUid: string;
  revokeTaskRunId: string;
  checkpointId: string;
  checkpointTreeSha256: string;
};

export type IsolatedWorkerDispatchTaskData = {
  authoritySpaceId: string;
  disposableSpaceId: string;
  sessionId: string;
  clientMessageId: string;
  content: ContentBlock[];
  source: string;
  model: string | null;
  provider: string | null;
  policySha256: string;
  inputBundle: IsolatedWorkerInputBundle;
  inputManifestSha256: string;
  creationPath: typeof ISOLATED_WORKER_CREATION_PATH;
  ordinarySandboxProvisioned: false;
  terminatedSpaceReused: false;
  credentialMode: "engine_scoped_dispatch_authority";
  engineInternalSecretIssued: false;
  publicPromptUsed: false;
  checkpointAdapter: "trusted_production";
  repairOfDisposableSpaceId?: string;
  reuseRejected?: false;
};

export type IsolatedWorkerReuseRejectedTaskData = {
  authoritySpaceId: string;
  disposableSpaceId: string;
  reuseRejected: true;
  reason: "terminated_space_reuse_forbidden";
};
