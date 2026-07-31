import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import { HttpError } from "@neta-art/cohub";
import { registerPrompt, registerSpaces } from "../src/commands/spaces.js";
import { submitWithIdempotentRetry } from "../src/commands/idempotent-submission.js";

test("all Space prompt entrypoints expose per-turn system instructions", () => {
  const program = new Command("cohub");
  registerPrompt(program);
  registerSpaces(program);

  const prompt = program.commands.find((command) => command.name() === "prompt");
  const spaces = program.commands.find((command) => command.name() === "spaces");
  const compatiblePrompt = spaces?.commands.find((command) => command.name() === "prompt");

  assert.ok(prompt);
  assert.ok(compatiblePrompt);
  assert.ok(compatiblePrompt.aliases().includes("send"));
  assert.ok(prompt.options.some((option) => option.attributeName() === "systemInstructions"));
  assert.ok(compatiblePrompt.options.some((option) => option.attributeName() === "systemInstructions"));
  assert.ok(prompt.options.some((option) => option.attributeName() === "clientMessageId"));
  assert.ok(compatiblePrompt.options.some((option) => option.attributeName() === "clientMessageId"));
});

test("ambiguous prompt submission retries the same request once", async () => {
  const request = { clientMessageId: "stable-message", content: [{ type: "text", text: "Hello" }] };
  const seen: typeof request[] = [];
  const result = await submitWithIdempotentRetry(async () => {
    seen.push(request);
    if (seen.length === 1) throw new TypeError("network response was lost");
    return { mode: "immediate" };
  }, async () => undefined);

  assert.deepEqual(result, { mode: "immediate" });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
});

test("prompt submission retries an internal handoff failure once", async () => {
  let attempts = 0;
  const result = await submitWithIdempotentRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new HttpError("queue handoff failed", 500, null);
    return { mode: "immediate" };
  }, async () => undefined);

  assert.deepEqual(result, { mode: "immediate" });
  assert.equal(attempts, 2);
});
