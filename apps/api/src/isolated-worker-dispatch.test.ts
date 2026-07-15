import assert from "node:assert/strict";
import {
  createIsolatedWorkerDispatch,
  createIsolatedWorkerReuseProbe,
  computeIsolatedWorkerInputManifestSha256,
  type IsolatedWorkerDispatchStore,
} from "./isolated-worker-dispatch.js";

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const nextId = (values: string[]) => {
  const value = values.shift();
  if (!value) throw new Error("test UUID sequence exhausted");
  return value;
};

const reservations: unknown[] = [];
const enqueued: unknown[] = [];
const failures: unknown[] = [];
const inputBundleBase = {
  authorityCheckpointId: "99999999-9999-4999-8999-999999999999",
  authorityCheckpointCommit: "a".repeat(40),
  authorityTreeSha256: "c".repeat(64),
  items: [{ sourcePath: "modules/task.md", destinationPath: "inputs/task.md", contentSha256: "d".repeat(64), sourceType: "regular_file" as const }],
};
const inputBundle = {
  ...inputBundleBase,
  inputManifestSha256: computeIsolatedWorkerInputManifestSha256(inputBundleBase),
  runtimeAuthorityReadAllowed: false as const,
};
const store: IsolatedWorkerDispatchStore = {
  async validateInputManifest() {},
  async reserveTask(input) {
    reservations.push(input);
  },
  async enqueue(input) {
    enqueued.push(input);
  },
  async markEnqueueFailed(input) {
    failures.push(input);
  },
  async assertReusableProbeTarget() {
    return { status: "terminated", authoritySpaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  },
  async reserveReuseProbe(input) {
    reservations.push(input);
  },
};

const result = await createIsolatedWorkerDispatch({
  authoritySpaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "user-1",
  input: {
    clientMessageId: "client-1",
    content: [{ type: "text", text: "build the declared output" }],
    inputBundle,
  },
  randomUUID: () => nextId(ids),
  store,
});

assert.equal(reservations.length, 1);
assert.equal(enqueued.length, 1);
assert.equal(failures.length, 0);
assert.deepEqual(result, {
  taskRunId: "33333333-3333-4333-8333-333333333333",
  authoritySpaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  disposableSpaceId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  policySha256: result.policySha256,
  inputManifestSha256: result.inputManifestSha256,
  creationPath: "dedicated_disposable_space_without_standard_sandbox",
  ordinarySandboxProvisioned: false,
  terminatedSpaceReused: false,
  credentialMode: "engine_scoped_dispatch_authority",
  engineInternalSecretIssued: false,
  publicPromptUsed: false,
  checkpointAdapter: "trusted_production",
});
assert.match(result.policySha256, /^[a-f0-9]{64}$/);

const reservation = reservations[0] as {
  taskRunId: string;
  payload: { data: { disposableSpaceId: string } };
};
assert.equal(reservation.taskRunId, result.taskRunId);
assert.equal(reservation.payload.data.disposableSpaceId, result.disposableSpaceId);
const queued = enqueued[0] as {
  taskRunId: string;
  payload: {
    type: string;
    spaceId: string;
    sessionId: string;
    data: Record<string, unknown> & { disposableSpaceId: string; engineInternalSecretIssued: boolean };
  };
};
assert.equal(queued.taskRunId, result.taskRunId);
assert.equal(queued.payload.type, "isolated_worker_dispatch");
assert.equal(queued.payload.spaceId, result.authoritySpaceId);
assert.equal(queued.payload.sessionId, result.sessionId);
assert.equal(queued.payload.data.disposableSpaceId, result.disposableSpaceId);
assert.equal(queued.payload.data.engineInternalSecretIssued, false);
assert.equal("authToken" in queued.payload.data, false);
assert.equal("workerSecret" in queued.payload.data, false);

const failedStore: IsolatedWorkerDispatchStore = {
  ...store,
  async enqueue() {
    throw new Error("queue unavailable");
  },
};
await assert.rejects(
  createIsolatedWorkerDispatch({
    authoritySpaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    userId: "user-1",
    input: { clientMessageId: "client-2", content: [{ type: "text", text: "preserve me" }], inputBundle },
    randomUUID: (() => {
      const failedIds = [
        "44444444-4444-4444-8444-444444444444",
        "55555555-5555-4555-8555-555555555555",
        "66666666-6666-4666-8666-666666666666",
      ];
      return () => nextId(failedIds);
    })(),
    store: failedStore,
  }),
  /queue unavailable/,
);
assert.equal(failures.length, 1, "queue failure must be persisted without deleting the allocation");

const reuse = await createIsolatedWorkerReuseProbe({
  authoritySpaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  disposableSpaceId: result.disposableSpaceId,
  sessionId: "77777777-7777-4777-8777-777777777777",
  userId: "user-1",
  randomUUID: () => "88888888-8888-4888-8888-888888888888",
  store,
});
assert.deepEqual(reuse, {
  taskRunId: "88888888-8888-4888-8888-888888888888",
  disposableSpaceId: result.disposableSpaceId,
  rejected: true,
  reason: "terminated_space_reuse_forbidden",
});
const reuseJob = enqueued.at(-1) as { payload: { data: { reuseRejected: boolean } } };
assert.equal(reuseJob.payload.data.reuseRejected, true);

await assert.rejects(
  createIsolatedWorkerDispatch({
    authoritySpaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    userId: "user-1",
    input: { content: [{ type: "text", text: "x" }], inputBundle, unexpected: true } as unknown as Parameters<typeof createIsolatedWorkerDispatch>[0]["input"],
    randomUUID: () => "99999999-9999-4999-8999-999999999999",
    store,
  }),
  /unknown isolated worker dispatch field: unexpected/,
);

const policyResults: string[] = [];
for (const text of ["content-a", "content-b"]) {
  const localIds = [
    "aaaaaaaa-1111-4111-8111-111111111111",
    "aaaaaaaa-2222-4222-8222-222222222222",
    "aaaaaaaa-3333-4333-8333-333333333333",
  ];
  const local = await createIsolatedWorkerDispatch({
    authoritySpaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    userId: "user-1",
    input: { clientMessageId: "same-client", content: [{ type: "text", text }], inputBundle },
    randomUUID: () => nextId(localIds),
    store,
  });
  policyResults.push(local.policySha256);
}
assert.notEqual(policyResults[0], policyResults[1], "policy hash must bind prompt content");

const defaultRandomResult = await createIsolatedWorkerDispatch({
  authoritySpaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "user-1",
  input: { clientMessageId: "default-random", content: [{ type: "text", text: "exercise production UUID generation" }], inputBundle },
  store,
});
assert.match(defaultRandomResult.taskRunId, /^[0-9a-f-]{36}$/);
assert.match(defaultRandomResult.disposableSpaceId, /^[0-9a-f-]{36}$/);
assert.match(defaultRandomResult.sessionId, /^[0-9a-f-]{36}$/);

console.log("isolated worker public dispatch allocation checks passed");
