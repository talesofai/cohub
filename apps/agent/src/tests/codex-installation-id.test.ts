import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { resolveCodexInstallationId } from "../runtime/codex-installation-id.js";

test("persists one installation ID across concurrent agent starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-installation-"));
  const path = join(root, "nested", "installation_id");
  try {
    const ids = await Promise.all([
      resolveCodexInstallationId(path, () => "11111111-1111-4111-8111-111111111111"),
      resolveCodexInstallationId(path, () => "22222222-2222-4222-8222-222222222222"),
    ]);

    assert.equal(ids[0], ids[1]);
    assert.equal((await readFile(path, "utf8")).trim(), ids[0]);
    assert.equal(await resolveCodexInstallationId(path), ids[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a corrupt persisted installation ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-installation-invalid-"));
  const path = join(root, "installation_id");
  try {
    await writeFile(path, "not-a-uuid\n", "utf8");
    await assert.rejects(
      resolveCodexInstallationId(path),
      /Invalid Codex installation ID/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
