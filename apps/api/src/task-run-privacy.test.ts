import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeScheduledPromptForClient } from "./task-run-privacy.js";

test("scheduled prompt client projections omit private system instructions", () => {
  const cronJob = {
    taskType: "send_message",
    payload: {
      content: [{ type: "text", text: "Create a prompt" }],
      systemInstructions: "Private cron instructions",
    },
  };
  const taskRun = {
    taskType: "send_message",
    payload: {
      type: "send_message",
      data: {
        content: [{ type: "text", text: "Create a prompt" }],
        systemInstructions: "Private task instructions",
      },
    },
  };

  assert.deepEqual(sanitizeScheduledPromptForClient(cronJob).payload, {
    content: [{ type: "text", text: "Create a prompt" }],
  });
  assert.deepEqual(sanitizeScheduledPromptForClient(taskRun).payload, {
    type: "send_message",
    data: { content: [{ type: "text", text: "Create a prompt" }] },
  });
  assert.equal(cronJob.payload.systemInstructions, "Private cron instructions");
  assert.equal(taskRun.payload.data.systemInstructions, "Private task instructions");
});

test("unrelated task payloads are unchanged", () => {
  const task = {
    taskType: "other",
    payload: { systemInstructions: "Not a scheduled prompt field" },
  };
  assert.equal(sanitizeScheduledPromptForClient(task), task);
});
