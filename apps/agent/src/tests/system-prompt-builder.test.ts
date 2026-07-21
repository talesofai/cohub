import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ModelsConfig } from "@cohub/infra/config-runtime/models";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/cohub_test";
process.env.APP_ENCRYPTION_KEY ??= "test-encryption-key";
process.env.SESSIONS_NAMESPACE ??= "test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.WORKSPACE_ROOT ??= "/tmp";
process.env.SESSIONS_DIR ??= "/tmp";
process.env.ENV ??= "dev";

const root = await mkdtemp(join(tmpdir(), "cohub-system-prompt-"));
process.env.PLATFORM_CONFIG_ROOT = join(root, "configs");

const userId = "11111111-1111-4111-8111-111111111111";
const secondUserId = "22222222-2222-4222-8222-222222222222";
const workspace = join(root, "workspace");
const userConfig = join(process.env.PLATFORM_CONFIG_ROOT, "users", userId);
const secondUserConfig = join(process.env.PLATFORM_CONFIG_ROOT, "users", secondUserId);
const platformAgent = join(process.env.PLATFORM_CONFIG_ROOT, "platform", ".cohub");

await mkdir(workspace, { recursive: true });
await mkdir(userConfig, { recursive: true });
await mkdir(secondUserConfig, { recursive: true });
await mkdir(platformAgent, { recursive: true });
await writeFile(join(platformAgent, "SYSTEM.md"), "You are a Cohub test assistant.");
await writeFile(join(userConfig, "AGENTS.md"), "Always prefer concise answers.");
await writeFile(join(secondUserConfig, "AGENTS.md"), "Prefer implementation details.");
await mkdir(join(userConfig, ".agents", "skills", "owner-skill"), { recursive: true });
await mkdir(join(secondUserConfig, ".agents", "skills", "actor-skill"), { recursive: true });
await writeFile(join(userConfig, ".agents", "skills", "owner-skill", "SKILL.md"), "---\nname: owner-skill\ndescription: Owner-only skill\n---\nOwner skill body.");
await writeFile(join(secondUserConfig, ".agents", "skills", "actor-skill", "SKILL.md"), "---\nname: actor-skill\ndescription: Actor skill should be skipped for non-owner\n---\nActor skill body.");
await writeFile(join(workspace, "AGENTS.md"), "Project rule: run typecheck.");

const { buildCohubSystemPrompt } = await import("../runtime/system-prompt-builder.js");

const prompt = await buildCohubSystemPrompt({
  cwd: workspace,
  userId,
  selectedTools: [],
});

assert.ok(prompt.includes("# User Context"), "should include user context section");
assert.ok(!prompt.includes("/configs/user/AGENTS.md"), "should not expose sandbox user rule path");
assert.ok(prompt.includes("Always prefer concise answers."), "should include user rules content");
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

const promptWithSkills = await buildCohubSystemPrompt({
  cwd: workspace,
  userId,
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

const { createCohubAgentSession } = await import("../runtime/session-runtime.js");
const { CohubModelRegistry } = await import("../runtime/model-registry.js");
const { SessionManager } = await import("../runtime/local-session-manager.js");
const { redis } = await import("../redis.js");
redis.disconnect();

const createModelsConfig = (provider: string, modelId: string): ModelsConfig => ({
  providers: {
    [provider]: {
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      apiKey: `${provider.toUpperCase()}_KEY`,
      models: [{ id: modelId, reasoning: false }],
    },
  },
});

const firstRegistry = new CohubModelRegistry({ configs: [createModelsConfig("first", "first-model")] });
const secondRegistry = new CohubModelRegistry({ configs: [createModelsConfig("second", "second-model")] });
const sessionRoot = await mkdtemp(join(tmpdir(), "cohub-system-prompt-runtime-"));
try {
  const sessionManager = SessionManager.create(workspace, join(sessionRoot, "sessions"));
  sessionManager.newSession({ id: "runtime-identity-test" });
  const { session } = await createCohubAgentSession({
    cwd: workspace,
    userId,
    spaceOwnerUserId: userId,
    modelRegistry: firstRegistry,
    sessionManager,
    tools: [] as AgentTool[],
  });

  await session.configureTools([{ name: "read" } as AgentTool]);
  assert.ok(session.agent.state.systemPrompt.includes("Always prefer concise answers."), "initial prompt should use first user context");
  assert.ok(session.agent.state.systemPrompt.includes("owner-skill"), "owner prompt should include owner user skills");
  assert.equal(session.agent.state.model.provider, "first");

  await session.configureRuntimeIdentity({ userId: secondUserId, modelRegistry: secondRegistry });

  assert.ok(session.agent.state.systemPrompt.includes("Prefer implementation details."), "runtime prompt should use actor user context");
  assert.ok(!session.agent.state.systemPrompt.includes("Always prefer concise answers."), "runtime prompt should drop previous user context");
  assert.ok(!session.agent.state.systemPrompt.includes("actor-skill"), "non-owner actor prompt should skip user skills");
  assert.ok(!session.agent.state.systemPrompt.includes("/configs/user/.agents/skills"), "non-owner actor prompt should not expose user skill paths");
  assert.equal(session.modelRegistry, secondRegistry);
  assert.equal(session.agent.state.model.provider, "second");

  await session.configureRuntimeIdentity({ userId: secondUserId, spaceOwnerUserId: secondUserId, modelRegistry: secondRegistry });
  assert.ok(session.agent.state.systemPrompt.includes("actor-skill"), "new owner actor prompt should include user skills after owner refresh");

  await assert.rejects(
    session.configureRuntimeIdentity({
      userId: secondUserId,
      spaceOwnerUserId: secondUserId,
      modelRegistry: secondRegistry,
      requestedModel: { provider: "missing", id: "missing-model" },
    }),
    /Requested model is not available: missing\/missing-model/,
  );
  assert.equal(session.modelRegistry, secondRegistry, "failed identity switch should keep previous registry");
  assert.equal(session.agent.state.model.provider, "second", "failed identity switch should keep previous model");
  assert.ok(session.agent.state.systemPrompt.includes("actor-skill"), "failed identity switch should keep previous prompt");
} finally {
  await rm(sessionRoot, { recursive: true, force: true });
}
