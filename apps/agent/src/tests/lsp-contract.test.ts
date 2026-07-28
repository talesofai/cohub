import assert from "node:assert/strict";
import {
  isLspAgentAction,
  LSP_AGENT_ACTIONS,
  READ_ONLY_SANDBOX_TOOL_NAMES,
} from "../sandbox/lsp-contract.js";

assert.deepEqual(LSP_AGENT_ACTIONS, [
  "status",
  "diagnostics",
  "definition",
  "references",
  "hover",
  "symbols",
]);
assert.equal(isLspAgentAction("hover"), true);
for (const forbidden of ["raw", "rename", "codeAction", "applyEdit", "executeCommand"]) {
  assert.equal(isLspAgentAction(forbidden), false, `${forbidden} must remain outside the read-only LSP contract`);
}
assert.equal(READ_ONLY_SANDBOX_TOOL_NAMES.includes("lsp"), true);
assert.equal(READ_ONLY_SANDBOX_TOOL_NAMES.includes("bash" as never), false);

console.log("lsp-contract.test.ts: all assertions passed");
