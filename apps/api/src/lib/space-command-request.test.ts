import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_SPACE_COMMAND_LENGTH,
  parseSpaceCommandRequest,
} from "./space-command-request.js";

test("space command requests default to immediate execution", () => {
  assert.deepEqual(parseSpaceCommandRequest({ command: "  git status  " }), {
    mode: "immediate",
    command: "git status",
  });
});

test("space command requests parse recurring execution", () => {
  const request = parseSpaceCommandRequest({
    command: "./reconcile.sh",
    title: "  bot-agent reconcile  ",
    schedule: {
      mode: "repeat",
      cronExpression: "  */5 * * * * ",
      timezone: "UTC",
    },
  });

  assert.equal(request.mode, "repeat");
  if (request.mode !== "repeat") assert.fail("expected repeat request");
  assert.equal(request.title, "bot-agent reconcile");
  assert.equal(request.cronExpression, "*/5 * * * *");
  assert.ok(request.nextRun instanceof Date);
});

test("space command requests reject malformed schedules and oversized commands", () => {
  assert.throws(
    () => parseSpaceCommandRequest({ command: "pwd", schedule: "repeat" }),
    /schedule must be an object/,
  );
  assert.throws(
    () =>
      parseSpaceCommandRequest({
        command: "pwd",
        schedule: { mode: "repeat", cronExpression: 5, timezone: "UTC" },
      }),
    /cronExpression is required/,
  );
  assert.throws(
    () => parseSpaceCommandRequest({ command: "x".repeat(MAX_SPACE_COMMAND_LENGTH + 1) }),
    /command is too long/,
  );
});
