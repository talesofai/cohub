import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWorkspaceMutationOperationKey } from "./workspace-mutation-key.js";

test("workspace mutation keys canonicalize payloads for an explicit request identity", () => {
  const first = buildWorkspaceMutationOperationKey("write", { path: "a.txt", content: "x" }, "mutation-1");
  const second = buildWorkspaceMutationOperationKey("write", { content: "x", path: "a.txt" }, "mutation-1");
  assert.equal(first, second);
});

test("workspace mutation keys do not dedupe unrelated requests without mutation ids", () => {
  const first = buildWorkspaceMutationOperationKey("write", { path: "a.txt", content: "x" });
  const second = buildWorkspaceMutationOperationKey("write", { path: "a.txt", content: "x" });
  assert.notEqual(first, second);
});

test("workspace mutation keys accept a move payload without an optional id", () => {
  const key = buildWorkspaceMutationOperationKey("move", { fromPath: "a.txt", toPath: "b.txt" });
  assert.match(key, /^move:[0-9a-f-]+:[0-9a-f]{64}$/);
});
