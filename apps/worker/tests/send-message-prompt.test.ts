import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildScheduledSendMessagePromptInput,
  parseScheduledSendMessagePromptOptions,
} from "../src/tasks/send-message-prompt.js";

test("scheduled send_message validates private prompt options before dispatch", () => {
  assert.deepEqual(
    parseScheduledSendMessagePromptOptions({
      env: { REPORT_FORMAT: "finance" },
      systemInstructions: "  Use the finance reporting format.  ",
    }),
    {
      env: { REPORT_FORMAT: "finance" },
      systemInstructions: "Use the finance reporting format.",
    },
  );
  assert.throws(
    () => parseScheduledSendMessagePromptOptions({ env: { "BAD-NAME": "x" } }),
    /env name/,
  );
});

test("scheduled send_message forwards validated turn instructions", () => {
  const prompt = buildScheduledSendMessagePromptInput({
    spaceId: "space-1",
    sessionId: "session-1",
    userId: "user-1",
    clientMessageId: "cron:cron-1:run:run-1",
    content: [{ type: "text", text: "Run the report" }],
    source: "scheduled_task",
    systemInstructions: "Use the finance reporting format.",
    context: {
      kind: "scheduled_task",
      taskRunId: "run-1",
      cronJobId: "cron-1",
      auth: null,
    },
  });

  assert.equal(prompt.systemInstructions, "Use the finance reporting format.");
  assert.equal(prompt.context.kind, "scheduled_task");
  assert.equal(prompt.clientMessageId, "cron:cron-1:run:run-1");
});

test("scheduled send_message clears omitted turn instructions", () => {
  const prompt = buildScheduledSendMessagePromptInput({
    spaceId: "space-1",
    sessionId: "session-1",
    userId: "user-1",
    clientMessageId: "taskrun:run-2",
    content: [{ type: "text", text: "Run the report" }],
    source: "scheduled_task",
    context: {
      kind: "scheduled_task",
      taskRunId: "run-2",
      cronJobId: null,
      auth: null,
    },
  });

  assert.equal(prompt.systemInstructions, null);
});
