import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Context, Model, Api, AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelsConfig } from "@cohub/infra/config-runtime/models";
import { CohubModelRegistry } from "../runtime/model-registry.js";
import { SessionManager } from "../runtime/local-session-manager.js";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/cohub_test";
process.env.APP_ENCRYPTION_KEY ??= "test-encryption-key";
process.env.SESSIONS_NAMESPACE ??= "test";

const { createCohubAgentSession } = await import("../runtime/session-runtime.js");
const { redis } = await import("../redis.js");
redis.disconnect();

const baseConfig: ModelsConfig = {
  providers: {
    test: {
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      apiKey: "TEST_API_KEY",
      models: [{ id: "plain", reasoning: false }],
    },
  },
};

const modelRegistry = new CohubModelRegistry({ configs: [baseConfig] });

async function withSession<T>(fn: (sessionManager: SessionManager) => Promise<T>) {
  const root = await mkdtemp(join(tmpdir(), "cohub-transform-context-"));
  try {
    const sessionManager = SessionManager.create(root, join(root, "sessions"));
    sessionManager.newSession({ id: "test-session" });
    return await fn(sessionManager);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Build a minimal mock streamFn that records the number of messages sent to
 * each LLM call and returns a deterministic assistant message.
 */
function createMockStreamFn(recorded: { messageCounts: number[] }) {
  let callIndex = 0;
  return (_model: Model<Api>, ctx: Context): AssistantMessageEventStream => {
    const index = callIndex++;
    recorded.messageCounts[index] = ctx.messages.length;

    const stream = createAssistantMessageEventStream();
    const assistantMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: `round-${index}` }],
      api: "openai-responses",
      provider: "test",
      model: "plain",
      stopReason: "stop",
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: Date.now(),
    } as AssistantMessage;

    // Emit start + done asynchronously so the agent loop can consume the stream.
    queueMicrotask(() => {
      stream.push({ type: "start", partial: assistantMessage });
      stream.push({ type: "done", reason: "stop", message: assistantMessage });
    });
    return stream;
  };
}

/**
 * Verify that the agent's transformContext hook fires before every LLM call
 * and returns the latest sessionManager context (not the stale loop-internal
 * snapshot).
 */
await withSession(async (sessionManager) => {
  // Pre-populate a couple of messages so the session has history.
  sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    provider: "test",
    model: "plain",
    stopReason: "stop",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  } as AgentMessage);

  const { session } = await createCohubAgentSession({
    cwd: "/workspace",
    modelRegistry,
    sessionManager,
    tools: [] as AgentTool[],
  });

  // Replace the streamFn with a mock that records message counts.
  const recorded = { messageCounts: [] as number[] };
  (session.agent as unknown as { streamFn: unknown }).streamFn = createMockStreamFn(recorded);

  let transformCalls = 0;
  const originalTransform = session.agent.transformContext;
  session.agent.transformContext = async () => {
    transformCalls++;
    // Always return the sessionManager's rebuilt context, simulating the
    // runWithRoundAutoCompaction hook behavior.
    return sessionManager.buildSessionContext().messages;
  };

  try {
    // First prompt — should trigger exactly one transformContext call.
    await session.promptMessages([
      { role: "user", content: [{ type: "text", text: "round 0" }], timestamp: Date.now() } as AgentMessage,
    ]);

    assert.equal(transformCalls, 1, "transformContext should fire once for the first prompt");
    assert.equal(recorded.messageCounts.length, 1, "exactly one LLM call expected");

    // Second prompt — transformContext should fire again.
    await session.promptMessages([
      { role: "user", content: [{ type: "text", text: "round 1" }], timestamp: Date.now() } as AgentMessage,
    ]);

    assert.equal(transformCalls, 2, "transformContext should fire again for the second prompt");
    assert.equal(recorded.messageCounts.length, 2, "exactly two LLM calls expected");

    // The mock streamFn always returns stopReason "stop", so agent.state.messages
    // should include the two new user messages plus mock assistant responses.
    const finalMessages = session.agent.state.messages;
    assert.ok(finalMessages.length >= 4, "agent state should contain both turns");

    // Restore original transform to confirm cleanup works without error.
    session.agent.transformContext = originalTransform;
  } finally {
    session.agent.transformContext = originalTransform;
  }
});

console.log("transform context checks passed");
