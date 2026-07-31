import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "cohub-system-prompt-"));
process.env.PLATFORM_CONFIG_ROOT = join(root, "configs");

const legacyUserId = "11111111-1111-4111-8111-111111111111";
const userId = "logto-user";
const workspace = join(root, "workspace");
const userConfig = join(process.env.PLATFORM_CONFIG_ROOT, "users", userId);
const legacyUserConfig = join(process.env.PLATFORM_CONFIG_ROOT, "users", legacyUserId);
const platformAgent = join(process.env.PLATFORM_CONFIG_ROOT, "platform", ".cohub");

await mkdir(workspace, { recursive: true });
await mkdir(userConfig, { recursive: true });
await mkdir(legacyUserConfig, { recursive: true });
await mkdir(platformAgent, { recursive: true });
await writeFile(join(platformAgent, "SYSTEM.md"), "You are a Cohub test assistant.");
await writeFile(join(userConfig, "AGENTS.md"), "Always prefer concise answers.");
await writeFile(join(legacyUserConfig, "AGENTS.md"), "Legacy instructions should be replaced.");
await writeFile(join(legacyUserConfig, "CLAUDE.md"), "Keep legacy-only context available during migration.");
await mkdir(join(userConfig, ".agents", "skills", "owner-skill"), { recursive: true });
await writeFile(join(userConfig, ".agents", "skills", "owner-skill", "SKILL.md"), "---\nname: owner-skill\ndescription: Owner-only skill\n---\nOwner skill body.");
await writeFile(join(workspace, "AGENTS.md"), "Project rule: run typecheck.");

const { buildCohubSystemPrompt } = await import("../runtime/system-prompt-builder.js");

const prompt = await buildCohubSystemPrompt({
  cwd: workspace,
  userId,
  userIdentity: { uuid: userId, legacyUserUuid: legacyUserId },
  selectedTools: [],
});

assert.ok(prompt.includes("# User Context"), "should include user context section");
assert.ok(!prompt.includes("/configs/user/AGENTS.md"), "should not expose sandbox user rule path");
assert.ok(prompt.includes("Always prefer concise answers."), "should include user rules content");
assert.ok(!prompt.includes("Legacy instructions should be replaced."), "canonical user rules should override the legacy namespace");
assert.ok(prompt.includes("Keep legacy-only context available during migration."), "missing canonical user context should fall back to the legacy namespace");
assert.ok(prompt.includes("# Project Context"), "should include project context section");
assert.ok(prompt.includes("Project rule: run typecheck."), "should include project rules content");
assert.ok(
  prompt.indexOf("# User Context") < prompt.indexOf("# Project Context"),
  "user context should be rendered before project context",
);

const promptWithoutUser = await buildCohubSystemPrompt({
  cwd: workspace,
  selectedTools: [],
});
assert.ok(!promptWithoutUser.includes("# User Context"), "should not include user context without userId");
assert.ok(promptWithoutUser.includes("# Project Context"), "should still include project context without userId");

// Test YAML block scalar frontmatter parsing
await mkdir(join(workspace, ".agents", "skills", "test-folded"), { recursive: true });
await mkdir(join(workspace, ".agents", "skills", "test-literal"), { recursive: true });
await writeFile(
  join(workspace, ".agents", "skills", "test-folded", "SKILL.md"),
  "---\nname: test-folded\ndescription: >\n  This is a folded\n  multi-line description.\n---\nFolded skill body.",
);
await writeFile(
  join(workspace, ".agents", "skills", "test-literal", "SKILL.md"),
  "---\nname: test-literal\ndescription: |\n  This is a literal\n  multi-line description.\n---\nLiteral skill body.",
);

// Skill with disable-model-invocation should be hidden from the model prompt
await mkdir(join(workspace, ".agents", "skills", "manual-only"), { recursive: true });
await writeFile(
  join(workspace, ".agents", "skills", "manual-only", "SKILL.md"),
  "---\nname: manual-only\ndescription: A side-effecting skill invocable only via /skill:name\ndisable-model-invocation: true\n---\nManual-only skill body.",
);

const promptWithSkills = await buildCohubSystemPrompt({
  cwd: workspace,
  userId,
  userIdentity: { uuid: userId, legacyUserUuid: legacyUserId },
  selectedTools: ["read"],
});

assert.ok(
  promptWithSkills.includes("This is a folded multi-line description."),
  "folded block scalar (>) should be joined with spaces",
);
assert.ok(
  promptWithSkills.includes("This is a literal\nmulti-line description."),
  "literal block scalar (|) should preserve newlines",
);
assert.ok(
  !promptWithSkills.includes("<description>></description>") && !promptWithSkills.includes("<description>|</description>"),
  "block scalar indicators should not appear as description text",
);
assert.ok(
  promptWithSkills.includes("test-folded"),
  "model-invocable skills should appear in the available_skills block",
);
assert.ok(
  !promptWithSkills.includes("manual-only"),
  "disable-model-invocation skills should be hidden from the available_skills block",
);
