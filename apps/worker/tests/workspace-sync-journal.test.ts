import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { recoverWorkspaceApplyBeforeRetry } from "../src/workspace-sync.js";

test("restores a partial workspace apply before retry scanning", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cohub-workspace-journal-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const workspaceRoot = join(temporaryRoot, "workspace");
  const journalRoot = join(temporaryRoot, "journal");
  await mkdir(join(journalRoot, "nodes"), { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(journalRoot, "nodes", "changed.txt"), "before\n");
  await writeFile(join(journalRoot, "journal.json"), JSON.stringify({
    version: 1,
    root: resolve(workspaceRoot),
    entries: [
      { path: "changed.txt", existed: true },
      { path: "created.txt", existed: false },
    ],
  }));

  await writeFile(join(workspaceRoot, "changed.txt"), "partially applied\n");
  await writeFile(join(workspaceRoot, "created.txt"), "partially created\n");

  await recoverWorkspaceApplyBeforeRetry({ root: workspaceRoot, stageRoot: journalRoot });

  assert.equal(await readFile(join(workspaceRoot, "changed.txt"), "utf8"), "before\n");
  await assert.rejects(stat(join(workspaceRoot, "created.txt")), { code: "ENOENT" });
  await assert.rejects(stat(journalRoot), { code: "ENOENT" });
});

test("fails closed when a journal path crosses a workspace symlink", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cohub-workspace-journal-symlink-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const workspaceRoot = join(temporaryRoot, "workspace");
  const outsideRoot = join(temporaryRoot, "outside");
  const journalRoot = join(temporaryRoot, "journal");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await mkdir(join(journalRoot, "nodes", "escape"), { recursive: true });
  await writeFile(join(journalRoot, "nodes", "escape", "pwned"), "before\n");
  await writeFile(join(journalRoot, "journal.json"), JSON.stringify({
    version: 1,
    root: resolve(workspaceRoot),
    entries: [{ path: "escape/pwned", existed: true }],
  }));
  await symlink(outsideRoot, join(workspaceRoot, "escape"));
  await writeFile(join(outsideRoot, "pwned"), "outside\n");

  await assert.rejects(
    recoverWorkspaceApplyBeforeRetry({ root: workspaceRoot, stageRoot: journalRoot }),
    /workspace parent is not a directory/,
  );
  assert.equal(await readFile(join(outsideRoot, "pwned"), "utf8"), "outside\n");
});
