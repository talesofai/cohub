export type IsolatedWorkerTerminalStatus = "completed" | "failed" | "interrupted" | "cancelled";

export type IsolatedWorkerTerminalTurn = {
  id: string;
  sessionId: string;
  status: string;
  meta: Record<string, unknown> | null;
};

export type IsolatedWorkerRevokeRequest = {
  spaceId: string;
  sessionId: string;
  turnId: string;
  authoritySpaceId: string;
  disposableSpaceId: string;
  podUid: string;
  terminalStatus: IsolatedWorkerTerminalStatus;
};

const TERMINAL_STATUSES = new Set<IsolatedWorkerTerminalStatus>([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function getIsolatedWorkerRevokeRequest(
  spaceId: string,
  turn: IsolatedWorkerTerminalTurn,
  terminalStatus: IsolatedWorkerTerminalStatus,
): IsolatedWorkerRevokeRequest | null {
  const handle = isRecord(turn.meta?.isolatedWorker) ? turn.meta.isolatedWorker : null;
  if (!handle) return null;
  if (!TERMINAL_STATUSES.has(terminalStatus)) {
    throw new Error("isolated worker requested terminal status is invalid");
  }
  const policy = isRecord(handle.isolatedWorkerPolicy) ? handle.isolatedWorkerPolicy : null;
  if (
    handle.sessionId !== turn.sessionId
    || handle.turnId !== turn.id
    || !policy
    || policy.disposableSpaceId !== spaceId
    || typeof policy.authoritySpaceId !== "string"
    || !policy.authoritySpaceId
    || typeof policy.podUid !== "string"
    || !policy.podUid
  ) {
    throw new Error("isolated worker terminal Turn binding mismatch");
  }
  return {
    spaceId,
    sessionId: turn.sessionId,
    turnId: turn.id,
    authoritySpaceId: policy.authoritySpaceId,
    disposableSpaceId: spaceId,
    podUid: policy.podUid,
    terminalStatus,
  };
}

export function createIsolatedWorkerTerminalFinalizer(deps: {
  revoke(request: IsolatedWorkerRevokeRequest): Promise<unknown>;
}) {
  return async (
    spaceId: string,
    turn: IsolatedWorkerTerminalTurn,
    terminalStatus: IsolatedWorkerTerminalStatus,
  ) => {
    const request = getIsolatedWorkerRevokeRequest(spaceId, turn, terminalStatus);
    if (!request) return null;
    const response = await deps.revoke(request);
    const body = isRecord(response) ? response : null;
    const receipt = body && isRecord(body.receipt) ? body.receipt : null;
    if (
      body?.ok !== true
      || !receipt
      || receipt.podUid !== request.podUid
      || receipt.automaticTrigger !== "turn_terminal_event"
      || receipt.manualEndpointInvoked !== false
      || typeof receipt.revokeTaskRunId !== "string"
      || !receipt.revokeTaskRunId
      || receipt.podDeleted !== true
      || receipt.credentialRevoked !== true
      || receipt.sandboxTerminated !== true
      || receipt.checkpointCreatedAfterPodDeletion !== true
      || receipt.checkpointAdapter !== "trusted_production"
      || typeof receipt.checkpointId !== "string"
      || !receipt.checkpointId
      || typeof receipt.checkpointCommit !== "string"
      || !receipt.checkpointCommit
      || typeof receipt.checkpointTreeSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(receipt.checkpointTreeSha256)
    ) {
      throw new Error("isolated worker termination receipt is incomplete or mismatched");
    }
    return receipt;
  };
}
