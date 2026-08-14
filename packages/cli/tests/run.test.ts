import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRunCliOptions } from "../src/commands/run.js";

test("run parses recurring command options", () => {
  assert.deepEqual(
    parseRunCliOptions([
      "-s",
      "deployment-space",
      "run",
      "--cron",
      "*/5 * * * *",
      "--timezone",
      "UTC",
      "--command",
      "./reconcile.sh",
    ]),
    {
      spaceId: "deployment-space",
      json: false,
      async: false,
      command: "./reconcile.sh",
      cron: "*/5 * * * *",
      timezone: "UTC",
    },
  );
});
