import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ModelsConfig } from "@cohub/infra/config-runtime/models";
import { CohubModelRegistry } from "../runtime/model-registry.js";
import { SessionManager } from "../runtime/local-session-manager.js";

const baseConfig: ModelsConfig = {
  providers: {
    test: {
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      apiKey: "TEST_API_KEY",
      models: [
        {
          id: "reasoning-default-high",
          reasoning: true,
          defaultThinkingLevel: "high",
          thinkingLevelMap: { xhigh: null },
        },
        {
          id: "reasoning-default-implicit",
          reasoning: true,
        },
        {
          id: "plain",
          reasoning: false,
        },
      ],
    },
  },
};

async function withSession<T>(fn: (sessionManager: SessionManager) => Promise<T>) {
  const root = await mkdtemp(join(tmpdir(), "cohub-agent-thinking-"));
  try {
    const sessionManager = SessionManager.create(root, join(root, "sessions"));
    sessionManager.newSession({ id: "test-session" });
    return await fn(sessionManager);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/cohub_test";
process.env.APP_ENCRYPTION_KEY ??= "test-encryption-key";
process.env.SESSIONS_NAMESPACE ??= "test";

const { createCohubAgentSession } = await import("../runtime/session-runtime.js");
const { redis } = await import("../redis.js");
redis.disconnect();

const modelRegistry = new CohubModelRegistry({ configs: [baseConfig] });
const tools: AgentTool[] = [];

await withSession(async (sessionManager) => {
  const { session } = await createCohubAgentSession({
    cwd: "/workspace",
    modelRegistry,
    sessionManager,
    tools,
  });

  assert.equal(session.agent.state.thinkingLevel, "high");
  assert.equal(sessionManager.buildSessionContext().thinkingLevel, "high");
});

await withSession(async (sessionManager) => {
  const implicitModel = modelRegistry.find("test", "reasoning-default-implicit");
  assert.ok(implicitModel);

  const { session } = await createCohubAgentSession({
    cwd: "/workspace",
    model: implicitModel,
    modelRegistry,
    sessionManager,
    tools,
  });

  assert.equal(session.agent.state.thinkingLevel, "high");
});

await withSession(async (sessionManager) => {
  sessionManager.appendThinkingLevelChange("low");
  sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });

  const { session } = await createCohubAgentSession({
    cwd: "/workspace",
    modelRegistry,
    sessionManager,
    tools,
  });

  assert.equal(session.agent.state.thinkingLevel, "low");
});

await withSession(async (sessionManager) => {
  const { session } = await createCohubAgentSession({
    cwd: "/workspace",
    modelRegistry,
    sessionManager,
    tools,
  });
  const plainModel = modelRegistry.find("test", "plain");
  assert.ok(plainModel);

  await session.setModel(plainModel);

  assert.equal(session.agent.state.thinkingLevel, "off");
  assert.equal(sessionManager.buildSessionContext().thinkingLevel, "off");
});

console.log("session thinking level checks passed");
