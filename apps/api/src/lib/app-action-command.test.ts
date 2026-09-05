import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { buildAppActionCommand, isAppActionKey } from "./app-action-command.js";

describe("App Action command", () => {
  it("accepts simple action keys only", () => {
    assert.equal(isAppActionKey("remove-background"), true);
    assert.equal(isAppActionKey("summarize_2"), true);
    assert.equal(isAppActionKey("../private"), false);
    assert.equal(isAppActionKey("nested/action"), false);
  });

  it("uses the immutable app version cache and dispatches Node files", () => {
    const command = buildAppActionCommand({
      appId: "app-1",
      appVersionId: "version-2",
      action: "summarize",
      actionInput: { text: "Hello" },
    });

    assert.match(command, /\/tmp\/cohub-app-actions\/app-1\/version-2/);
    assert.match(command, /cohub --json apps download 'app-1'/);
    assert.match(command, /if \[\[ ! -d "\$cache" \]\]/);
    assert.match(command, /\.ts\|\*\.mts\|\*\.cts\|\*\.js\|\*\.mjs\|\*\.cjs/);
    assert.match(command, /node "\$entry"/);
    assert.match(command, /dependency_root=/);
    assert.match(command, /cache\/node_modules\/\$name/);
    assert.match(command, /eyJ0ZXh0IjoiSGVsbG8ifQ==/);
    assert.equal(spawnSync("bash", ["-n"], { input: command }).status, 0);
  });

  it("runs a single cached Node Action with JSON stdin", async () => {
    const appId = randomUUID();
    const appVersionId = randomUUID();
    const cache = `/tmp/cohub-app-actions/${appId}/${appVersionId}`;
    await mkdir(`${cache}/.cohub/actions`, { recursive: true });
    await writeFile(
      `${cache}/.cohub/actions/echo.js`,
      'let value = ""; process.stdin.on("data", chunk => value += chunk).on("end", () => process.stdout.write(value));\n',
    );
    try {
      const command = buildAppActionCommand({
        appId,
        appVersionId,
        action: "echo",
        actionInput: { ok: true },
      });
      const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { ok: true });
    } finally {
      await rm(`/tmp/cohub-app-actions/${appId}`, { recursive: true, force: true });
    }
  });
});
