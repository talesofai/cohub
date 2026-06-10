#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { registerAuth } from "./commands/auth.js";
import { registerChannels } from "./commands/channels.js";
import { registerCronJobs } from "./commands/cron-jobs.js";
import { registerGenerations } from "./commands/generations.js";
import { registerModels } from "./commands/models.js";
import { registerProfile } from "./commands/profile.js";
import { registerSearch } from "./commands/search.js";
import { registerPrompt, registerSpaces } from "./commands/spaces.js";
import { registerTasks } from "./commands/tasks.js";
import { registerVoice } from "./commands/voice.js";
import { ensureCliSelfUpdated } from "./self-update.js";

const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    return pkg.version as string;
  } catch {
    return "1.0.0";
  }
})();

const program = new Command("cohub");

program
  .name("cohub")
  .summary("Work with Cohub from your terminal")
  .description("Send prompts, inspect sessions, manage space files, and generate multimodal outputs.")
  .version(VERSION, "-v, --version", "Show version")
  .option("-s, --space <id>", "Target space ID for prompt, files, sessions, and space-scoped commands")
  .option("--json", "Print machine-readable JSON when supported")
  .helpOption("-h, --help", "Show help")
  .addHelpText("after", `

Common commands:
  cohub auth login
  cohub profile avatar ./avatar.png
  cohub spaces ls
  cohub -s <space-id> prompt "Fix the failing tests"
  cohub voice terms ls
  cohub -s <space-id> spaces voice-lexicon ls
  cohub search "release notes"
  cohub -s <space-id> spaces sessions turns ls <session-id>
  cohub -s <space-id> spaces files ls
  cohub models ls
  cohub models ls --model-type multimodal
  cohub generate "A calm lake at sunrise" --model <model> --output lake.png

Environment:
  COHUB_EXECUTION_TOKEN  Use this token instead of the stored Logto session
  ENV=dev                Use the development Cohub environment
`);

registerAuth(program);
registerProfile(program);
registerPrompt(program);
registerSpaces(program);
registerChannels(program);
registerGenerations(program);
registerModels(program);
registerSearch(program);
registerTasks(program);
registerCronJobs(program);
registerVoice(program);

const isVersionRequest = (argv: string[]) => argv.some((arg) => arg === "-v" || arg === "--version");

try {
  if (!isVersionRequest(process.argv.slice(2))) {
    await ensureCliSelfUpdated();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`cohub self-update failed: ${message}\n`);
  process.stderr.write("run with --version to skip self-update\n");
  process.exit(1);
}

program.parse();
