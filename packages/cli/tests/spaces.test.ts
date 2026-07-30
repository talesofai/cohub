import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import { registerPrompt, registerSpaces } from "../src/commands/spaces.js";

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
});
