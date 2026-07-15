import assert from "node:assert/strict";
import { createIsolatedWorkerTerminalFinalizer } from "../isolated-worker-termination.js";

const statuses = ["completed", "failed", "interrupted", "cancelled"] as const;
const calls: string[] = [];
const finalizer = createIsolatedWorkerTerminalFinalizer({
  async revoke(request) {
    calls.push(`${request.turnId}:${request.podUid}`);
    return {
      ok: true,
      receipt: {
        revokeTaskRunId: "11111111-1111-4111-8111-111111111111",
        automaticTrigger: "turn_terminal_event",
        manualEndpointInvoked: false,
        podUid: request.podUid,
        podDeleted: true,
        credentialRevoked: true,
        sandboxTerminated: true,
        checkpointCreatedAfterPodDeletion: true,
        checkpointAdapter: "trusted_production",
        checkpointId: `checkpoint-${request.turnId}`,
        checkpointCommit: "a".repeat(40),
        checkpointTreeSha256: "b".repeat(64),
      },
    };
  },
});

for (const [index, status] of statuses.entries()) {
  const turnId = `turn-${index}`;
  const receipt = await finalizer("disposable-space", {
    id: turnId,
    sessionId: "session-1",
    status: status === "cancelled" ? "queued" : "running",
    meta: {
      isolatedWorker: {
        sessionId: "session-1",
        turnId,
        isolatedWorkerPolicy: {
          authoritySpaceId: "authority-space",
          disposableSpaceId: "disposable-space",
          podUid: `pod-${index}`,
        },
      },
    },
  }, status);
  assert.equal(receipt?.podUid, `pod-${index}`);
}

assert.deepEqual(calls, statuses.map((_, index) => `turn-${index}:pod-${index}`));
assert.equal(await finalizer("ordinary-space", {
  id: "ordinary-turn",
  sessionId: "session-2",
  status: "completed",
  meta: null,
}, "completed"), null);

await assert.rejects(() => finalizer("disposable-space", {
  id: "running-turn",
  sessionId: "session-1",
  status: "running",
  meta: {
    isolatedWorker: {
      sessionId: "session-1",
      turnId: "running-turn",
      isolatedWorkerPolicy: {
        authoritySpaceId: "authority-space",
        disposableSpaceId: "disposable-space",
        podUid: "pod-running",
      },
    },
  },
}, "not-terminal" as never), /requested terminal status is invalid/);

console.log("isolated worker terminal finalization checks passed");
