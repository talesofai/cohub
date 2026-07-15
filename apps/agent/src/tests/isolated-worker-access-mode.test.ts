import assert from "node:assert/strict";
import { resolvePromptAccessMode } from "../isolated-worker-access.js";

assert.equal(resolvePromptAccessMode({}), "full_access");
assert.equal(resolvePromptAccessMode({ accessMode: null }), "full_access");
assert.equal(resolvePromptAccessMode({ accessMode: "read_only" }), "read_only");
assert.equal(resolvePromptAccessMode({ accessMode: "full_access" }), "full_access");
assert.equal(resolvePromptAccessMode({ accessMode: "isolated_worker" }), "isolated_worker");
assert.throws(() => resolvePromptAccessMode({ accessMode: "isolated-wroker" }), /invalid prompt access mode/);
assert.throws(() => resolvePromptAccessMode({ accessMode: 1 }), /invalid prompt access mode/);

console.log("isolated worker access mode checks passed");
