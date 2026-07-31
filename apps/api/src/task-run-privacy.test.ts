import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH } from "@cohub/protocol";
import {
  prepareScheduledPromptPayloadUpdate,
  sanitizeScheduledPromptForClient,
} from "./task-run-privacy.js";

test("scheduled prompt client projections omit private system instructions", () => {
  const cronJob = {
    taskType: "send_message",
    payload: {
      content: [{ type: "text", text: "Create a prompt" }],
      systemInstructions: "Private cron instructions",
      auth: { type: "delegated_prompt", scopes: ["session.prompt.fullaccess"] },
      env: { API_KEY: "cron-secret" },
    },
  };
  const taskRun = {
    taskType: "send_message",
    payload: {
      type: "send_message",
      data: {
        content: [{ type: "text", text: "Create a prompt" }],
        systemInstructions: "Private task instructions",
        auth: { type: "delegated_prompt", scopes: ["session.prompt.fullaccess"] },
        env: { API_KEY: "task-secret" },
      },
    },
  };

  const sanitizedCronJob = sanitizeScheduledPromptForClient(cronJob);
  const sanitizedTaskRun = sanitizeScheduledPromptForClient(taskRun);
  assert.deepEqual(sanitizedCronJob.payload, {
    content: [{ type: "text", text: "Create a prompt" }],
  });
  assert.equal(sanitizedCronJob.hasSystemInstructions, true);
  assert.deepEqual(sanitizedTaskRun.payload, {
    type: "send_message",
    data: { content: [{ type: "text", text: "Create a prompt" }] },
  });
  assert.equal(sanitizedTaskRun.hasSystemInstructions, true);
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

test("scheduled prompt updates preserve omitted private instructions", () => {
  const payload = prepareScheduledPromptPayloadUpdate({
    taskType: "send_message",
    currentPayload: {
      content: [{ type: "text", text: "Before" }],
      systemInstructions: "Private cron instructions",
      auth: { type: "delegated_prompt", scopes: ["session.prompt.fullaccess"] },
      env: { API_KEY: "cron-secret" },
    },
    nextPayload: { content: [{ type: "text", text: "After" }] },
  });

  assert.deepEqual(payload, {
    content: [{ type: "text", text: "After" }],
    systemInstructions: "Private cron instructions",
    auth: { type: "delegated_prompt", scopes: ["session.prompt.fullaccess"] },
    env: { API_KEY: "cron-secret" },
  });
});

test("scheduled prompt updates normalize replacements and allow explicit clearing", () => {
  const input = {
    taskType: "send_message",
    currentPayload: {
      systemInstructions: "Before",
      auth: { type: "delegated_prompt", scopes: ["session.prompt.fullaccess"] },
    },
  };
  assert.deepEqual(prepareScheduledPromptPayloadUpdate({
    ...input,
    nextPayload: { systemInstructions: "  After  " },
  }), {
    systemInstructions: "After",
    auth: { type: "delegated_prompt", scopes: ["session.prompt.fullaccess"] },
  });
  assert.deepEqual(prepareScheduledPromptPayloadUpdate({
    ...input,
    nextPayload: { systemInstructions: null },
  }), { auth: { type: "delegated_prompt", scopes: ["session.prompt.fullaccess"] } });
});

test("scheduled prompt updates reject invalid private instructions before persistence", () => {
  assert.throws(() => prepareScheduledPromptPayloadUpdate({
    taskType: "send_message",
    currentPayload: {},
    nextPayload: { systemInstructions: { invalid: true } },
  }), /must be a string/);
  assert.throws(() => prepareScheduledPromptPayloadUpdate({
    taskType: "send_message",
    currentPayload: {},
    nextPayload: { systemInstructions: "x".repeat(MAX_PROMPT_SYSTEM_INSTRUCTIONS_LENGTH + 1) },
  }), /cannot exceed/);
});
