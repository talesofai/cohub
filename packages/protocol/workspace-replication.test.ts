import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WorkspaceManifestSchema,
  canonicalizeJson,
  detectManifestPathCollisions,
  manifestTreeHash,
  reconcileWorkspaceManifests,
  validateManifest,
} from "./src/workspace-replication/index.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

const manifest = (entries: Record<string, unknown>[]) =>
  WorkspaceManifestSchema.parse({
    version: 1,
    policyVersion: 1,
    scanPolicyHash: hashA,
    entries,
    boundaries: [],
    portableGitState: null,
  });

test("canonicalizes JSON deterministically while preserving array order", () => {
  assert.equal(
    canonicalizeJson({ z: 1, a: [{ b: true, a: null }], m: "x" }),
    '{"a":[{"a":null,"b":true}],"m":"x","z":1}',
  );
});

test("sorts and validates manifest entries", () => {
  const result = validateManifest(
    manifest([
      { path: "src/z.ts", type: "file", size: 1, sha256: hashA, executable: false },
      { path: "src", type: "directory" },
    ]),
  );
  assert.deepEqual(result.entries.map((entry) => entry.path), ["src", "src/z.ts"]);
});

test("rejects unsafe paths and symlinks", () => {
  assert.throws(
    () => validateManifest(manifest([{ path: "../secret", type: "directory" }])),
    /path_segments_unsafe/,
  );
  assert.throws(
    () =>
      validateManifest(
        manifest([{ path: "link", type: "symlink", symlinkTarget: "../../secret" }]),
      ),
    /symlink_unsafe/,
  );
});

test("rejects non-portable Windows names and trailing path characters", () => {
  for (const path of ["CON", "src/NUL.txt", "trailing.", "trailing "]) {
    assert.throws(
      () => validateManifest(manifest([{ path, type: "directory" }])),
      /path_segments_unsafe/,
    );
  }
});

test("reports normalization and case collisions", () => {
  assert.ok(
    detectManifestPathCollisions([
      { path: "Cafe\u0301.txt" },
      { path: "Café.txt" },
    ]).some((item) => item.kind === "normalization"),
  );
  assert.ok(
    detectManifestPathCollisions([{ path: "README.md" }, { path: "readme.md" }]).some(
      (item) => item.kind === "case",
    ),
  );
});

test("builds a deterministic three-way plan and preserves conflicts", () => {
  const base = manifest([
    { path: "same.txt", type: "file", size: 1, sha256: hashA, executable: false },
    { path: "changed.txt", type: "file", size: 1, sha256: hashA, executable: false },
    { path: "deleted.txt", type: "file", size: 1, sha256: hashA, executable: false },
  ]);
  const local = manifest([
    { path: "same.txt", type: "file", size: 1, sha256: hashB, executable: false },
    { path: "changed.txt", type: "file", size: 1, sha256: hashB, executable: false },
  ]);
  const cloud = manifest([
    { path: "same.txt", type: "file", size: 1, sha256: hashB, executable: false },
    { path: "changed.txt", type: "file", size: 1, sha256: hashA, executable: false },
    { path: "deleted.txt", type: "file", size: 1, sha256: hashB, executable: false },
  ]);
  const result = reconcileWorkspaceManifests({ base, local, cloud });
  assert.deepEqual(result.conflicts.map((item) => item.path), ["deleted.txt"]);
  assert.ok(result.unchangedPaths.includes("same.txt"));
  assert.deepEqual(result.operations, [
    {
      path: "changed.txt",
      action: "apply_local_to_cloud",
      entry: { path: "changed.txt", type: "file", size: 1, sha256: hashB, executable: false },
      expectedBase: { path: "changed.txt", type: "file", size: 1, sha256: hashA, executable: false },
    },
  ]);
});

test("omitted paths are not treated as deletions", () => {
  const secret = { path: ".env", type: "file", size: 1, sha256: hashA, executable: false } as const;
  const base = manifest([secret]);
  const cloud = manifest([secret]);
  const local = WorkspaceManifestSchema.parse({ ...manifest([]), omitted: [".env"] });
  const result = reconcileWorkspaceManifests({ base, local, cloud });
  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.unchangedPaths, [".env"]);
});

test("omitted paths do not change the tree hash", async () => {
  const plain = manifest([{ path: "a", type: "directory" }]);
  const withOmission = WorkspaceManifestSchema.parse({ ...plain, omitted: ["secret.pem"] });
  assert.equal(await manifestTreeHash(plain), await manifestTreeHash(withOmission));
});

test("produces stable tree hashes independent of input entry order", async () => {
  const first = manifest([
    { path: "b", type: "directory" },
    { path: "a", type: "directory" },
  ]);
  const second = manifest([
    { path: "a", type: "directory" },
    { path: "b", type: "directory" },
  ]);
  assert.equal(await manifestTreeHash(first), await manifestTreeHash(second));
});
