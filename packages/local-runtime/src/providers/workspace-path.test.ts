import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveWorkspacePath, workspaceFenceRoot } from "./workspace-path.js";

test("maps virtual workspace paths to the physical replica root", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-workspace-path-"));
  const cwd = join(root, "packages");
  assert.equal(resolveWorkspacePath("/workspace", cwd, root), root);
  assert.equal(resolveWorkspacePath("/workspace/src/index.ts", cwd, root), join(root, "src/index.ts"));
  assert.equal(resolveWorkspacePath("src/index.ts", cwd, root), join(cwd, "src/index.ts"));
  assert.equal(workspaceFenceRoot(cwd, root), root);
});

test("preserves physical aliases while resolving virtual paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-workspace-path-alias-"));
  const cwd = join(root, "app");
  assert.equal(resolveWorkspacePath("@/workspace/config.json", cwd, root), join(root, "config.json"));
  assert.equal(resolveWorkspacePath("file:///etc/hosts", cwd, root), "/etc/hosts");
});
