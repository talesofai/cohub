import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  classifyIsolatedWorkerDisposable,
  createIsolatedWorkerDisposableGuard,
  createIsolatedWorkerDisposableRouteGuard,
  IsolatedWorkerDisposableOperationError,
  type IsolatedWorkerDisposableRecord,
} from "./isolated-worker-disposable-guard-domain.js";

const ordinary: IsolatedWorkerDisposableRecord = {
  spaceMeta: { config: {} },
  sandboxStatus: "running",
  sandboxMeta: {},
};
const active: IsolatedWorkerDisposableRecord = {
  spaceMeta: { isolatedWorkerDisposable: { authoritySpaceId: "authority" } },
  sandboxStatus: "running",
  sandboxMeta: { isolatedWorker: { state: "running" } },
};
const terminated: IsolatedWorkerDisposableRecord = {
  spaceMeta: { isolatedWorkerDisposable: null },
  sandboxStatus: "running",
  sandboxMeta: { termination: { sandboxTerminated: true } },
};

assert.equal(classifyIsolatedWorkerDisposable(null), null);
assert.equal(classifyIsolatedWorkerDisposable(ordinary), null);
assert.equal(classifyIsolatedWorkerDisposable(active), "active");
assert.equal(classifyIsolatedWorkerDisposable(terminated), "terminated");
assert.equal(classifyIsolatedWorkerDisposable({
  spaceMeta: {},
  sandboxStatus: "allocated",
  sandboxMeta: { isolatedWorkerPolicy: null },
}), "active", "a malformed persisted identity must fail closed");

let reads = 0;
const records = new Map<string, IsolatedWorkerDisposableRecord>([
  ["ordinary", ordinary],
  ["active", active],
  ["terminated", terminated],
]);
const guard = createIsolatedWorkerDisposableGuard(async (spaceId) => {
  reads += 1;
  return records.get(spaceId) ?? null;
});

await guard("ordinary", "generic_prompt");
await assert.rejects(
  guard("active", "generic_task_dispatch"),
  (error: unknown) => error instanceof IsolatedWorkerDisposableOperationError
    && error.state === "active"
    && error.operation === "generic_task_dispatch",
);
await assert.rejects(
  guard("terminated", "sandbox_lifecycle"),
  (error: unknown) => error instanceof IsolatedWorkerDisposableOperationError
    && error.state === "terminated",
);
for (const operation of [
  "isolated_worker_dispatch",
  "isolated_worker_runtime",
  "isolated_worker_revoke",
  "isolated_worker_checkpoint",
  "isolated_worker_reuse_probe",
] as const) {
  await guard("active", operation);
}
for (const operation of [
  "isolated_worker_checkpoint",
  "isolated_worker_receipt_scan",
] as const) {
  await guard("terminated", operation);
}
await assert.rejects(guard("terminated", "isolated_worker_revoke"), IsolatedWorkerDisposableOperationError);
await assert.rejects(guard("terminated", "isolated_worker_reuse_probe"), IsolatedWorkerDisposableOperationError);
await assert.rejects(guard("active", "isolated_worker_receipt_scan"), IsolatedWorkerDisposableOperationError);
assert.equal(reads, 13);

let sideEffects = 0;
const routeGuard = createIsolatedWorkerDisposableRouteGuard(guard);
const app = new Hono();
app.post("/:id/generic", async (c) => {
  const rejected = await routeGuard(c, { spaceId: c.req.param("id"), operation: "generic_mutation" });
  if (rejected) return rejected;
  sideEffects += 1;
  return c.json({ ok: true });
});

const blocked = await app.request("http://test/active/generic", { method: "POST" });
assert.equal(blocked.status, 409);
assert.deepEqual(await blocked.json(), {
  message: "isolated worker disposable spaces only accept dedicated isolated worker lifecycle operations",
  code: "ISOLATED_WORKER_DISPOSABLE_OPERATION_FORBIDDEN",
  state: "active",
});
assert.equal(sideEffects, 0, "a rejected route must not run downstream side effects");

const allowed = await app.request("http://test/ordinary/generic", { method: "POST" });
assert.equal(allowed.status, 200);
assert.equal(sideEffects, 1);

console.log("isolated worker disposable guard checks passed");
