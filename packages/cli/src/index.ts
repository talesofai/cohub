#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { registerAuth } from "./commands/auth.js";
import { registerBoards } from "./commands/boards.js";
import { registerChannels } from "./commands/channels.js";
import { registerCronJobs } from "./commands/cron-jobs.js";
import { registerGenerations } from "./commands/generations.js";
import { registerMe } from "./commands/me.js";
import { registerModels } from "./commands/models.js";
import { registerProfile } from "./commands/profile.js";
import { registerPrompts } from "./commands/prompts.js";
import { registerPublic } from "./commands/public.js";
import { registerSkills } from "./commands/skills.js";
import { registerSearch } from "./commands/search.js";
import { registerReferences } from "./commands/references.js";
import { registerReferrals } from "./commands/referrals.js";
import { registerPrompt, registerSpaces } from "./commands/spaces.js";
import { maybeHandleRunCommand } from "./commands/run.js";
import { registerSandbox } from "./commands/sandbox.js";
import { registerTasks } from "./commands/tasks.js";
import { registerDesktop, registerLegacyUi } from "./commands/desktop.js";
import { registerApps } from "./commands/apps.js";
import { registerWorkspace } from "./commands/workspace.js";
import { registerAgentRuntime } from "./commands/agent-runtime.js";

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
  .description("Send prompts, manage Space files, and publish public output.")
  .version(VERSION, "-v, --version", "Show version")
  .option("-s, --space <id>", "Target Space ID")
  .option("--json", "Print machine-readable JSON when supported")
  .helpOption("-h, --help", "Show help")
  .addHelpText("after", `

Common commands:
  cohub auth login
  cohub profile avatar ./avatar.png
  cohub spaces ls
  cohub -s <space-id> prompt "Fix the failing tests"
  cohub -s <space-id> completion "Summarize AGENTS.md" --system-prompt AGENTS.md --stream
  cohub -s <space-id> run -- git status
  cohub sandbox up ./my-project
  cohub workspace attach <space-id> ./my-project
  cohub search "release notes"
  cohub -s <space-id> boards inspect <board-id>
  cohub -s <space-id> spaces turns ls --author others
  cohub -s <space-id> spaces sessions turns ls <session-id>
  cohub -s <space-id> spaces files ls
  cohub -s <space-id> public upload ./dist demo
  cohub -s <space-id> apps publish demo --file dist/index.html
  cohub desktop open <app-id> --call selection.get
  cohub -s <space-id> spaces commerce products list
  cohub models ls
  cohub models ls --model-type multimodal
  cohub generate "A calm lake at sunrise" --model <model> --output lake.png

Environment:
  COHUB_EXECUTION_TOKEN  Use this token instead of the stored Logto session
  ENV=dev                Use the development Cohub environment
`);

registerAuth(program);
registerBoards(program);
registerProfile(program);
registerMe(program);
registerPrompt(program);
registerSpaces(program);
registerSandbox(program);
registerChannels(program);
registerGenerations(program);
registerModels(program);
registerPrompts(program);
registerPublic(program);
registerSkills(program);
registerSearch(program);
registerReferences(program);
registerReferrals(program);
registerTasks(program);
registerCronJobs(program);
registerApps(program);
registerWorkspace(program);
registerAgentRuntime(program);
registerDesktop(program);
registerLegacyUi(program);

const argv = process.argv.slice(2);
if (await maybeHandleRunCommand(argv)) {
  process.exit();
}

program.parse();
