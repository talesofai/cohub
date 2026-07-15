import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeFrozenInputManifest,
  prepareFrozenInputWorkspaceForPublish,
  removeFrozenInputWorkspace,
  sealFrozenInputWorkspace,
} from "./isolated-worker-inputs.js";

const root = await mkdtemp(join(tmpdir(), "cohub-isolated-inputs-"));
const source = join(root, "source");
const target = join(root, "target");
await mkdir(join(source, "modules"), { recursive: true });
await writeFile(join(source, "modules", "method.md"), "frozen method\n");
await writeFile(join(source, "modules", "undeclared.md"), "must not copy\n");
const content = Buffer.from("frozen method\n");
const inputBundle = {
  authorityCheckpointId: "99999999-9999-4999-8999-999999999999",
  authorityCheckpointCommit: "a".repeat(40),
  authorityTreeSha256: "c".repeat(64),
  inputManifestSha256: "d".repeat(64),
  runtimeAuthorityReadAllowed: false as const,
  items: [{
    sourcePath: "modules/method.md",
    destinationPath: "inputs/method.md",
    contentSha256: createHash("sha256").update(content).digest("hex"),
    sourceType: "regular_file" as const,
  }],
};
const firstItem = inputBundle.items[0];
assert.ok(firstItem);

const receipt = await materializeFrozenInputManifest({ sourceRoot: source, targetRoot: target, inputBundle });
assert.equal(await readFile(join(target, "inputs", "method.md"), "utf8"), "frozen method\n");
await assert.rejects(readFile(join(target, "inputs", "undeclared.md")), /ENOENT/);
assert.deepEqual(receipt.files, inputBundle.items);
await prepareFrozenInputWorkspaceForPublish(target);
assert.equal((await lstat(target)).mode & 0o777, 0o755);
await sealFrozenInputWorkspace(target);
assert.equal((await lstat(target)).mode & 0o777, 0o555);

const cleanupTarget = join(root, "target-cleanup");
await materializeFrozenInputManifest({ sourceRoot: source, targetRoot: cleanupTarget, inputBundle });
await removeFrozenInputWorkspace(cleanupTarget);
await assert.rejects(lstat(cleanupTarget), /ENOENT/);

const symlinkTarget = join(root, "target-symlink");
await symlink("method.md", join(source, "modules", "link.md"));
await assert.rejects(
  materializeFrozenInputManifest({
    sourceRoot: source,
    targetRoot: symlinkTarget,
    inputBundle: { ...inputBundle, items: [{ ...firstItem, sourcePath: "modules/link.md" }] },
  }),
  /regular file/,
);

const badHashTarget = join(root, "target-bad-hash");
await assert.rejects(
  materializeFrozenInputManifest({
    sourceRoot: source,
    targetRoot: badHashTarget,
    inputBundle: { ...inputBundle, items: [{ ...firstItem, contentSha256: "0".repeat(64) }] },
  }),
  /hash mismatch/,
);

const outside = join(root, "outside");
await mkdir(outside);
await writeFile(join(outside, "secret.md"), "outside secret\n");
await symlink(outside, join(source, "modules-link"));
await assert.rejects(
  materializeFrozenInputManifest({
    sourceRoot: source,
    targetRoot: join(root, "target-intermediate-symlink"),
    inputBundle: { ...inputBundle, items: [{ ...firstItem, sourcePath: "modules-link/secret.md" }] },
  }),
  /symlink/,
);

await assert.rejects(
  materializeFrozenInputManifest({
    sourceRoot: source,
    targetRoot: join(root, "target-path-escape"),
    inputBundle: { ...inputBundle, items: [{ ...firstItem, sourcePath: "../secret" }] },
  }),
  /unsafe manifest path/,
);

await assert.rejects(
  materializeFrozenInputManifest({
    sourceRoot: source,
    targetRoot: join(root, "target-undeclared"),
    inputBundle: { ...inputBundle, items: [{ ...firstItem, sourcePath: "modules/not-declared.md" }] },
  }),
  /ENOENT/,
);

console.log("isolated worker frozen input materialization checks passed");
