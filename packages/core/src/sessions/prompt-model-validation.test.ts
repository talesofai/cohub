import assert from "node:assert/strict";
import test from "node:test";
import type { SessionPromptDependencies, SubmitSessionPromptInput } from "./prompt.js";
import { ModelUnavailableError, submitSessionPrompt } from "./prompt.js";

const input: SubmitSessionPromptInput = {
  spaceId: "space-1",
  sessionId: "session-1",
  userId: " user-1 ",
  clientMessageId: "message-1",
  content: [{ type: "text", text: "Hello" }],
  source: "web",
  model: " model-1 ",
  provider: null,
};

function createDeps(validatePromptModel: SessionPromptDependencies["validatePromptModel"]): SessionPromptDependencies {
  return {
    randomUUID: () => "message-id",
    expandPromptTemplate: async () => null,
    createSessionTurn: async () => ({ id: "turn-id", spaceId: "space-1" }),
    enqueueSpacePrompt: async () => undefined,
    failSessionTurn: async () => undefined,
    validatePromptModel,
  };
}

test("matching prevalidated model skips duplicate model validation", async () => {
  let validationCalls = 0;
  const result = await submitSessionPrompt(
    createDeps(async () => {
      validationCalls += 1;
      return false;
    }),
    input,
    {},
    { prevalidatedModel: { provider: "cohub", model: "model-1" } },
  );

  assert.deepEqual(result, { turnId: "turn-id", userMessageId: "message-id" });
  assert.equal(validationCalls, 0);
});

test("local ACP runtime rejects a Cohub model override", async () => {
  await assert.rejects(
    submitSessionPrompt(
      createDeps(async () => true),
      { ...input, runtimeId: "runtime-1" },
    ),
    /local ACP runtime uses its own provider configuration/,
  );
});

test("local ACP runtime rejects Cohub generation and environment overrides", async () => {
  await assert.rejects(
    submitSessionPrompt(
      createDeps(async () => true),
      {
        ...input,
        model: null,
        runtimeId: "runtime-1",
        generationPolicy: { version: 1, mode: "limited" },
      },
    ),
    /local ACP runtime uses its provider's own generation configuration/,
  );
  await assert.rejects(
    submitSessionPrompt(
      createDeps(async () => true),
      {
        ...input,
        model: null,
        runtimeId: "runtime-1",
        env: { TEST_VALUE: "ignored" },
      },
    ),
    /local ACP runtime does not accept Cohub environment overrides/,
  );
});

test("local ACP runtime rejects scheduled execution", async () => {
  await assert.rejects(
    submitSessionPrompt(
      createDeps(async () => true),
      { ...input, model: null, runtimeId: "runtime-1", source: "scheduled_task" },
    ),
    /local ACP runtime prompts must run immediately/,
  );
});

test("mismatched prevalidated model still validates the requested model", async () => {
  let validatedInput: { userId: string; provider: string; model: string } | undefined;

  await assert.rejects(
    submitSessionPrompt(
      createDeps(async (modelInput) => {
        validatedInput = modelInput;
        return false;
      }),
      input,
      {},
      { prevalidatedModel: { provider: "cohub", model: "other-model" } },
    ),
    ModelUnavailableError,
  );

  assert.deepEqual(validatedInput, { userId: "user-1", provider: "cohub", model: "model-1" });
});
