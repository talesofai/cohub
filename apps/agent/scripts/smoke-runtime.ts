import { CohubModelRegistry } from "../src/runtime/model-registry.js";
import { SANDBOX_PLATFORM_SKILLS_PATH, SANDBOX_WORKSPACE_PATH } from "../src/runtime/paths.js";
import { buildCohubSystemPrompt } from "../src/runtime/system-prompt-builder.js";

async function main() {
  const models = new CohubModelRegistry();
  const cwd = process.env.SMOKE_WORKSPACE_PATH?.trim() || process.cwd();
  const prompt = await buildCohubSystemPrompt({
    cwd,
    selectedTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    toolSnippets: {
      read: "Read file contents",
      bash: "Execute bash commands",
      edit: "Make precise file edits with exact text replacement",
      write: "Create or overwrite files",
      grep: "Search file contents",
      find: "Search files by glob pattern",
      ls: "List directory contents",
    },
  });

  console.log("[smoke] model registry error:", models.getError() ?? null);
  console.log("[smoke] available models:", models.getAvailable().map((model) => `${model.provider}/${model.id}`));
  console.log("[smoke] workspace source:", cwd);
  console.log("[smoke] sandbox cwd:", SANDBOX_WORKSPACE_PATH);
  console.log("[smoke] sandbox skills root:", SANDBOX_PLATFORM_SKILLS_PATH);
  console.log("[smoke] prompt length:", prompt.length);
  console.log("[smoke] prompt preview:\n");
  console.log(prompt.slice(0, 4000));
}

main().catch((error) => {
  console.error("[smoke] failed:", error);
  process.exit(1);
});
