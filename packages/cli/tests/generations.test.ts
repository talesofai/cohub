import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import { HttpError } from "@neta-art/cohub";
import {
  createGenerationWithRetry,
  registerGenerations,
} from "../src/commands/generations.js";

test("generate exposes an explicit client request id", () => {
  const program = new Command("cohub");
  registerGenerations(program);
  const command = program.commands.find((candidate) => candidate.name() === "generate");
  assert.ok(command?.options.some((option) => option.attributeName() === "clientRequestId"));
});

test("ambiguous generation submission retries the same closure once", async () => {
  let attempts = 0;
  const request = { clientRequestId: "stable-request", model: "image-model" };
  const seen: typeof request[] = [];
  const result = await createGenerationWithRetry(async () => {
    attempts += 1;
    seen.push(request);
    if (attempts === 1) throw new TypeError("network response was lost");
    return { taskRunId: "task-1" };
  }, async () => undefined);

  assert.deepEqual(result, { taskRunId: "task-1" });
  assert.equal(attempts, 2);
  assert.equal(seen[0], seen[1]);
});

test("deterministic API failures are not retried", async () => {
  let attempts = 0;
  await assert.rejects(
    createGenerationWithRetry(async () => {
      attempts += 1;
      throw new HttpError("insufficient balance", 402, { code: "billing_access_blocked" });
    }, async () => undefined),
    /insufficient balance/,
  );
  assert.equal(attempts, 1);
});
