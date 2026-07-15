import assert from "node:assert/strict";
import {
  assertSandboxCanResumeOrRecreate,
  assertSandboxCanAutoRecover,
  buildInvalidatedSandboxEndpointMeta,
  getSandboxPromptRecoveryReason,
  hasSandboxEndpoint,
  isSandboxAwaitingEndpointReport,
  isSandboxDialable,
  isTerminatedIsolatedWorkerSandbox,
  sandboxEndpointInvalidationPatch,
} from "./index.js";

assert.equal(hasSandboxEndpoint({ podIp: "10.0.0.1" }), true);
assert.equal(hasSandboxEndpoint({ wsEndpoint: "ws://10.0.0.1:8788/sandbox" }), true);
assert.equal(hasSandboxEndpoint({ podIp: "", wsEndpoint: "  " }), false);
assert.equal(hasSandboxEndpoint(null), false);

assert.equal(isSandboxDialable({ status: "running", meta: { podIp: "10.0.0.1" } }), true);
assert.equal(isSandboxDialable({ status: "running", meta: {} }), false);
assert.equal(isSandboxDialable({ status: "stopped", meta: { podIp: "10.0.0.1" } }), false);

assert.equal(
  isTerminatedIsolatedWorkerSandbox({
    status: "running",
    meta: {
      isolatedWorkerPolicy: { disposableSpaceId: "space-disposable" },
      termination: { sandboxTerminated: true },
    },
  }),
  true,
  "a persisted termination receipt is terminal even when status is stale",
);
assert.equal(
  isTerminatedIsolatedWorkerSandbox({
    status: "terminated",
    meta: { isolatedWorkerPolicy: { disposableSpaceId: "space-disposable" } },
  }),
  true,
  "terminated isolated workers cannot be recreated without a receipt readback",
);
assert.equal(
  isTerminatedIsolatedWorkerSandbox({
    status: "terminated",
    meta: {},
  }),
  false,
  "ordinary terminated sandboxes keep their existing recreate behavior",
);
assert.equal(
  isTerminatedIsolatedWorkerSandbox({
    status: "running",
    meta: { termination: { sandboxTerminated: true } },
  }),
  false,
  "a termination marker without isolated worker identity is not enough",
);
assert.equal(
  isTerminatedIsolatedWorkerSandbox({
    status: "stopping",
    meta: {
      isolatedWorkerPolicy: { disposableSpaceId: "space-disposable" },
      terminationClaimId: "claim-1",
    },
  }),
  true,
  "a failed or in-flight revocation stays non-resumable",
);
assert.throws(
  () => assertSandboxCanResumeOrRecreate({
    status: "stopped",
    meta: {
      isolatedWorkerPolicy: { disposableSpaceId: "space-disposable" },
      termination: { sandboxTerminated: true },
    },
  }),
  /isolated worker sandbox cannot be resumed or recreated/,
);
assert.throws(
  () => assertSandboxCanAutoRecover({ status: "terminated", meta: {} }),
  /terminated sandbox cannot be automatically recovered/,
);
assert.throws(
  () => assertSandboxCanAutoRecover({
    status: "running",
    meta: {
      isolatedWorkerPolicy: { disposableSpaceId: "space-disposable" },
      termination: { sandboxTerminated: true },
    },
  }),
  /isolated worker sandbox cannot be resumed or recreated/,
);
assert.throws(
  () => assertSandboxCanResumeOrRecreate({
    status: "allocated",
    meta: {
      isolatedWorker: {
        state: "allocated",
        authoritySpaceId: "space-authority",
        disposableSpaceId: "space-disposable",
        resumable: false,
      },
    },
  }),
  /allocate a new disposable space/,
);

assert.equal(getSandboxPromptRecoveryReason(null), "missing");
assert.equal(
  getSandboxPromptRecoveryReason({ status: "running", provider: "local", meta: {} }),
  null,
  "local sandboxes are never server-recovered",
);
assert.equal(
  getSandboxPromptRecoveryReason({ status: "provisioning", provider: "cloud", meta: {} }),
  null,
  "already provisioning — do not thrash",
);
assert.equal(
  getSandboxPromptRecoveryReason({ status: "error", provider: "cloud", meta: { podIp: "1.2.3.4" } }),
  "auto_recover",
);
assert.equal(
  getSandboxPromptRecoveryReason({ status: "stopped", provider: "cloud", meta: {} }),
  "auto_resume",
);
assert.equal(
  getSandboxPromptRecoveryReason({ status: "running", provider: "cloud", meta: { podIp: null, wsEndpoint: null } }),
  "missing_endpoint",
  "usable without coordinates should wake recover early",
);
assert.equal(
  getSandboxPromptRecoveryReason({
    status: "running",
    provider: "cloud",
    meta: {
      podIp: null,
      lastRecoveredAt: new Date().toISOString(),
      recoveryStatus: "ready",
    },
  }),
  null,
  "post-recover grace should not thrash missing_endpoint",
);
assert.equal(
  isSandboxAwaitingEndpointReport({ recoveryStatus: "recreating" }),
  true,
);
assert.equal(
  getSandboxPromptRecoveryReason({ status: "running", provider: "cloud", meta: { podIp: "10.187.125.231" } }),
  null,
  "present endpoint is left to agent-side unreachable recover",
);

const invalidated = buildInvalidatedSandboxEndpointMeta(
  { podIp: "10.0.0.1", wsEndpoint: "ws://10.0.0.1:8788/sandbox", reportTokenHash: "abc", keep: 1 },
  "endpoint_unreachable",
  "2026-07-13T00:00:00.000Z",
);
assert.equal(invalidated.podIp, null);
assert.equal(invalidated.wsEndpoint, null);
assert.equal(invalidated.reportTokenHash, null);
assert.equal(invalidated.keep, 1);
assert.deepEqual(
  sandboxEndpointInvalidationPatch("idle", "2026-07-13T00:00:00.000Z").podIp,
  null,
);

console.log("sandbox prompt recovery gate checks passed");
