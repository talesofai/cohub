import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scanWorkspaceReplica, WorkspaceScanError } from "./index.js";

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "cohub-workspace-scan-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("workspace scanner includes directories, hashes files, and applies policy exclusions", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "src"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "src", "main.ts"), "export const value = 1;\n");
    await writeFile(join(root, ".env"), "TOKEN=secret\n");
    await writeFile(join(root, ".git", "config"), "private\n");

    const result = await scanWorkspaceReplica(root, {
      policyVersion: 1,
      sensitiveContentMode: "exclude_with_warning",
    });

    assert.deepEqual(result.manifest.entries.map((entry) => entry.path), ["src", "src/main.ts"]);
    assert.equal(result.blobs.length, 1);
    assert.ok(result.warnings.some((warning) => warning.path === ".env" && warning.type === "sensitive"));
    assert.equal(result.manifestSha256.length, 64);
    assert.equal(result.treeHash.length, 64);
  });
});

test("scanner preserves safe relative symlinks and excludes unsafe ones", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "target.txt"), "ok");
    await symlink("target.txt", join(root, "safe-link"));
    await symlink("/etc/passwd", join(root, "unsafe-link"));
    const result = await scanWorkspaceReplica(root, { policyVersion: 1 });
    assert.equal(result.manifest.entries.find((entry) => entry.path === "safe-link")?.type, "symlink");
    assert.ok(result.warnings.some((warning) => warning.path === "unsafe-link"));
  });
});

test("scanner fails closed on normalization/case collisions", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "README.md"), "one");
    await writeFile(join(root, "readme.md"), "two");
    await assert.rejects(
      scanWorkspaceReplica(root, { policyVersion: 1 }),
      (error: unknown) => error instanceof WorkspaceScanError && error.code === "path_collision",
    );
  });
});

test("scanner rejects non-portable reserved paths", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "CON"), "reserved");
    await assert.rejects(
      scanWorkspaceReplica(root, { policyVersion: 1 }),
      (error: unknown) => error instanceof WorkspaceScanError && error.code === "path_unsupported",
    );
  });
});

test("scanner rejects invalid policy versions", async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      scanWorkspaceReplica(root, { policyVersion: 0 }),
      (error: unknown) => error instanceof WorkspaceScanError && error.code === "scan_incomplete",
    );
  });
});
