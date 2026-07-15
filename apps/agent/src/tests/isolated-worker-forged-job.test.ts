import assert from "node:assert/strict";
import { assertSandboxAccessMode } from "../isolated-worker-access.js";

const sandbox = {
  meta: {
    isolatedWorkerPolicy: { disposableSpaceId: "disposable-space", executionTokenIssued: false },
    worker_identity: { access_mode: "isolated_worker" },
  },
};

assert.throws(() => assertSandboxAccessMode(sandbox, "full_access"), /generic Agent execution is forbidden/);
assert.throws(() => assertSandboxAccessMode(sandbox, "read_only"), /generic Agent execution is forbidden/);
assert.doesNotThrow(() => assertSandboxAccessMode(sandbox, "isolated_worker"));
assert.doesNotThrow(() => assertSandboxAccessMode({ meta: {} }, "full_access"));

console.log("isolated worker forged Agent job checks passed");
