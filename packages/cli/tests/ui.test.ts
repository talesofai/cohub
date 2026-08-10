import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import { registerUi } from "../src/commands/ui.js";

function createProgram(): { ui: Command; preview: Command } {
  const program = new Command("cohub")
    .option("-s, --space <id>", "Target space ID")
    .helpOption("-h, --help", "Show help");
  registerUi(program);
  const ui = program.commands.find((command) => command.name() === "ui");
  assert.ok(ui, "ui command must be registered");
  const preview = ui.commands.find((command) => command.name() === "preview");
  assert.ok(preview, "ui preview must be registered");
  return { ui, preview };
}

/** `helpInformation()` omits addHelpText sections. */
function renderHelp(command: Command): string {
  let text = "";
  command.configureOutput({ writeOut: (chunk) => { text += chunk; } });
  command.outputHelp();
  return text;
}

test("showing and calling a Work preview is one command", () => {
  const { ui, preview } = createProgram();
  assert.deepEqual(ui.commands.map((command) => command.name()), ["preview"]);
  assert.deepEqual(preview.registeredArguments.map((arg) => arg.name()), ["work"]);
});

test("ui preview exposes call, targeting, and retry options", () => {
  const { preview } = createProgram();
  const options = preview.options.map((option) => option.long);
  for (const expected of [
    "--call",
    "--data",
    "--input",
    "--client",
    "--command-id",
    "--no-wait",
    "--timeout-ms",
    "--json",
  ]) {
    assert.ok(options.includes(expected), `missing ${expected}`);
  }
});

test("help states the routing limit and who decides what is callable", () => {
  const { ui, preview } = createProgram();
  const uiHelp = renderHelp(ui);
  assert.match(uiHelp, /preview/);
  assert.match(uiHelp, /originated/i);

  const previewHelp = renderHelp(preview);
  assert.match(previewHelp, /idempotent/i);
  assert.match(previewHelp, /Work author/i);
  assert.match(previewHelp, /default: 600000/);
  assert.match(previewHelp, /max:\s+43200000/);
});
